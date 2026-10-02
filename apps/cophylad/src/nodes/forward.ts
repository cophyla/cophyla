// Forwarding on the primary: one wrapper over both method tables (the clients' and the
// brain's). A request that names a session, an ask, a workspace or a terminal another node
// owns goes to that node over the link, gated there as principal `node`; one that names a
// `node` goes to it, and a tool run or a terminal started in a workspace goes where the
// workspace is; a terminal opened or closed on another node goes with the client it is for
// (terminals.ts); the list requests merge this node's rows with the mirrors or a fan-out;
// the rest run here. The caller's own gate still runs first, on the primary, so a forwarded
// write is asked about twice by default: once as the caller's class here, once as the
// node's class there. `[gate.rules] "node:session.send" = "allow"` on a node that trusts
// its primary removes the second.

import { RpcError } from "@cophyla/protocol";
import type { Ask, ClientKind, ClientParams, ClientResult, NodeRecord, Session, SpendTotals, Terminal, Workspace } from "@cophyla/protocol";
import type { Chat } from "../chat/index.ts";
import { intervalFor } from "../metrics/delivery.ts";
import type { ProcessDetail } from "../metrics/delivery.ts";

export interface ForwardHost {
  selfId(): string;
  ownerOfSession(id: string): string | undefined;
  ownerOfAsk(id: string): string | undefined;
  ownerOfWorkspace(id: string): string | undefined;
  ownerOfTerminal(id: string): string | undefined;
  /** A terminal a node answered it started: mirrored at once, so the client that opens it next is routed to it before the node's own row comes up. */
  noteTerminal(node: string, t: Terminal): void;
  mirrorAsk(id: string): Ask | undefined;
  mirrorSessions(): Session[];
  mirrorWorkspaces(): Workspace[];
  mirrorTerminals(): Terminal[];
  registryList(): NodeRecord[];
  /** Whether the node is linked now, so a forward can fail fast. */
  linked(node: string): boolean;
  forward(node: string, method: string, params: unknown, opts: { signal?: AbortSignal; onPending?: (ask: Ask) => void }): Promise<unknown>;
  /** The same request to every linked node; a node that fails or times out is left out. */
  fanout(method: string, params: unknown): Promise<Map<string, unknown>>;
  remoteMetrics: {
    subscribe(client: string, node: string, intervalMs: number, processes: ProcessDetail, spend?: { from?: number; to?: number }): Promise<{ spend?: SpendTotals }>;
    unsubscribe(client: string): Promise<void>;
  };
  /** A terminal of another node opened and closed for a client, whose output then comes to it alone. */
  remoteTerminals: {
    open(client: string, node: string, p: ClientParams<"terminal.open">, opts: { signal?: AbortSignal; onPending?: (ask: Ask) => void }): Promise<ClientResult<"terminal.open">>;
    close(client: string, node: string, p: ClientParams<"terminal.close">, opts: { signal?: AbortSignal; onPending?: (ask: Ask) => void }): Promise<ClientResult<"terminal.close">>;
  };
  chat: Pick<Chat, "peek" | "touchSession">;
  /** The local workspace rows, so `workspace.list` shows this node's and the mirrors' without the stale rows of a node that is away. */
  localWorkspaces(): Workspace[];
}

/** The two tables share this shape: a target for the audit, an optional risk, the ask's words, whether it is on the caller's own, a handler. */
interface Entry {
  target?: (p: unknown) => string | undefined;
  risk?: (p: unknown) => string | undefined;
  ask?: (p: unknown) => { title: string; detail?: string };
  own?: (p: unknown) => boolean;
  handler: (p: unknown, ctx: unknown) => unknown;
}

interface Ctx {
  signal?: AbortSignal;
  onPending?: (ask: Ask) => void;
  client?: { id: string; kind: ClientKind };
  principal?: { kind: string };
}

type Route = { kind: "node"; node: string } | { kind: "merge" } | { kind: "local" };

const P = (p: unknown) => p as Record<string, unknown>;

