// Access: what one credential may do, and on which of a node's things. A grant's access is
// its scopes (the client protocol's, as before) and, when it is limited, the nodes, the
// workspaces and the paths it may reach; with limits on several of them, a thing must pass
// every one. Access with any limit never holds a global scope: one whose requests and rows
// are not about a node, a workspace or a path and so cannot be cut down to them (the chat
// with the brain, voice, tasks, the phones, the account, updates, the audit, the nodes) or
// that reaches past any limit (a terminal's raw keys go wherever its shell can). `messages`
// is the grant's say in agent messaging: see agent-messaging.md.
//
// The filter tables say, for every client request and notification, what it is about: a
// request a limited credential cannot see is refused, a row it cannot see is not sent, and a
// list it asks for comes back without them. They are exhaustive over the protocol's names,
// so a new method cannot be added without saying how it is filtered. Path limits compare
// paths as text here; the daemon resolves links and short names before it acts on one.

import { Scope } from "./entities.ts";
import type { Access, Ask, MessagesRule, MetricsSample, Session, Terminal, Workspace } from "./entities.ts";
import type { ClientNotificationName, ClientNotificationParams, ClientParams, ClientRequestName, ClientResult, ClientSession, ClientWorkspace } from "./client.ts";

/** The scopes limited access may never hold. */
export const GLOBAL_SCOPES = ["chat", "voice", "tasks:read", "tasks:write", "controllers", "account", "updates", "audit:read", "nodes", "terminal"] as const satisfies readonly Scope[];

const ALL: readonly Scope[] = Scope.options;

/** Everything: the desktop's own access, a full node's, and a phone paired the old way. */
export const FULL: Access = { scopes: [...ALL], messages: "send" };
/** The sessions and their asks, the views, the metrics: what a phone limited to some nodes or workspaces is given by default. */
export const SESSIONS: Access = { scopes: ["sessions:read", "sessions:write", "asks:answer", "views", "metrics:read"], messages: "none" };
/** Watching only. */
export const VIEW: Access = { scopes: ["sessions:read", "views", "metrics:read"], messages: "none" };

export const ACCESS_PRESETS = { full: FULL, sessions: SESSIONS, view: VIEW } as const;
export type AccessPreset = keyof typeof ACCESS_PRESETS;

/** Whether access has any limit: nodes, workspaces or paths. */
export function isLimited(a: Access): boolean {
  return a.nodes !== undefined || a.workspaces !== undefined || a.paths !== undefined;
}

/** Whether access is everything: every scope, no limit, and messaging. */
export function isFull(a: Access): boolean {
  return !isLimited(a) && ALL.every((s) => a.scopes.includes(s)) && a.messages === "send";
}

const MESSAGES_RANK: Record<MessagesRule, number> = { none: 0, reply: 1, send: 2 };

/**
 * The messaging rule, which the future messages module must call before it delivers:
 * `reply` may answer a conversation another started with it, `send` may also start one.
 */
export function mayMessage(a: Pick<Access, "messages">, act: "initiate" | "reply"): boolean {
  return act === "reply" ? a.messages !== "none" : a.messages === "send";
}

/**
 * Why access cannot be minted, or undefined when it can. Limited access holds no global
 * scope and names at least one thing in each limit it has. With a `minter`, what is minted
 * is no more than the minter holds: its scopes, its messaging, and limits within the
 * minter's own.
 */
export function validateAccess(a: Access, minter?: Access): string | undefined {
  if (a.scopes.length === 0) return "access needs at least one scope";
  if (new Set(a.scopes).size !== a.scopes.length) return "a scope is named twice";
  if (isLimited(a)) {
    const global = a.scopes.filter((s) => (GLOBAL_SCOPES as readonly string[]).includes(s));
    if (global.length > 0) return `limited access cannot hold ${global.join(", ")}`;
    for (const [name, list] of [
      ["nodes", a.nodes],
      ["workspaces", a.workspaces],
      ["paths", a.paths],
    ] as const) {
      if (list !== undefined && list.length === 0) return `a ${name} limit names nothing`;
    }
  }
  if (!minter) return undefined;
  const beyond = a.scopes.filter((s) => !minter.scopes.includes(s));
  if (beyond.length > 0) return `the minter does not hold ${beyond.join(", ")}`;
  if (MESSAGES_RANK[a.messages] > MESSAGES_RANK[minter.messages]) return `the minter may not give messages: ${a.messages}`;
  if (minter.nodes && !(a.nodes && a.nodes.every((n) => minter.nodes!.includes(n)))) return "the minter is limited to some nodes, and so is what it mints";
  if (minter.workspaces && !(a.workspaces && a.workspaces.every((w) => minter.workspaces!.includes(w)))) return "the minter is limited to some workspaces, and so is what it mints";
  if (minter.paths && !(a.paths && a.paths.every((p) => minter.paths!.some((m) => pathWithin(p, m))))) return "the minter is limited to some paths, and so is what it mints";
  return undefined;
}

