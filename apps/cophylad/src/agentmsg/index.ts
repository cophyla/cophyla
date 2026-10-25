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
//
// A session the user made a leader (`leaders/`) speaks to the sessions of its group as the
// user: its message is checked against the limits as any is, gated as `agent.lead`, and typed
// into the session as the user's own words, past the parity ask, since the promotion is the
// user's consent. A session in focus gets it when its focus ends, typed before what else came,
// unless the leader sent it `past_focus`, which types it in at once as the user's own words
// would be. What the session does next comes back to the leader (`leaders/reports.ts`), and the
// leader may answer the session's asks as the user (`answer_ask`, gated as `agent.answer`). A
// session it leads that cannot take the user's words (one cophylad cannot type into, a machine
// with an older Cophyla) gets the message as another agent's, and the leader is told why.
//
// A tool's answer is text, and for `read_group` the photos of the posts it shows too, as MCP
// image content the harness hands its model. `send_file` reaches another person's agent through
// the files module (`peerfiles/`), and `get_file` copies a file posted in a group to the agent's
// own machine.

import { posix, win32 } from "node:path";
import { AGENT_MCP_INSTRUCTIONS, AGENT_MCP_SERVER, AGENT_TOOLS, AgentMessageId, ASK_TEXT_OPTION, AskId, GROUP_TOOLS, mayMessage, newId, nodeLinkRequests, RpcError } from "@cophyla/protocol";
import type { Access, AgentListing, AgentMode, AgentRef, Ask, AskOption, ConnectionListing, Focus, GroupToolName, MachineListing, NodeRecord, PeerSource, Session, TalkParty, TalkStatus, TeammateListing, Transfer, TransferBy, TransferConfirm } from "@cophyla/protocol";
import { Connections } from "../connections/index.ts";
import type { Groups, PhotoRef, ToolAnswer } from "../groups/index.ts";
import type { PeerFiles, PeerLink } from "../peerfiles/index.ts";
import type { Asks } from "../gate/asks.ts";
import type { Gate } from "../gate/index.ts";
import type { Leaders } from "../leaders/index.ts";
import type { Reports } from "../leaders/reports.ts";
import type { Logger } from "../log.ts";
import type { SendOptions } from "../sessions/index.ts";
import { leadCommand } from "../sessions/lead.ts";
import { reasonOf, sizeText } from "../transfers/index.ts";
import { identify, senderBypasses } from "./caller.ts";
import type { CallerLookup, Evidence } from "./caller.ts";
import { agentRef, directory, eligible, folderOf, listing, listingText, resolve, slug } from "./directory.ts";
import type { Directory, DirectoryEntry } from "./directory.ts";
import type { EnvelopeInfo } from "./envelope.ts";
import { clockTime, minutesLeft } from "./focus.ts";
import type { Focuses } from "./focus.ts";
import { Limits } from "./limits.ts";
import type { LimitsConfig } from "./limits.ts";
import { peerParty } from "./talk.ts";
import type { TalkLog } from "./talk.ts";

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
  /** An ask another node holds, as its mirror here has it. */
  mirrorAsk?(id: string): Ask | undefined;
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
  /** The connections to other users' terminals, on the node that routes. */
  connections?: () => Connections | undefined;
  /** The agents in focus, on the node that routes. */
  focus?: () => Focuses | undefined;
  /** The group chats, on the node that routes. */
  groups?: () => Groups | undefined;
  /** The teammates' agents, on the node that routes. */
  teammates?: () => AgentTeammates | undefined;
  /** Files to other people's agents, on the node that routes. */
  peerFiles?: () => PeerFiles | undefined;
  /** Sending files for an agent (`send_file`), on the node that routes. */
  files?: () => AgentFiles | undefined;
  /** For what only the user answers, never remembered: a big transfer through the relay. And this node's asks, which a leader answers as the user. */
  asks?: Pick<Asks, "open" | "wait" | "get" | "answer">;
  /** The leaders, on the node that routes. */
  leaders?: () => Leaders | undefined;
  /** What a session a leader messaged does next, told to the leader; on the node that routes. */
  reports?: () => Reports | undefined;
  /** The agents' conversations, which every message carried here goes into; on the node that routes. */
  talk?: () => TalkLog | undefined;
  /** How long a tool call waits for what it started before it answers and tells the outcome later. */
  toolWaitMs?: number;
  now?: () => number;
}

/** What the router needs to send a file for an agent: what a path holds, a transfer started where it goes, and its end. */
export interface AgentFiles {
  /** What `path` on `node` holds; refuses what is not there or may not be sent. */
  peek(node: string, path: string): Promise<{ kind: "file" | "folder"; name: string; total: number; files: number }>;
  /** Starts a transfer on the machine it goes to, here or forwarded there. */
  start(params: { from: { node: string; path: string }; to: { node: string; dir?: string }; reason?: string; relayOk?: boolean; by: TransferBy; notify?: string; peer?: PeerSource }): Promise<{ transfer?: Transfer; confirm?: TransferConfirm }>;
  /** The transfer once it has ended. */
  ended(id: string): Promise<Transfer>;
}

/** What the router needs of the teammates: their open agents as a session lists them, and a message to one. */
export interface AgentTeammates {
  /** The teammates' agents open to `caller` now, as their sides last said. */
  listing(caller: Session): Promise<TeammateListing[]>;
  /** Whether `to` names a teammate's agent: `<login>/<name>` with a teammate's login, or a `tm_` id. */
  names(to: string): boolean;
  /** A message from `caller` to a teammate's agent. */
  send(caller: Session, mode: AgentMode, p: { to: string; text: string; replyTo?: string }): Promise<{ status: "sent" | "held" | "queued" | "focus"; id: string; teammate: string; alias: string; focus?: Focus }>;
  /** The teammate's agent a file from `caller` goes to. */
  fileTarget(caller: Session, to: string): { link: PeerLink; name: string; alias: string };
}

/** A tool's answer as the model reads it: its words, whether it is a refusal, and images shown with it. */
interface CallAnswer {
  text: string;
  isError?: boolean;
  images?: { mime: string; data: string }[];
}

/** Where a `send_file` goes: a machine, and the agent session there it is for, when it is. */
interface Receiver {
  node: string;
  nodeName: string;
  agent?: AgentRef;
  /** The agent's folder, which a relative `dir` is under. */
  cwd?: string;
}

/**
 * What a send is answered: delivered as far as cophylad can tell, held in the receiving
 * terminal, or waiting on the user; on a connection, also kept until the other user's Cophyla
 * is reached (`queued`) or until an agent runs in its terminal (`waiting`).
 */
export interface SendAnswer {
  status: "sent" | "held" | "pending" | "queued" | "waiting" | "focus";
  id: string;
  to?: AgentRef;
  /** A message to another user's agent: on a connection, or a teammate's. */
  peer?: { connection?: string; teammate?: string; alias: string };
  ask?: string;
  /** The receiver's focus, while it holds the message. */
  focus?: Focus;
  /** It went as the user's own words: the sender leads the session. */
  asUser?: true;
  /** The sender leads the session, but it went as another agent's: why. */
  fallback?: string;
}

/** What a send is asked to do: `pastFocus`, a leader's words to a session it leads go in even while it is in focus. */
export interface SendParams {
  to: string;
  text: string;
  replyTo?: string;
  pastFocus?: boolean;
}

/** The connection tools, which a secondary's sessions call through the primary. */
const CONNECTION_TOOLS = new Set(["create_invite", "accept_invite", "end_connection"]);
/** The group tools and focus, which live on the primary too. */
const GROUP_TOOL_NAMES = new Set<string>(GROUP_TOOLS);

/** A send's text as the audit row and an ask keep it. */
const AUDIT_TEXT = 2000;
/** How long an upward request may take; a send is answered at once, held or not. */
const UPWARD_MS = 30_000;
/** How long a prompt waits on the primary for what its session has not read in its groups: a prompt is not held up for it. */
const NOTE_MS = 1_500;
/** How long `send_file` waits for its transfer to land before it answers, and tells the outcome later; an upward one a little longer. */
const FILE_WAIT_MS = 90_000;
const FILE_UPWARD_MS = 120_000;
/** How long the user has to answer a big transfer's way through the relay. */
const RELAY_ASK_MS = 5 * 60_000;
/** The sessions the router remembers having listed, so a message to one whose machine went away says so. */
const KNOWN = 500;
const PROTOCOL = "2025-06-18";

type Json = Record<string, unknown>;

/** A workspace node: hands, lending folders of another person's machine to this cluster. Files never go there. */
function lent(n: Pick<NodeRecord, "hands" | "scope">): boolean {
  return n.hands === true && n.scope.kind === "workspaces";
}

