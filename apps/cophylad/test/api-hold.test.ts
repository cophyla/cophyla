// A phone held for its return, through the api: `client.away` holds what it would be sent and
// answers before sending it once it is back; a tunnel that closes holds the phone, and a hello
// naming it on a new tunnel takes it up (`resumed`, the same id, what it missed and no
// welcome); a live one is taken up only by a phone moving off it, which hears `client.moved`
// there last; another phone cannot take it; and one held past its time begins again.

import { afterEach, describe, expect, test } from "bun:test";
import type { Client, Controller } from "@cophyla/protocol";
import type { Daemon } from "../src/daemon.ts";
import type { NodeSocketHandler } from "../src/api/server.ts";
import { stopDaemon, testDaemon, TestClient, waitFor } from "./helpers.ts";

let current: (Daemon & { home: string }) | undefined;
afterEach(async () => {
  if (current) await stopDaemon(current);
  current = undefined;
});

type Frame = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { data?: { code: string } } };

/** The far end of a tunnel as the api sees it: what it was sent, in order, and the close it got. */
class FakeTunnel {
  readonly frames: Frame[] = [];
  closed?: { code: number; reason: string };
  handler!: NodeSocketHandler;
  private waiters: { test: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  private n = 0;

  constructor(d: Daemon) {
    this.handler = d.api.acceptTunnel({
      send: (text) => {
        const f = JSON.parse(text) as Frame;
        this.frames.push(f);
        for (const w of [...this.waiters]) if (w.test(f)) (this.waiters.splice(this.waiters.indexOf(w), 1), w.resolve(f));
      },
      close: (code, reason) => {
        this.closed = { code, reason };
      },
      remote: "relay:ctl_test",
    });
  }

  call(method: string, params: unknown = {}): Promise<Frame> {
    const id = ++this.n;
    const p = this.wait((f) => f.id === id);
    this.handler.message(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return p;
  }

  wait(test: (f: Frame) => boolean, ms = 5000): Promise<Frame> {
    const have = this.frames.find(test);
    if (have) return Promise.resolve(have);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no frame")), ms);
      this.waiters.push({ test, resolve: (f) => (clearTimeout(t), resolve(f)) });
    });
  }

  titles(): string[] {
    return this.frames.filter((f) => f.method === "ask.state").map((f) => (f.params as { title: string }).title);
  }
}

const AUDIO = { in: true, out: true };
const askFor = (d: Daemon, title: string) => d.asks.open({ type: "choice", source: { kind: "brain" }, title, options: [{ id: "y", label: "Yes" }], answerableBy: ["user"] });

async function phoneOn(d: Daemon, token: string, extra: Record<string, unknown> = {}): Promise<{ t: FakeTunnel; hello: Frame; client: Client }> {
  const t = new FakeTunnel(d);
  const hello = await t.call("hello", { token, kind: "controller", audio: AUDIO, ...extra });
  return { t, hello, client: (hello.result as { client: Client }).client };
}

describe("api: a phone out of sight", () => {
  test("away holds what it would be sent, and it is not there for anyone; back, the answer goes first and what it missed after", async () => {
    const d = (current = await testDaemon("[controller]\nenabled = true\nport = 0\n"));
    const ui = await TestClient.connect(d.api.url);
    await ui.hello(d.token, { name: "desktop" });
    const { token } = d.grants.createController("Pixel");
    const { t, client } = await phoneOn(d, token);
    expect((await t.call("client.away", { away: true })).result).toEqual({});
    expect(d.clients.held(client.id)).toBe("away");
    expect((await ui.request<{ controllers: Controller[] }>("controller.list", {})).controllers[0]!.connected).toBe(false);
    askFor(d, "while away");
    await Bun.sleep(50);
    expect(t.titles()).not.toContain("while away");
    const back = t.call("client.away", { away: false });
    const answer = await back;
    await t.wait((f) => f.method === "ask.state" && (f.params as { title: string }).title === "while away");
    expect(t.frames.indexOf(answer)).toBeLessThan(t.frames.findIndex((f) => f.method === "ask.state" && (f.params as { title: string }).title === "while away"));
    expect(d.clients.held(client.id)).toBeUndefined();
    expect((await ui.request<{ controllers: Controller[] }>("controller.list", {})).controllers[0]!.connected).toBe(true);
    // a view never says it
    ui.close();
  });
});