// --- paths -------------------------------------------------------------------------------

/** Whether a path is a Windows one: a drive letter or a share. */
function windowsPath(p: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}

/**
 * A path as the limits compare it: forward slashes, no `.` or `..` segment, no trailing
 * slash, and a Windows path in lower case. Lexical only.
 */
export function normalPath(p: string): string {
  const win = windowsPath(p);
  const unc = win && /^[\\/]{2}/.test(p);
  const parts = p.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const [i, part] of parts.entries()) {
    if (part === "" && i > 0) continue;
    if (part === ".") continue;
    if (part === "..") {
      if (out.length > 1 || (out.length === 1 && out[0] !== "" && !/^[A-Za-z]:$/.test(out[0]!))) out.pop();
      continue;
    }
    out.push(part);
  }
  let joined = out.join("/");
  if (unc) joined = "//" + joined.replace(/^\/+/, "");
  if (joined === "") joined = "/";
  if (/^[A-Za-z]:$/.test(joined)) joined += "/";
  return win ? joined.toLowerCase() : joined;
}

/** Whether `child` is `parent` or inside it. */
export function pathWithin(child: string, parent: string): boolean {
  const c = normalPath(child);
  const p = normalPath(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith("/") ? p : p + "/");
}

// --- what a request or a row is about ----------------------------------------------------

/**
 * What a request or a row is about: its node, workspace and path as far as it says them, or
 * a session or an ask for the daemon to look up.
 */
export interface Target {
  node?: string;
  workspace?: string;
  path?: string;
  session?: string;
  ask?: string;
  /**
   * About the node as a whole, as its load is: in reach of access that reaches the node, or,
   * limited to workspaces or paths, anything on it. A target that names only a node without
   * this (its desktop) is out of reach of any workspace or path limit.
   */
  hosts?: boolean;
}

/** How the daemon looks up what a target names; undefined for what it does not know. */
export interface TargetLookup {
  /** This node's id: what a request that names no node is about. */
  self: string;
  session(id: string): { node: string; workspace?: string; path?: string } | undefined;
  ask(id: string): Target | undefined;
  workspace(id: string): { node: string; path: string } | undefined;
}

/** Whether limited access reaches what a target is about. Unlimited access reaches everything; a session or an ask the lookup does not know is out of reach. */
export function allows(a: Access, target: Target, look: TargetLookup): boolean {
  if (!isLimited(a)) return true;
  if (target.hosts && target.workspace === undefined && target.path === undefined && target.session === undefined && target.ask === undefined) {
    if (target.node === undefined) return false;
    if (a.nodes && !a.nodes.includes(target.node)) return false;
    if (a.workspaces && !a.workspaces.some((id) => look.workspace(id)?.node === target.node)) return false;
    return true;
  }
  let t: Target = { ...target };
  if (t.ask !== undefined) {
    const found = look.ask(t.ask);
    if (!found) return false;
    t = { ...found, ...stripUndefined(t) };
  }
  if (t.session !== undefined) {
    const found = look.session(t.session);
    if (!found) return false;
    t = { ...found, ...stripUndefined(t) };
  }
  if (a.nodes && (t.node === undefined || !a.nodes.includes(t.node))) return false;
  if (a.workspaces) {
    const inOne =
      (t.workspace !== undefined && a.workspaces.includes(t.workspace)) ||
      (t.path !== undefined &&
        a.workspaces.some((id) => {
          const w = look.workspace(id);
          return w !== undefined && (t.node === undefined || t.node === w.node) && pathWithin(t.path!, w.path);
        }));
    if (!inOne) return false;
  }
  if (a.paths && (t.path === undefined || !a.paths.some((p) => pathWithin(t.path!, p)))) return false;
  return true;
}

function stripUndefined(t: Target): Target {
  const out: Target = {};
  for (const [k, v] of Object.entries(t)) if (v !== undefined) out[k as keyof Target] = v;
  return out;
}

export const sessionTarget = (s: Pick<Session | ClientSession, "node" | "workspace" | "cwd">): Target => ({ node: s.node, ...(s.workspace !== undefined ? { workspace: s.workspace } : {}), path: s.cwd });
export const workspaceTarget = (w: Pick<Workspace | ClientWorkspace, "id" | "node" | "path">): Target => ({ node: w.node, workspace: w.id, path: w.path });
export const terminalTarget = (t: Pick<Terminal, "node" | "cwd">): Target => ({ node: t.node, path: t.cwd });
/** An ask is about its node, and a harness's ask about its session too; a gate's or the brain's is about no workspace. */
export const askTarget = (a: Pick<Ask, "node" | "source">): Target => ({ node: a.node, ...(a.source.kind === "harness" ? { session: a.source.session } : {}) });

