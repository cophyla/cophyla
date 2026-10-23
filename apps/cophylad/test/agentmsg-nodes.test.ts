// Agent messaging across nodes, three daemons: a session on one secondary lists the cluster's
// agents and messages a session on another through the primary. The message lands there as
// the first session's turn, gated on the primary as that session and on its node as the
// primary's node; the answer comes back the same way, carrying what it answers; and once the
// second node is gone, a message to its session fails at once. A session the user made the
// leader of another's speaks to it as the user, hears what it said, and answers its ask. The
// ingress itself is the hook token's and loopback's.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditEntry, Session } from "@cophyla/protocol";
import { waitFor } from "./helpers.ts";
import { client, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

let primary: Primary | undefined;
let alpha: Started | undefined;
let beta: Started | undefined;

afterEach(async () => {
  await stopAll(alpha, beta, primary?.d);
  primary = undefined;
  alpha = undefined;
  beta = undefined;
});

/** A session on `d`, started over ACP in its own home, idle once its first turn ends. */
async function spawnOn(d: Started): Promise<Session> {
  const ws = d.workspaces.put({ node: d.identity.id, path: d.home, name: "work" });
  const s = await d.sessions.spawn({ harness: "claude", workspace: ws.id, prompt: "say hi" }, { profiles: d.profiles });
  await waitFor(() => d.sessions.get(s.id)?.status === "idle", 10_000);
  return d.sessions.get(s.id)!;
}

/** A tool call as the session's own shim would hand it to its node. */
async function callAs(d: Started, s: Session, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const answer = (await d.agentMessages.mcp({ harness: "claude", ppid: s.native.pid! }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } })) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: answer.result.content[0]!.text, ...(answer.result.isError ? { isError: true } : {}) };
}

const agentTurns = (d: Started, s: Session) => d.store.sessionEvents.history(s.id, { limit: 200 }).filter((e) => e.kind === "user_turn" && (e.payload as { source?: string }).source === "agent");

