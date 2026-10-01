// What a node serves the primary: the slice of the capability table a forwarded request
// may reach, run through this node's gate as principal `{kind: node}` with the link as the
// session key, so each machine enforces its own policy and keeps its own audit row. A
// request held on an ask reports `pending` up the link; `cancel` is served first, before
// the table; `metrics.subscribe`, `metrics.unsubscribe` and `metrics.history` (client
// methods, not capability ones) are served here too, so the primary's clients can watch
// this node, `remote.invite` and `remote.revoke` likewise, so they can hand out and take
// back access to this desktop, `profile.update`, so they can set this node's profiles,
// `direct.enable` and `direct.disable`, so they can switch this node's direct connections,
// and `session.files`, `session.git` and `session.file`, so their explorer shows this node's
// sessions' files and their viewer a file's text.
//
// On a node whose owner shared some folders alone (`confine.ts`) this is where the primary's
// requests are checked: a session, a workspace or a path outside is refused, and so is the
// state of a repository whose root is above them; the lists and the searches answer what is
// inside, and the audit row keeps that answer; editable and network tools, the desktop and
// this node's profiles are refused. An ask this node does not hold, or one about something
// outside, is `not_found`. On a node that answers its asks itself (`--answer-here`), the
// primary answers none of them.

import { capabilityRequests, clientRequests, RpcError } from "@cophyla/protocol";
import type { Ask, CapabilityRequestName, CapabilityResult, FileText, Hit, MetricsSample, Principal, RiskClass, RpcId, Session, ToolDefinition, ToolSource, Workspace } from "@cophyla/protocol";
import type { Confinement } from "./confine.ts";
import type { ToolConfinement } from "../tools/index.ts";
import { brainMethods, sendOptions } from "../brain-link/methods.ts";
import type { BrainMethodContext, BrainMethodDeps, BrainMethodTable } from "../brain-link/methods.ts";
import type { Gate } from "../gate/index.ts";
import type { Logger } from "../log.ts";
import type { Metrics } from "../metrics/index.ts";
import type { Remote } from "../remote/index.ts";
import { updatePatch } from "../api/methods.ts";
import type { Profiles } from "../sessions/profiles.ts";
import { fileSummary, listingSummary } from "../sessions/files.ts";
import type { FilesResult, SessionFiles } from "../sessions/files.ts";
import type { Direct } from "../direct/index.ts";
import { findRepo } from "../workspaces/index.ts";

/** The capability requests a node answers for its primary. */
export const NODE_SERVED: readonly CapabilityRequestName[] = [
  "node.list",
  "profile.list",
  "profile.limits",
  "session.list",
  "session.history",
  "session.send",
  "session.spawn",
  "session.stop",
  "session.mode",
  "ask.answer",
  "annotate",
  "workspace.list",
  "workspace.put",
  "event.list",
  "event.history",
  "tool.list",
  "tool.run",
  "recall",
  "metrics.query",
  "remote.pair",
  "remote.screenshot",
];

/** The client-protocol metrics requests a node serves over the link, on top of the capability slice. */
export const NODE_SERVED_METRICS = ["metrics.subscribe", "metrics.unsubscribe", "metrics.history"] as const;
/** The client-protocol remote requests a node serves the same way: an invite from, and a revoke on, this desktop's host. */
export const NODE_SERVED_REMOTE = ["remote.invite", "remote.revoke"] as const;
/** And what the user sets on this node's profiles from an app on the primary. */
export const NODE_SERVED_PROFILES = ["profile.update"] as const;

/** The direct connections' switch, served for the primary's clients. */
export const NODE_SERVED_DIRECT = ["direct.enable", "direct.disable"] as const;

/** A session's folders, repository and files, for the explorer and the viewer of a view on the primary. */
export const NODE_SERVED_FILES = ["session.files", "session.git", "session.file"] as const;

/**
 * The served table: `brainMethods` narrowed to the allowlist, with `ui.say` and its kin never
 * reachable. `ask.answer` answers as the primary node, not as the brain: the primary already
 * checked who may answer, and the answer is recorded as coming through it.
 */