describe("api: a phone coming back", () => {
  test("a closed tunnel holds it; a hello naming it takes it up: resumed, the same id, what it missed, no welcome", async () => {
    const d = (current = await testDaemon("[controller]\nenabled = true\nport = 0\n"));
    const { token } = d.grants.createController("Pixel");
    askFor(d, "before");
    const first = await phoneOn(d, token);
    await first.t.wait((f) => f.method === "ask.state");
    first.t.handler.close(4409, "tunnel closed");
    await waitFor(() => d.clients.held(first.client.id) === "parked");
    askFor(d, "missed");
    const again = await phoneOn(d, token, { resume: first.client.id });
    expect((again.hello.result as { resumed?: boolean }).resumed).toBe(true);
    expect(again.client.id).toBe(first.client.id);
    await again.t.wait((f) => f.method === "ask.state" && (f.params as { title: string }).title === "missed");
    await Bun.sleep(50);
    // what it had heard already is not said again
    expect(again.t.titles()).toEqual(["missed"]);
    expect(d.clients.get(first.client.id)?.listener).toBe("cloud");
    // and it is served as itself
    expect((await again.t.call("session.list", {})).result).toEqual({ sessions: [] });
  });

  test("a live client is not taken up by a hello that does not say it moves: that one begins again, welcome and all", async () => {
    const d = (current = await testDaemon("[controller]\nenabled = true\nport = 0\n"));
    const { token } = d.grants.createController("Pixel");
    askFor(d, "open");
    const first = await phoneOn(d, token);
    const again = await phoneOn(d, token, { resume: first.client.id });
    expect((again.hello.result as { resumed?: boolean }).resumed).toBeUndefined();
    expect(again.client.id).not.toBe(first.client.id);
    await again.t.wait((f) => f.method === "ask.state");
  });

  test("a phone moving off a live connection takes its client along: client.moved is the last thing sent there; that one's close ends nothing", async () => {
    const d = (current = await testDaemon("[controller]\nenabled = true\nport = 0\n"));
    const { token } = d.grants.createController("Pixel");
    const first = await phoneOn(d, token);
    const moved = await phoneOn(d, token, { resume: first.client.id, move: true });
    expect((moved.hello.result as { resumed?: boolean }).resumed).toBe(true);
    expect(moved.client.id).toBe(first.client.id);
    await first.t.wait((f) => f.method === "client.moved");
    const marked = first.t.frames.length;
    askFor(d, "after the move");
    await moved.t.wait((f) => f.method === "ask.state");
    expect(first.t.frames).toHaveLength(marked);
    first.t.handler.close(1000, "the link moved");
    await Bun.sleep(50);
    expect(d.clients.get(first.client.id)?.listener).toBe("cloud");
    expect(d.clients.held(first.client.id)).toBeUndefined();
  });

  test("another phone's token cannot take it up", async () => {
    const d = (current = await testDaemon("[controller]\nenabled = true\nport = 0\n"));
    const mine = d.grants.createController("Pixel");
    const theirs = d.grants.createController("Other");
    const first = await phoneOn(d, mine.token);
    first.t.handler.close(4409, "tunnel closed");
    await waitFor(() => d.clients.held(first.client.id) === "parked");
    const other = await phoneOn(d, theirs.token, { resume: first.client.id, move: true });
    expect((other.hello.result as { resumed?: boolean }).resumed).toBeUndefined();
    expect(other.client.id).not.toBe(first.client.id);
    expect(d.clients.held(first.client.id)).toBe("parked");
  });

  test("held past its time it is let go, and its hello begins again", async () => {
    const d = (current = await testDaemon("[controller]\nenabled = true\nport = 0\n", { holds: { holdMs: 60 } }));
    const { token } = d.grants.createController("Pixel");
    const first = await phoneOn(d, token);
    first.t.handler.close(4409, "tunnel closed");
    await waitFor(() => d.clients.get(first.client.id) === undefined);
    const again = await phoneOn(d, token, { resume: first.client.id });
    expect((again.hello.result as { resumed?: boolean }).resumed).toBeUndefined();
  });

  test("a refused or revoked socket is not held", async () => {
    const d = (current = await testDaemon("[controller]\nenabled = true\nport = 0\n"));
    const ui = await TestClient.connect(d.api.url);
    await ui.hello(d.token, { name: "desktop" });
    const { controller, token } = d.grants.createController("Pixel");
    const first = await phoneOn(d, token);
    await ui.request("controller.revoke", { id: controller.id });
    // the revoke closes the tunnel with 4401, as its close says
    first.t.handler.close(4401, "controller revoked");
    await waitFor(() => d.clients.get(first.client.id) === undefined);
    ui.close();
  });
});
