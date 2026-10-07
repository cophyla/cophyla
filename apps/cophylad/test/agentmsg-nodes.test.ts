// Agent messaging across nodes, three daemons: a session on one secondary lists the cluster's
// agents and messages a session on another through the primary. The message lands there as
// the first session's turn, gated on the primary as that session and on its node as the
// primary's node; the answer comes back the same way, carrying what it answers; and once the
// second node is gone, a message to its session fails at once. The ingress itself is the hook
// token's and loopback's.

import { afterEach, describe, expect, test } from "bun:test";
import type { AuditEntry, Session } from "@cophyla/protocol";
import { waitFor } from "./helpers.ts";
import { linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
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

  test("the ingress answers the hook token on loopback alone, and nothing to a notification", async () => {
    primary = await startPrimary();
    const url = `http://127.0.0.1:${primary.d.api.port}/mcp/agents`;
    const post = (token: string, message: unknown) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ evidence: { harness: "claude", env: { CLAUDE_PID: "1" } }, message }) });
    expect((await post("wrong", { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    const list = await post(primary.d.hookToken, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)).toEqual(["list_agents", "send_message"]);
    expect((await post(primary.d.hookToken, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(204);
    const call = await post(primary.d.hookToken, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_agents", arguments: {} } });
    expect(((await call.json()) as { result: { isError: boolean; content: { text: string }[] } }).result).toMatchObject({ isError: true, content: [{ text: "Cophyla can't tell which session you are, so nothing was sent." }] });
  }, 30_000);
});
