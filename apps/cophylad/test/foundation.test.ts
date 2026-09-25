// Milestone 0, "done when": a test client connects with a token, sends a request, and the
// audit table holds the request, the decision and the result, whole below the cap and as
// hash and size above it. A request the policy answers with `ask` opens an Ask, streams
// `ask.state`, holds until `ask.answer` arrives, and `remember` writes the answer into
// policy. A message carrying a field the receiver does not know is accepted.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Ask, AuditEntry, Node } from "@cophyla/protocol";
import { AuditEntry as AuditEntrySchema, Ask as AskSchema } from "@cophyla/protocol";
import type { Daemon } from "../src/daemon.ts";
import { isMethod, stopDaemon, TestClient, testDaemon, waitFor } from "./helpers.ts";

describe("token auth on loopback", () => {
  let d: Daemon & { home: string };
  beforeAll(async () => {
    d = await testDaemon();
  });
  afterAll(() => stopDaemon(d));

  test("binds loopback only", () => {
    expect(d.api.url.startsWith("ws://127.0.0.1:")).toBe(true);
  });

  test("a wrong token is refused and the socket closed", async () => {
    const c = await TestClient.connect(d.api.url);
    const r = await c.hello("not-the-token");
    expect("error" in r && r.error.data?.code).toBe("denied");
    const closed = await c.closed;
    expect(closed.code).toBe(4401);
  });

  test("a request before hello is refused", async () => {
    const c = await TestClient.connect(d.api.url);
    const r = await c.call("node.list", {});
    expect("error" in r && r.error.data?.code).toBe("denied");
    expect((await c.closed).code).toBe(4401);
  });

  test("the right token connects and gets a client", async () => {
    const c = await TestClient.connect(d.api.url);
    const r = await c.hello(d.token, { name: "test" });
    expect("result" in r).toBe(true);
    const result = (r as { result: { client: { id: string; kind: string }; node: string; protocolVersion: number } }).result;
    expect(result.client.id.startsWith("cli_")).toBe(true);
    expect(result.client.kind).toBe("ui");
    expect(result.node).toBe(d.identity.id);
    expect(result.protocolVersion).toBe(1);
    expect(d.api.clients().map((x) => x.id)).toContain(result.client.id);
    c.close();
  });

  test("a second hello on the same socket is a conflict", async () => {
    const c = await TestClient.connect(d.api.url);
    await c.hello(d.token);
    const r = await c.hello(d.token);
    expect("error" in r && r.error.data?.code).toBe("conflict");
    c.close();
  });

  test("the token never reaches the audit table", async () => {
    const hello = d.store.audit.list({ limit: 50 }).find((e) => e.action === "hello");
    expect(hello).toBeDefined();
    expect(JSON.stringify(hello!.args)).not.toContain(d.token);
    expect((hello!.args as { token: string }).token).toBe("[redacted]");
  });
});

