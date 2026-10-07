// The sidecar supervisor: a spawn on a port it chose, health polling, restarts with backoff,
// giving up, and stopping for good. The child is a small Bun script whose behaviour comes
// from its environment, so every path is exercised against a real process on a real port.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, Sidecars } from "../src/sidecars/index.ts";
import type { SidecarSpec } from "../src/sidecars/index.ts";
import { silentLogger } from "../src/log.ts";
import { waitFor } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fakes", "sidecar.ts");

const dirs: string[] = [];
const running: Sidecars[] = [];

afterEach(async () => {
  for (const s of running.splice(0)) await s.stopAll();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sidecars(): { sidecars: Sidecars; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cophyla-sidecar-"));
  dirs.push(dir);
  const s = new Sidecars({ dir, log: silentLogger });
  running.push(s);
  return { sidecars: s, dir };
}

function spec(over: Partial<SidecarSpec> = {}): SidecarSpec {
  return {
    name: "fake",
    command: process.execPath,
    args: [FAKE, "--port", "{port}", "--host", "127.0.0.1"],
    health: { path: "/health", intervalMs: 50, timeoutMs: 500, startTimeoutMs: 4000 },
    restart: { backoffMs: 50, maxMs: 200, max: 2 },
    ...over,
  };
}

describe("sidecars", () => {
  test("spawns on a free loopback port, comes ready, answers there, and logs its output", async () => {
    const { sidecars: s, dir } = sidecars();
    const sidecar = s.spawn(spec({ env: { FAKE_SIDECAR_LOG: "hello from the sidecar" } }));
    await sidecar.start();
    expect(sidecar.state().status).toBe("ready");
    expect(sidecar.state().pid).toBeGreaterThan(0);
    expect(sidecar.url).toBe(`http://127.0.0.1:${sidecar.port}`);
    const res = await fetch(`${sidecar.url}/health`);
    expect(await res.json()).toMatchObject({ ok: true, port: sidecar.port });
    // Loopback only: the port it was given is not bound on the LAN.
    expect(s.list()).toEqual([sidecar.state()]);
    await waitFor(() => existsSync(join(dir, "fake.log")) && readFileSync(join(dir, "fake.log"), "utf8").includes("hello from the sidecar"));
    expect(readFileSync(join(dir, "fake.log"), "utf8")).toContain("[out]");
  }, 15_000);

  test("a fixed port is used as given, the health check can be a whole URL, and a start interval checks sooner", async () => {
    const { sidecars: s } = sidecars();
    const port = freePort();
    const sidecar = s.spawn(
      spec({
        port,
        health: { path: "/ignored", url: "http://127.0.0.1:{port}/health", intervalMs: 60_000, startIntervalMs: 50, timeoutMs: 500, startTimeoutMs: 4000 },
      }),
    );
    expect(sidecar.port).toBe(port);
    const t = Date.now();
    await sidecar.start();
    // the steady interval is a minute: only the start interval could have seen it this soon
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(sidecar.state()).toMatchObject({ status: "ready", port });
    expect(((await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { port: number }).port).toBe(port);
  }, 15_000);

  test("waits for a slow start, then reports ready", async () => {
    const { sidecars: s } = sidecars();
    const sidecar = s.spawn(spec({ env: { FAKE_SIDECAR_WARM_MS: "700" } }));
    const t = Date.now();
    await sidecar.start();
    expect(Date.now() - t).toBeGreaterThanOrEqual(600);
    expect(sidecar.state().status).toBe("ready");
  }, 15_000);

  test("a crash after it was ready is restarted with backoff", async () => {
    const { sidecars: s } = sidecars();
    const sidecar = s.spawn(spec({ env: { FAKE_SIDECAR_EXIT_MS: "300" } }));
    const seen: string[] = [];
    sidecar.onChange((st) => seen.push(st.status));
    await sidecar.start();
    await waitFor(() => sidecar.state().restarts >= 1, 8000);
    expect(seen).toContain("restarting");
    // It comes back up on the same port, for a moment: the new process exits after 300 ms too.
    await waitFor(() => seen.lastIndexOf("ready") > seen.indexOf("restarting"), 8000);
  }, 20_000);

  test("a health check still out when the process dies leaves the restart standing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cophyla-sidecar-"));
    dirs.push(dir);
    // Every answer of the first life is held 400 ms, so one is out when it exits at 300 ms and
    // comes back inside the second's backoff.
    let hold = false;
    const held = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const res = await fetch(input, init);
      if (hold) await Bun.sleep(400);
      return res;
    }) as typeof fetch;
    const s = new Sidecars({ dir, log: silentLogger, fetch: held });
    running.push(s);
    const sidecar = s.spawn(spec({ env: { FAKE_SIDECAR_EXIT_MS: "300" }, restart: { backoffMs: 1000, maxMs: 1000, max: 2 } }));
    const seen: string[] = [];
    sidecar.onChange((st) => {
      seen.push(st.status);
      if (st.status === "restarting") hold = false;
    });
    await sidecar.start();
    hold = true;
    await waitFor(() => seen.lastIndexOf("ready") > seen.indexOf("restarting") && seen.includes("restarting"), 5000);
    // the late answer changed nothing: the second life was spawned after the backoff and is ready on its own answer
    const from = seen.indexOf("restarting");
    expect(seen.slice(from, from + 3)).toEqual(["restarting", "starting", "ready"]);
  }, 20_000);

  test("a process that never answers is failed, and the start rejects", async () => {
    const { sidecars: s } = sidecars();
    const sidecar = s.spawn(spec({ env: { FAKE_SIDECAR_DEAF: "1" }, health: { path: "/health", intervalMs: 50, timeoutMs: 200, startTimeoutMs: 600 } }));
    await expect(sidecar.start()).rejects.toThrow(/health check never passed/);
    expect(sidecar.state().status).toBe("failed");
  }, 15_000);

  test("a command that is not there fails at once rather than restarting for ever", async () => {
    const { sidecars: s } = sidecars();
    const sidecar = s.spawn(spec({ command: join(import.meta.dir, "no-such-binary-ever") }));
    await expect(sidecar.start()).rejects.toThrow();
    expect(sidecar.state().status).toBe("failed");
    expect(sidecar.state().restarts).toBe(0);
  }, 15_000);

  test("an exit before the first health check is a failure to start, not a restart", async () => {
    const { sidecars: s } = sidecars();
    const sidecar = s.spawn(spec({ env: { FAKE_SIDECAR_DEAF: "1", FAKE_SIDECAR_EXIT_MS: "100", FAKE_SIDECAR_EXIT_CODE: "3" } }));
    await expect(sidecar.start()).rejects.toThrow(/exited 3 before it was ready/);
    expect(sidecar.state().status).toBe("failed");
    expect(sidecar.state().restarts).toBe(0);
  }, 15_000);

  test("a sidecar that keeps dying is given up on after the restart cap", async () => {
    const { sidecars: s } = sidecars();
    // Ready at once, then gone: every life is a restart, and the third one gives up.
    const sidecar = s.spawn(spec({ env: { FAKE_SIDECAR_EXIT_MS: "250" }, restart: { backoffMs: 20, maxMs: 40, max: 2 } }));
    await sidecar.start();
    await waitFor(() => sidecar.state().status === "failed", 12_000);
    expect(sidecar.state().restarts).toBe(2);
    expect(sidecar.state().reason).toContain("exited");
  }, 25_000);

  test("one that stops answering goes unhealthy without being restarted", async () => {
    const { sidecars: s } = sidecars();
    const sidecar = s.spawn(spec({ env: { FAKE_SIDECAR_SICK_MS: "200" } }));
    await sidecar.start();
    await waitFor(() => sidecar.state().status === "unhealthy", 8000);
    expect(sidecar.state().restarts).toBe(0);
  }, 20_000);

  test("stop kills it, and a stubborn one is killed hard", async () => {
    const { sidecars: s } = sidecars();
    const sidecar = s.spawn(spec({ env: { FAKE_SIDECAR_IGNORE_TERM: "1" } }));
    await sidecar.start();
    const port = sidecar.port;
    await s.stopAll();
    expect(sidecar.state().status).toBe("stopped");
    // The port is free again: nothing answers on it.
    await expect(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  }, 20_000);

  test.skipIf(process.platform !== "win32")("stop ends what the sidecar started too, which would otherwise outlive it", async () => {
    const { sidecars: s, dir } = sidecars();
    const sidecar = s.spawn(spec({ env: { FAKE_SIDECAR_CHILD: "1" } }));
    await sidecar.start();
    const log = join(dir, "fake.log");
    await waitFor(() => existsSync(log) && /child \d+/.test(readFileSync(log, "utf8")));
    const child = Number(/child (\d+)/.exec(readFileSync(log, "utf8"))![1]);
    const alive = () => {
      try {
        process.kill(child, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      expect(alive()).toBe(true);
      await s.stopAll();
      await waitFor(() => !alive(), 5000);
    } finally {
      if (alive()) process.kill(child);
    }
  }, 20_000);

  test("spawning the same name twice gives the same sidecar, and freePort gives a bindable one", async () => {
    const { sidecars: s } = sidecars();
    const one = s.spawn(spec());
    const two = s.spawn(spec());
    expect(two).toBe(one);
    const port = freePort();
    expect(port).toBeGreaterThan(0);
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
    expect(server.port).toBe(port);
    await server.stop(true);
  });
});