describe("agent messages across nodes", () => {
  test("one secondary's session messages another's through the primary, is answered, and a gone node fails at once", async () => {
    primary = await startPrimary();
    alpha = await startSecondary(primary, { agent: true, node: 'name = "Alpha"\n' });
    beta = await startSecondary(primary, { agent: true, node: 'name = "Beta"\n' });
    await linked(alpha);
    await linked(beta);
    await waitFor(() => primary!.d.nodes.linkedTo(alpha!.identity.id) && primary!.d.nodes.linkedTo(beta!.identity.id));
    const a = await spawnOn(alpha);
    const b = await spawnOn(beta);
    await waitFor(() => primary!.d.nodes.mirror.ownerOfSession(a.id) === alpha!.identity.id && primary!.d.nodes.mirror.ownerOfSession(b.id) === beta!.identity.id, 10_000);

    // The directory comes from the primary: Beta's session is there, Alpha's own is not.
    const listed = await callAs(alpha, a, "list_agents", {});
    expect(listed.text).toContain("Claude Code on Beta");
    expect(listed.text).not.toContain("on Alpha");

    const sent = await callAs(alpha, a, "send_message", { to: b.id, text: "is the build green?" });
    expect(sent.isError).toBeUndefined();
    const id = /pmsg_[0-9A-Z]{26}/.exec(sent.text)![0];
    const turn = await waitFor(() => agentTurns(beta!, b)[0], 10_000);
    expect(turn.payload).toMatchObject({ source: "agent", messageId: id, text: "is the build green?", from: { session: a.id, node: alpha.identity.id, nodeName: "Alpha", harness: "claude" } });
    // Gated on the primary as the session, on Beta as the primary's node.
    const routed = primary.d.store.audit.list({ limit: 50 }).find((e: AuditEntry) => e.action === "agent.send")!;
    expect(routed).toMatchObject({ principal: { kind: "harness", session: a.id }, target: b.id, outcome: "ok" });
    const delivered = beta.store.audit.list({ limit: 50 }).find((e: AuditEntry) => e.action === "session.send")!;
    expect(delivered).toMatchObject({ principal: { kind: "node", id: primary.d.identity.id }, outcome: "ok" });
    expect(delivered.args).toMatchObject({ as: "agent", agent: { messageId: id, mode: "prompting" } });

    // The answer goes back by the sender's name, carrying what it answers.
    const from = (turn.payload as { from: { alias: string } }).from.alias;
    const reply = await callAs(beta, b, "send_message", { to: from, text: "green", reply_to: id });
    expect(reply.isError).toBeUndefined();
    const replyId = /pmsg_[0-9A-Z]{26}/.exec(reply.text)![0];
    const back = await waitFor(() => agentTurns(alpha!, a).find((e) => (e.payload as { replyTo?: string }).replyTo === id), 10_000);
    expect(back.payload).toMatchObject({ messageId: replyId, text: "green", from: { session: b.id, nodeName: "Beta" } });
    // A third message in the conversation is its third hop.
    expect(primary.d.agentMessages.limits.hops(a.id, replyId)).toEqual({ hops: 3, reply: true });

    // Beta goes: a message to its session fails at once, saying so.
    const betaId = beta.identity.id;
    await stopAll(beta);
    beta = undefined;
    await waitFor(() => !primary!.d.nodes.linkedTo(betaId), 10_000);
    const started = Date.now();
    const off = await callAs(alpha, a, "send_message", { to: b.id, text: "still there?" });
    expect(off).toEqual({ text: "Beta is offline; not sent.", isError: true });
    expect(Date.now() - started).toBeLessThan(2000);
  }, 60_000);

  test("one secondary's session sends a file to another's through the primary: asked about first, then told where it landed", async () => {
    primary = await startPrimary();
    alpha = await startSecondary(primary, { agent: true, node: 'name = "Alpha"\n' });
    beta = await startSecondary(primary, { agent: true, node: 'name = "Beta"\n' });
    await linked(alpha);
    await linked(beta);
    await waitFor(() => primary!.d.nodes.linkedTo(alpha!.identity.id) && primary!.d.nodes.linkedTo(beta!.identity.id));
    const a = await spawnOn(alpha);
    const b = await spawnOn(beta);
    await waitFor(() => primary!.d.nodes.mirror.ownerOfSession(a.id) === alpha!.identity.id && primary!.d.nodes.mirror.ownerOfSession(b.id) === beta!.identity.id, 10_000);
    mkdirSync(join(alpha.home, "out"), { recursive: true });
    writeFileSync(join(alpha.home, "out", "report.txt"), "all green");

    // the machines are listed for it, by name
    expect((await callAs(alpha, a, "list_agents", {})).text).toContain("Machines (send_file with to set to the name):");
    // the session prompts: the primary asks the user first
    const sending = callAs(alpha, a, "send_file", { path: "out/report.txt", to: b.id, dir: "inbox", reason: "Test results for review" });
    const ask = await waitFor(() => primary!.d.asks.listOpen().find((x) => x.title.startsWith("Let ")), 10_000);
    expect(ask.title).toMatch(/send report\.txt \(9 B\) to .+ on Beta\?$/);
    expect(ask.detail).toStartWith("Test results for review\n");
    primary.d.asks.answer(ask.id, { option: "allow" }, { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" });
    const sent = await sending;
    expect(sent.isError).toBeUndefined();
    const landed = join(beta.home, "inbox", "report.txt");
    expect(sent.text).toContain(`it landed at ${landed}.`);
    expect(readFileSync(landed, "utf8")).toBe("all green");
    // the receiving session hears where, from cophyla
    const told = await waitFor(() => beta!.store.sessionEvents.history(b.id, { limit: 200 }).find((e) => e.kind === "user_turn" && String((e.payload as { text?: string }).text ?? "").includes("sent you report.txt")), 10_000);
    expect((told.payload as { text: string }).text).toContain(landed);
    expect((told.payload as { text: string }).text).toContain('("Test results for review")');
    // the transfer was Beta's, started as the agent's with its reason, gated on Beta as the primary's node
    const row = beta.transfers.list()[0]!;
    expect(row).toMatchObject({ state: "done", reason: "Test results for review", by: { kind: "agent", session: a.id }, from: { node: alpha.identity.id } });
    // and the primary's apps see the reason in the row Beta lists
    await waitFor(() => primary!.d.nodes.mirror.transfers().find((t) => t.id === row.id && t.state === "done"), 10_000);
    expect(primary.d.nodes.mirror.transfers().find((t) => t.id === row.id)!.reason).toBe("Test results for review");
    expect(beta.store.audit.list({ limit: 50 }).find((e: AuditEntry) => e.action === "transfer.start")).toMatchObject({ principal: { kind: "node", id: primary.d.identity.id }, outcome: "ok" });
  }, 60_000);

  test("a group's tag reaches a secondary's session as a quiet notice, with none of the post's words; its own node decides how it goes", async () => {
    primary = await startPrimary();
    beta = await startSecondary(primary, { agent: true, node: 'name = "Beta"\n' });
    await linked(beta);
    await waitFor(() => primary!.d.nodes.linkedTo(beta!.identity.id));
    const b = await spawnOn(beta);
    await waitFor(() => primary!.d.nodes.mirror.ownerOfSession(b.id) === beta!.identity.id, 10_000);
    const g = await primary.d.groups.create({ name: "release", members: [{ session: b.id }] });
    const handle = g.members.find((m) => m.kind === "agent")!;
    await waitFor(() => agentTurns(beta!, b).some((e) => String((e.payload as { text?: string }).text ?? "").includes("put you in the group chat #release")), 10_000);
    await waitFor(() => beta!.sessions.get(b.id)?.status === "idle", 10_000);
    await primary.d.groups.postAsUser(g.id, `@${handle.kind === "agent" ? handle.handle : ""} is the schema merged?`);
    const notice = await waitFor(() => agentTurns(beta!, b).find((e) => String((e.payload as { text?: string }).text ?? "").includes("tagged you in #release")), 10_000);
    expect((notice.payload as { text: string }).text).not.toContain("schema");
    // forwarded quiet; a session started over ACP answers no hooks here, so it went as a message
    const sends = beta.store.audit.list({ limit: 50 }).filter((e: AuditEntry) => e.action === "session.send");
    expect(sends.map((e) => e.args)).toContainEqual(expect.objectContaining({ as: "agent", agent: expect.objectContaining({ group: expect.objectContaining({ name: "release" }), quiet: true }) }));
  });

  test("a leader on one secondary speaks as the user to a session on another, hears what it said, and answers its ask", async () => {
    primary = await startPrimary();
    alpha = await startSecondary(primary, { agent: true, node: 'name = "Alpha"\n' });
    beta = await startSecondary(primary, { agent: true, node: 'name = "Beta"\n' });
    await linked(alpha);
    await linked(beta);
    await waitFor(() => primary!.d.nodes.linkedTo(alpha!.identity.id) && primary!.d.nodes.linkedTo(beta!.identity.id));
    const a = await spawnOn(alpha);
    const b = await spawnOn(beta);
    await waitFor(() => primary!.d.nodes.mirror.ownerOfSession(a.id) === alpha!.identity.id && primary!.d.nodes.mirror.ownerOfSession(b.id) === beta!.identity.id, 10_000);
    // the user makes Alpha's session the leader of Beta's, from the primary's app
    const c = await client(primary.d);
    await c.request("lead.set", { speaker: a.id, targets: [b.id] });
    const listed = await callAs(alpha, a, "list_agents", {});
    expect(listed.text).toContain("led by you");

    const sent = await callAs(alpha, a, "send_message", { to: b.id, text: "Run the build and tell me if it is green." });
    expect(sent.isError).toBeUndefined();
    expect(sent.text).toContain("as your user's own words");
    // it lands on Beta as the user's turn, sent by Alpha's session; forwarded as a leader's, never an agent's
    const turn = await waitFor(() => beta!.store.sessionEvents.history(b.id, { limit: 200 }).find((e) => e.kind === "user_turn" && (e.payload as { source?: string }).source === "lead"), 10_000);
    expect(turn.payload).toMatchObject({ text: "Run the build and tell me if it is green.", by: { session: a.id, nodeName: "Alpha" } });
    expect(agentTurns(beta, b)).toEqual([]);
    const there = beta.store.audit.list({ limit: 50 }).find((e: AuditEntry) => e.action === "session.send" && (e.args as { as?: string }).as === "lead");
    expect(there?.principal).toEqual({ kind: "node", id: primary.d.identity.id });
    expect(primary.d.store.audit.list({ limit: 50 }).find((e: AuditEntry) => e.action === "agent.lead")?.principal).toEqual({ kind: "harness", session: a.id });
    // once Beta's session settles, what it said comes back to the leader in its envelope
    const back = await waitFor(() => agentTurns(alpha!, a).find((e) => (e.payload as { from?: { session?: string } }).from?.session === b.id), 15_000);
    expect((back.payload as { text: string }).text.length).toBeGreaterThan(0);

    // an ask of Beta's session is the leader's to answer as the user, through the primary to Beta
    const ask = beta.asks.open({ type: "permission", source: { kind: "harness", session: b.id }, title: "Run npm test?", options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }], answerableBy: ["user", "brain"] }, Date.now());
    await waitFor(() => primary!.d.nodes.mirror.ownerOfAsk(ask.id) === beta!.identity.id, 10_000);
    const answered = await callAs(alpha, a, "answer_ask", { ask: ask.id, option: "allow" });
    expect(answered.isError).toBeUndefined();
    expect(answered.text).toStartWith(`Answered ${ask.id} in `);
    expect(answered.text).toEndWith(" as your user: Allow.");
    await waitFor(() => beta!.asks.get(ask.id)?.status === "answered", 10_000);
    expect(beta.asks.get(ask.id)!.answer?.option).toBe("allow");
    c.close();
  }, 40_000);

  test("the bypass switch is set on the node an app on the primary names, and that node's row says so", async () => {
    primary = await startPrimary();
    alpha = await startSecondary(primary, { node: 'name = "Alpha"\n' });
    await linked(alpha);
    await waitFor(() => primary!.d.nodes.linkedTo(alpha!.identity.id));
    const c = await client(primary.d);
    try {
      expect(primary.d.nodes.registry.get(alpha.identity.id)?.capabilities.agents).toEqual({ acceptInBypass: false });
      await c.request("agents.accept", { node: alpha.identity.id, on: true });
      await waitFor(() => primary!.d.nodes.registry.get(alpha!.identity.id)?.capabilities.agents?.acceptInBypass === true, 5000);
      // kept on the node, gated there as the primary's node
      expect(alpha.store.kv.get("agentmsg", "accept_in_bypass")).toBe(true);
      expect(alpha.store.audit.list({ limit: 50 }).find((e: AuditEntry) => e.action === "agents.accept")).toMatchObject({ principal: { kind: "node", id: primary.d.identity.id }, outcome: "ok" });
      // and on the primary itself, for its own sessions
      await c.request("agents.accept", { on: true });
      expect(primary.d.nodes.self().capabilities.agents).toEqual({ acceptInBypass: true });
      await c.request("agents.accept", { on: false });
      expect(primary.d.nodes.self().capabilities.agents).toEqual({ acceptInBypass: false });
    } finally {
      c.close();
    }
  }, 30_000);

  test("the ingress answers the hook token on loopback alone, and nothing to a notification", async () => {
    primary = await startPrimary();
    const url = `http://127.0.0.1:${primary.d.api.port}/mcp/agents`;
    const post = (token: string, message: unknown) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ evidence: { harness: "claude", env: { CLAUDE_PID: "1" } }, message }) });
    expect((await post("wrong", { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    const list = await post(primary.d.hookToken, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)).toEqual(["list_agents", "send_message", "send_file", "create_invite", "accept_invite", "end_connection", "read_group", "post_group", "ack_post", "get_file", "focus", "answer_ask"]);
    expect((await post(primary.d.hookToken, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(204);
    const call = await post(primary.d.hookToken, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_agents", arguments: {} } });
    expect(((await call.json()) as { result: { isError: boolean; content: { text: string }[] } }).result).toMatchObject({ isError: true, content: [{ text: "Cophyla can't tell which session you are, so nothing was sent." }] });
  }, 30_000);
});