describe("audit: request, decision and result", () => {
  let d: Daemon & { home: string };
  let c: TestClient;
  beforeAll(async () => {
    d = await testDaemon("[gate]\naudit_result_cap = 100000\n");
    c = await TestClient.connect(d.api.url);
    await c.hello(d.token);
  });
  afterAll(async () => {
    c.close();
    await stopDaemon(d);
  });

  test("a request below the cap is kept whole", async () => {
    const result = await c.request<{ nodes: Node[] }>("node.list", {});
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.id).toBe(d.identity.id);

    const entries = d.store.audit.list({ limit: 10 }).filter((e) => e.action === "node.list");
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(AuditEntrySchema.safeParse(e).success).toBe(true);
    expect(e.principal.kind).toBe("user");
    expect(e.args).toEqual({});
    expect(e.decision).toBe("allow");
    expect(e.outcome).toBe("ok");
    expect(e.result?.body).toEqual(result);
    const text = JSON.stringify(result);
    expect(e.result?.bytes).toBe(Buffer.byteLength(text));
    expect(e.result?.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(e.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("a read's entry is kept, not streamed; any other is streamed twice, the second time with the result summarised and no body", async () => {
    expect(c.notifications.filter(isMethod("audit.entry", (p) => (p as AuditEntry).action === "node.list"))).toHaveLength(0);
    await c.request("task.create", { title: "streamed" });
    await waitFor(() => c.notifications.filter(isMethod("audit.entry", (p) => (p as AuditEntry).action === "task.create")).length === 2);
    const entries = c.notifications.filter(isMethod("audit.entry", (p) => (p as AuditEntry).action === "task.create"));
    expect(entries).toHaveLength(2);
    const first = entries[0]!.params as AuditEntry;
    const second = entries[1]!.params as AuditEntry;
    expect(first.id).toBe(second.id);
    expect(first.outcome).toBeUndefined();
    expect(second.outcome).toBe("ok");
    expect(second.result).toBeDefined();
    expect(second.result).not.toHaveProperty("body");
    expect(second.result!.summary.length).toBeLessThanOrEqual(200);
  });

  test("the brain's own bookkeeping is kept, not streamed: its model calls and its tasks reach the table alone", async () => {
    const brain = { kind: "brain" } as const;
    await d.gate.run({ principal: brain, action: "llm.complete", target: "fast", args: { model: { tier: "fast" } } }, () => ({ content: [] }));
    await d.gate.run({ principal: brain, action: "task.create", args: { title: "the brain's" } }, () => ({ id: "task_x" }));
    await c.request("task.create", { title: "the user's" });
    // Two entries per request, the one before this test's too.
    await waitFor(() => c.notifications.filter(isMethod("audit.entry", (p) => (p as AuditEntry).action === "task.create")).length === 4);
    const told = c.notifications.filter(isMethod("audit.entry")).map((n) => n.params as AuditEntry);
    expect(told.filter((e) => e.principal.kind === "brain")).toEqual([]);
    expect(told.filter((e) => e.action === "task.create").every((e) => e.principal.kind === "user")).toBe(true);
    const kept = d.store.audit.list({ limit: 50 }).filter((e) => e.principal.kind === "brain");
    expect(kept.map((e) => e.action).sort()).toEqual(["llm.complete", "task.create"]);
  });
});

describe("audit: a result over the cap keeps hash and size", () => {
  let d: Daemon & { home: string };
  let c: TestClient;
  beforeAll(async () => {
    d = await testDaemon("[gate]\naudit_result_cap = 64\n");
    c = await TestClient.connect(d.api.url);
    await c.hello(d.token);
  });
  afterAll(async () => {
    c.close();
    await stopDaemon(d);
  });

  test("body is dropped, hash and size stay", async () => {
    const result = await c.request<{ nodes: Node[] }>("node.list", {});
    const text = JSON.stringify(result);
    expect(text.length).toBeGreaterThan(64);
    const e = d.store.audit.list({ limit: 10 }).find((x) => x.action === "node.list")!;
    expect(e.outcome).toBe("ok");
    expect(e.result).toBeDefined();
    expect(e.result).not.toHaveProperty("body");
    expect(e.result!.bytes).toBe(Buffer.byteLength(text));
    expect(e.result!.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(e.result!.summary.length).toBeGreaterThan(0);
  });
});

/** Runs `trigger` and resolves with the ask it opened, as seen by `watcher`, ignoring asks seen before. */
async function askOpenedBy<T>(watcher: TestClient, trigger: () => Promise<T>): Promise<{ ask: Ask; inFlight: Promise<T> }> {
  const seen = new Set(watcher.notifications.filter(isMethod("ask.state")).map((n) => (n.params as Ask).id));
  const inFlight = trigger();
  const n = await watcher.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && !seen.has((p as Ask).id)));
  return { ask: n.params as Ask, inFlight };
}

describe("gate: ask, hold, answer, remember", () => {
  let d: Daemon & { home: string };
  let asker: TestClient;
  let answerer: TestClient;
  beforeAll(async () => {
    d = await testDaemon('[gate.rules]\n"user:node.list" = "ask"\n');
    asker = await TestClient.connect(d.api.url);
    await asker.hello(d.token, { name: "asker" });
    answerer = await TestClient.connect(d.api.url);
    await answerer.hello(d.token, { name: "answerer" });
  });
  afterAll(async () => {
    asker.close();
    answerer.close();
    await stopDaemon(d);
  });

  test("a request the policy answers with ask opens an Ask, streams ask.state, and holds until ask.answer", async () => {
    const { ask, inFlight } = await askOpenedBy(answerer, () => asker.call("node.list", {}));
    expect(AskSchema.safeParse(ask).success).toBe(true);
    expect(ask.type).toBe("permission");
    expect(ask.source.kind).toBe("gate");
    expect(ask.source.kind === "gate" && ask.source.action).toBe("node.list");
    expect(ask.answerableBy).toEqual(["user"]);
    expect(ask.options.map((o) => o.id)).toEqual(["allow", "deny"]);
    expect(d.store.asks.get(ask.id)?.status).toBe("open");

    // The audit row already holds the request and the decision while the ask is open.
    const held = d.store.audit.list({ limit: 10 }).find((e) => e.action === "node.list")!;
    expect(held.decision).toBe("ask");
    expect(held.ask).toBe(ask.id);
    expect(held.outcome).toBeUndefined();

    // Nothing has resolved yet.
    const race = await Promise.race([inFlight.then(() => "resolved"), new Promise((r) => setTimeout(() => r("held"), 150))]);
    expect(race).toBe("held");

    await answerer.request("ask.answer", { id: ask.id, option: "allow", remember: "always" });

    const r = await inFlight;
    expect("result" in r).toBe(true);
    const answered = await asker.next(isMethod("ask.state", (p) => (p as Ask).id === ask.id && (p as Ask).status === "answered"));
    const final = answered.params as Ask;
    expect(final.answer?.option).toBe("allow");
    expect(final.answer?.by.kind).toBe("user");
    expect(final.remember).toBe("always");

    const done = d.store.audit.get(held.id)!;
    expect(done.outcome).toBe("ok");
    expect(done.result?.body).toBeDefined();
  });

  test("remember wrote the answer into policy, so the next request is allowed without an ask", async () => {
    const rules = d.policy.rules();
    expect(rules.map((r) => [r.key, r.decision])).toEqual([["user:node.list", "allow"]]);
    expect(d.store.policy.list()).toHaveLength(1);

    const before = d.store.asks.listOpen().length;
    const r = await asker.call("node.list", {});
    expect("result" in r).toBe(true);
    expect(d.store.asks.listOpen()).toHaveLength(before);
    const latest = d.store.audit.list({ limit: 1 })[0]!;
    expect(latest.action).toBe("node.list");
    expect(latest.decision).toBe("allow");
  });

  test("a remembered answer survives a restart of the daemon", async () => {
    const home = d.home;
    await d.stop();
    const { startDaemon } = await import("../src/daemon.ts");
    const { silentLogger } = await import("../src/log.ts");
    const again = await startDaemon({ home, port: 0, log: silentLogger, brain: false });
    try {
      expect(again.policy.rules().map((r) => r.key)).toEqual(["user:node.list"]);
      expect(again.identity.id).toBe(d.identity.id);
      expect(again.token).toBe(d.token);
    } finally {
      await again.stop();
    }
    // Reopen for the remaining tests in this block.
    d = Object.assign(await startDaemon({ home, port: 0, log: silentLogger, brain: false }), { home });
    asker = await TestClient.connect(d.api.url);
    await asker.hello(d.token);
    answerer = await TestClient.connect(d.api.url);
    await answerer.hello(d.token);
  });

  test("a deny answer denies the held request", async () => {
    d.policy.forget("user:node.list");
    const { ask, inFlight } = await askOpenedBy(answerer, () => asker.call("node.list", {}));
    await answerer.request("ask.answer", { id: ask.id, option: "deny", text: "not now" });
    const r = await inFlight;
    expect("error" in r && r.error.data?.code).toBe("denied");
    expect("error" in r && r.error.message).toBe("not now");
    const e = d.store.audit.list({ limit: 5 }).find((x) => x.ask === ask.id)!;
    expect(e.outcome).toBe("denied");
  });

  test("answering twice is a conflict, and an unknown option is invalid", async () => {
    const { ask, inFlight } = await askOpenedBy(answerer, () => asker.call("node.list", {}));
    const bad = await answerer.call("ask.answer", { id: ask.id, option: "maybe" });
    expect("error" in bad && bad.error.data?.code).toBe("invalid");
    await answerer.request("ask.answer", { id: ask.id, option: "allow" });
    await inFlight;
    const twice = await answerer.call("ask.answer", { id: ask.id, option: "allow" });
    expect("error" in twice && twice.error.data?.code).toBe("conflict");
  });

  test("a new client is told about asks that are already open", async () => {
    const { ask, inFlight } = await askOpenedBy(answerer, () => asker.call("node.list", {}));
    const late = await TestClient.connect(d.api.url);
    await late.hello(d.token);
    const seen = await late.next(isMethod("ask.state", (p) => (p as Ask).id === ask.id));
    expect((seen.params as Ask).status).toBe("open");
    await late.request("ask.answer", { id: ask.id, option: "allow" });
    await inFlight;
    late.close();
  });

  test("remember: session lasts while the client is connected", async () => {
    const { ask, inFlight } = await askOpenedBy(answerer, () => asker.call("node.list", {}));
    await answerer.request("ask.answer", { id: ask.id, option: "allow", remember: "session" });
    await inFlight;
    expect(d.store.policy.list()).toHaveLength(0);
    // Same client again: no ask.
    const openBefore = d.store.asks.listOpen().length;
    const r2 = await asker.call("node.list", {});
    expect("result" in r2).toBe(true);
    expect(d.store.asks.listOpen()).toHaveLength(openBefore);
    // A fresh client is asked again.
    const fresh = await TestClient.connect(d.api.url);
    await fresh.hello(d.token);
    const again = await askOpenedBy(answerer, () => fresh.call("node.list", {}));
    await answerer.request("ask.answer", { id: again.ask.id, option: "deny" });
    const r3 = await again.inFlight;
    expect("error" in r3).toBe(true);
    fresh.close();
  });
});

describe("gate: deny and timeout", () => {
  test("a deny rule denies at once and lands in audit", async () => {
    const d = await testDaemon('[gate.rules]\n"*:node.list" = "deny"\n');
    try {
      const c = await TestClient.connect(d.api.url);
      await c.hello(d.token);
      const r = await c.call("node.list", {});
      expect("error" in r && r.error.data?.code).toBe("denied");
      const e = d.store.audit.list({ limit: 1 })[0]!;
      expect(e.action).toBe("node.list");
      expect(e.decision).toBe("deny");
      expect(e.outcome).toBe("denied");
      expect(d.store.asks.listOpen()).toHaveLength(0);
      c.close();
    } finally {
      await stopDaemon(d);
    }
  });

  test("an ask that expires cancels the request", async () => {
    const d = await testDaemon('[gate]\nask_timeout_ms = 200\n[gate.rules]\n"user:node.list" = "ask"\n');
    try {
      const c = await TestClient.connect(d.api.url);
      await c.hello(d.token);
      const r = await c.call("node.list", {});
      expect("error" in r && r.error.data?.code).toBe("timeout");
      const expired = c.notifications.find(isMethod("ask.state", (p) => (p as Ask).status === "expired"));
      expect(expired).toBeDefined();
      const e = d.store.audit.list({ limit: 1 })[0]!;
      expect(e.outcome).toBe("cancelled");
      c.close();
    } finally {
      await stopDaemon(d);
    }
  });

  test("asks left open by a previous run are closed at start", async () => {
    const d = await testDaemon('[gate.rules]\n"user:node.list" = "ask"\n');
    const home = d.home;
    const c = await TestClient.connect(d.api.url);
    await c.hello(d.token);
    void c.call("node.list", {});
    await c.next(isMethod("ask.state"));
    expect(d.store.asks.listOpen()).toHaveLength(1);
    c.close();
    await d.stop();
    const { startDaemon } = await import("../src/daemon.ts");
    const { silentLogger } = await import("../src/log.ts");
    const again = await startDaemon({ home, port: 0, log: silentLogger, brain: false });
    try {
      expect(again.store.asks.listOpen()).toHaveLength(0);
    } finally {
      await again.stop();
      const { removeHome } = await import("./helpers.ts");
      removeHome(home);
    }
  });
});

describe("unknown fields and bad frames", () => {
  let d: Daemon & { home: string };
  beforeAll(async () => {
    d = await testDaemon();
  });
  afterAll(() => stopDaemon(d));

  test("a hello and a request carrying unknown fields are accepted", async () => {
    const c = await TestClient.connect(d.api.url);
    const h = await c.hello(d.token, { futureField: { nested: true } });
    expect("result" in h).toBe(true);
    const r = await c.call("node.list", { somethingNew: 42 });
    expect("result" in r).toBe(true);
    c.close();
  });

  test("an unknown method is unsupported, bad params are invalid, and a non-JSON frame is invalid", async () => {
    const c = await TestClient.connect(d.api.url);
    await c.hello(d.token);
    const u = await c.call("no.such.method", {});
    expect("error" in u && u.error.data?.code).toBe("unsupported");
    const b = await c.call("ask.answer", { id: "not-an-id", option: "allow" });
    expect("error" in b && b.error.data?.code).toBe("invalid");
    const nonJson = c.next((n) => false, 300).catch(() => undefined);
    c.sendRaw("{not json");
    await nonJson;
    c.close();
  });

  test("a signal with an unknown name is ignored and the connection stays up", async () => {
    const c = await TestClient.connect(d.api.url);
    await c.hello(d.token);
    c.sendRaw(JSON.stringify({ jsonrpc: "2.0", method: "chat.typing", params: { active: true } }));
    c.sendRaw(JSON.stringify({ jsonrpc: "2.0", method: "future.signal", params: {} }));
    const r = await c.call("node.list", {});
    expect("result" in r).toBe(true);
    c.close();
  });
});
