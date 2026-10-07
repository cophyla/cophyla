// `agentmsg`: agent messaging. Every agent session, on any harness and any node, is given the
// `cophyla-agents` MCP server (the native shim, `apps/mcp`), which hands each line it is sent to
// `/mcp/agents` here. This module speaks MCP for it: it tells who is calling (`caller.ts`),
// lists the user's other agent sessions (`directory.ts`), and sends a message to one.
//
// Everything is routed by the primary, since a secondary cannot reach another secondary: a
// node in no cluster routes its own; a secondary passes its sessions' calls up the node link
// (`agent.list`, `agent.send`), which the primary serves only for a session that node holds,
// and only as far as the node's grant may message. A message is checked against the limits
// (`limits.ts`), gated as `{kind: harness, session}` (`agent.send`, which a built-in rule
// allows and the user's rules may deny), and delivered through the receiving harness's own
// way in, in its envelope (`envelope.ts`): here, or by forwarding `session.send` as `agent` to
// the node that owns the session. There, a message from a session that prompts into one that
// runs without prompts is asked about too (`agent.escalate`), unless the session is a Claude
// one that holds such a message itself. Whatever waits on the user is answered at once as
// held, and delivered once they allow it; a denial or an expiry comes back to the sender as a
// notice in the same envelope, from cophyla, so it never waits for an answer that will not come.

import { AGENT_MCP_INSTRUCTIONS, AGENT_MCP_SERVER, AGENT_TOOLS, AgentMessageId, mayMessage, newId, nodeLinkRequests, RpcError } from "@cophyla/protocol";
import type { Access, AgentListing, AgentMode, AgentRef, Ask, NodeRecord, Session } from "@cophyla/protocol";
import type { Gate } from "../gate/index.ts";
import type { Logger } from "../log.ts";
import type { SendOptions } from "../sessions/index.ts";
import { identify, senderBypasses } from "./caller.ts";
import type { CallerLookup, Evidence } from "./caller.ts";
import { agentRef, directory, eligible, folderOf, listing, listingText, resolve } from "./directory.ts";
import type { Directory, DirectoryEntry } from "./directory.ts";
import type { EnvelopeInfo } from "./envelope.ts";
import { Limits } from "./limits.ts";
import type { LimitsConfig } from "./limits.ts";

export type { Evidence } from "./caller.ts";

/** `[agent_messages]`. */
export interface AgentMessagesConfig extends LimitsConfig {
  enabled: boolean;
}

/** What the module needs of this node's sessions. */
export interface AgentSessions extends CallerLookup {
  /** This node's own live sessions: never a workspace node's, never the chat's own. */
  list(): Session[];
  get(id: string): Session | undefined;
  send(id: string, text: string, opts: SendOptions): Promise<{ status: "queued" | "held"; ref?: string }>;
  /** Whether a session of this node runs with no permission prompts; undefined when it cannot be told. */
  bypasses(id: string): boolean | undefined;
  /** Whether a Claude session takes any session's message in at once, which one that bypasses otherwise holds. */
  acceptsInbound(id: string): boolean;
}

/** What it needs of the cluster. */
export interface AgentCluster {
  /** Whether this node routes agents' messages itself: it is the primary, or in no cluster. */
  routes(): boolean;
  /** The primary's name, for the words when it cannot be reached. */
  primaryName(): string | undefined;
  /** Whether this secondary's link to its primary is up. */
  primaryLinked(): boolean;
  mirrorSessions(): Session[];
  ownerOfSession(id: string): string | undefined;
  nodes(): NodeRecord[];
  linked(node: string): boolean;
  forward(node: string, method: string, params: unknown, opts: { onPending?: (ask: Ask) => void; timeoutMs?: number }): Promise<unknown>;
  requestPrimary(method: string, params: unknown, opts: { timeoutMs?: number }): Promise<unknown>;
  /** A grant this node keeps, by id: a linked node's, whose access says how far its sessions may message. */
  grant(id: string): { access: Access } | undefined;
}

export interface AgentMessagesDeps {
  config: () => AgentMessagesConfig;
  self: () => { id: string; name: string };
  sessions: AgentSessions;
  cluster: AgentCluster;
  gate: Gate;
  log: Logger;
  version: string;
  /** The bypass switch: lets agents' messages into this node's Claude sessions that run without prompts, or takes that back. */
  accept?: (on: boolean) => void;
  now?: () => number;
}