export function nodeServedTable(deps: BrainMethodDeps, primaryId: string, opts: { confine?: () => ToolConfinement | undefined } = {}): BrainMethodTable {
  const all = brainMethods(deps) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const name of NODE_SERVED) if (all[name]) out[name] = all[name];
  // A tool run for the primary on a confined node reaches its folders alone.
  const run: BrainMethodTable["tool.run"] = {
    target: (p) => p.name,
    risk: (p) => deps.tools.risk(p.name),
    handler: async (p, ctx) => {
      const confine = opts.confine?.();
      return { result: await deps.tools.run(p.name, p.args, { signal: ctx.signal, ...(confine ? { confine } : {}) }) };
    },
  };
  out["tool.run"] = run;
  const answer: BrainMethodTable["ask.answer"] = {
    target: (p) => p.id,
    handler: (p) => {
      const input: { option: string; options?: string[]; text?: string } = { option: p.option };
      if (p.options !== undefined) input.options = p.options;
      if (p.text !== undefined) input.text = p.text;
      deps.asks.answer(p.id, input, { kind: "node", id: primaryId });
      return {};
    },
  };
  out["ask.answer"] = answer;
  // A message forwarded by the primary says whose it is; the brain's own table never asks.
  const send: BrainMethodTable["session.send"] = {
    target: (p) => p.id,
    handler: (p) => deps.sessions.send(p.id, p.text, sendOptions(p, p.as ?? "brain")),
  };
  out["session.send"] = send;
  // So does a stop: the user's may end a session of their own.
  const stop: BrainMethodTable["session.stop"] = {
    target: (p) => p.id,
    handler: async (p) => {
      await deps.sessions.stopSession(p.id, { as: p.as ?? "brain" });
      return {};
    },
  };
  out["session.stop"] = stop;
  return out as BrainMethodTable;
}

export interface ServeDeps {
  gate: Gate;
  table: BrainMethodTable;
  principal: Principal & { kind: "node" };
  /** The link id: the gate's session key for remembered answers. */
  sessionKey: string;
  log: Logger;
  /** Reports a held request up the link. */
  onPending: (id: RpcId, ask: Ask) => void;
  metrics?: Pick<Metrics, "subscribe" | "unsubscribe" | "history">;
  /** The subscriber id the metrics module delivers this link's samples to. */
  metricsSubscriber: string;
  remote?: Remote;
  /** This node's profiles, for `profile.update`. */
  profiles?: Pick<Profiles, "update">;
  direct?: Direct;
  /** This node's sessions' folders, repositories and files, for `session.files`, `session.git` and `session.file`. */
  files?: Pick<SessionFiles, "list" | "git" | "read">;
  /** The folders this node shares with its primary, when its owner named some. */
  confine?: () => Confinement | undefined;
  /** This node answers the asks raised on it itself: the primary answers none. */
  answerHere?: () => boolean;
  /** This node's own sessions, workspaces and asks, for the checks. */
  local?: {
    session(id: string): Session | undefined;
    workspace(id: string): Workspace | undefined;
    ask(id: string): Ask | undefined;
  };
  /** Where a tool comes from and its risk: an editable or a network tool is refused on a confined node. */
  tools?: { source(name: string): ToolSource | undefined; risk(name: string): RiskClass | undefined };
  now?: () => number;
}

/** A capability request's params as the checks read them. */
type Params = Record<string, unknown>;

interface InFlight {
  controller: AbortController;
  method: string;
}

/** Serves one request from the primary; the returned map holds what is in flight for `cancel`. */
export class NodeServer {
  private deps: ServeDeps;
  private inflight = new Map<string, InFlight>();

