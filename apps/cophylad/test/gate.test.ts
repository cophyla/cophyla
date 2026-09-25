// The gate at the module level, with no socket: policy precedence, control actions,
// principals, the abort signal, and the audit of errors thrown by a handler.

import { describe, expect, test } from "bun:test";
import { RpcError } from "@cophyla/protocol";
import type { Ask, AuditEntry, Principal } from "@cophyla/protocol";
import { Bus } from "../src/bus.ts";
import { Config } from "../src/config/schema.ts";
import { Asks } from "../src/gate/asks.ts";
import { Audit, describeResult, redact, summarise, toldToClients } from "../src/gate/audit.ts";
import { Gate } from "../src/gate/index.ts";
import { Policy, parseRuleKey, ruleKey } from "../src/gate/policy.ts";
import { silentLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";
import { waitFor } from "./helpers.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const brain: Principal = { kind: "brain" };
const user: Principal = { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" };

function harness(toml = "") {
  const config = Config.parse(Bun.TOML.parse(toml));
  const store = new Store(":memory:");
  store.migrate();
  const bus = new Bus();
  const asks = new Asks(store, NODE, bus);
  const audit = new Audit(store, NODE, config.gate.audit_result_cap, bus);
  const policy = new Policy(config.gate, store);
  const gate = new Gate({ config: config.gate, policy, asks, audit, log: silentLogger });
  const askStates: Ask[] = [];
  const auditEntries: AuditEntry[] = [];
  bus.on("ask.state", (a) => askStates.push(a));
  bus.on("audit.entry", (e) => auditEntries.push(e));
  return { config, store, bus, asks, audit, policy, gate, askStates, auditEntries };
}

describe("policy precedence", () => {
  test("class default per principal kind", () => {
    const { policy } = harness();
    expect(policy.decide({ principal: "user", action: "session.send", risk: "write" }).decision).toBe("allow");
    expect(policy.decide({ principal: "brain", action: "session.send", risk: "write" }).decision).toBe("ask");
    expect(policy.decide({ principal: "brain", action: "session.list", risk: "read" }).decision).toBe("allow");
    expect(policy.decide({ principal: "node", action: "tool.run", risk: "exec" }).decision).toBe("ask");
  });

  test("the brain's own conversation is allowed by a built-in rule; a config rule beats it", () => {
    const { policy } = harness();
    expect(policy.decide({ principal: "brain", action: "ui.say", risk: "write" })).toMatchObject({ decision: "allow", source: "builtin.rule", rule: "brain:ui.say" });
    expect(policy.decide({ principal: "brain", action: "llm.complete", risk: "network" })).toMatchObject({ decision: "allow", source: "builtin.rule" });
    expect(policy.decide({ principal: "brain", action: "task.update", risk: "write" }).decision).toBe("allow");
    expect(policy.decide({ principal: "brain", action: "session.stop", risk: "exec" })).toMatchObject({ decision: "ask", source: "config.class" });
    expect(policy.decide({ principal: "user", action: "ui.say", risk: "write" })).toMatchObject({ decision: "allow", source: "config.class" });
    const strict = harness('[gate.rules]\n"brain:llm.complete" = "ask"\n');
    expect(strict.policy.decide({ principal: "brain", action: "llm.complete", risk: "network" })).toMatchObject({ decision: "ask", source: "config.rule" });
  });

  test("the brain starts a session without asking, unless config puts the ask back; a forwarded start still asks the node", () => {
    const { policy } = harness();
    expect(policy.decide({ principal: "brain", action: "session.spawn", risk: "exec", target: "ws_1" })).toMatchObject({ decision: "allow", source: "builtin.rule", rule: "brain:session.spawn" });
    expect(policy.decide({ principal: "node", action: "session.spawn", risk: "exec", target: "ws_1" })).toMatchObject({ decision: "ask", source: "config.class" });
    const strict = harness('[gate.rules]\n"brain:session.spawn" = "ask"\n');
    expect(strict.policy.decide({ principal: "brain", action: "session.spawn", risk: "exec" })).toMatchObject({ decision: "ask", source: "config.rule" });
    const trusting = harness('[gate.rules]\n"node:session.spawn" = "allow"\n');
    expect(trusting.policy.decide({ principal: "node", action: "session.spawn", risk: "exec" })).toMatchObject({ decision: "allow", source: "config.rule" });
  });

  test("the brain messages a session it started without asking; any other session still asks, and config beats both", () => {
    const { policy } = harness();
    expect(policy.decide({ principal: "brain", action: "session.send", risk: "write", target: "sess_1", own: true })).toMatchObject({ decision: "allow", source: "builtin.rule", rule: "brain:session.send" });
    expect(policy.decide({ principal: "brain", action: "session.send", risk: "write", target: "sess_1" })).toMatchObject({ decision: "ask", source: "config.class" });
    // The brain's own rules only: a node forwarding a message is not the brain.
    expect(policy.decide({ principal: "node", action: "session.send", risk: "write", own: true })).toMatchObject({ decision: "ask", source: "config.class" });
    const strict = harness('[gate.rules]\n"brain:session.send" = "ask"\n');
    expect(strict.policy.decide({ principal: "brain", action: "session.send", risk: "write", own: true })).toMatchObject({ decision: "ask", source: "config.rule" });
  });

  test("a config rule beats the class default, a target rule beats an action rule", () => {
    const { policy } = harness('[gate.rules]\n"brain:session.send" = "allow"\n"brain:tool.run@my.deploy" = "deny"\n"*:remote.open" = "deny"\n');
    expect(policy.decide({ principal: "brain", action: "session.send", risk: "write" })).toMatchObject({ decision: "allow", source: "config.rule", rule: "brain:session.send" });
    expect(policy.decide({ principal: "brain", action: "tool.run", risk: "exec", target: "my.deploy" })).toMatchObject({ decision: "deny", rule: "brain:tool.run@my.deploy" });
    expect(policy.decide({ principal: "brain", action: "tool.run", risk: "exec", target: "fs.read" }).decision).toBe("ask");
    expect(policy.decide({ principal: "user", action: "remote.open", risk: "exec" })).toMatchObject({ decision: "deny", rule: "*:remote.open" });
  });

  test("a remembered answer beats a config rule, a session answer beats a remembered one", () => {
    const { policy, store } = harness('[gate.rules]\n"brain:session.send" = "ask"\n');
    policy.remember({ principal: "brain", action: "session.send" }, "allow", "always", user);
    expect(policy.decide({ principal: "brain", action: "session.send", risk: "write" })).toMatchObject({ decision: "allow", source: "remembered" });
    expect(store.policy.list()[0]).toMatchObject({ key: "brain:session.send", decision: "allow", createdBy: user });

    policy.remember({ principal: "brain", action: "session.send", sessionKey: "brain-1" }, "deny", "session", user);
    expect(policy.decide({ principal: "brain", action: "session.send", risk: "write", sessionKey: "brain-1" })).toMatchObject({ decision: "deny", source: "session" });
    expect(policy.decide({ principal: "brain", action: "session.send", risk: "write", sessionKey: "brain-2" }).decision).toBe("allow");
    policy.forgetSession("brain-1");
    expect(policy.decide({ principal: "brain", action: "session.send", risk: "write", sessionKey: "brain-1" }).decision).toBe("allow");
  });

  test("control actions and the system principal are always allowed", () => {
    const { policy } = harness('[gate.rules]\n"*:ask.answer" = "deny"\n');
    expect(policy.decide({ principal: "brain", action: "ask.answer", risk: "write", control: true }).source).toBe("control");
    expect(policy.decide({ principal: "system", action: "anything", risk: "exec" }).source).toBe("system");
  });

  test("rule keys round-trip", () => {
    expect(parseRuleKey(ruleKey("brain", "tool.run", "my.deploy"))).toEqual({ principal: "brain", action: "tool.run", target: "my.deploy" });
    expect(parseRuleKey("*:node.list")).toEqual({ principal: "*", action: "node.list" });
    expect(() => parseRuleKey("nope")).toThrow();
  });
});

describe("gate.run", () => {
  test("allow runs the handler and audits the result", async () => {
    const { gate, store, auditEntries } = harness();
    const out = await gate.run({ principal: brain, action: "session.list", args: { filter: {} } }, () => ({ sessions: [] }));
    expect(out).toEqual({ sessions: [] });
    const e = store.audit.list()[0]!;
    expect(e).toMatchObject({ principal: brain, action: "session.list", decision: "allow", outcome: "ok" });
    expect(e.result?.body).toEqual({ sessions: [] });
    expect(auditEntries).toHaveLength(2);
    expect(auditEntries[1]!.result).not.toHaveProperty("body");
  });

  test("a handler error is audited as error and rethrown", async () => {
    const { gate, store } = harness();
    await expect(gate.run({ principal: brain, action: "session.list", args: {} }, () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const e = store.audit.list()[0]!;
    expect(e.outcome).toBe("error");
    expect(e.result?.body).toEqual({ error: "boom" });
  });

  test("an unknown action with no risk is unsupported and never runs", async () => {
    const { gate, store } = harness();
    let ran = false;
    await expect(gate.run({ principal: brain, action: "made.up", args: {} }, () => { ran = true; })).rejects.toBeInstanceOf(RpcError);
    expect(ran).toBe(false);
    expect(store.audit.count()).toBe(0);
  });

  test("tool.run takes the tool's own risk", async () => {
    const { gate, store } = harness();
    // exec would ask for the brain; a read tool is allowed.
    await gate.run({ principal: brain, action: "tool.run", target: "fs.read", args: {}, risk: "read" }, () => "ok");
    expect(store.audit.list()[0]).toMatchObject({ decision: "allow", target: "fs.read" });
  });

  test("ask: pending is reported, the request holds, and an answer releases it", async () => {
    const { gate, asks, askStates, store } = harness();
    let pendingAsk: Ask | undefined;
    const run = gate.run(
      { principal: brain, action: "session.send", target: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1", args: { text: "hi" }, sessionKey: "brain-1" },
      () => "sent",
      { onPending: (ask) => (pendingAsk = ask) },
    );
    await Bun.sleep(10);
    expect(pendingAsk).toBeDefined();
    expect(pendingAsk!.title).toContain("the brain");
    expect(askStates[0]!.status).toBe("open");
    expect(asks.listOpen()).toHaveLength(1);

    // The brain may not answer a gate ask about its own request.
    expect(() => asks.answer(pendingAsk!.id, { option: "allow" }, brain)).toThrow(RpcError);

    asks.answer(pendingAsk!.id, { option: "allow", remember: "session" }, user);
    expect(await run).toBe("sent");
    expect(store.audit.list()[0]).toMatchObject({ decision: "ask", ask: pendingAsk!.id, outcome: "ok" });

    // Remembered for the session: the same principal and key is not asked again.
    const again = await gate.run({ principal: brain, action: "session.send", target: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1", args: {}, sessionKey: "brain-1" }, () => "sent again");
    expect(again).toBe("sent again");
    expect(asks.listOpen()).toHaveLength(0);
    expect(store.policy.list()).toHaveLength(0);
  });

  test("ask: an abort signal cancels the ask and the request", async () => {
    const { gate, asks, store } = harness();
    const ctl = new AbortController();
    const run = gate.run({ principal: brain, action: "session.send", args: {} }, () => "never", { signal: ctl.signal });
    await Bun.sleep(10);
    expect(asks.listOpen()).toHaveLength(1);
    ctl.abort();
    await expect(run).rejects.toMatchObject({ code: "cancelled" });
    expect(asks.listOpen()).toHaveLength(0);
    expect(store.audit.list()[0]!.outcome).toBe("cancelled");
  });

  test("ask: words for the ask can be supplied", async () => {
    const { gate, asks } = harness();
    const run = gate.run({ principal: brain, action: "session.send", args: {}, ask: { title: "Send to the agent?", detail: "run the tests" } }, () => "ok");
    await Bun.sleep(10);
    const [ask] = asks.listOpen();
    expect(ask).toMatchObject({ title: "Send to the agent?", detail: "run the tests" });
    asks.answer(ask!.id, { option: "deny" }, user);
    await expect(run).rejects.toMatchObject({ code: "denied" });
  });
});

describe("asks: what an answer may carry", () => {
  const base = {
    type: "choice" as const,
    source: { kind: "brain" as const },
    title: "Which?",
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    answerableBy: ["user" as const],
  };
  const answer = (asks: Asks, id: string, input: Parameters<Asks["answer"]>[1]) => asks.answer(id, input, user);
  const invalid = (asks: Asks, id: string, input: Parameters<Asks["answer"]>[1]) =>
    expect(() => answer(asks, id, input)).toThrow(expect.objectContaining({ code: "invalid" }));

  test("single: a declared option, or text under the reserved id when text is allowed", () => {
    const { asks } = harness();
    invalid(asks, asks.open(base).id, { option: "c" });
    invalid(asks, asks.open(base).id, { option: "c", text: "note" });
    invalid(asks, asks.open(base).id, { option: "text", text: "free" });
    invalid(asks, asks.open({ ...base, allowsText: true }).id, { option: "text" });
    invalid(asks, asks.open(base).id, { option: "a", options: ["a", "b"] });
    expect(answer(asks, asks.open(base).id, { option: "a", text: "with a note" }).answer).toMatchObject({ option: "a", text: "with a note" });
    expect(answer(asks, asks.open(base).id, { option: "a", options: ["a"] }).answer).not.toHaveProperty("options");
    const free = answer(asks, asks.open({ ...base, allowsText: true }).id, { option: "text", text: "free" }).answer!;
    expect(free).toMatchObject({ option: "text", text: "free" });
    expect(free).not.toHaveProperty("options");
  });

  test("multiple: every id declared and `option` first; text alone only when allowed", () => {
    const { asks } = harness();
    const multi = { ...base, multiple: true };
    const picked = answer(asks, asks.open(multi).id, { option: "b", options: ["b", "a"] }).answer!;
    expect(picked).toMatchObject({ option: "b", options: ["b", "a"] });
    expect(answer(asks, asks.open(multi).id, { option: "a" }).answer).toMatchObject({ option: "a", options: ["a"] });
    invalid(asks, asks.open(multi).id, { option: "a", options: ["b", "a"] });
    invalid(asks, asks.open(multi).id, { option: "a", options: ["a", "c"] });
    invalid(asks, asks.open(multi).id, { option: "a", options: ["a", "a"] });
    invalid(asks, asks.open(multi).id, { option: "a", options: [] });
    invalid(asks, asks.open(multi).id, { option: "text", options: ["text", "a"], text: "x" });
    invalid(asks, asks.open(multi).id, { option: "text", text: "x" });
    expect(answer(asks, asks.open({ ...multi, allowsText: true }).id, { option: "text", text: "x" }).answer).toMatchObject({ option: "text", options: ["text"], text: "x" });
    expect(answer(asks, asks.open({ ...multi, allowsText: true }).id, { option: "a", options: ["a", "b"], text: "and more" }).answer).toMatchObject({ options: ["a", "b"], text: "and more" });
  });

  test("a declared option literally named text answers as itself", () => {
    const { asks } = harness();
    const literal = { ...base, options: [{ id: "text", label: "text" }], allowsText: true };
    expect(answer(asks, asks.open(literal).id, { option: "text" }).answer).toMatchObject({ option: "text" });
    expect(answer(asks, asks.open({ ...literal, multiple: true }).id, { option: "text" }).answer).toMatchObject({ options: ["text"] });
  });
});

describe("audit helpers", () => {
  test("redact hides credential-shaped keys at any depth", () => {
    expect(redact({ token: "x", nested: [{ password: "y", ok: 1 }], Authorization: "z" })).toEqual({ token: "[redacted]", nested: [{ password: "[redacted]", ok: 1 }], Authorization: "[redacted]" });
    expect(redact("plain")).toBe("plain");
  });

  test("redact hides a pairing pin, an invite's code and passphrase, and the secret query values of a link", () => {
    expect(redact({ node: "n", pin: "4821", name: "laptop" })).toEqual({ node: "n", pin: "[redacted]", name: "laptop" });
    const invite = { otp: "2357", passphrase: "cophyla-7f3a", link: "art://192.168.1.44:47989?pin=2357&passphrase=cophyla-7f3a&name=study", expiresAt: 1 };
    expect(redact(invite)).toEqual({ otp: "[redacted]", passphrase: "[redacted]", link: "art://192.168.1.44:47989?pin=[redacted]&passphrase=[redacted]&name=study", expiresAt: 1 });
    // a screenshot, as a result or inside a model call, is kept as its size, never as the picture
    const shot = { image: { mime: "image/jpeg", base64: "A".repeat(4000) }, width: 640, height: 360 };
    expect(redact(shot)).toEqual({ image: { mime: "image/jpeg", base64: "[3000 bytes]" }, width: 640, height: 360 });
    const call = { messages: [{ role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "screenshot" }, { type: "image", mime: "image/jpeg", base64: "QUJD" }] }] };
    expect(JSON.stringify(redact(call))).toContain(`"base64":"[3 bytes]"`);
    // a stream page's ticket is a key while it lives; a `t` elsewhere is not
    expect(redact("https://h:4818/remote/?t=abc&token=xyz")).toBe("https://h:4818/remote/?t=[redacted]&token=[redacted]");
    expect(redact({ url: "https://h:4818/remote/?t=0123abcd" })).toEqual({ url: "https://h:4818/remote/?t=[redacted]" });
    expect(redact("https://example.com/watch?v=1&t=42")).toBe("https://example.com/watch?v=1&t=42");
    // prose with an equals sign is not a URL and is left alone
    expect(redact("pin=1234 is what the screen says")).toBe("pin=1234 is what the screen says");
  });

  test("redact hides TURN credentials, keeps a session description as its size, and a stream ticket in a bare path", () => {
    const info = { iceServers: [{ urls: ["stun:s:3478"] }, { urls: ["turn:t:3478"], username: "u123", credential: "c456" }], expiresAt: 1 };
    expect(redact(info)).toEqual({ iceServers: [{ urls: ["stun:s:3478"] }, { urls: ["turn:t:3478"], username: "[redacted]", credential: "[redacted]" }], expiresAt: 1 });
    expect(redact({ sdp: "v=0\r\na=candidate:1 1 udp 1 192.168.1.44 5000 typ host\r\n", epk: "k" })).toEqual({ sdp: "[55 characters]", epk: "k" });
    expect(redact({ path: "/remote/?t=0123abcd", transport: "webrtc" })).toEqual({ path: "/remote/?t=[redacted]", transport: "webrtc" });
    expect(redact("/remote/stream.html?hostId=1&appId=2")).toBe("/remote/stream.html?hostId=1&appId=2");
  });

  test("a result is redacted like the arguments before it is kept", async () => {
    const h = harness();
    await h.gate.run({ principal: user, action: "remote.invite", args: { node: NODE } }, () => ({ otp: "2357", link: "art://h:47989?pin=2357&passphrase=p&name=n" }));
    const row = h.store.audit.list({ limit: 5 }).find((e) => e.action === "remote.invite")!;
    expect(row.result!.body).toEqual({ otp: "[redacted]", link: "art://h:47989?pin=[redacted]&passphrase=[redacted]&name=n" });
    expect(row.result!.summary).not.toContain("2357");
  });

  test("an ask carries the words the method gave it", async () => {
    const h = harness('[gate.rules]\n"brain:remote.pair" = "ask"\n');
    const run = h.gate.run({ principal: brain, action: "remote.pair", target: "laptop", args: { node: NODE, pin: "1234", name: "laptop" }, ask: { title: "Let laptop view and control this desktop?", detail: "the screen" } }, () => ({}));
    await waitFor(() => h.askStates.find((a) => a.status === "open"));
    const ask = h.askStates.find((a) => a.status === "open")!;
    expect(ask.title).toBe("Let laptop view and control this desktop?");
    expect(ask.detail).toBe("the screen");
    h.asks.answer(ask.id, { option: "deny" }, user);
    await expect(run).rejects.toMatchObject({ code: "denied" });
  });

  test("summarise collapses whitespace and caps length", () => {
    expect(summarise("a\n  b\tc")).toBe("a b c");
    expect(summarise("x".repeat(500)).length).toBe(200);
  });

  test("describeResult keeps the body only at or under the cap", () => {
    const small = describeResult({ a: 1 }, 100);
    expect(small.body).toEqual({ a: 1 });
    expect(small.bytes).toBe(7);
    const big = describeResult({ a: "x".repeat(200) }, 100);
    expect(big).not.toHaveProperty("body");
    expect(big.sha256).toHaveLength(64);
    expect(describeResult(undefined, 10).body).toBeNull();
  });
});

describe("what clients are told", () => {
  test("a read and the brain's bookkeeping stay in the table; the brain's reach beyond it, a refusal and anything a person did are told", async () => {
    const h = harness('[gate.rules]\n"brain:session.focus" = "allow"\n"brain:memory.write" = "deny"\n');
    await h.gate.run({ principal: brain, action: "llm.complete", target: "fast", args: {} }, () => ({}));
    await h.gate.run({ principal: brain, action: "ui.say", args: {} }, () => ({}));
    await h.gate.run({ principal: brain, action: "annotate", target: "thr_1", args: {} }, () => ({}));
    await h.gate.run({ principal: brain, action: "session.list", args: {} }, () => ({}));
    await h.gate.run({ principal: brain, action: "session.focus", target: "sess_1", args: {} }, () => ({}));
    await expect(h.gate.run({ principal: brain, action: "memory.write", args: {} }, () => ({}))).rejects.toMatchObject({ code: "denied" });
    await h.gate.run({ principal: user, action: "task.create", args: {} }, () => ({}));
    await h.gate.run({ principal: user, action: "chat.load", args: {} }, () => ({}));
    const told = [...new Set(h.auditEntries.filter(toldToClients).map((e) => `${e.principal.kind}:${e.action}`))];
    expect(told).toEqual(["brain:session.focus", "brain:memory.write", "user:task.create"]);
  });
});