/** What a send is answered: delivered as far as cophylad can tell, held in the receiving terminal, or waiting on the user. */
export interface SendAnswer {
  status: "sent" | "held" | "pending";
  id: string;
  to: AgentRef;
  ask?: string;
}

/** A send's text as the audit row and an ask keep it. */
const AUDIT_TEXT = 2000;
/** How long an upward request may take; a send is answered at once, held or not. */
const UPWARD_MS = 30_000;
/** The sessions the router remembers having listed, so a message to one whose machine went away says so. */
const KNOWN = 500;
const PROTOCOL = "2025-06-18";

type Json = Record<string, unknown>;

function cap(text: string, n = AUDIT_TEXT): string {
  return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const HARNESS_WORDS: Record<string, string> = { claude: "Claude Code", codex: "Codex", muse: "Muse", acp: "ACP" };

export class AgentMessages {
  private deps: AgentMessagesDeps;
  private log: Logger;
  readonly limits: Limits;
  /** Where each session listed lately ran, and the names it answered to: a node that leaves takes its rows from the mirror. */
  private known = new Map<string, { node: string; nodeName: string; forms: string[] }>();

  constructor(deps: AgentMessagesDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.limits = new Limits(() => deps.config(), deps.now ?? Date.now);
  }

  // --- the MCP server -------------------------------------------------------------------------

  /** One JSON-RPC message from a session's shim: its answer, or undefined for a notification. */
  async mcp(evidence: Evidence, raw: unknown): Promise<Json | undefined> {
    const m = (raw ?? {}) as { id?: unknown; method?: unknown; params?: Json };
    if (typeof m.method !== "string") return undefined;
    const id = m.id;
    const answers = id !== undefined && id !== null;
    const ok = (result: unknown): Json => ({ jsonrpc: "2.0", id, result });
    switch (m.method) {
      case "initialize":
        return ok({
          protocolVersion: typeof m.params?.["protocolVersion"] === "string" ? m.params["protocolVersion"] : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: AGENT_MCP_SERVER, version: this.deps.version },
          instructions: AGENT_MCP_INSTRUCTIONS,
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: AGENT_TOOLS });
      case "tools/call": {
        const name = String(m.params?.["name"] ?? "");
        const args = (m.params?.["arguments"] ?? {}) as Json;
        const meta = m.params?.["_meta"] as Json | undefined;
        const r = await this.call(name, args, meta, evidence);
        return ok({ content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) });
      }
      default:
        if (!answers || m.method.startsWith("notifications/")) return undefined;
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${m.method}` } };
    }
  }

  /** A tool call, as the model reads its answer. */
  private async call(name: string, args: Json, meta: Json | undefined, evidence: Evidence): Promise<{ text: string; isError?: boolean }> {
    if (name !== "list_agents" && name !== "send_message") return { text: `cophyla-agents has no tool ${name}`, isError: true };
    if (!this.deps.config().enabled) return { text: "Agent messaging is off on this machine ([agent_messages] enabled = false); nothing was sent.", isError: true };
    const who = identify(evidence, meta, this.deps.sessions);
    if ("error" in who) {
      this.log.warn("an agent's call refused: its caller is not known", { tool: name, harness: evidence.harness, error: who.error });
      return { text: `${who.error}.`, isError: true };
    }
    const caller = who.session;
    try {
      if (name === "list_agents") return { text: listingText(await this.listFrom(caller)) };
      const to = typeof args["to"] === "string" ? args["to"].trim() : "";
      const text = typeof args["text"] === "string" ? args["text"] : "";
      const replyTo = args["reply_to"];
      if (!to) return { text: "send_message needs to: the name list_agents gives the session.", isError: true };
      if (!text.trim()) return { text: "send_message needs text: the message.", isError: true };
      if (replyTo !== undefined && replyTo !== "" && !AgentMessageId.safeParse(replyTo).success) return { text: "reply_to is the id (pmsg_…) of the message you are answering, from its envelope.", isError: true };
      const mode: AgentMode = senderBypasses(meta, this.deps.sessions.bypasses(caller.id)) ? "bypass" : "prompting";
      const answer = await this.sendFrom(caller, mode, { to, text, ...(typeof replyTo === "string" && replyTo !== "" ? { replyTo } : {}) });
      return { text: answerText(answer) };
    } catch (e) {
      return { text: refusalText(e), isError: true };
    }
  }

  /** The directory as `caller` sees it, from here or from the primary. */
  private async listFrom(caller: Session): Promise<AgentListing[]> {
    if (this.deps.cluster.routes()) return this.list(caller);
    const r = await this.upward("agent.list", { caller: caller.id });
    return nodeLinkRequests["agent.list"].result.parse(r).agents;
  }

  private async sendFrom(caller: Session, mode: AgentMode, p: { to: string; text: string; replyTo?: string }): Promise<SendAnswer> {
    if (this.deps.cluster.routes()) return this.send(caller, mode, p);
    const r = await this.upward("agent.send", { caller: caller.id, mode, ...p });
    return nodeLinkRequests["agent.send"].result.parse(r);
  }

  /** One request to the primary's router; what it refuses comes back as it said it. */
  private async upward(method: "agent.list" | "agent.send", params: unknown): Promise<unknown> {
    const noLink = () => new RpcError("unavailable", `this machine has no link to ${this.deps.cluster.primaryName() ?? "the primary"}, which carries agents' messages, so nothing was sent`);
    if (!this.deps.cluster.primaryLinked()) throw noLink();
    try {
      return await this.deps.cluster.requestPrimary(method, params, { timeoutMs: UPWARD_MS });
    } catch (e) {
      // the link went while the request was out
      if (e instanceof RpcError && e.code === "unavailable" && !this.deps.cluster.primaryLinked()) throw noLink();
      throw e;
    }
  }

  // --- the router (the primary, or a node in no cluster) ---------------------------------------

  /** Every live agent session of the cluster, with the machine it runs on. */
  private directory(): Directory {
    const self = this.deps.self();
    const nodes = new Map(this.deps.cluster.nodes().map((n) => [n.id, n]));
    const entries: DirectoryEntry[] = [];
    const seen = new Set<string>();
    for (const s of this.deps.sessions.list()) {
      if (!eligible(s, undefined)) continue;
      seen.add(s.id);
      entries.push({ session: s, nodeName: self.name });
    }
    for (const s of this.deps.cluster.mirrorSessions()) {
      if (seen.has(s.id) || s.node === self.id) continue;
      const node = nodes.get(s.node);
      if (!eligible(s, node)) continue;
      seen.add(s.id);
      entries.push({ session: s, nodeName: node?.name ?? s.node });
    }
    const d = directory(entries);
    for (const e of d.entries) {
      this.known.delete(e.session.id);
      this.known.set(e.session.id, { node: e.session.node, nodeName: e.nodeName, forms: [e.session.id.toLowerCase(), ...(d.aliases.get(e.session.id)?.forms ?? [])] });
    }
    while (this.known.size > KNOWN) this.known.delete(this.known.keys().next().value!);
    return d;
  }

  /** The machine a session `to` named ran on, when it is one the router listed and that machine is not linked now. */
  private offline(to: string): string | undefined {
    const key = to.trim().toLowerCase();
    const self = this.deps.self().id;
    for (const k of this.known.values()) {
      if (k.node !== self && k.forms.includes(key) && !this.deps.cluster.linked(k.node)) return k.nodeName;
    }
    return undefined;
  }

  /** The directory as `caller` sees it: everyone but itself. */
  async list(caller: Session): Promise<AgentListing[]> {
    return this.deps.gate.run({ principal: { kind: "harness", session: caller.id }, action: "agent.list", args: {}, sessionKey: caller.id }, () => {
      const d = this.directory();
      return d.entries.filter((e) => e.session.id !== caller.id).map((e) => listing(d, e));
    });
  }

  /**
   * A message from `caller` to the session `to` names: refused for what it may not be, then
   * gated, then delivered. Answered as soon as it is delivered, held in the receiving terminal,
   * or waiting on the user; one that waits is delivered once allowed, and its sender is told
   * when it is not. `access` is the grant of the node it came up from, when it did.
   */
  async send(caller: Session, mode: AgentMode, p: { to: string; text: string; replyTo?: string }, access?: Access): Promise<SendAnswer> {
    const d = this.directory();
    const fromEntry = d.entries.find((e) => e.session.id === caller.id) ?? { session: caller, nodeName: this.nameOf(caller.node) };
    const found = resolve(d, p.to);
    if ("error" in found) {
      const away = this.offline(p.to);
      throw away !== undefined ? new RpcError("unavailable", `${away} is offline; not sent`) : new RpcError("not_found", found.error);
    }
    const target = found;
    if (target.session.id === caller.id) throw new RpcError("invalid", "that is this session: send_message reaches another one");
    const from = agentRef(d, fromEntry);
    const to = agentRef(d, target);
    const { hops, reply } = this.limits.hops(caller.id, p.replyTo);
    if (access && !mayMessage(access, reply ? "reply" : "initiate")) {
      throw new RpcError("denied", access.messages === "none" ? `${from.nodeName}'s access lets its sessions send no messages` : `${from.nodeName}'s access lets its sessions answer messages, not start a conversation`);
    }
    const why = this.limits.check(caller.id, target.session.id, to.alias, p.text, hops);
    if (why) throw new RpcError("denied", why);
    if (target.session.node !== this.deps.self().id && !this.deps.cluster.linked(target.session.node)) throw new RpcError("unavailable", `${to.nodeName} is offline; not sent`);
    const id = newId("agentMessage");
    this.limits.record(id, caller.id, target.session.id, p.text, hops);
    const agent: EnvelopeInfo & { mode: AgentMode } = { from, messageId: id, ...(p.replyTo ? { replyTo: p.replyTo } : {}), mode };

    let held: (ask: Ask) => void = () => undefined;
    const pending = new Promise<Ask>((r) => (held = r));
    const work = this.deps.gate.run(
      {
        principal: { kind: "harness", session: caller.id },
        action: "agent.send",
        target: target.session.id,
        args: { to: to.alias, text: cap(p.text), ...(p.replyTo ? { replyTo: p.replyTo } : {}), id },
        sessionKey: caller.id,
        ask: { title: `Let ${from.alias} (${HARNESS_WORDS[from.harness] ?? from.harness} on ${from.nodeName}) message ${to.alias}?`, detail: cap(p.text) },
      },
      () => this.deliver(target.session, p.text, agent, held),
      { onPending: (ask) => held(ask) },
    );
    const first = await Promise.race([work.then((r) => ({ done: r })), pending.then((ask) => ({ ask }))]);
    if ("ask" in first) {
      this.log.info("agent message held for the user", { id, from: caller.id, to: target.session.id, ask: first.ask.id });
      work.then(
        () => this.log.info("agent message delivered once allowed", { id, to: target.session.id }),
        (e: unknown) => {
          this.log.info("agent message not delivered", { id, to: target.session.id, error: message(e) });
          void this.notice(caller, id, to, e);
        },
      );
      return { status: "pending", id, to, ask: first.ask.id };
    }
    this.log.info("agent message sent", { id, from: caller.id, to: target.session.id, status: first.done.status, hops });
    return { status: first.done.status === "held" ? "held" : "sent", id, to };
  }

  /** Delivers to the session wherever it is: here, or by its node, gated there too. */
  private async deliver(target: Session, text: string, agent: EnvelopeInfo & { mode?: AgentMode }, onPending: (ask: Ask) => void): Promise<{ status: "queued" | "held"; ref?: string }> {
    if (target.node === this.deps.self().id) return this.deliverHere(target.id, text, agent, onPending);
    const name = this.nameOf(target.node);
    if (!this.deps.cluster.linked(target.node)) throw new RpcError("unavailable", `${name} is offline; not sent`);
    try {
      return (await this.deps.cluster.forward(target.node, "session.send", { id: target.id, text, as: "agent", agent }, { onPending })) as { status: "queued" | "held"; ref?: string };
    } catch (e) {
      if (e instanceof RpcError && e.code === "unavailable") throw new RpcError("unavailable", `${name} is offline; not sent`);
      throw e;
    }
  }

  /**
   * Delivers to a session of this node: what the router does for its own, and what a node does
   * with a message forwarded to it. A message from a session that prompts, into one that runs
   * without prompts, is asked about first (the parity rule), unless the session is a Claude one
   * that holds such a message in its own terminal: asking twice would be wrong.
   */
  async deliverHere(targetId: string, text: string, agent: EnvelopeInfo & { mode?: AgentMode }, onPending?: (ask: Ask) => void): Promise<{ status: "queued" | "held"; ref?: string }> {
    const s = this.deps.sessions.get(targetId);
    if (!s || s.status === "ended") throw new RpcError("not_found", "that session has ended; not sent");
    if (agent.from && agent.mode !== "bypass" && this.deps.sessions.bypasses(targetId) === true) {
      const claudeHolds = s.harness === "claude" && !this.deps.sessions.acceptsInbound(targetId);
      if (!claudeHolds) {
        const where = `${HARNESS_WORDS[s.harness] ?? s.harness}${folderOf(s.cwd) ? ` in ${folderOf(s.cwd)}` : ""}`;
        await this.deps.gate.run(
          {
            principal: { kind: "harness", session: agent.from.session },
            action: "agent.escalate",
            target: targetId,
            args: { from: agent.from.alias, text: cap(text), id: agent.messageId },
            sessionKey: agent.from.session,
            ask: { title: `Let ${agent.from.alias}, which asks before it acts, message ${where}, which runs without asking?`, detail: cap(text) },
          },
          () => undefined,
          onPending ? { onPending: (ask) => onPending(ask) } : {},
        );
      }
    }
    const { mode: _mode, ...info } = agent;
    return this.deps.sessions.send(targetId, text, { from: "agent", agent: info });
  }

  /** Tells the sender, in its own session, that its message was not delivered. */
  private async notice(caller: Session, id: string, to: AgentRef, e: unknown): Promise<void> {
    const why = e instanceof RpcError && e.code === "denied" ? "the user did not allow it" : e instanceof RpcError && e.code === "timeout" ? "no one answered the approval in time" : e instanceof RpcError && e.code === "cancelled" ? "its approval was withdrawn" : message(e);
    const text = `Your message ${id} to ${to.alias} was not delivered: ${why}.`;
    try {
      await this.deliver(caller, text, { messageId: newId("agentMessage"), replyTo: id }, () => undefined);
    } catch (err) {
      this.log.warn("an agent's notice could not be delivered", { session: caller.id, id, error: message(err) });
    }
  }

  // --- served upward, on the primary ----------------------------------------------------------

  /**
   * A secondary's `agent.list` or `agent.send` for one of its sessions: refused for a session
   * the primary does not hold as that node's, and a send as far as the node's grant may
   * message; gated as the session, never as the node.
   */
  async upwardRequest(peer: { id: string; grant?: string }, method: "agent.list" | "agent.send", params: unknown): Promise<unknown> {
    if (!this.deps.config().enabled) throw new RpcError("unavailable", "agent messaging is off on the primary");
    if (method === "agent.list") {
      const parsed = nodeLinkRequests["agent.list"].params.safeParse(params ?? {});
      if (!parsed.success) throw new RpcError("invalid", "bad agent.list", parsed.error.issues);
      return { agents: await this.list(this.callerOf(peer, parsed.data.caller)) };
    }
    const parsed = nodeLinkRequests["agent.send"].params.safeParse(params ?? {});
    if (!parsed.success) throw new RpcError("invalid", "bad agent.send", parsed.error.issues);
    const p = parsed.data;
    const caller = this.callerOf(peer, p.caller);
    const grant = peer.grant !== undefined ? this.deps.cluster.grant(peer.grant) : undefined;
    if (!grant) throw new RpcError("denied", "the node's grant is not known here");
    return this.send(caller, p.mode, { to: p.to, text: p.text, ...(p.replyTo !== undefined ? { replyTo: p.replyTo } : {}) }, grant.access);
  }

  private callerOf(peer: { id: string }, id: string): Session {
    const s = this.deps.cluster.ownerOfSession(id) === peer.id ? this.deps.cluster.mirrorSessions().find((x) => x.id === id) : undefined;
    if (!s || s.status === "ended") throw new RpcError("denied", `${id} is not a live session of the asking node`);
    return s;
  }

  /** The bypass switch, from an app here or on the primary. */
  setAccept(on: boolean): void {
    if (!this.deps.accept) throw new RpcError("unsupported", "this node has no Claude profiles to set");
    this.deps.accept(on);
  }

  private nameOf(node: string): string {
    if (node === this.deps.self().id) return this.deps.self().name;
    return this.deps.cluster.nodes().find((n) => n.id === node)?.name ?? node;
  }
}

/** A send's answer, as the model reads it. */
export function answerText(a: SendAnswer): string {
  switch (a.status) {
    case "sent":
      return `Sent to ${a.to.alias} (${a.id}). Its answer, if any, comes to you as a <cophyla-message>; do not wait for it.`;
    case "held":
      return `Held in ${a.to.alias}'s terminal (${a.id}): that session runs without permission prompts, so Claude Code asks its user before it takes a message from a session that does not. It is delivered once they allow it.`;
    case "pending":
      return `Waiting for the user's approval (${a.id}) before it reaches ${a.to.alias}. It is delivered once they allow it; if they do not, you will be told.`;
  }
}

function refusalText(e: unknown): string {
  const text = message(e);
  const why = text.endsWith(".") ? text.slice(0, -1) : text;
  return /not sent|nothing was sent|not delivered/.test(why) ? `${why}.` : `Not sent: ${why}.`;
}
