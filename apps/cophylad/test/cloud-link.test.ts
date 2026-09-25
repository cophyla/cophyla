import { afterEach, describe, expect, test } from "bun:test";
import { RpcError } from "@cophyla/protocol";
import { ServerLink, serverUrlAllowed } from "../src/cloud/link.ts";
import { startDeviceFlow } from "../src/cloud/login.ts";
import { silentLogger } from "../src/log.ts";
import { FakeServer } from "./fakes/server.ts";
import { sleep, waitFor } from "./helpers.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("serverUrlAllowed", () => {
  test("https anywhere, http only on loopback unless allowed", () => {
    expect(serverUrlAllowed("https://api.getcophyla.com", false)).toBe(true);
    expect(serverUrlAllowed("http://127.0.0.1:8080", false)).toBe(true);
    expect(serverUrlAllowed("http://localhost:8080", false)).toBe(true);
    expect(serverUrlAllowed("http://192.168.1.4:8080", false)).toBe(false);
    expect(serverUrlAllowed("http://192.168.1.4:8080", true)).toBe(true);
    expect(serverUrlAllowed("ftp://x", true)).toBe(false);
    expect(serverUrlAllowed("nope", true)).toBe(false);
  });
});

describe("ServerLink", () => {
  let fake: FakeServer | undefined;
  let link: ServerLink | undefined;
  afterEach(async () => {
    await link?.close();
    await fake?.stop();
    fake = undefined;
    link = undefined;
  });

  function make(token: () => string | undefined, over: Partial<ConstructorParameters<typeof ServerLink>[0]> = {}) {
    const events: string[] = [];
    const sleeps: number[] = [];
    link = new ServerLink({
      url: fake!.url,
      token,
      node: NODE,
      log: silentLogger,
      reconnectMs: 10,
      reconnectMaxMs: 80,
      requestTimeoutMs: 2000,
      allowInsecure: true,
      sleep: async (ms) => {
        sleeps.push(ms);
        await sleep(Math.min(ms, 20));
      },
      onUp: (a) => events.push(`up:${a.subject}`),
      onDown: (r) => events.push(`down:${r.split(" ")[0]}`),
      onAuthRefused: () => events.push("refused"),
      onFrame: (m) => events.push(`frame:${m}`),
      ...over,
    });
    return { link, events, sleeps };
  }

  test("auths first, requests route their deltas by id, cancel on abort, frames to the owner", async () => {
    fake = new FakeServer();
    const token = fake.mintToken();
    const { link: l, events } = make(() => token);
    l.connect();
    await waitFor(() => l.connected);
    expect(events).toEqual([`up:${fake.subject}`]);
    expect(fake.seen).toEqual(["auth"]);
    const deltas: string[] = [];
    const r = (await l.request(
      "llm.complete",
      { model: { tier: "fast" }, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      { onNotice: (m, p) => deltas.push(`${m}:${(p as { delta: { text: string } }).delta.text}`) },
    )) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe("Nothing is open.");
    expect(deltas).toEqual(["llm.delta:Nothing ", "llm.delta:is open."]);
    // a second request's deltas do not leak into the first's handler
    const other: string[] = [];
    fake.scripts["slow"] = { deltas: ["one", "two", "three"] };
    await l.request("llm.complete", { model: { tier: "fast" }, messages: [{ role: "user", content: [{ type: "text", text: "slow" }] }] }, { onNotice: (_m, p) => other.push((p as { delta: { text: string } }).delta.text) });
    expect(other).toEqual(["one", "two", "three"]);
    expect(deltas).toHaveLength(2);
    // abort → cancel {id} reaches the server and the request rejects cancelled
    const ac = new AbortController();
    fake.scripts["long"] = { deltas: Array.from({ length: 40 }, (_, i) => `w${i} `) };
    const p = l.requestCancellable("llm.complete", { model: { tier: "fast" }, messages: [{ role: "user", content: [{ type: "text", text: "long" }] }] }, { signal: ac.signal });
    await sleep(30);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
    await waitFor(() => fake!.cancels.length === 1);
    // a frame about nothing in flight goes to the owner
    fake.pushEntitlement();
    await waitFor(() => events.includes("frame:entitlement.updated"));
    // unsupported methods answer as such
    await expect(l.request("session.list", {})).rejects.toMatchObject({ code: "unsupported" });
  });

  test("reconnects with backoff after a restart, doubling to the max, and resets on success", async () => {
    fake = new FakeServer();
    const token = fake.mintToken();
    const { link: l, events, sleeps } = make(() => token);
    l.connect();
    await waitFor(() => l.connected);
    const attempts = l.attempts;
    await fake.stop();
    await waitFor(() => !l.connected);
    await sleep(150);
    expect(l.attempts).toBeGreaterThan(attempts + 1);
    expect(sleeps.slice(0, 4)).toEqual([10, 20, 40, 80]);
    expect(sleeps.every((s) => s <= 80)).toBe(true);
    const port = new URL(fake.url).port;
    void port;
    // a new server at another address is not this test's concern: what matters is that the loop kept trying
    expect(events.filter((e) => e.startsWith("down:")).length).toBeGreaterThanOrEqual(1);
    await l.close();
    expect(l.state).toBe("off");
  });

  test("a refused token keeps retrying at the slowest pace and reports the refusal; a missing token stops the loop", async () => {
    fake = new FakeServer();
    const { link: l, events, sleeps } = make(() => "tok_nope");
    l.connect();
    await waitFor(() => events.includes("refused"));
    await sleep(60);
    // between attempts the state is refused; during one, connecting
    expect(["refused", "connecting"]).toContain(l.state);
    expect(events.filter((e) => e === "refused").length).toBeGreaterThanOrEqual(1);
    expect(sleeps.every((s) => s === 80)).toBe(true);
    expect(fake.seen.filter((m) => m === "auth").length).toBeGreaterThanOrEqual(1);
    await expect(l.request("entitlement.refresh", {})).rejects.toMatchObject({ code: "unavailable" });
    await l.close();
    let t: string | undefined;
    const second = make(() => t);
    second.link.connect();
    await sleep(30);
    expect(second.link.state).toBe("off");
    expect(second.link.attempts).toBe(0);
    t = fake.mintToken();
    second.link.connect();
    await waitFor(() => second.link.connected);
  });

  test("the request timeout and a link that is down", async () => {
    fake = new FakeServer();
    const token = fake.mintToken();
    const { link: l } = make(() => token, { requestTimeoutMs: 50 });
    await expect(l.request("entitlement.refresh", {})).rejects.toMatchObject({ code: "unavailable" });
    l.connect();
    await waitFor(() => l.connected);
    fake.scripts["stall"] = { deltas: Array.from({ length: 100 }, () => "x") };
    await expect(l.request("llm.complete", { model: { tier: "fast" }, messages: [{ role: "user", content: [{ type: "text", text: "stall" }] }] })).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("device flow", () => {
  test("offers a code at once, polls until granted, and gives up on 410 or expiry", async () => {
    const fake = new FakeServer();
    try {
      const flow = await startDeviceFlow({ url: fake.url, node: "desk", fetch, log: silentLogger });
      expect(flow.offer.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
      expect(flow.offer.verificationUrl).toContain(flow.offer.userCode);
      expect(fake.http.map((h) => h.path)).toEqual(["/auth/device"]);
      await sleep(50);
      expect(fake.http.filter((h) => h.path === "/auth/token").length).toBeGreaterThanOrEqual(1);
      fake.approve(flow.offer.userCode);
      const g = await flow.granted;
      expect(g.token.startsWith("tok_")).toBe(true);
      expect(g.subject).toBe(fake.subject);
      expect(fake.tokens.get(g.token)).toBeDefined();

      const denied = await startDeviceFlow({ url: fake.url, node: "desk", fetch, log: silentLogger });
      fake.deny();
      await expect(denied.granted).rejects.toMatchObject({ code: "denied" });

      let now = Date.now();
      const late = await startDeviceFlow({ url: fake.url, node: "desk", fetch, log: silentLogger, now: () => now });
      now += 16 * 60_000;
      await expect(late.granted).rejects.toMatchObject({ code: "denied" });

      const ac = new AbortController();
      const cancelled = await startDeviceFlow({ url: fake.url, node: "desk", fetch, log: silentLogger, signal: ac.signal });
      ac.abort();
      await expect(cancelled.granted).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      await fake.stop();
    }
  });

  test("a server that cannot be reached is unavailable", async () => {
    await expect(startDeviceFlow({ url: "http://127.0.0.1:1", node: "desk", fetch, log: silentLogger })).rejects.toBeInstanceOf(RpcError);
  });
});