/** Where a request goes: the owner of what it names, the node it names, a merge, or here. */
export function routeOf(name: string, params: unknown, host: ForwardHost): Route {
  const p = P(params);
  const self = host.selfId();
  const node = (id: string | undefined): Route => (id !== undefined && id !== self ? { kind: "node", node: id } : { kind: "local" });
  switch (name) {
    case "session.history":
    case "session.send":
    case "session.focus":
    case "session.stop":
    case "session.mode":
    case "session.files":
    case "session.git":
    case "session.file":
      return node(host.ownerOfSession(p["id"] as string));
    case "ask.answer":
      return node(host.ownerOfAsk(p["id"] as string));
    case "terminal.open":
    case "terminal.close":
    case "terminal.file":
    case "terminal.prompt":
      return node(host.ownerOfTerminal(p["terminal"] as string));
    case "terminal.spawn": {
      // A shell in a workspace starts where the workspace is; else on the node named.
      const workspace = p["workspace"] as string | undefined;
      if (workspace !== undefined) return node(host.ownerOfWorkspace(workspace) ?? host.localWorkspaces().find((w) => w.id === workspace)?.node);
      return node(p["node"] as string | undefined);
    }
    case "annotate": {
      const on = p["on"] as string;
      return node(host.ownerOfSession(on) ?? host.ownerOfWorkspace(on));
    }
    case "session.spawn":
      return node(host.ownerOfWorkspace(p["workspace"] as string) ?? host.localWorkspaces().find((w) => w.id === p["workspace"])?.node);
    case "tool.run": {
      // A tool run in a workspace runs where the workspace is, unless the node is named.
      const workspace = (p["args"] as Record<string, unknown> | undefined)?.["workspace"];
      return node((p["node"] as string | undefined) ?? (typeof workspace === "string" ? host.ownerOfWorkspace(workspace) : undefined));
    }
    case "event.history":
    case "workspace.put":
    case "recall":
    case "metrics.query":
    case "metrics.history":
    // The desktop's owner pairs, invites, revokes, captures and switches sharing; `remote.open` runs where the client is and is never here.
    case "remote.pair":
    case "remote.invite":
    case "remote.revoke":
    case "remote.screenshot":
    case "remote.enable":
    case "remote.disable":
    // Direct connections are each node's own to switch.
    case "direct.enable":
    case "direct.disable":
    // The picker lists a folder of the computer a terminal is to start on.
    case "terminal.folders":
      return node(p["node"] as string | undefined);
    case "profile.list":
    case "profile.limits":
      return p["node"] === undefined ? { kind: "merge" } : node(p["node"] as string);
    case "profile.update":
      return node(p["node"] as string);
    case "session.list":
    case "workspace.list":
    case "terminal.list":
    case "node.list":
    case "tool.list":
    case "event.list":
      return { kind: "merge" };
    default:
      return { kind: "local" };
  }
}

type Merge = (local: unknown, params: unknown, host: ForwardHost) => Promise<unknown>;

const byActivity = (a: { lastActivity: number }, b: { lastActivity: number }) => b.lastActivity - a.lastActivity;

/** The list merges: this node's rows with the mirrors, or with a fan-out, one row per id. */
export const merges: Record<string, Merge> = {
  "session.list": async (local, params, host) => {
    const filter = (P(params)["filter"] ?? {}) as { node?: string; harness?: string; status?: string[]; workspace?: string };
    const mine = (local as { sessions: Session[] }).sessions;
    const remote = host
      .mirrorSessions()
      .filter((s) => filter.node === undefined || s.node === filter.node)
      .filter((s) => filter.harness === undefined || s.harness === filter.harness)
      .filter((s) => filter.workspace === undefined || s.workspace === filter.workspace)
      .filter((s) => !filter.status || filter.status.length === 0 || filter.status.includes(s.status));
    return { sessions: dedupe([...mine, ...remote]).sort(byActivity) };
  },
  "workspace.list": async (_local, _params, host) => ({ workspaces: dedupe([...host.localWorkspaces(), ...host.mirrorWorkspaces()]).sort(byActivity) }),
  "terminal.list": async (local, _params, host) => ({ terminals: dedupe([...(local as { terminals: Terminal[] }).terminals, ...host.mirrorTerminals()]) }),
  "node.list": async (_local, _params, host) => ({ nodes: host.registryList() }),
  "tool.list": async (local, params, host) => {
    const mine = (local as { tools: { name: string; node: string }[] }).tools;
    const others = await host.fanout("tool.list", params);
    const remote = [...others.values()].flatMap((r) => ((r as { tools?: { name: string; node: string }[] }).tools ?? []).filter((t) => t.node !== host.selfId()));
    return { tools: [...mine, ...remote] };
  },
  "event.list": async (local, params, host) => {
    const mine = (local as { events: { name: string; node: string }[] }).events;
    const others = await host.fanout("event.list", params);
    const remote = [...others.values()].flatMap((r) => ((r as { events?: { name: string; node: string; source: unknown }[] }).events ?? []).filter((e) => e.node !== host.selfId() && e.source !== "builtin"));
    return { events: [...mine, ...remote] };
  },
  "profile.list": async (local, params, host) => {
    const mine = (local as { profiles: { id: string }[] }).profiles;
    const others = await host.fanout("profile.list", params);
    const remote = [...others.values()].flatMap((r) => (r as { profiles?: { id: string }[] }).profiles ?? []);
    return { profiles: dedupe([...mine, ...remote]) };
  },
  "profile.limits": async (local, params, host) => {
    const limits = { ...(local as { limits: Record<string, unknown> }).limits };
    const others = await host.fanout("profile.limits", params);
    for (const r of others.values()) for (const [id, l] of Object.entries((r as { limits?: Record<string, unknown> }).limits ?? {})) if (!(id in limits)) limits[id] = l;
    return { limits };
  },
};