// --- the tables --------------------------------------------------------------------------

/**
 * What a request is about. `global`: refused to limited access whatever its scopes. `open`:
 * about nothing a limit cuts (the caller itself, the views), with the answer's rows filtered
 * by `result` when it lists any. A function: the targets it names, each of which the access
 * must reach.
 */
export interface RequestFilter<N extends ClientRequestName> {
  /** `self` is this node's id, for a request that names no node. */
  names: "global" | "open" | ((p: ClientParams<N>, self: string) => Target[]);
  /** The answer as limited access gets it: the rows it cannot reach left out. */
  result?: (r: ClientResult<N>, keep: (t: Target) => boolean) => ClientResult<N>;
}

export const requestFilters = {
  hello: { names: "open" },
  "chat.send": { names: "global" },
  "chat.load": { names: "global" },
  "session.list": { names: "open", result: (r, keep) => ({ ...r, sessions: r.sessions.filter((s) => keep(sessionTarget(s))) }) },
  "session.history": { names: (p) => [{ session: p.id }] },
  "session.send": { names: (p) => [{ session: p.id }] },
  "session.focus": { names: (p) => [{ session: p.id }] },
  "session.stop": { names: (p) => [{ session: p.id }] },
  "session.watch": { names: (p) => p.ids.map((id) => ({ session: id })) },
  // the session's own directory, the path its target is checked by, and nothing above it
  "session.files": { names: (p) => [{ session: p.id }] },
  "session.git": { names: (p) => [{ session: p.id }] },
  "terminal.list": { names: "open", result: (r, keep) => ({ ...r, terminals: r.terminals.filter((t) => keep(terminalTarget(t))) }) },
  "terminal.spawn": { names: "global" },
  "terminal.open": { names: "global" },
  "terminal.close": { names: "global" },
  "ask.answer": { names: (p) => [{ ask: p.id }] },
  "task.list": { names: "global" },
  "task.create": { names: "global" },
  "task.update": { names: "global" },
  "workspace.list": { names: "open", result: (r, keep) => ({ ...r, workspaces: r.workspaces.filter((w) => keep(workspaceTarget(w))) }) },
  "workspace.put": { names: (p) => [{ node: p.node, path: p.path }, ...(p.id !== undefined ? [{ workspace: p.id, node: p.node }] : [])] },
  "event.list": { names: "global" },
  "voice.ptt": { names: "global" },
  "voice.wakeword": { names: "global" },
  "voice.wake": { names: "global" },
  // The node's speech, not any one session's.
  "voice.settings": { names: "global" },
  "voice.configure": { names: "global" },
  "voice.preview": { names: "global" },
  "voice.install": { names: "global" },
  "view.list": { names: "open" },
  "view.get": { names: "open" },
  // The default view is the node's, for every client.
  "view.setDefault": { names: "global" },
  "view.stage": { names: "open" },
  "pair.start": { names: "global" },
  "pair.claim": { names: "open" },
  "pair.account": { names: "open" },
  "invite.redeem": { names: "open" },
  "relay.info": { names: "open" },
  "push.register": { names: "open" },
  "push.unregister": { names: "open" },
  "controller.list": { names: "global" },
  "controller.revoke": { names: "global" },
  "grant.invite": { names: "global" },
  "grant.list": { names: "global" },
  "grant.revoke": { names: "global" },
  "node.list": { names: "global" },
  "node.promote": { names: "global" },
  "node.restart": { names: "global" },
  "node.join": { names: "global" },
  "node.leave": { names: "global" },
  // The node's brain, not any one session's.
  "listener.list": { names: "global" },
  "listener.remove": { names: "global" },
  "profile.list": { names: "global" },
  "profile.limits": { names: "global" },
  "profile.update": { names: "global" },
  "metrics.subscribe": { names: (p, self) => [{ node: p.node ?? self, hosts: true }] },
  "metrics.unsubscribe": { names: "open" },
  "metrics.history": { names: (p) => [{ node: p.node, hosts: true }] },
  "remote.pair": { names: (p) => [{ node: p.node }] },
  "remote.invite": { names: (p) => [{ node: p.node }] },
  "remote.open": { names: (p) => [{ node: p.node }] },
  // the stream this client opened, and the pipes of its page to the desktop's node
  "remote.close": { names: "open" },
  "remote.pipe.open": { names: (p, self) => [{ node: p.node ?? self }] },
  "remote.revoke": { names: (p) => [{ node: p.node }] },
  // a node's direct connections are its settings; a phone's own data channel is about nothing a limit cuts
  "direct.enable": { names: "global" },
  "direct.disable": { names: "global" },
  "direct.info": { names: "open" },
  "direct.offer": { names: "open" },
  "account.login": { names: "global" },
  "account.logout": { names: "global" },
  "backup.enable": { names: "global" },
  "backup.disable": { names: "global" },
  "backup.restore": { names: "global" },
  "update.check": { names: "global" },
  "update.apply": { names: "global" },
} as const satisfies { [N in ClientRequestName]: RequestFilter<N> };

