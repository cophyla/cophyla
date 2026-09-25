// `node.restart`: a busy daemon refuses with what it would cut off, unless forced; otherwise
// it answers, stops, starts its successor (or leaves that to the desktop app attached on this
// machine) and exits. A successor that could not start refuses the restart and the daemon
// runs on; one that fails after the stop ends in exit 1; a second request while restarting is
// a conflict. `waitForExit` is what a successor waits on.

import { afterEach, describe, expect, test } from "bun:test";
import type { AuditEntry } from "@cophyla/protocol";
import type { Daemon } from "../src/daemon.ts";
import { waitForExit } from "../src/restart.ts";
import { isMethod, removeHome, stopDaemon, TestClient, testDaemon, waitFor } from "./helpers.ts";

let d: (Daemon & { home: string }) | undefined;
let exited: number[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  // A daemon that restarted has stopped itself already.
  if (d) {
    if (exited.length > 0) removeHome(d.home);
    else await stopDaemon(d);
  }
  d = undefined;
  exited = [];
});

async function restartable(respawn: () => number, delayMs = 0, preflight: () => void = () => {}): Promise<Daemon & { home: string }> {
  return testDaemon("", { restart: { preflight, respawn, exit: (code) => exited.push(code), delayMs } });
}

async function connect(daemon: Daemon, name: string): Promise<TestClient> {
  const c = await TestClient.connect(daemon.api.url);
  await c.hello(daemon.token, { name });
  clients.push(c);
  return c;
}

const codeOf = (r: Awaited<ReturnType<TestClient["call"]>>) => ("error" in r ? (r.error.data as { code: string }).code : "ok");

describe("node.restart", () => {
  test("a busy daemon says what it would cut off; forced, it stops, then starts its successor, and exits", async () => {
    let spawned = 0;
    let stoppedFirst = false;
    d = await restartable(() => {
      spawned++;
      // The listeners are closed before the successor starts: it must not inherit them.
      stoppedFirst = d!.api.clients().length === 0;
      return 4242;
    });
    const c = await connect(d, "test");
    d.asks.open({ type: "choice", source: { kind: "brain" }, title: "Restart?", options: [{ id: "y", label: "Yes" }], answerableBy: ["user"] });
    const busy = await c.call("node.restart", {});
    expect(codeOf(busy)).toBe("conflict");
    expect("error" in busy && (busy.error.data as { data: { reasons: string[] } }).data.reasons).toEqual(["1 open ask"]);
    expect(spawned).toBe(0);
    expect(await c.request<object>("node.restart", { force: true })).toEqual({});
    await waitFor(() => exited.length === 1);
    expect(exited).toEqual([0]);
    expect(spawned).toBe(1);
    expect(stoppedFirst).toBe(true);
    // Stopped: the socket is closed, and the audit row said who asked before it went.
    await c.closed;
    const row = c.notifications.filter(isMethod("audit.entry", (p) => (p as AuditEntry).action === "node.restart" && (p as AuditEntry).outcome === "ok"))[0]!.params as AuditEntry;
    expect(row.principal.kind).toBe("user");
    expect(row.args).toEqual({ force: true });
  });

  test("with the desktop app attached on this machine, the daemon leaves the next start to it", async () => {
    let spawned = 0;
    d = await restartable(() => {
      spawned++;
      return 4242;
    });
    const desktop = await connect(d, "desktop");
    expect(await desktop.request<object>("node.restart", {})).toEqual({});
    await waitFor(() => exited.length === 1);
    expect(spawned).toBe(0);
  });

  test("a successor that could not start refuses the restart, and the daemon runs on", async () => {
    let spawned = 0;
    d = await restartable(
      () => ++spawned,
      0,
      () => {
        throw new Error("no runtime");
      },
    );
    const c = await connect(d, "test");
    const r = await c.call("node.restart", {});
    expect(codeOf(r)).toBe("unavailable");
    await Bun.sleep(50);
    expect(exited).toEqual([]);
    expect(spawned).toBe(0);
    expect(await c.request<{ nodes: unknown[] }>("node.list", {})).toMatchObject({ nodes: [{ id: d.identity.id }] });
  });

  test("a successor that fails once the daemon has stopped ends in exit 1", async () => {
    d = await restartable(() => {
      throw new Error("spawn failed");
    });
    const c = await connect(d, "test");
    expect(await c.request<object>("node.restart", {})).toEqual({});
    await waitFor(() => exited.length === 1);
    expect(exited).toEqual([1]);
  });

  test("a second request while restarting is a conflict", async () => {
    d = await restartable(() => 4242, 300);
    const c = await connect(d, "test");
    expect(await c.request<object>("node.restart", {})).toEqual({});
    expect(codeOf(await c.call("node.restart", { force: true }))).toBe("conflict");
    await waitFor(() => exited.length === 1);
  });
});

describe("waitForExit", () => {
  test("resolves once the process is gone, and says so when it is still there at the deadline", async () => {
    const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 300)"], { stdout: "ignore", stderr: "ignore" });
    expect(await waitForExit(child.pid, 10_000, 20)).toBe(true);
    expect(await waitForExit(process.pid, 150, 20)).toBe(false);
  });
});