  constructor(deps: ServeDeps) {
    this.deps = deps;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  /** Aborts everything in flight: the link is gone. */
  abortAll(): void {
    for (const [id, f] of this.inflight) {
      this.inflight.delete(id);
      f.controller.abort();
    }
  }

  /** The folders this node shares, when its owner named some; undefined when the primary sees the machine. */
  private confined(): Confinement | undefined {
    const c = this.deps.confine?.();
    return c?.active ? c : undefined;
  }

  /**
   * Refuses what the primary may not ask here: an ask this node answers itself, and on a
   * confined node anything that reaches past the folders it shares.
   */
  private refuse(name: string, p: Params): void {
    const local = this.deps.local;
    const c = this.confined();
    if (name === "ask.answer") {
      // An ask this node does not hold, or one about something outside, is not the primary's to know of.
      const id = String(p["id"]);
      const ask = local?.ask(id);
      if (local && (!ask || (c && !c.ask(ask, (s) => local.session(s))))) throw new RpcError("not_found", `no ask ${id}`);
      if (ask && this.deps.answerHere?.()) throw new RpcError("denied", "this node answers its own asks");
      return;
    }
    if (!c) return;
    switch (name) {
      case "session.history":
      case "session.send":
      case "session.stop":
      case "session.mode": {
        const s = local?.session(String(p["id"]));
        c.require(s?.cwd, "that session");
        return;
      }
      case "annotate": {
        const on = String(p["on"]);
        if (on.startsWith("ws_")) c.require(local?.workspace(on)?.path, "that workspace");
        else c.require(local?.session(on)?.cwd, "that session");
        if (typeof p["workspace"] === "string") c.require(local?.workspace(p["workspace"])?.path, "that workspace");
        return;
      }
      case "session.spawn":
        c.require(local?.workspace(String(p["workspace"]))?.path, "that workspace");
        return;
      case "workspace.put":
        c.require(String(p["path"]), "that folder");
        if (typeof p["id"] === "string" && local?.workspace(p["id"])) c.require(local.workspace(p["id"])!.path, "that workspace");
        return;
      case "tool.run": {
        const tool = String(p["name"]);
        if (this.deps.tools?.source(tool) === "editable") throw new RpcError("denied", "this node shares folders alone: its editable tools are not run for the primary");
        if (this.deps.tools?.risk(tool) === "network") throw new RpcError("denied", "this node shares folders alone: it makes no requests to the network for the primary");
        return;
      }
      case "remote.pair":
      case "remote.screenshot":
        throw new RpcError("denied", "this node shares folders alone, not its desktop");
      default:
        return;
    }
  }

  /** What a confined node answers of a list or a search: what is inside the folders it shares. */
  private shape(name: string, result: unknown): unknown {
    const c = this.confined();
    if (!c) return result;
    const local = this.deps.local;
    const sessionOf = (id: string) => local?.session(id);
    switch (name) {
      case "session.list": {
        const r = result as CapabilityResult<"session.list">;
        return { ...r, sessions: r.sessions.filter((s) => c.session(s)) };
      }
      case "workspace.list": {
        const r = result as CapabilityResult<"workspace.list">;
        return { ...r, workspaces: r.workspaces.filter((w) => c.workspace(w)) };
      }
      case "event.history": {
        const r = result as CapabilityResult<"event.history">;
        // an event is shared when it is about a session inside
        return { ...r, events: r.events.filter((e) => {
          const session = (e.payload as { session?: unknown } | null)?.session;
          const s = typeof session === "string" ? sessionOf(session) : undefined;
          return s !== undefined && c.session(s);
        }) };
      }
      case "recall": {
        const r = result as { hits: Hit[] };
        return { ...r, hits: r.hits.filter((h) => {
          if (h.source.kind === "session") {
            const s = sessionOf(h.source.session);
            return s !== undefined && c.session(s);
          }
          if (h.source.kind === "file") return c.contains(h.source.path);
          return false;
        }) };
      }
      case "metrics.query":
      case "metrics.history": {
        const r = result as { samples: MetricsSample[] };
        return { ...r, samples: r.samples.map((s) => c.sample(s, sessionOf)) };
      }
      case "tool.list": {
        const r = result as { tools: ToolDefinition[] };
        return { ...r, tools: r.tools.filter((t) => t.source !== "editable" && t.risk !== "network") };
      }
      default:
        return result;
    }
  }

  async serve(method: string, params: unknown, id: RpcId): Promise<unknown> {
    if (method === "cancel") return this.cancel(params);
    if ((NODE_SERVED_METRICS as readonly string[]).includes(method)) return this.serveMetrics(method as (typeof NODE_SERVED_METRICS)[number], params);
    if ((NODE_SERVED_REMOTE as readonly string[]).includes(method)) {
      if (this.confined()) throw new RpcError("denied", "this node shares folders alone, not its desktop");
      return this.serveRemote(method as (typeof NODE_SERVED_REMOTE)[number], params);
    }
    if ((NODE_SERVED_PROFILES as readonly string[]).includes(method)) {
      // a profile names a command and a folder of its own: not the primary's to change on a confined node
      if (this.confined()) throw new RpcError("denied", "this node shares folders alone: its profiles are its own");
      return this.serveProfile(params);
    }
    if ((NODE_SERVED_DIRECT as readonly string[]).includes(method)) return this.serveDirect(method as (typeof NODE_SERVED_DIRECT)[number], params);
    if ((NODE_SERVED_FILES as readonly string[]).includes(method)) return this.serveFiles(method as (typeof NODE_SERVED_FILES)[number], params);
    const name = method as CapabilityRequestName;
    const def = capabilityRequests[name];
    const impl = this.deps.table[name];
    if (!def || !impl) throw new RpcError("unsupported", `${method} is not served over the node link`);
    const parsed = def.params.safeParse(params ?? {});
    if (!parsed.success) throw new RpcError("invalid", `bad params for ${method}`, parsed.error.issues);
    const p = parsed.data;
    this.refuse(name, p as Params);
    const key = String(id);
    const controller = new AbortController();
    this.inflight.set(key, { controller, method });
    const target = (impl as { target?: (p: unknown) => string | undefined }).target?.(p);
    const risk = (impl as { risk?: (p: unknown) => RiskClass | undefined }).risk?.(p);
    const ask = (impl as { ask?: (p: unknown) => { title: string; detail?: string } }).ask?.(p);
    if (name === "tool.run" && risk === undefined) {
      this.inflight.delete(key);
      throw new RpcError("not_found", `no tool ${(p as { name: string }).name}`);
    }
    try {
      const result = await this.deps.gate.run(
        {
          principal: this.deps.principal,
          action: method,
          args: p,
          ...(target !== undefined ? { target } : {}),
          ...(risk !== undefined ? { risk } : {}),
          ...(ask ? { ask } : {}),
          sessionKey: this.deps.sessionKey,
        },
        // Shaped inside, so the audit row keeps what the primary was answered, not the whole list.
        async (gctx) => {
          const ctx: BrainMethodContext = {
            audit: gctx.audit,
            id,
            signal: controller.signal,
            delta: () => undefined,
            onPending: (ask) => this.deps.onPending(id, ask),
          };
          return this.shape(name, await (impl as { handler: (p: unknown, c: BrainMethodContext) => unknown }).handler(p, ctx));
        },
        { onPending: (ask) => this.deps.onPending(id, ask), signal: controller.signal },
      );
      return result;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      this.deps.log.error("forwarded request failed", { method, error: e });
      throw new RpcError("unavailable", e instanceof Error ? e.message : String(e));
    } finally {
      this.inflight.delete(key);
    }
  }

  private async cancel(params: unknown): Promise<unknown> {
    const parsed = capabilityRequests.cancel.params.safeParse(params ?? {});
    if (!parsed.success) throw new RpcError("invalid", "bad params for cancel", parsed.error.issues);
    const target = String(parsed.data.id);
    return this.deps.gate.run({ principal: this.deps.principal, action: "cancel", args: parsed.data, target, sessionKey: this.deps.sessionKey }, () => {
      const f = this.inflight.get(target);
      if (f) f.controller.abort();
      return { cancelled: f !== undefined };
    });
  }

  /** A profile of this node set from an app on the primary: gated here, as the owner's policy says. */
  private async serveProfile(params: unknown): Promise<unknown> {
    const profiles = this.deps.profiles;
    if (!profiles) throw new RpcError("unsupported", "this node has no profiles to set");
    const parsed = clientRequests["profile.update"].params.safeParse(params ?? {});
    if (!parsed.success) throw new RpcError("invalid", "bad params for profile.update", parsed.error.issues);
    const p = parsed.data;
    return this.deps.gate.run({ principal: this.deps.principal, action: "profile.update", args: p, target: p.id, sessionKey: this.deps.sessionKey }, () => ({ profile: profiles.update(p.id, updatePatch(p.patch)) }));
  }

  /** An invite from, or a revoke on, this node's own desktop host, for the primary's clients. */
  private async serveRemote(method: (typeof NODE_SERVED_REMOTE)[number], params: unknown): Promise<unknown> {
    const remote = this.deps.remote;
    if (!remote) throw new RpcError("unsupported", "this node has no remote module");
    const def = clientRequests[method];
    const parsed = def.params.safeParse(params ?? {});
    if (!parsed.success) throw new RpcError("invalid", `bad params for ${method}`, parsed.error.issues);
    const p = parsed.data as { node: string; viewer?: string };
    return this.deps.gate.run({ principal: this.deps.principal, action: method, args: p, target: p.viewer ?? p.node, sessionKey: this.deps.sessionKey }, (): Promise<unknown> =>
      method === "remote.invite" ? remote.invite() : remote.revoke(p.viewer!),
    );
  }

  /** This node's direct connections switched on or off, for the primary's clients. */
  private async serveDirect(method: (typeof NODE_SERVED_DIRECT)[number], params: unknown): Promise<unknown> {
    const direct = this.deps.direct;
    if (!direct) throw new RpcError("unsupported", "this node has no direct connections");
    const parsed = clientRequests[method].params.safeParse(params ?? {});
    if (!parsed.success) throw new RpcError("invalid", `bad params for ${method}`, parsed.error.issues);
    const p = parsed.data;
    return this.deps.gate.run({ principal: this.deps.principal, action: method, args: p, ...(p.node !== undefined ? { target: p.node } : {}), sessionKey: this.deps.sessionKey }, async () => {
      if (method === "direct.enable") await direct.enable();
      else await direct.disable();
      return {};
    });
  }

  /**
   * A session's folders, repository or a file, for the primary's clients. On a node that
   * shares some folders alone, a session outside them is not the primary's to look into; one
   * inside lists and reads nothing above its own directory.
   */
  private async serveFiles(method: (typeof NODE_SERVED_FILES)[number], params: unknown): Promise<unknown> {
    const files = this.deps.files;
    if (!files) throw new RpcError("unsupported", "this node lists no files");
    const parsed = clientRequests[method].params.safeParse(params ?? {});
    if (!parsed.success) throw new RpcError("invalid", `bad params for ${method}`, parsed.error.issues);
    const p = parsed.data as { id: string; dirs?: string[]; path?: string; image?: true; whole?: true; at?: number; log?: number };
    const c = this.confined();
    const cwd = this.deps.local?.session(p.id)?.cwd;
    c?.require(cwd, "that session");
    // A repository's state names files from its root: one whose root is above the folders would show what is outside.
    if (c && method === "session.git" && cwd !== undefined) {
      const repo = findRepo(cwd);
      if (repo && !c.contains(repo.root, true)) throw new RpcError("denied", "that session's repository reaches above the folders this node shares");
    }
    const redactResult = method === "session.files" ? (r: unknown) => listingSummary(r as FilesResult) : method === "session.file" ? (r: unknown) => fileSummary(r as FileText) : undefined;
    return this.deps.gate.run({ principal: this.deps.principal, action: method, args: p, target: p.id, sessionKey: this.deps.sessionKey, ...(redactResult ? { redactResult } : {}) }, async () => {
      if (method === "session.files") return files.list(p.id, p.dirs);
      if (method === "session.file") return files.read(p.id, p.path ?? "", { image: p.image === true, whole: p.whole === true, ...(p.at !== undefined ? { at: p.at } : {}) });
      const git = await files.git(p.id, p.log);
      return git ? { git } : {};
    });
  }

  private async serveMetrics(method: (typeof NODE_SERVED_METRICS)[number], params: unknown): Promise<unknown> {
    const metrics = this.deps.metrics;
    if (!metrics) throw new RpcError("unsupported", "this node keeps no metrics");
    const def = clientRequests[method];
    const parsed = def.params.safeParse(params ?? {});
    if (!parsed.success) throw new RpcError("invalid", `bad params for ${method}`, parsed.error.issues);
    const p = parsed.data as { node?: string; intervalMs?: number; processes?: "all" | "owners"; spend?: { from?: number; to?: number }; range?: { from?: number; to?: number } };
    return this.deps.gate.run({ principal: this.deps.principal, action: method, args: p, ...(p.node !== undefined ? { target: p.node } : {}), sessionKey: this.deps.sessionKey }, () => {
      if (method === "metrics.subscribe") {
        const spend = metrics.subscribe(this.deps.metricsSubscriber, p.intervalMs!, p.processes, p.spend);
        return spend ? { spend } : {};
      }
      if (method === "metrics.unsubscribe") {
        metrics.unsubscribe(this.deps.metricsSubscriber);
        return {};
      }
      return this.shape(method, { samples: metrics.history(p.node!, p.range ?? {}) });
    });
  }
}