function dedupe<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/** What runs on the primary after a forwarded call answered, by the node that answered it. */
const after: Record<string, (result: unknown, params: unknown, host: ForwardHost, node: string) => void> = {
  "session.spawn": (result, _params, host) => {
    const thread = host.chat.peek();
    const id = (result as { id?: string }).id;
    if (thread && id) host.chat.touchSession(thread.id, id);
  },
  "terminal.prompt": (result, _params, host) => {
    const thread = host.chat.peek();
    const id = (result as { id?: string }).id;
    if (thread && id) host.chat.touchSession(thread.id, id);
  },
  "terminal.spawn": (result, _params, host, node) => {
    const t = (result as { terminal?: Terminal }).terminal;
    if (t?.node === node) host.noteTerminal(node, t);
  },
};

/** Wraps a method table: every entry keeps its target and risk, and its handler routes first. */
export function withForwarding<T extends object>(table: T, host: ForwardHost): T {
  const out: Record<string, Entry> = {};
  for (const [name, entry] of Object.entries(table) as [string, Entry | undefined][]) {
    if (!entry) continue;
    // Everything an entry says about itself (its target, its words, what its audit row redacts) is kept; the handler routes first.
    const wrapped: Entry = {
      ...entry,
      // A session the brain started on another node is its own there too: the mirror knows its origin.
      ...(entry.own
        ? {
            own: (p: unknown) => entry.own!(p) || ((name === "session.send" || name === "session.stop") && host.mirrorSessions().some((s) => s.id === P(p)["id"] && s.origin === "orchestrator")),
          }
        : {}),
      // A tool run elsewhere is gated here at its risk when this node knows the tool, else as exec; the owner re-gates with the tool's own risk.
      ...(entry.risk
        ? {
            risk: (p: unknown) => {
              const risk = entry.risk!(p);
              return risk === undefined && name === "tool.run" && routeOf(name, p, host).kind === "node" ? "exec" : risk;
            },
          }
        : {}),
      handler: async (p: unknown, ctx: unknown) => {
        const c = (ctx ?? {}) as Ctx;
        if (name === "metrics.subscribe" && c.client) {
          const node = P(p)["node"] as string | undefined;
          if (node !== undefined && node !== host.selfId()) {
            return host.remoteMetrics.subscribe(c.client.id, node, intervalFor(c.client.kind, P(p)["intervalMs"] as number), (P(p)["processes"] as ProcessDetail | undefined) ?? "all", P(p)["spend"] as { from?: number; to?: number } | undefined);
          }
        }
        if (name === "metrics.unsubscribe" && c.client) await host.remoteMetrics.unsubscribe(c.client.id);
        const route = routeOf(name, p, host);
        if (route.kind === "node") {
          if (name === "ask.answer") {
            // The owner answers under principal node, which checks nothing: the primary checks who may answer.
            const ask = host.mirrorAsk(P(p)["id"] as string);
            const by = c.principal?.kind === "brain" ? "brain" : "user";
            if (ask && !ask.answerableBy.includes(by)) throw new RpcError("denied", `ask ${ask.id} is not answerable by the ${by}`);
          }
          if (!host.linked(route.node)) {
            const known = host.registryList().some((n) => n.id === route.node);
            throw known ? new RpcError("unavailable", `node ${route.node} is not linked`) : new RpcError("not_found", `no node ${route.node}`);
          }
          const opts = { ...(c.signal ? { signal: c.signal } : {}), ...(c.onPending ? { onPending: c.onPending } : {}) };
          // A terminal is opened for a client, whose output then comes to it alone.
          if (name === "terminal.open" && c.client) return host.remoteTerminals.open(c.client.id, route.node, p as ClientParams<"terminal.open">, opts);
          if (name === "terminal.close" && c.client) return host.remoteTerminals.close(c.client.id, route.node, p as ClientParams<"terminal.close">, opts);
          // The owner types a user's message and pipes the brain's, and ends a session of the
          // user's only for the user: it learns who asked from here.
          const params = name === "session.send" || name === "session.stop" ? { ...P(p), as: c.principal?.kind === "brain" ? "brain" : "user" } : p;
          const result = await host.forward(route.node, name, params, opts);
          after[name]?.(result, p, host, route.node);
          return result;
        }
        const local = await entry.handler(p, ctx);
        if (route.kind === "merge" && merges[name]) return merges[name]!(local, p, host);
        return local;
      },
    };
    out[name] = wrapped;
  }
  return out as unknown as T;
}