function cap(text: string, n = AUDIT_TEXT): string {
  return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Why a message that waited on the user never landed, as its sender is told. */
function notDelivered(e: unknown): string {
  if (e instanceof RpcError && e.code === "denied") return "the user did not allow it";
  if (e instanceof RpcError && e.code === "timeout") return "no one answered the approval in time";
  if (e instanceof RpcError && e.code === "cancelled") return "its approval was withdrawn";
  return message(e);
}

const HARNESS_WORDS: Record<string, string> = { claude: "Claude Code", codex: "Codex", muse: "Muse", acp: "ACP" };

/** An agent as its conversation's other end names it: its alias then, its harness, machine and folder. */
function partyOf(r: AgentRef): TalkParty & { session: string } {
  return { session: r.session, name: r.alias, harness: r.harness, machine: r.nodeName, ...(r.folder ? { folder: r.folder } : {}) };
}

export class AgentMessages {
  private deps: AgentMessagesDeps;
  private log: Logger;
  readonly limits: Limits;
  /** Where each session listed lately ran, and the names it answered to, a renamed one's old ones too: a node that leaves takes its rows from the mirror. */
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
        const images = (r.images ?? []).map((i) => ({ type: "image", data: i.data, mimeType: i.mime }));
        return ok({ content: [{ type: "text", text: r.text }, ...images], ...(r.isError ? { isError: true } : {}) });
      }
      default:
        if (!answers || m.method.startsWith("notifications/")) return undefined;
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${m.method}` } };
    }
  }

  /** A tool call, as the model reads its answer. */
  private async call(name: string, args: Json, meta: Json | undefined, evidence: Evidence): Promise<CallAnswer> {
    if (name !== "list_agents" && name !== "send_message" && name !== "send_file" && name !== "answer_ask" && !CONNECTION_TOOLS.has(name) && !GROUP_TOOL_NAMES.has(name)) return { text: `cophyla-agents has no tool ${name}`, isError: true };
    if (!this.deps.config().enabled) return { text: "Agent messaging is off on this machine ([agent_messages] enabled = false); nothing was sent.", isError: true };
    const who = identify(evidence, meta, this.deps.sessions);
    if ("error" in who) {
      this.log.warn("an agent's call refused: its caller is not known", { tool: name, harness: evidence.harness, error: who.error });
      return { text: `${who.error}.`, isError: true };
    }
    const caller = who.session;
    const r = await this.callAs(caller, name, args, meta);
    // what is unread in its groups rides along, said once: not beside a read, which shows it, nor focus
    if (r.isError || name === "read_group" || name === "focus") return r;
    const note = await this.promptNote(caller);
    return note ? { ...r, text: `${r.text}\n\n${note}` } : r;
  }

  /**
   * What `s` has not read in its group chats and was not told of yet, for the prompt its harness
   * is about to start a turn with (the prompt hook's added context) or a tool's answer: from the
   * groups here, or asked of the primary, which keeps them, for a moment only, since a prompt
   * waits on it. Marked told once given.
   */
  async promptNote(s: Session): Promise<string | undefined> {
    try {
      if (this.deps.cluster.routes()) return this.deps.groups?.()?.unreadNote(s.id, { consume: true });
      if (!this.deps.cluster.primaryLinked()) return undefined;
      const r = nodeLinkRequests["group.note"].result.parse(await this.upward("group.note", { caller: s.id }, NOTE_MS));
      return r.text;
    } catch (e) {
      this.log.debug("no group note for a prompt", { session: s.id, error: message(e) });
      return undefined;
    }
  }

  private async callAs(caller: Session, name: string, args: Json, meta: Json | undefined): Promise<CallAnswer> {
    if (CONNECTION_TOOLS.has(name)) {
      const mode: AgentMode = senderBypasses(meta, this.deps.sessions.bypasses(caller.id)) ? "bypass" : "prompting";
      return this.connectionTool(caller, mode, name as "create_invite" | "accept_invite" | "end_connection", args);
    }
    if (name === "send_file") {
      const mode: AgentMode = senderBypasses(meta, this.deps.sessions.bypasses(caller.id)) ? "bypass" : "prompting";
      return this.fileTool(caller, mode, args);
    }
    if (name === "answer_ask") return this.answerTool(caller, args);
    if (GROUP_TOOL_NAMES.has(name)) {
      const mode: AgentMode = senderBypasses(meta, this.deps.sessions.bypasses(caller.id)) ? "bypass" : "prompting";
      return this.groupTool(caller, mode, name as GroupToolName, args);
    }
    try {
      if (name === "list_agents") {
        const listed = await this.listFrom(caller);
        return { text: listingText(listed.agents, listed.connections, listed.machines, caller.node, listed.teammates, this.now()) };
      }
      const to = typeof args["to"] === "string" ? args["to"].trim() : "";
      const text = typeof args["text"] === "string" ? args["text"] : "";
      const replyTo = args["reply_to"];
      const pastFocus = args["past_focus"];
      if (!to) return { text: "send_message needs to: the name list_agents gives the session.", isError: true };
      if (!text.trim()) return { text: "send_message needs text: the message.", isError: true };
      if (replyTo !== undefined && replyTo !== "" && !AgentMessageId.safeParse(replyTo).success) return { text: "reply_to is the id (pmsg_…) of the message you are answering, from its envelope.", isError: true };
      if (pastFocus !== undefined && typeof pastFocus !== "boolean") return { text: "past_focus is true or false.", isError: true };
      const mode: AgentMode = senderBypasses(meta, this.deps.sessions.bypasses(caller.id)) ? "bypass" : "prompting";
      const answer = await this.sendFrom(caller, mode, { to, text, ...(typeof replyTo === "string" && replyTo !== "" ? { replyTo } : {}), ...(pastFocus === true ? { pastFocus: true } : {}) });
      return { text: answerText(answer, this.now()) };
    } catch (e) {
      return { text: refusalText(e), isError: true };
    }
  }

  /** The directory as `caller` sees it, its connections to other users' agents, the teammates' open agents, and the user's machines, from here or from the primary. */
  private async listFrom(caller: Session): Promise<{ agents: AgentListing[]; connections: ConnectionListing[]; machines: MachineListing[]; teammates: TeammateListing[] }> {
    if (this.deps.cluster.routes()) return { agents: await this.list(caller), connections: this.deps.connections?.()?.listing(caller) ?? [], machines: this.machines(), teammates: await this.teammatesOf(caller) };
    const r = nodeLinkRequests["agent.list"].result.parse(await this.upward("agent.list", { caller: caller.id }));
    return { agents: r.agents, connections: r.connections ?? [], machines: r.machines ?? [], teammates: r.teammates ?? [] };
  }

  /** The teammates' agents open to `caller`, or none when they cannot be asked now. */
  private async teammatesOf(caller: Session): Promise<TeammateListing[]> {
    const t = this.deps.teammates?.();
    if (!t) return [];
    try {
      return await t.listing(caller);
    } catch (e) {
      this.log.info("the teammates' agents could not be listed", { error: message(e) });
      return [];
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** One of the group tools or `focus`, on the primary's groups, here or through the link; the photos a read shows, read where they are kept. */
  private async groupTool(caller: Session, mode: AgentMode, tool: GroupToolName, args: Json): Promise<CallAnswer> {
    try {
      const routes = this.deps.cluster.routes();
      const r: ToolAnswer & { isError?: boolean } = routes
        ? await this.groupToolHere(caller, mode, tool, args)
        : nodeLinkRequests["group.tool"].result.parse(await this.upward("group.tool", { caller: caller.id, mode, tool, args }, tool === "get_file" || tool === "post_group" ? FILE_UPWARD_MS : UPWARD_MS));
      if (!r.photos?.length) return { text: r.text, ...(r.isError ? { isError: true } : {}) };
      const images = await this.photosFor(caller, r.photos, routes);
      return { text: r.text, ...(images.length > 0 ? { images } : {}), ...(r.isError ? { isError: true } : {}) };
    } catch (e) {
      return { text: groupRefusal(e), isError: true };
    }
  }

  private async groupToolHere(caller: Session, mode: AgentMode, tool: GroupToolName, args: Json): Promise<ToolAnswer> {
    if (tool === "focus") return { text: await this.focusTool(caller, args) };
    if (tool === "get_file") return { text: await this.getFile(caller, mode, args) };
    const groups = this.deps.groups?.();
    if (!groups) throw new RpcError("unavailable", "group chats are off on this machine");
    return groups.tool(caller, tool, args, mode);
  }

  /** The photos a read shows, as images: kept here on the primary, else read from it a piece at a time. One that cannot be read is left out. */
  private async photosFor(caller: Session, refs: readonly PhotoRef[], here: boolean): Promise<{ mime: string; data: string }[]> {
    const out: { mime: string; data: string }[] = [];
    for (const ref of refs) {
      try {
        if (here) {
          const groups = this.deps.groups?.();
          if (!groups) break;
          out.push({ mime: ref.type, data: Buffer.from(await groups.photoBytes(ref.group, ref.photo)).toString("base64") });
          continue;
        }
        const parts: Buffer[] = [];
        let at = 0;
        let total = 1;
        while (at < total && parts.length < 8) {
          const piece = nodeLinkRequests["group.photo"].result.parse(await this.upward("group.photo", { caller: caller.id, group: ref.group, photo: ref.photo, ...(at > 0 ? { at } : {}) }));
          const bytes = Buffer.from(piece.data, "base64");
          if (piece.at !== at || bytes.length === 0) throw new RpcError("unavailable", "the photo came short");
          parts.push(bytes);
          at += bytes.length;
          total = piece.total;
        }
        if (at < total) throw new RpcError("unavailable", "the photo came short");
        out.push({ mime: ref.type, data: Buffer.concat(parts).toString("base64") });
      } catch (e) {
        this.log.info("a group's photo could not be shown to an agent", { session: caller.id, photo: ref.photo, error: message(e) });
      }
    }
    return out;
  }

  /**
   * `get_file`, on the router: a file posted in a group the caller is in, copied to the caller's
   * machine (its Downloads folder, or `dir`), from where it is now: one of this user's machines,
   * or the other person's, through their Cophyla. Answered once it lands, or later.
   */
  private async getFile(caller: Session, mode: AgentMode, args: Json): Promise<string> {
    const groups = this.deps.groups?.();
    const files = this.deps.files?.();
    if (!groups || !files) throw new RpcError("unavailable", "copying files is off on this machine");
    const group = typeof args["group"] === "string" ? args["group"].trim() : "";
    const ref = typeof args["file"] === "string" ? args["file"].trim() : "";
    const dirArg = typeof args["dir"] === "string" && args["dir"].trim() ? args["dir"].trim() : undefined;
    if (!group) throw new RpcError("invalid", "get_file needs group: the group's name as read_group lists it");
    if (!ref) throw new RpcError("invalid", "get_file needs file: its gfile_ id from read_group");
    const found = groups.fileFor(caller, group, ref);
    const node = caller.node;
    const nodeName = this.nameOf(node);
    if (node !== this.deps.self().id) {
      const row = this.deps.cluster.nodes().find((n) => n.id === node);
      if (row && !row.capabilities.files) throw new RpcError("unsupported", `${nodeName} runs an older Cophyla: update it to receive files`);
      if (!this.deps.cluster.linked(node)) throw new RpcError("unavailable", `${nodeName} is offline`);
    }
    const there = this.pathsOf(node);
    const dir = dirArg === undefined ? undefined : there.isAbsolute(dirArg) ? dirArg : there.join(caller.cwd, dirArg);
    const f = found.file;
    const label = `${f.kind === "folder" ? `the folder ${f.name}` : f.name} (${sizeText(f.bytes)})`;
    const alias = this.aliasOf(caller);
    let asking = false;
    const work = async (): Promise<string> => {
      await this.deps.gate.run({ principal: { kind: "harness", session: caller.id }, action: "group.file.get", target: found.group, args: { group: found.groupName, file: f.id, ...(dir ? { dir } : {}) }, sessionKey: caller.id }, () => undefined);
      // into a folder the agent names, not its Downloads: placed where it writes, asked as send_file is
      if (dir) {
        await this.deps.gate.run(
          {
            principal: { kind: "harness", session: caller.id },
            action: "transfer.send",
            target: node,
            args: { group: found.groupName, file: f.id, to: nodeName, dir, bytes: f.bytes },
            sessionKey: caller.id,
            ask: { title: `Let ${alias} copy ${label} from #${found.groupName} into ${dir}?`, detail: `It goes into that folder on ${nodeName}, beside what is there and never over it.` },
            ...(mode === "bypass" ? { unprompted: true } : {}),
          },
          () => undefined,
          { onPending: () => (asking = true) },
        );
        asking = false;
      }
      const by: TransferBy = { kind: "agent", alias, session: caller.id };
      const to = { node, ...(dir ? { dir } : {}) };
      let started = await groups.save(found.group, found.post, f.id, to, { by });
      if (started.confirm) {
        asking = true;
        await this.askUser(caller, `Copy ${label} through the relay?`, `${alias} copies it from #${found.groupName} to ${nodeName}. It is over 1 GB and comes through the Cophyla server's relay, which counts what it carries.`, "Copy it");
        asking = false;
        started = await groups.save(found.group, found.post, f.id, to, { by, relayOk: true });
      }
      if (!started.transfer) throw new RpcError("unavailable", "the copy did not start");
      this.log.info("an agent copies a group's file", { id: started.transfer.id, session: caller.id, group: found.group, bytes: f.bytes });
      return gotText(await files.ended(started.transfer.id), label, found.groupName);
    };
    return this.waitOrLater(caller, work, () =>
      asking ? `Waiting for your user to allow copying ${label}. You will be told by a message from cophyla how it went.` : `Copying ${label} from #${found.groupName} to this machine. You will be told by a message from cophyla when it lands.`,
    );
  }

  /** `focus`: taken for an hour or two, or ended. */
  private async focusTool(caller: Session, args: Json): Promise<string> {
    const focus = this.deps.focus?.();
    if (!focus) throw new RpcError("unavailable", "focus is off on this machine");
    if (args["off"] === true) {
      // not awaited past the end itself: what was held follows once this tool has answered
      const ended = await this.deps.gate.run({ principal: { kind: "harness", session: caller.id }, action: "agent.focus", args: { off: true }, sessionKey: caller.id }, () => focus.release(caller.id, "agent"));
      return ended ? "Your focus has ended; what came meanwhile follows." : "You were not in focus.";
    }
    const minutes = args["minutes"] === undefined ? 60 : args["minutes"];
    if (minutes !== 60 && minutes !== 120) throw new RpcError("invalid", "minutes is 60 or 120");
    const reason = typeof args["reason"] === "string" ? args["reason"] : "";
    const f = await this.deps.gate.run({ principal: { kind: "harness", session: caller.id }, action: "agent.focus", args: { minutes, reason: reason.slice(0, 200) }, sessionKey: caller.id }, () => focus.take(caller, minutes, reason));
    return `You are in focus until ${clockTime(f.until)} (${minutes} minutes), or until your turn ends: messages from other agents and group chats are held, and their senders are told until when and why. You get what came when it ends. Your own user still reaches you. focus with off: true ends it sooner.`;
  }

  /** The user's machines a file may be sent to, hands ones too, never another person's folders lent here: whether it is there now and whether it takes files. */
  private machines(): MachineListing[] {
    if (!this.deps.files?.()) return [];
    const self = this.deps.self().id;
    return this.deps.cluster
      .nodes()
      .filter((n) => !lent(n))
      .map((n) => ({ node: n.id, name: n.name, online: n.id === self || (n.status === "online" && this.deps.cluster.linked(n.id)), files: n.capabilities.files === true }));
  }

  /** `send_file`, here or through the primary: its words for the model. */
  private async fileTool(caller: Session, mode: AgentMode, args: Json): Promise<CallAnswer> {
    const path = typeof args["path"] === "string" ? args["path"].trim() : "";
    const to = typeof args["to"] === "string" ? args["to"].trim() : "";
    const dir = typeof args["dir"] === "string" && args["dir"].trim() ? args["dir"].trim() : undefined;
    const reason = reasonOf(typeof args["reason"] === "string" ? args["reason"] : undefined);
    if (!path) return { text: "send_file needs path: the file or folder on this machine.", isError: true };
    if (!to) return { text: "send_file needs to: an agent session or a machine, by the name list_agents gives it.", isError: true };
    const p = { path, to, ...(dir ? { dir } : {}), ...(reason ? { reason } : {}) };
    try {
      if (this.deps.cluster.routes()) return { text: await this.sendFile(caller, mode, p) };
      return nodeLinkRequests["file.send"].result.parse(await this.upward("file.send", { caller: caller.id, mode, ...p }, FILE_UPWARD_MS));
    } catch (e) {
      return { text: refusalText(e), isError: true };
    }
  }

  /** One of the connection tools, on the primary's connections, here or through the link. */
  private async connectionTool(caller: Session, mode: AgentMode, tool: "create_invite" | "accept_invite" | "end_connection", args: Json): Promise<CallAnswer> {
    try {
      if (this.deps.cluster.routes()) {
        const c = this.deps.connections?.();
        if (!c) return { text: "Connections are off on this machine; nothing was done.", isError: true };
        return { text: await c.tool(caller, tool, args, mode === "bypass") };
      }
      return nodeLinkRequests["connection.tool"].result.parse(await this.upward("connection.tool", { caller: caller.id, mode, tool, args }));
    } catch (e) {
      return { text: connectionRefusal(e), isError: true };
    }
  }

  /** `answer_ask`: a leader answers an ask of a session it leads, as the user, here or through the primary. */
  private async answerTool(caller: Session, args: Json): Promise<{ text: string; isError?: boolean }> {
    const ask = typeof args["ask"] === "string" ? args["ask"].trim() : "";
    const option = typeof args["option"] === "string" ? args["option"].trim() : "";
    const options = Array.isArray(args["options"]) ? args["options"].filter((o): o is string => typeof o === "string" && o.trim() !== "").map((o) => o.trim()) : [];
    const text = typeof args["text"] === "string" ? args["text"] : undefined;
    if (!AskId.safeParse(ask).success) return { text: "answer_ask needs ask: the ask's id (ask_…), from the notice or list_agents.", isError: true };
    if (!option) return { text: "answer_ask needs option: the id of the option you choose.", isError: true };
    const p = { ask, option, ...(options.length > 0 ? { options: options.slice(0, 32) } : {}), ...(text !== undefined ? { text: text.slice(0, 16_000) } : {}) };
    try {
      if (this.deps.cluster.routes()) return { text: await this.answerAsk(caller, p) };
      return nodeLinkRequests["agent.answer"].result.parse(await this.upward("agent.answer", { caller: caller.id, ...p }));
    } catch (e) {
      return { text: answerRefusal(e), isError: true };
    }
  }

  private async sendFrom(caller: Session, mode: AgentMode, p: SendParams): Promise<SendAnswer> {
    if (this.deps.cluster.routes()) return this.send(caller, mode, p);
    const r = await this.upward("agent.send", { caller: caller.id, mode, ...p });
    return nodeLinkRequests["agent.send"].result.parse(r);
  }

  /** One request to the primary's router; what it refuses comes back as it said it. */
  private async upward(method: "agent.list" | "agent.send" | "agent.answer" | "connection.tool" | "group.tool" | "group.note" | "group.photo" | "file.send", params: unknown, timeoutMs = UPWARD_MS): Promise<unknown> {
    const noLink = () => new RpcError("unavailable", `this machine has no link to ${this.deps.cluster.primaryName() ?? "the primary"}, which carries agents' messages, so nothing was sent`);
    if (!this.deps.cluster.primaryLinked()) throw noLink();
    try {
      return await this.deps.cluster.requestPrimary(method, params, { timeoutMs });
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
      if (!eligible(s, "self")) continue;
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
    const d = directory(entries, (id) => this.known.get(id)?.forms);
    for (const e of d.entries) {
      const a = d.aliases.get(e.session.id);
      this.known.delete(e.session.id);
      this.known.set(e.session.id, { node: e.session.node, nodeName: e.nodeName, forms: [e.session.id.toLowerCase(), ...(a?.forms ?? []), ...(a?.former ?? [])] });
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

  /** The directory as `caller` sees it: everyone but itself, the sessions it leads marked, with the ask open in each. */
  async list(caller: Session): Promise<AgentListing[]> {
    return this.deps.gate.run({ principal: { kind: "harness", session: caller.id }, action: "agent.list", args: {}, sessionKey: caller.id }, () => {
      const d = this.directory();
      const focus = this.deps.focus?.();
      const leaders = this.deps.leaders?.();
      return d.entries
        .filter((e) => e.session.id !== caller.id)
        .map((e) => {
          let row: AgentListing = listing(d, e);
          const f = focus?.get(e.session.id);
          if (f) row = { ...row, focus: f };
          const lead = leaders?.route(caller.id, e.session);
          if (lead && "lead" in lead) row = { ...row, led: true, ...(e.session.ask ? { ask: e.session.ask } : {}) };
          return row;
        });
    });
  }

  /** Every live agent of the user's with its alias now and every form it answers to: what a group chat tags them by. */
  agentNames(): Map<string, { alias: string; forms: string[] }> {
    const d = this.directory();
    const out = new Map<string, { alias: string; forms: string[] }>();
    for (const [id, a] of d.aliases) out.set(id, { alias: a.alias, forms: [...new Set([a.alias, ...a.forms, ...a.former])] });
    return out;
  }

  /**
   * A message from `caller` to the session `to` names: refused for what it may not be, then
   * gated, then delivered. Answered as soon as it is delivered, held in the receiving terminal,
   * or waiting on the user; one that waits is delivered once allowed, and its sender is told
   * when it is not. `access` is the grant of the node it came up from, when it did. To a
   * session the caller leads, it goes as the user's own words (`asUser`), or as another agent's
   * with why (`fallback`) when that session cannot take them; either waits for the session's
   * focus to end unless the caller sent it `pastFocus`, which only a session it leads takes.
   */
  async send(caller: Session, mode: AgentMode, { pastFocus, ...p }: SendParams, access?: Access): Promise<SendAnswer> {
    // another user's agent, on a connection of the caller's terminal: carried by the connection alone
    const connections = this.deps.connections?.();
    const teammates = this.deps.teammates?.();
    const peer = (teammates && !connections?.resolveFor(caller, p.to) && teammates.names(p.to)) || (connections && (connections.resolveFor(caller, p.to) || Connections.names(p.to)));
    if (peer && pastFocus) throw new RpcError("invalid", "past_focus is for a session you lead, and another person's agent is never one: send without it");
    if (teammates && !connections?.resolveFor(caller, p.to) && teammates.names(p.to)) {
      if (access && !mayMessage(access, "initiate")) throw new RpcError("denied", `${this.nameOf(caller.node)}'s access lets its sessions send no messages to other people`);
      const sent = await teammates.send(caller, mode, p);
      this.talkOut(caller.id, sent.id, p, peerParty(sent.alias, { teammate: sent.teammate }), sent.status);
      return { status: sent.status, id: sent.id, peer: { teammate: sent.teammate, alias: sent.alias }, ...(sent.focus ? { focus: sent.focus } : {}) };
    }
    if (connections && (connections.resolveFor(caller, p.to) || Connections.names(p.to))) {
      if (access && !mayMessage(access, "initiate")) throw new RpcError("denied", `${this.nameOf(caller.node)}'s access lets its sessions send no messages to other people`);
      const sent = await connections.send(caller, p);
      this.talkOut(caller.id, sent.id, p, peerParty(sent.alias, { connection: sent.connection }), sent.status);
      return { status: sent.status, id: sent.id, peer: { connection: sent.connection, alias: sent.alias } };
    }
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
    // a session the caller leads takes its words as the user's; one that cannot, as another agent's, and the caller is told why
    const lead = this.deps.leaders?.()?.route(caller.id, target.session);
    const asLead = lead !== undefined && "lead" in lead;
    const fallback = lead !== undefined && "fallback" in lead ? lead.fallback : undefined;
    if (pastFocus && !lead) throw new RpcError("invalid", `past_focus is for a session you lead, and you do not lead ${to.alias}: send without it, and it gets your message when any focus of its ends`);
    const command = asLead ? leadCommand(p.text) : undefined;
    if (command) throw new RpcError("invalid", command);
    const { hops, reply } = this.limits.hops(caller.id, p.replyTo);
    if (access && !mayMessage(access, reply ? "reply" : "initiate")) {
      throw new RpcError("denied", access.messages === "none" ? `${from.nodeName}'s access lets its sessions send no messages` : `${from.nodeName}'s access lets its sessions answer messages, not start a conversation`);
    }
    const why = this.limits.check(caller.id, target.session.id, to.alias, p.text, hops);
    if (why) throw new RpcError("denied", why);
    if (target.session.node !== this.deps.self().id && !this.deps.cluster.linked(target.session.node)) throw new RpcError("unavailable", `${to.nodeName} is offline; not sent`);
    const id = newId("agentMessage");
    this.limits.record(id, caller.id, target.session.id, p.text, hops);
    const said = { id, text: p.text, ...(p.replyTo ? { replyTo: p.replyTo } : {}) };
    // the receiver in focus: held for it, its sender told at once until when and why, unless the
    // caller leads it and sent it past focus (or what was held for it still being handed over,
    // which this queues behind)
    const focus = this.deps.focus?.();
    const inFocus = focus?.get(target.session.id);
    const holds = focus !== undefined && (inFocus !== undefined || focus.holding(target.session.id));
    if (asLead) {
      if (focus && holds && !pastFocus) {
        // its sender's permission class kept too, for the parity rule should it go as the leader's own message after all
        const info: EnvelopeInfo & { mode: AgentMode } = { from, messageId: id, ...(p.replyTo ? { replyTo: p.replyTo } : {}), mode };
        const heldIt = await this.deps.gate.run(
          { principal: { kind: "harness", session: caller.id }, action: "agent.lead", target: target.session.id, args: { to: to.alias, text: cap(p.text), ...(p.replyTo ? { replyTo: p.replyTo } : {}), id, focus: true }, sessionKey: caller.id },
          () => focus.hold(target.session, p.text, info, from.alias, caller.id, true),
        );
        if (heldIt) {
          this.log.info("a leader's message held for focus", { id, from: caller.id, to: target.session.id });
          this.deps.talk?.()?.between(partyOf(from), partyOf(to), { ...said, lead: true, status: "focus" });
          const still = focus.get(target.session.id);
          return { status: still ? "focus" : "sent", id, to, asUser: true, ...(still ? { focus: still } : {}) };
        }
        // its focus ended while this was asked about: typed in as ever, below
      }
      const answer = await this.lead(caller, target.session, from, to, id, p, hops, holds && pastFocus === true);
      this.deps.talk?.()?.between(partyOf(from), partyOf(to), { ...said, lead: true, status: "sent" });
      return answer;
    }
    const told = (a: SendAnswer): SendAnswer => {
      // into both conversations, as it was answered: one waiting on the user is in the receiver's once it lands
      const talk = this.deps.talk?.();
      if (talk && a.status === "pending") talk.add(caller.id, { ...said, dir: "out", with: partyOf(to), status: "pending" });
      else talk?.between(partyOf(from), partyOf(to), { ...said, status: a.status === "held" || a.status === "focus" ? a.status : "sent" });
      return fallback ? { ...a, fallback } : a;
    };
    const agent: EnvelopeInfo & { mode: AgentMode } = { from, messageId: id, ...(p.replyTo ? { replyTo: p.replyTo } : {}), mode };

    if (focus && holds && !pastFocus) {
      const heldIt = await this.deps.gate.run(
        { principal: { kind: "harness", session: caller.id }, action: "agent.send", target: target.session.id, args: { to: to.alias, text: cap(p.text), ...(p.replyTo ? { replyTo: p.replyTo } : {}), id, focus: true }, sessionKey: caller.id },
        () => focus.hold(target.session, p.text, agent, from.alias, caller.id),
      );
      if (heldIt) {
        this.log.info("agent message held for focus", { id, from: caller.id, to: target.session.id });
        const still = focus.get(target.session.id);
        if (still) return told({ status: "focus", id, to, focus: still });
        return told({ status: "sent", id, to });
      }
      // its focus ended while this was asked about: sent as ever, below
    }

    let held: (ask: Ask) => void = () => undefined;
    const pending = new Promise<Ask>((r) => (held = r));
    const work = this.deps.gate.run(
      {
        principal: { kind: "harness", session: caller.id },
        action: "agent.send",
        target: target.session.id,
        args: { to: to.alias, text: cap(p.text), ...(p.replyTo ? { replyTo: p.replyTo } : {}), id, ...(holds && pastFocus ? { pastFocus: true } : {}) },
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
        (r) => {
          this.log.info("agent message delivered once allowed", { id, to: target.session.id });
          const talk = this.deps.talk?.();
          talk?.settle(id, r.status === "held" ? "held" : "sent");
          talk?.add(target.session.id, { id, text: p.text, ...(p.replyTo ? { replyTo: p.replyTo } : {}), dir: "in", with: partyOf(from) });
        },
        (e: unknown) => {
          this.log.info("agent message not delivered", { id, to: target.session.id, error: message(e) });
          this.deps.talk?.()?.settle(id, "failed", notDelivered(e));
          void this.notice(caller, id, to, e);
        },
      );
      return told({ status: "pending", id, to, ask: first.ask.id });
    }
    this.log.info("agent message sent", { id, from: caller.id, to: target.session.id, status: first.done.status, hops, ...(fallback ? { fallback } : {}) });
    return told({ status: first.done.status === "held" ? "held" : "sent", id, to });
  }

  /** A message the caller sent to another person's agent, into the caller's conversation as it was answered. */
  private talkOut(caller: string, id: string, p: { text: string; replyTo?: string }, to: TalkParty, status: TalkStatus): void {
    this.deps.talk?.()?.add(caller, { id, text: p.text, ...(p.replyTo ? { replyTo: p.replyTo } : {}), dir: "out", with: to, status });
  }

  /**
   * A leader's message to a session it leads, checked and counted already: gated as
   * `agent.lead`, and typed into the session as the user's own words. Never asked about for
   * parity: the user made the caller its leader. One to a session in focus got here only sent
   * past it (`pastFocus`, which the audit row says). What the session does next is told to the
   * caller (`leaders/reports.ts`).
   */
  private async lead(caller: Session, target: Session, from: AgentRef, to: AgentRef, id: string, p: { text: string; replyTo?: string }, hops: number, pastFocus?: boolean): Promise<SendAnswer> {
    // watched before it goes: a session can take it before the send is answered
    const going = this.deps.reports?.()?.begin(caller.id, target.id);
    let r: { status: "queued" | "held"; ref?: string };
    try {
      r = await this.deps.gate.run(
        { principal: { kind: "harness", session: caller.id }, action: "agent.lead", target: target.id, args: { to: to.alias, text: cap(p.text), ...(p.replyTo ? { replyTo: p.replyTo } : {}), id, ...(pastFocus ? { pastFocus: true } : {}) }, sessionKey: caller.id },
        () => this.deliverAsLead(target, p.text, from),
      );
    } catch (e) {
      going?.failed();
      throw e;
    }
    if (r.ref) going?.sent(r.ref, id);
    else going?.failed();
    this.log.info("a leader's message sent as the user's words", { id, from: caller.id, to: target.id, hops, ...(r.ref ? { ref: r.ref } : {}), ...(pastFocus ? { pastFocus: true } : {}) });
    return { status: "sent", id, to, asUser: true };
  }

  /**
   * A leader's words that focus held for `target`, typed in as the user's now that it has ended,
   * as one message, and watched as a leader's message is (`leaders/reports.ts`): the ref its
   * landing is recorded under. False, and nothing typed, when `by` no longer speaks to it as the
   * user (the user made it lead no more, or the session cannot take the user's words now): they
   * go as its message with the rest.
   */
  async typeHeld(target: Session, text: string, by: AgentRef, ids: string[]): Promise<{ ref?: string } | false> {
    const lead = this.deps.leaders?.()?.route(by.session, target);
    if (!lead || !("lead" in lead)) return false;
    const going = this.deps.reports?.()?.begin(by.session, target.id);
    let r: { status: "queued" | "held"; ref?: string };
    try {
      r = await this.deliverAsLead(target, text, by);
    } catch (e) {
      going?.failed();
      throw e;
    }
    if (r.ref) going?.sent(r.ref, ids[ids.length - 1]!);
    else going?.failed();
    const talk = this.deps.talk?.();
    for (const id of ids) talk?.settle(id, "sent");
    this.log.info("a leader's words held for focus typed as the user's", { from: by.session, to: target.id, messages: ids.length, ...(r.ref ? { ref: r.ref } : {}) });
    return r.ref ? { ref: r.ref } : {};
  }

  /** Delivers a leader's message as the user's words, wherever the session is: here, or by its node, which the router knows takes it. */
  private async deliverAsLead(target: Session, text: string, by: AgentRef): Promise<{ status: "queued" | "held"; ref?: string }> {
    const lead = { by };
    if (target.node === this.deps.self().id) return this.deps.sessions.send(target.id, text, { from: "lead", lead });
    const name = this.nameOf(target.node);
    if (!this.deps.cluster.linked(target.node)) throw new RpcError("unavailable", `${name} is offline; not sent`);
    try {
      return (await this.deps.cluster.forward(target.node, "session.send", { id: target.id, text, as: "lead", lead }, {})) as { status: "queued" | "held"; ref?: string };
    } catch (e) {
      if (e instanceof RpcError && e.code === "unavailable" && !this.deps.cluster.linked(target.node)) throw new RpcError("unavailable", `${name} is offline; not sent`);
      throw e;
    }
  }

  /**
   * `answer_ask` on the router: `caller` answers an ask as the user. Refused unless the caller
   * leads the ask's session, the ask is that session's own (its harness's permission prompt,
   * question or plan), open, and one the user answers; gated as `agent.answer`, then answered
   * where the ask is: here, or by its node, as the brain's answers are.
   */
  async answerAsk(caller: Session, p: { ask: string; option: string; options?: string[]; text?: string }): Promise<string> {
    const leaders = this.deps.leaders?.();
    if (!leaders) throw new RpcError("unavailable", "the leaders are kept by the primary");
    const ask = this.deps.asks?.get(p.ask) ?? this.deps.cluster.mirrorAsk?.(p.ask);
    if (!ask) throw new RpcError("not_found", `no ask ${p.ask} is open`);
    if (ask.source.kind !== "harness") throw new RpcError("denied", `${p.ask} is not an agent session's ask: only your user answers it`);
    const session = ask.source.session;
    const alias = this.aliasOfId(session);
    if (!leaders.leads(caller.id, session)) throw new RpcError("denied", `you do not lead ${alias}, so its asks are your user's alone`);
    if (ask.status !== "open") throw new RpcError("conflict", `${p.ask} is ${ask.status} already`);
    if (!ask.answerableBy.includes("user")) throw new RpcError("denied", `${p.ask} is not one your user answers`);
    const chosen = ask.options.find((o) => o.id === p.option);
    if (!chosen && !(p.option === ASK_TEXT_OPTION && ask.allowsText)) throw new RpcError("invalid", `${p.ask} has no option ${p.option}: its options are ${ask.options.map((o) => `${o.id} (${o.label})`).join(", ")}${ask.allowsText ? `, or ${ASK_TEXT_OPTION} with a written answer` : ""}`);
    const input = { option: p.option, ...(p.options ? { options: p.options } : {}), ...(p.text !== undefined ? { text: p.text } : {}) };
    await this.deps.gate.run(
      { principal: { kind: "harness", session: caller.id }, action: "agent.answer", target: ask.id, args: { session, ...input, ...(input.text !== undefined ? { text: cap(input.text) } : {}) }, sessionKey: caller.id },
      async () => {
        if (ask.node === this.deps.self().id) {
          if (!this.deps.asks) throw new RpcError("unavailable", "no ask can be answered here");
          this.deps.asks.answer(ask.id, input, { kind: "harness", session: caller.id });
          return;
        }
        if (!this.deps.cluster.linked(ask.node)) throw new RpcError("unavailable", `${this.nameOf(ask.node)} is offline; not answered`);
        await this.deps.cluster.forward(ask.node, "ask.answer", { id: ask.id, ...input }, {});
      },
    );
    this.log.info("a leader answered an ask as the user", { ask: ask.id, by: caller.id, session, option: p.option });
    return `Answered ${ask.id} in ${alias} as your user: ${chosen ? chosen.label : "your written answer"}.`;
  }

  /**
   * A report to a leader (`leaders/reports.ts`): a notice from cophyla, or the words of a session
   * it leads, in that session's envelope, as information. Held by the leader's focus as any
   * message is, and never counted against the limits.
   */
  async report(leaderId: string, text: string, from?: { session: string; replyTo?: string }): Promise<void> {
    const d = this.directory();
    const leader = d.entries.find((e) => e.session.id === leaderId)?.session;
    if (!leader) return;
    const fromEntry = from ? d.entries.find((e) => e.session.id === from.session) : undefined;
    const sender = fromEntry ? agentRef(d, fromEntry) : undefined;
    const mode: AgentMode | undefined = fromEntry ? (fromEntry.session.mode === "bypassPermissions" ? "bypass" : "prompting") : undefined;
    const info: EnvelopeInfo & { mode?: AgentMode } = { messageId: newId("agentMessage"), ...(sender ? { from: sender } : {}), ...(from?.replyTo ? { replyTo: from.replyTo } : {}), ...(mode ? { mode } : {}) };
    // a led session's own words are its side of the conversation; cophyla's notices are not
    const talk = () => {
      if (sender) this.deps.talk?.()?.add(leaderId, { id: info.messageId, text, ...(info.replyTo ? { replyTo: info.replyTo } : {}), dir: "in", with: partyOf(sender), report: true });
    };
    const focus = this.deps.focus?.();
    try {
      if (focus?.hold(leader, text, info, sender?.alias ?? "cophyla")) return talk();
    } catch (e) {
      this.log.info("a report to a leader was not held: its focus holds too much", { leader: leaderId, error: message(e) });
      return;
    }
    await this.deliver(leader, text, info, () => undefined);
    talk();
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
   *
   * `more`: messages handed over with this one as one message, each in its own envelope after
   * it (what focus held). Each is asked about as it would be alone, and one the user does not
   * let in is left out and named in `dropped`; nothing goes when every one is.
   */
  async deliverHere(
    targetId: string,
    text: string,
    agent: EnvelopeInfo & { mode?: AgentMode; quiet?: boolean },
    onPending?: (ask: Ask) => void,
    more: readonly (EnvelopeInfo & { mode?: AgentMode; text: string })[] = [],
  ): Promise<{ status: "queued" | "held"; ref?: string; dropped?: { messageId: string; why: string }[] }> {
    const s = this.deps.sessions.get(targetId);
    if (!s || s.status === "ended") throw new RpcError("not_found", "that session has ended; not sent");
    const { mode: _mode, quiet, ...info } = agent;
    if (more.length === 0) {
      await this.parity(s, text, agent, onPending);
      return this.deps.sessions.send(targetId, text, { from: "agent", agent: info, ...(quiet ? { quiet: true } : {}) });
    }
    const kept: { info: EnvelopeInfo; text: string }[] = [];
    const dropped: { messageId: string; why: string }[] = [];
    for (const { mode, text: words, ...one } of [{ ...info, ...(agent.mode ? { mode: agent.mode } : {}), text }, ...more]) {
      try {
        await this.parity(s, words, { ...one, ...(mode ? { mode } : {}) }, onPending);
        kept.push({ info: one, text: words });
      } catch (e) {
        dropped.push({ messageId: one.messageId, why: notDelivered(e) });
      }
    }
    const [first, ...rest] = kept;
    if (!first) return { status: "queued", dropped };
    const r = await this.deps.sessions.send(targetId, first.text, { from: "agent", agent: first.info, ...(rest.length > 0 ? { more: rest } : {}) });
    return dropped.length > 0 ? { ...r, dropped } : r;
  }

  /** The parity rule: a message from a session that prompts, into one of this node's that runs without prompts, waits on the user unless the session holds it itself. */
  private async parity(s: Session, text: string, agent: EnvelopeInfo & { mode?: AgentMode }, onPending?: (ask: Ask) => void): Promise<void> {
    if (!agent.from || agent.mode === "bypass" || this.deps.sessions.bypasses(s.id) !== true) return;
    if (s.harness === "claude" && !this.deps.sessions.acceptsInbound(s.id)) return;
    const where = `${HARNESS_WORDS[s.harness] ?? s.harness}${folderOf(s.cwd) ? ` in ${folderOf(s.cwd)}` : ""}`;
    await this.deps.gate.run(
      {
        principal: { kind: "harness", session: agent.from.session },
        action: "agent.escalate",
        target: s.id,
        args: { from: agent.from.alias, text: cap(text), id: agent.messageId },
        sessionKey: agent.from.session,
        ask: { title: `Let ${agent.from.alias}, which asks before it acts, message ${where}, which runs without asking?`, detail: cap(text) },
      },
      () => undefined,
      onPending ? { onPending: (ask) => onPending(ask) } : {},
    );
  }

  /** Tells the sender, in its own session, that its message was not delivered. */
  private async notice(caller: Session, id: string, to: AgentRef, e: unknown): Promise<void> {
    const text = `Your message ${id} to ${to.alias} was not delivered: ${notDelivered(e)}.`;
    try {
      await this.deliver(caller, text, { messageId: newId("agentMessage"), replyTo: id }, () => undefined);
    } catch (err) {
      this.log.warn("an agent's notice could not be delivered", { session: caller.id, id, error: message(err) });
    }
  }

  // --- files -------------------------------------------------------------------------------------

  /** The path module of a machine, as its row says: Windows's or everyone else's; this one's own process says it before its row is there. */
  private pathsOf(node: string): typeof posix {
    const row = this.deps.cluster.nodes().find((n) => n.id === node)?.platform;
    const platform = row ?? (node === this.deps.self().id && process.platform === "win32" ? "windows" : undefined);
    return platform === "windows" ? win32 : posix;
  }

  /** Where `send_file`'s `to` goes: an agent session, or a machine by its name. */
  private receiver(caller: Session, to: string): Receiver {
    const d = this.directory();
    const found = resolve(d, to);
    if (!("error" in found)) {
      if (found.session.id === caller.id) throw new RpcError("invalid", "that is this session: send_file reaches another session, or a machine by its name");
      return { node: found.session.node, nodeName: found.nodeName, agent: agentRef(d, found), cwd: found.session.cwd };
    }
    const key = to.trim().toLowerCase();
    const machines = this.deps.cluster.nodes().filter((n) => !lent(n) && (n.id === to.trim() || n.name.toLowerCase() === key || slug(n.name) === key));
    if (machines.length === 1) return { node: machines[0]!.id, nodeName: machines[0]!.name };
    if (machines.length > 1) throw new RpcError("invalid", `more than one machine is called "${to}"`);
    const away = this.offline(to);
    if (away !== undefined) throw new RpcError("unavailable", `${away} is offline; not sent`);
    throw new RpcError("not_found", `no agent session or machine is called "${to}": list_agents names both`);
  }

  /**
   * `send_file` on the router: `path`, on the caller's machine, to an agent session or a
   * machine. A caller that prompts is asked about by the gate (`transfer.send`); one that runs
   * without prompts is not, as its harness would not ask. A big one through the relay asks the
   * user too, never remembered. Answered once it lands, or, when it takes longer, at once with
   * what is happening and later with how it ended.
   */
  async sendFile(caller: Session, mode: AgentMode, p: { path: string; to: string; dir?: string; reason?: string }): Promise<string> {
    const files = this.deps.files?.();
    if (!files) throw new RpcError("unavailable", "sending files is off on this machine");
    const from = caller.node;
    const fromName = this.nameOf(from);
    const fromRow = from === this.deps.self().id ? undefined : this.deps.cluster.nodes().find((n) => n.id === from);
    if (fromRow && !fromRow.capabilities.files) throw new RpcError("unsupported", `${fromName} runs an older Cophyla, which sends no files: update it`);
    const here = this.pathsOf(from);
    const path = here.isAbsolute(p.path) ? p.path : here.join(caller.cwd, p.path);
    // another person's agent: offered to their Cophyla, which pulls it
    const peer = this.peerTarget(caller, p.to);
    if (peer) return this.sendFileToPeer(caller, mode, { ...p, path }, peer);
    const target = this.receiver(caller, p.to);
    const there = this.pathsOf(target.node);
    let dir: string | undefined;
    if (p.dir !== undefined) {
      if (there.isAbsolute(p.dir)) dir = p.dir;
      else if (target.cwd !== undefined) dir = there.join(target.cwd, p.dir);
      else throw new RpcError("invalid", `dir is an absolute path on ${target.nodeName} when to is a machine`);
    }
    if (target.node !== this.deps.self().id) {
      const row = this.deps.cluster.nodes().find((n) => n.id === target.node);
      if (row && !row.capabilities.files) throw new RpcError("unsupported", `${target.nodeName} runs an older Cophyla: update it to receive files`);
      if (!this.deps.cluster.linked(target.node)) throw new RpcError("unavailable", `${target.nodeName} is offline; not sent`);
    }
    const what = await files.peek(from, path);
    const label = `${what.kind === "folder" ? `the folder ${what.name}` : what.name} (${sizeText(what.total)}${what.kind === "folder" ? `, ${what.files} ${what.files === 1 ? "file" : "files"}` : ""})`;
    const where = target.agent ? `${target.agent.alias} on ${target.nodeName}` : target.nodeName;
    const alias = this.aliasOf(caller);
    let asking = false;
    const work = async (): Promise<string> => {
      await this.deps.gate.run(
        {
          principal: { kind: "harness", session: caller.id },
          action: "transfer.send",
          target: target.node,
          args: { path, to: p.to, ...(dir ? { dir } : {}), ...(p.reason ? { reason: p.reason } : {}), bytes: what.total },
          sessionKey: caller.id,
          ask: { title: `Let ${alias} send ${label} to ${where}?`, detail: `${p.reason ? `${p.reason}\n` : ""}${path} on ${fromName}, into ${dir ?? "the Downloads folder"} on ${target.nodeName}.` },
          ...(mode === "bypass" ? { unprompted: true } : {}),
        },
        () => undefined,
        { onPending: () => (asking = true) },
      );
      asking = false;
      const by: TransferBy = { kind: "agent", alias, session: caller.id };
      const params = { from: { node: from, path }, to: { node: target.node, ...(dir ? { dir } : {}) }, ...(p.reason ? { reason: p.reason } : {}), by, ...(target.agent ? { notify: target.agent.session } : {}) };
      let started = await files.start(params);
      if (started.confirm) {
        asking = true;
        await this.askUser(caller, `Send ${label} through the relay?`, `${alias} sends it from ${fromName} to ${where}. It is over 1 GB and the machines have no direct way between them, so it goes through the Cophyla server's relay, which counts what it carries.`, "Send it");
        asking = false;
        started = await files.start({ ...params, relayOk: true });
      }
      if (!started.transfer) throw new RpcError("unavailable", "the transfer did not start");
      this.log.info("an agent's file sent", { id: started.transfer.id, from: caller.id, to: target.node, bytes: what.total });
      return endText(await files.ended(started.transfer.id), label, where, target.agent);
    };
    return this.waitOrLater(caller, work, () =>
      asking
        ? `Waiting for your user to allow sending ${label} to ${where}. You will be told by a message from cophyla how it went.`
        : `Sending ${label} to ${where}. You will be told by a message from cophyla when it lands.`,
    );
  }

  /** The other person's agent `to` names, when it names one: on a connection of the caller's terminal, or a teammate's. */
  private peerTarget(caller: Session, to: string): { link: PeerLink; name: string; alias: string } | undefined {
    // as a message's: a teammate's unless the caller's own connection has the name, else a connection's
    const connections = this.deps.connections?.();
    const teammates = this.deps.teammates?.();
    if (teammates && !connections?.resolveFor(caller, to) && teammates.names(to)) return teammates.fileTarget(caller, to);
    if (connections && (connections.resolveFor(caller, to) || (Connections.names(to) && to.includes("/")))) return connections.fileTarget(caller, to);
    return undefined;
  }

  /**
   * `send_file` to another person's agent: asked about as one to the user's own machines is (a
   * caller that prompts asks, one that runs without prompts does not), then offered to their
   * Cophyla, which pulls it into that agent's machine. Answered once their side took it; how it
   * ended comes later, from cophyla.
   */
  private async sendFileToPeer(caller: Session, mode: AgentMode, p: { path: string; to: string; reason?: string; dir?: string }, peer: { link: PeerLink; name: string; alias: string }): Promise<string> {
    const files = this.deps.files?.();
    const peerFiles = this.deps.peerFiles?.();
    if (!files || !peerFiles) throw new RpcError("unavailable", "sending files to other people is off on this machine");
    if (p.dir !== undefined) throw new RpcError("invalid", "dir is for the user's own machines: another person's file lands in their Downloads folder");
    const what = await files.peek(caller.node, p.path);
    const label = `${what.kind === "folder" ? `the folder ${what.name}` : what.name} (${sizeText(what.total)}${what.kind === "folder" ? `, ${what.files} ${what.files === 1 ? "file" : "files"}` : ""})`;
    const alias = this.aliasOf(caller);
    const fromName = this.nameOf(caller.node);
    let asking = false;
    const work = async (): Promise<string> => {
      await this.deps.gate.run(
        {
          principal: { kind: "harness", session: caller.id },
          action: "peer.file.send",
          target: peer.link.id,
          args: { path: p.path, to: peer.alias, user: peer.link.user, ...(p.reason ? { reason: p.reason } : {}), bytes: what.total },
          sessionKey: caller.id,
          ask: { title: `Let ${alias} send ${label} to ${peer.alias}, ${peer.link.user}'s agent?`, detail: `${p.reason ? `${p.reason}\n` : ""}${p.path} on ${fromName}. It leaves your machines for ${peer.link.user}'s, through the Cophyla server's relay.` },
          ...(mode === "bypass" ? { unprompted: true } : {}),
        },
        () => undefined,
        { onPending: () => (asking = true) },
      );
      asking = false;
      const status = await peerFiles.offer(caller, alias, { src: { node: caller.node, path: p.path }, what, ...(p.reason ? { reason: p.reason } : {}), peer: peer.link, to: peer.name });
      this.log.info("an agent's file offered to another person", { from: caller.id, to: peer.alias, bytes: what.total, status });
      return status === "asked"
        ? `Sent ${label} to ${peer.alias}: it is big, so ${peer.link.user} is asked first whether to take it. You will be told by a message from cophyla whether it landed.`
        : `Sending ${label} to ${peer.alias}: ${peer.link.user}'s Cophyla is copying it into that agent's Downloads folder now. You will be told by a message from cophyla when it lands.`;
    };
    return this.waitOrLater(caller, work, () => (asking ? `Waiting for your user to allow sending ${label} to ${peer.alias}. You will be told by a message from cophyla how it went.` : `Sending ${label} to ${peer.alias}. You will be told by a message from cophyla how it went.`));
  }

  /** A session's alias as the directory gives it. */
  private aliasOf(s: Session): string {
    return this.aliasOfId(s.id);
  }

  private aliasOfId(id: string): string {
    return this.directory().aliases.get(id)?.alias ?? id;
  }

  /** Runs `work`, answering with its words when it ends soon, else with `later`, its outcome then reaching the session as a notice. */
  private async waitOrLater(caller: Session, work: () => Promise<string>, later: () => string): Promise<string> {
    const p = work();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<"slow">((r) => (timer = setTimeout(() => r("slow"), this.deps.toolWaitMs ?? FILE_WAIT_MS)));
    try {
      const first = await Promise.race([p, slow]);
      if (first !== "slow") return first;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const tell = (text: string) =>
      this.deliver(caller, text, { messageId: newId("agentMessage") }, () => undefined).catch((e: unknown) => this.log.warn("a send_file's outcome could not be told", { session: caller.id, error: message(e) }));
    p.then(
      (text) => void tell(text),
      (e: unknown) => void tell(refusalText(e)),
    );
    return later();
  }

  /** An ask only the user answers, never remembered: allowed, or a `denied`/`timeout` error. */
  private async askUser(caller: Session, title: string, detail: string, yes: string): Promise<void> {
    const asks = this.deps.asks;
    if (!asks) throw new RpcError("unavailable", "no one can be asked here");
    const now = (this.deps.now ?? Date.now)();
    const options: AskOption[] = [
      { id: "allow", label: yes, style: "primary" },
      { id: "deny", label: "Don't", style: "danger" },
    ];
    const ask = asks.open({ type: "choice", source: { kind: "harness", session: caller.id }, title, detail, options, answerableBy: ["user"], expiresAt: now + RELAY_ASK_MS }, now, this.deps.self().id);
    const settled = await asks.wait(ask.id);
    if (settled.status === "answered" && settled.answer?.option === "allow") return;
    if (settled.status === "expired") throw new RpcError("timeout", "your user did not answer in time; nothing was sent");
    throw new RpcError("denied", "your user did not allow it; nothing was sent");
  }

  // --- served upward, on the primary ----------------------------------------------------------

  /**
   * A secondary's `agent.list` or `agent.send` for one of its sessions: refused for a session
   * the primary does not hold as that node's, and a send as far as the node's grant may
   * message; gated as the session, never as the node.
   */
  async upwardRequest(peer: { id: string; grant?: string }, method: "agent.list" | "agent.send" | "agent.answer" | "connection.tool" | "group.tool" | "group.note" | "group.photo" | "file.send", params: unknown): Promise<unknown> {
    if (!this.deps.config().enabled) throw new RpcError("unavailable", "agent messaging is off on the primary");
    if (method === "agent.answer") {
      const parsed = nodeLinkRequests["agent.answer"].params.safeParse(params ?? {});
      if (!parsed.success) throw new RpcError("invalid", "bad agent.answer", parsed.error.issues);
      const { caller: id, ...p } = parsed.data;
      const caller = this.callerOf(peer, id);
      const grant = peer.grant !== undefined ? this.deps.cluster.grant(peer.grant) : undefined;
      if (!grant) throw new RpcError("denied", "the node's grant is not known here");
      // answering as the user speaks for them, as starting a conversation does
      if (!mayMessage(grant.access, "initiate")) return { text: "Not answered: this machine's access lets its sessions start no conversations with other agents.", isError: true };
      try {
        return { text: await this.answerAsk(caller, p) };
      } catch (e) {
        return { text: answerRefusal(e), isError: true };
      }
    }
    if (method === "agent.list") {
      const parsed = nodeLinkRequests["agent.list"].params.safeParse(params ?? {});
      if (!parsed.success) throw new RpcError("invalid", "bad agent.list", parsed.error.issues);
      const caller = this.callerOf(peer, parsed.data.caller);
      const connections = this.deps.connections?.()?.listing(caller) ?? [];
      const machines = this.machines();
      const teammates = await this.teammatesOf(caller);
      return { agents: await this.list(caller), ...(connections.length > 0 ? { connections } : {}), ...(machines.length > 0 ? { machines } : {}), ...(teammates.length > 0 ? { teammates } : {}) };
    }
    if (method === "group.tool") {
      const parsed = nodeLinkRequests["group.tool"].params.safeParse(params ?? {});
      if (!parsed.success) throw new RpcError("invalid", "bad group.tool", parsed.error.issues);
      const p = parsed.data;
      const caller = this.callerOf(peer, p.caller);
      const grant = peer.grant !== undefined ? this.deps.cluster.grant(peer.grant) : undefined;
      if (!grant) throw new RpcError("denied", "the node's grant is not known here");
      // a post tells other agents, as a message does: the machine's access must let its sessions start one
      if (p.tool === "post_group" && !mayMessage(grant.access, "initiate")) return { text: "Not posted: this machine's access lets its sessions start no conversations with other agents.", isError: true };
      try {
        const r = await this.groupToolHere(caller, p.mode, p.tool, p.args);
        return { text: r.text, ...(r.photos?.length ? { photos: r.photos } : {}) };
      } catch (e) {
        return { text: groupRefusal(e), isError: true };
      }
    }
    if (method === "group.photo") {
      const parsed = nodeLinkRequests["group.photo"].params.safeParse(params ?? {});
      if (!parsed.success) throw new RpcError("invalid", "bad group.photo", parsed.error.issues);
      const p = parsed.data;
      const caller = this.callerOf(peer, p.caller);
      if (peer.grant === undefined || !this.deps.cluster.grant(peer.grant)) throw new RpcError("denied", "the node's grant is not known here");
      const groups = this.deps.groups?.();
      if (!groups) throw new RpcError("unavailable", "group chats are off on the primary");
      return groups.photoForAgent(caller.id, p.group, p.photo, p.at ?? 0);
    }
    if (method === "group.note") {
      const parsed = nodeLinkRequests["group.note"].params.safeParse(params ?? {});
      if (!parsed.success) throw new RpcError("invalid", "bad group.note", parsed.error.issues);
      const caller = this.callerOf(peer, parsed.data.caller);
      if (peer.grant === undefined || !this.deps.cluster.grant(peer.grant)) throw new RpcError("denied", "the node's grant is not known here");
      const text = this.deps.groups?.()?.unreadNote(caller.id, { consume: true });
      return text ? { text } : {};
    }
    if (method === "file.send") {
      const parsed = nodeLinkRequests["file.send"].params.safeParse(params ?? {});
      if (!parsed.success) throw new RpcError("invalid", "bad file.send", parsed.error.issues);
      const p = parsed.data;
      const caller = this.callerOf(peer, p.caller);
      if (peer.grant === undefined || !this.deps.cluster.grant(peer.grant)) throw new RpcError("denied", "the node's grant is not known here");
      try {
        return { text: await this.sendFile(caller, p.mode, { path: p.path, to: p.to, ...(p.dir !== undefined ? { dir: p.dir } : {}), ...(p.reason !== undefined ? { reason: p.reason } : {}) }) };
      } catch (e) {
        return { text: refusalText(e), isError: true };
      }
    }
    if (method === "connection.tool") {
      const parsed = nodeLinkRequests["connection.tool"].params.safeParse(params ?? {});
      if (!parsed.success) throw new RpcError("invalid", "bad connection.tool", parsed.error.issues);
      const p = parsed.data;
      const caller = this.callerOf(peer, p.caller);
      const grant = peer.grant !== undefined ? this.deps.cluster.grant(peer.grant) : undefined;
      if (!grant) throw new RpcError("denied", "the node's grant is not known here");
      // a node whose sessions may send no message makes no connection for them either
      if (p.tool !== "end_connection" && !mayMessage(grant.access, "initiate")) throw new RpcError("denied", "this machine's access lets its sessions send no messages to other people");
      const c = this.deps.connections?.();
      if (!c) throw new RpcError("unavailable", "connections are off on the primary");
      return { text: await c.tool(caller, p.tool, p.args, p.mode === "bypass") };
    }
    const parsed = nodeLinkRequests["agent.send"].params.safeParse(params ?? {});
    if (!parsed.success) throw new RpcError("invalid", "bad agent.send", parsed.error.issues);
    const p = parsed.data;
    const caller = this.callerOf(peer, p.caller);
    const grant = peer.grant !== undefined ? this.deps.cluster.grant(peer.grant) : undefined;
    if (!grant) throw new RpcError("denied", "the node's grant is not known here");
    return this.send(caller, p.mode, { to: p.to, text: p.text, ...(p.replyTo !== undefined ? { replyTo: p.replyTo } : {}), ...(p.pastFocus ? { pastFocus: true } : {}) }, grant.access);
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

/** A send's answer, as the model reads it: a session the sender leads but that took it as another agent's says why. */
export function answerText(a: SendAnswer, now = Date.now()): string {
  const to = a.peer?.alias ?? a.to?.alias ?? "the session";
  if (a.asUser && a.status === "focus") {
    const until = a.focus ? ` until ${clockTime(a.focus.until)}, ${minutesLeft(a.focus.until, now)} from now, or until its turn ends (${a.focus.reason})` : "";
    return `Held for ${to} (${a.id}): it is in focus${until}. Your message is typed into it as your user's own words when its focus ends, before what else came; you are told then when it asks something, and get its last words when it settles. If it cannot wait, send it again with past_focus: true. Do not wait for it in a loop.`;
  }
  if (a.asUser) return `Typed into ${to} as your user's own words (${a.id}). You are told when it asks something, and get its last words when it settles; do not wait for it in a loop.`;
  const text = statusText(a, to, now);
  return a.fallback ? `${text} You lead ${to}, but this went as another agent's message, not as your user's words: ${a.fallback}.` : text;
}

function statusText(a: SendAnswer, to: string, now: number): string {
  switch (a.status) {
    case "sent":
      return `Sent to ${to} (${a.id}). Its answer, if any, comes to you as a <cophyla-message>; do not wait for it.`;
    case "held":
      return `Held in ${to}'s terminal (${a.id}): that session runs without permission prompts, so Claude Code asks its user before it takes a message from a session that does not. It is delivered once they allow it.`;
    case "pending":
      return a.peer
        ? `Waiting for ${to}'s user to approve (${a.id}): that session runs without permission prompts. It is delivered once they allow it; if they do not, you will be told.`
        : `Waiting for the user's approval (${a.id}) before it reaches ${to}. It is delivered once they allow it; if they do not, you will be told.`;
    case "queued":
      return `Kept to send (${a.id}): the other person's Cophyla cannot be reached now (asleep, or offline). It goes to ${to} once it can be, within a day; if it cannot, you will be told.`;
    case "waiting":
      return `Delivered to ${to}'s Cophyla (${a.id}), but no agent runs in that terminal now: it waits there for one, up to a day.`;
    case "focus":
      return a.focus
        ? `Held for ${to} (${a.id}): it is in focus until ${clockTime(a.focus.until)}, ${minutesLeft(a.focus.until, now)} from now, or until its turn ends (${a.focus.reason}). It gets your message then; its answer, if any, comes to you as a <cophyla-message>. Do not wait for it in a loop.`
        : `Held for ${to} (${a.id}): it is in focus, and gets your message when it comes out.`;
  }
}

/** The group tools and focus, as the model is told they were refused. */
function groupRefusal(e: unknown): string {
  const text = message(e);
  const why = text.endsWith(".") ? text.slice(0, -1) : text;
  return /^not posted|nothing was|not done/i.test(why) ? `${why.charAt(0).toUpperCase()}${why.slice(1)}.` : `Not done: ${why}.`;
}

/** How a `get_file` ended, as the model reads it. */
export function gotText(t: Transfer, label: string, group: string): string {
  if (t.state === "done") return `Copied ${label} from #${group}: it is at ${t.to.path ?? t.to.dir}.`;
  if (t.state === "failed") return `Not copied: ${label} did not come from #${group}: ${t.error ?? "it failed"}. What came of it is kept until the user retries or dismisses it in Cophyla.`;
  return `Not copied: the user stopped copying ${label}, and nothing of it was kept.`;
}

/** How a `send_file` ended, as the model reads it. */
export function endText(t: Transfer, label: string, where: string, agent?: AgentRef): string {
  if (t.state === "done") return `Sent ${label} to ${where}: it landed at ${t.to.path ?? t.to.dir}.${agent ? ` ${agent.alias} was told where it landed.` : ""}`;
  if (t.state === "failed") return `Not sent: ${label} did not reach ${where}: ${t.error ?? "it failed"}. What came of it is kept there until the user retries or dismisses it in Cophyla.`;
  return `Not sent: the user stopped sending ${label} to ${where}, and nothing of it was kept.`;
}

function refusalText(e: unknown): string {
  const text = message(e);
  const why = text.endsWith(".") ? text.slice(0, -1) : text;
  return /not sent|nothing was sent|not delivered/.test(why) ? `${why}.` : `Not sent: ${why}.`;
}

function answerRefusal(e: unknown): string {
  const text = message(e);
  const why = text.endsWith(".") ? text.slice(0, -1) : text;
  return /^not answered/i.test(why) ? `${why}.` : `Not answered: ${why}.`;
}

function connectionRefusal(e: unknown): string {
  const text = message(e);
  const why = text.endsWith(".") ? text.slice(0, -1) : text;
  return /nothing was done|not sent|not delivered/.test(why) ? `${why}.` : `Not done: ${why}.`;
}