/** What a notification is about: `global` rows reach no limited client, `open` ones every client, the rest only those that reach the target. */
export type NotificationFilter<N extends ClientNotificationName> = "global" | "open" | ((p: ClientNotificationParams<N>) => Target);

export const notificationFilters = {
  "chat.message": "global",
  "chat.delta": "global",
  "chat.retract": "global",
  "session.state": (p) => sessionTarget(p),
  "session.event": (p) => ({ session: p.session }),
  "terminal.state": (p) => terminalTarget(p),
  "terminal.output": "global",
  "task.state": "global",
  "thread.state": "global",
  "workspace.state": (p) => workspaceTarget(p),
  "ask.state": (p) => askTarget(p),
  "voice.state": "global",
  "voice.audio": "global",
  "voice.setup": "global",
  "view.content": "open",
  "view.changed": "open",
  "node.state": "global",
  "metrics.sample": (p) => ({ node: p.node, hosts: true }),
  "remote.state": (p) => ({ node: p.node }),
  "direct.state": "global",
  // a client's own data channel and pipes, sent to it alone
  "direct.candidate": "open",
  "remote.pipe.data": "open",
  "remote.pipe.ack": "open",
  "remote.pipe.close": "open",
  "audit.entry": "global",
  "account.state": "global",
  "update.state": "global",
} as const satisfies { [N in ClientNotificationName]: NotificationFilter<N> };

/** The requests refused to limited access whatever its scopes. */
export const GLOBAL_REQUESTS: readonly ClientRequestName[] = (Object.keys(requestFilters) as ClientRequestName[]).filter((n) => requestFilters[n].names === "global");

/**
 * Why limited access may not make a request, or undefined when it may: a global request, a
 * target out of reach, or an answer remembered for always (a rule that outlives the ask
 * would reach past the limits).
 */
export function refuseRequest<N extends ClientRequestName>(a: Access, name: N, params: ClientParams<N>, look: TargetLookup): string | undefined {
  if (!isLimited(a)) return undefined;
  const filter = requestFilters[name] as RequestFilter<N>;
  if (filter.names === "global") return `${name} is not for limited access`;
  if (name === "ask.answer" && (params as ClientParams<"ask.answer">).remember === "always") return "limited access cannot answer for always";
  if (filter.names === "open") return undefined;
  for (const t of filter.names(params, look.self)) if (!allows(a, t, look)) return `${name} reaches past this access`;
  return undefined;
}

/** A request's answer as limited access gets it: the rows it cannot reach left out. */
export function filterResult<N extends ClientRequestName>(a: Access, name: N, result: ClientResult<N>, look: TargetLookup): ClientResult<N> {
  if (!isLimited(a)) return result;
  const filter = requestFilters[name] as RequestFilter<N>;
  return filter.result ? filter.result(result, (t) => allows(a, t, look)) : result;
}

/** Whether a notification reaches a client with this access. */
export function allowsNotification<N extends ClientNotificationName>(a: Access, name: N, params: ClientNotificationParams<N>, look: TargetLookup): boolean {
  if (!isLimited(a)) return true;
  const filter = notificationFilters[name] as NotificationFilter<N>;
  if (filter === "global") return false;
  if (filter === "open") return true;
  return allows(a, filter(params), look);
}

/**
 * A sample as a limited watcher gets it: every process that belongs to a session out of reach,
 * and every process nobody owns, summed into one `other` row, so the node's load stays whole
 * without saying what else runs there.
 */
export function trimSample(sample: MetricsSample, keep: (session: string) => boolean): MetricsSample {
  const kept: MetricsSample["processes"] = [];
  let other: MetricsSample["processes"][number] | undefined;
  for (const p of sample.processes) {
    if (p.owner.kind === "session" && keep(p.owner.session)) {
      kept.push(p);
      continue;
    }
    if (p.owner.kind === "platform" || p.owner.kind === "brain" || p.owner.kind === "sidecar") {
      kept.push(p);
      continue;
    }
    other ??= { pid: 0, parent: 0, name: "other", cpu: 0, memory: 0, owner: { kind: "other" } };
    other.cpu += p.cpu;
    other.memory += p.memory;
    if (p.vram !== undefined) other.vram = (other.vram ?? 0) + p.vram;
  }
  return { ...sample, processes: other ? [...kept, other] : kept };
}
