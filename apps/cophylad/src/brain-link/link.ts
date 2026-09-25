// brain-link: spawns the brain, speaks the capability protocol with it over stdio, and is
// the only path into it. The handshake is brain-link's `hello` request, answered with the
// brain's own hello and protocol range; a brain outside the range is refused. Every request
// from the brain crosses the gate with `principal: brain`; a held one is reported as
// `pending`; `cancel` withdraws one in flight; `llm.delta` streams a completion back, and
// the completions flagged `reply` double as the view's provisional reply. A brain that exits is restarted with backoff, its
// open asks cancelled and its in-flight requests aborted; events raised while it is down wait
// in an outbox and are flushed after the next handshake. The brain is located again before
// every spawn, after the update module has promoted a staged release, and an installed or
// bundled brain is verified against its signed release entry first: one that fails is
// refused and the previous one put back.

import { CapabilityHello, capabilityRequests, PROTOCOL_VERSION, RpcError, ulid } from "@cophyla/protocol";
import type { Ask, AuditEntry, CapabilityRequestName, LlmDelta, LlmResult, NodeRole, RpcId } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { Chat } from "../chat/index.ts";
import type { BrainConfig } from "../config/schema.ts";
import type { EventStream } from "../events/stream.ts";
import type { Gate } from "../gate/index.ts";
import type { Policy } from "../gate/policy.ts";
import type { Logger } from "../log.ts";
import { StdioRpc } from "../rpc/stdio.ts";
import type { Store } from "../store/index.ts";
import { Feed } from "./feed.ts";
import type { FeedEvent } from "./feed.ts";
import type { BrainLocation } from "./locate.ts";
import { brainMethods } from "./methods.ts";
import type { BrainMethodContext, BrainMethodDeps, BrainMethodTable } from "./methods.ts";
import type { QuoteLookup } from "./quotes.ts";
import { ReplyStream } from "./stream.ts";

export type BrainState = "down" | "starting" | "up" | "refused" | "stopped";

export type BrainCheckResult = { ok: true } | { ok: false; reason: string };

export interface BrainLinkDeps {
  config: BrainConfig;
  /** Where the brain is now; asked before every spawn. */
  locate: () => BrainLocation | undefined;
  /** Runs before `locate`: the update module promotes a staged brain here. */
  beforeSpawn?: () => Promise<void> | void;
  /** Checks the located brain before it runs; a failure refuses it. */
  verify?: (location: BrainLocation) => Promise<BrainCheckResult> | BrainCheckResult;
  /** A refused brain: true when something was put back and another spawn makes sense. */
  onRefused?: (location: BrainLocation, reason: string) => Promise<boolean> | boolean;
  nodeId: string;
  role: NodeRole;
  platformVersion: string;
  /** The platform's IANA time zone, told at the handshake. */
  tz: string;
  log: Logger;
  bus: Bus;
  /** The daemon's event stream: what the brain hears. */
  stream: EventStream;
  gate: Gate;
  policy: Policy;
  chat: Chat;
  store: Store;
  methods: Omit<BrainMethodDeps, "quotes" | "stream">;
  /** Wraps the served table once it is built: the nodes module's forwarding. */
  wrapMethods?: (table: BrainMethodTable) => BrainMethodTable;
  /** The daemon's environment; the brain gets a scrubbed copy. */
  env: Record<string, string | undefined>;
  /** The account's entitlement token now, sent as one `entitlement.updated` right after the handshake so a fresh brain has it. */
  entitlement?: () => string | undefined;
  now?: () => number;
}

interface InFlight {
  controller: AbortController;
  method: string;
  audit?: string;
}

export const OUTBOX_CAP = 1000;
const AUDIT_MAP_CAP = 4096;

/** What the brain's environment keeps: a minimum for a process to run, plus `COPHYLA_*` (where to record) and the test fakes' own. */
const ENV_KEEP = ["PATH", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "PATHEXT", "LANG", "TZ", "NODE_OPTIONS"];
const ENV_KEEP_PREFIX = /^(COPHYLA_|FAKE_BRAIN_)/;

export class BrainLink {
  private deps: BrainLinkDeps;
  private log: Logger;
  private rpc?: StdioRpc;
  private stateValue: BrainState = "down";
  private stopping = false;
  private backoffMs: number;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private outbox: FeedEvent[] = [];
  private inflight = new Map<string, InFlight>();
  private auditIds = new Map<string, string>();
  private lastEventId?: string;
  private instanceIdValue?: string;
  private brainVersionValue?: string;
  private feed: Feed;
  private stream: ReplyStream;
  private table: BrainMethodTable;
  private unsubscribe: (() => void)[] = [];
  private starts = 0;
  private restarting = false;
  private locationValue?: BrainLocation;

  constructor(deps: BrainLinkDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.backoffMs = deps.config.restart_backoff_ms;
    this.stream = new ReplyStream(deps.bus, deps.now ?? Date.now);
    const quotes: QuoteLookup = { entry: (request) => this.auditEntry(request) };
    const table = brainMethods({ ...deps.methods, quotes, stream: this.stream });
    this.table = deps.wrapMethods ? deps.wrapMethods(table) : table;
    this.feed = new Feed({ stream: deps.stream, sessions: deps.methods.sessions, send: (e) => this.send(e), ...(deps.now ? { now: deps.now } : {}) });
    this.unsubscribe.push(deps.bus.on("user.message", () => this.stream.reset()));
  }

  get state(): BrainState {
    return this.stateValue;
  }

  /** `brain-<ulid>`, new at every handshake: the gate's session key for remembered answers. */
  get instanceId(): string | undefined {
    return this.instanceIdValue;
  }

  get brainVersion(): string | undefined {
    return this.brainVersionValue;
  }

  get pid(): number | undefined {
    return this.rpc?.pid;
  }

  /** How many times the brain was spawned. */
  get spawnCount(): number {
    return this.starts;
  }

  get outboxSize(): number {
    return this.outbox.length;
  }

  /** Requests from the brain being served now. */
  get inflightCount(): number {
    return this.inflight.size;
  }

  /** Where the last spawn found the brain. */
  get location(): BrainLocation | undefined {
    return this.locationValue;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // --- lifecycle ------------------------------------------------------------------------

  async start(): Promise<void> {
    this.stopping = false;
    await this.spawn();
  }

  private brainEnv(): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(this.deps.env)) if (v !== undefined && (ENV_KEEP.includes(k) || ENV_KEEP_PREFIX.test(k))) out[k] = v;
    out["COPHYLA_NODE"] = this.deps.nodeId;
    return out;
  }

  private async spawn(): Promise<void> {
    if (this.stopping || this.stateValue === "refused") return;
    this.stateValue = "starting";
    const log = this.log;
    try {
      await this.deps.beforeSpawn?.();
    } catch (e) {
      log.warn("before brain spawn", { error: e instanceof Error ? e.message : String(e) });
    }
    if (this.stopping) return;
    const loc = this.deps.locate();
    this.locationValue = loc;
    if (!loc) {
      this.stateValue = "down";
      log.info("brain off: nothing to run");
      return;
    }
    if (this.deps.verify) {
      const check = await this.deps.verify(loc);
      if (this.stopping) return;
      if (!check.ok) {
        log.error("brain refused", { origin: loc.origin, command: loc.command, reason: check.reason });
        const again = (await this.deps.onRefused?.(loc, check.reason)) ?? false;
        if (again && !this.stopping) {
          this.stateValue = "down";
          return this.spawn();
        }
        this.stateValue = "refused";
        return;
      }
    }
    this.starts++;
    const rpc = new StdioRpc({
      command: loc.command,
      args: loc.args,
      cwd: loc.cwd,
      env: this.brainEnv(),
      log,
      onRequest: (method, params, id) => this.onRequest(rpc, method, params, id),
      onNotification: (method, params) => log.debug("notification from the brain ignored", { method, params }),
      onExit: (code, signal) => this.onExit(rpc, code, signal),
      onStderr: (line) => log.info("brain", { line: line.slice(0, 500) }),
    });
    this.rpc = rpc;
    log.info("brain starting", { command: loc.command, args: loc.args, origin: loc.origin, pid: rpc.pid });
    let hello: unknown;
    try {
      hello = await rpc.request("hello", { protocolVersion: PROTOCOL_VERSION, platformVersion: this.deps.platformVersion, nodeId: this.deps.nodeId, role: this.deps.role, tz: this.deps.tz }, { timeoutMs: this.deps.config.hello_timeout_ms });
    } catch (e) {
      if (this.rpc !== rpc) return;
      log.warn("brain hello failed", { error: e instanceof Error ? e.message : String(e) });
      rpc.kill();
      return;
    }
    if (this.rpc !== rpc) return;
    const parsed = CapabilityHello.safeParse(hello);
    const range = parsed.success ? (parsed.data.protocolRange ?? { min: parsed.data.protocolVersion, max: parsed.data.protocolVersion }) : undefined;
    if (!parsed.success || parsed.data.role !== "brain" || !range || range.min > PROTOCOL_VERSION || range.max < PROTOCOL_VERSION) {
      log.error("brain refused", { hello, reason: !parsed.success ? "bad hello" : parsed.data.role !== "brain" ? "not a brain" : `protocol range ${range?.min}-${range?.max} excludes ${PROTOCOL_VERSION}` });
      this.stateValue = "refused";
      rpc.kill();
      return;
    }
    this.instanceIdValue = `brain-${ulid(this.now())}`;
    this.brainVersionValue = parsed.data.brainVersion;
    this.backoffMs = this.deps.config.restart_backoff_ms;
    this.stateValue = "up";
    this.feed.reset();
    log.info("brain up", { instance: this.instanceIdValue, version: parsed.data.brainVersion, pid: rpc.pid, outbox: this.outbox.length });
    // The plan first, before anything queued: what the brain may do depends on it.
    const token = this.deps.entitlement?.();
    if (token !== undefined) this.send({ name: "entitlement.updated", params: { at: this.now(), token, eventId: `evt_${ulid(this.now())}` } });
    const queued = this.outbox;
    this.outbox = [];
    for (const e of queued) this.send(e);
  }

  private onExit(rpc: StdioRpc, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.rpc !== rpc) return;
    this.rpc = undefined;
    const wasUp = this.stateValue === "up";
    if (this.stateValue !== "refused") this.stateValue = this.stopping ? "stopped" : "down";
    const instance = this.instanceIdValue;
    if (instance) this.deps.policy.forgetSession(instance);
    this.instanceIdValue = undefined;
    this.brainVersionValue = undefined;
    for (const [id, f] of this.inflight) {
      this.inflight.delete(id);
      f.controller.abort();
    }
    this.stream.reset();
    if (this.restarting && !this.stopping) {
      this.restarting = false;
      this.stateValue = "down";
      const cancelled = this.deps.chat.cancelBrainAsks();
      this.log.info("brain restarting", { code, signal, wasUp, asksCancelled: cancelled });
      void this.spawn();
      return;
    }
    if (this.stopping || this.stateValue === "refused") {
      this.log.info("brain stopped", { code, signal });
      return;
    }
    const cancelled = this.deps.chat.cancelBrainAsks();
    this.log.warn("brain exited", { code, signal, wasUp, asksCancelled: cancelled, restartInMs: this.backoffMs });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.spawn();
    }, this.backoffMs);
    if (typeof this.restartTimer === "object" && "unref" in this.restartTimer) this.restartTimer.unref();
    this.backoffMs = Math.min(this.backoffMs * 2, this.deps.config.restart_backoff_max_ms);
  }

  /** Stops the brain and stays down. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.feed.dispose();
    const rpc = this.rpc;
    if (rpc) await rpc.stop(1000);
    this.stateValue = "stopped";
  }

  /**
   * Stops the brain and spawns it again at once, with no backoff, locating it afresh: how a
   * staged release is applied. Clears `refused`, so a brain put back or newly staged gets its turn.
   */
  async restart(): Promise<void> {
    if (this.stopping) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const rpc = this.rpc;
    if (rpc?.alive) {
      this.restarting = true;
      rpc.kill();
      return;
    }
    this.rpc = undefined;
    this.stateValue = "down";
    await this.spawn();
  }

  /** Kills the brain process; the link restarts it as after any exit. For tests and `talk.ts`. */
  kill(): void {
    this.rpc?.kill();
  }

  // --- events ------------------------------------------------------------------------------

  send(event: FeedEvent): void {
    if (this.stateValue === "up" && this.rpc?.alive) {
      this.lastEventId = event.params.eventId;
      this.rpc.notify(event.name, event.params);
      return;
    }
    if (this.stateValue === "refused" || this.stopping) return;
    if (this.outbox.length >= OUTBOX_CAP) {
      const idx = this.outbox.findIndex((e) => e.name !== "user.message");
      if (idx >= 0) this.outbox.splice(idx, 1);
      else this.outbox.shift();
    }
    this.outbox.push(event);
  }

  // --- requests -------------------------------------------------------------------------

  private auditEntry(request: string): AuditEntry | undefined {
    const id = request.startsWith("aud_") ? request : this.auditIds.get(request);
    return id ? this.deps.store.audit.get(id) : undefined;
  }

  private remember(requestId: RpcId, auditId: string): void {
    this.auditIds.set(String(requestId), auditId);
    if (this.auditIds.size > AUDIT_MAP_CAP) {
      const first = this.auditIds.keys().next().value;
      if (first !== undefined) this.auditIds.delete(first);
    }
  }

  private async onRequest(rpc: StdioRpc, method: string, params: unknown, id: RpcId): Promise<unknown> {
    if (this.rpc !== rpc) throw new RpcError("unavailable", "brain instance replaced");
    const key = String(id);
    if (method === "cancel") return this.cancel(params, id);
    const name = method as CapabilityRequestName;
    const def = capabilityRequests[name];
    const impl = this.table[name];
    if (!def || !impl) throw new RpcError("unsupported", `unknown request ${method}`);
    const parsed = def.params.safeParse(params ?? {});
    if (!parsed.success) throw new RpcError("invalid", `bad params for ${method}`, parsed.error.issues);
    const p = parsed.data;
    const controller = new AbortController();
    const entry: InFlight = { controller, method };
    this.inflight.set(key, entry);
    const target = (impl as { target?: (p: unknown) => string | undefined }).target?.(p);
    const risk = (impl as { risk?: (p: unknown) => string | undefined }).risk?.(p);
    const ask = (impl as { ask?: (p: unknown) => { title: string; detail?: string } }).ask?.(p);
    const own = (impl as { own?: (p: unknown) => boolean }).own?.(p) === true;
    if (name === "tool.run" && risk === undefined) {
      this.inflight.delete(key);
      throw new RpcError("not_found", `no tool ${(p as { name: string }).name}`);
    }
    const thread = this.deps.chat.peek();
    // Only a completion the brain flags as a reply streams to the view; its placeholder ends in the `ui.say` or a retract.
    const reply = name === "llm.complete" && (p as { reply?: boolean }).reply === true;
    if (reply) this.stream.begin(key);
    let ended: { ok: boolean; toolUse?: boolean } = { ok: false };
    try {
      const result = await this.deps.gate.run(
        {
          principal: { kind: "brain" },
          action: method,
          args: p,
          ...(target !== undefined ? { target } : {}),
          ...(risk !== undefined ? { risk: risk as "read" | "write" | "exec" | "network" } : {}),
          ...(ask ? { ask } : {}),
          ...(own ? { own: true } : {}),
          ...(this.instanceIdValue ? { sessionKey: this.instanceIdValue } : {}),
          ...(this.lastEventId ? { correlation: this.lastEventId } : {}),
          ...(thread ? { thread: thread.id } : {}),
        },
        (gctx) => {
          entry.audit = gctx.audit.id;
          this.remember(id, gctx.audit.id);
          const ctx: BrainMethodContext = {
            audit: gctx.audit,
            id,
            signal: controller.signal,
            delta: (delta: LlmDelta) => {
              if (this.rpc !== rpc) return;
              rpc.notify("llm.delta", { id, delta });
              if (reply && delta.type === "text") this.stream.push(key, delta.text);
            },
            ...(reply ? { retry: () => this.stream.restart(key) } : {}),
            onPending: (ask: Ask) => this.pending(rpc, id, ask),
          };
          return (impl as { handler: (p: unknown, c: BrainMethodContext) => unknown }).handler(p, ctx);
        },
        {
          onPending: (ask, audit) => {
            entry.audit = audit.id;
            this.remember(id, audit.id);
            this.pending(rpc, id, ask);
          },
          signal: controller.signal,
        },
      );
      if (reply) {
        const r = result as LlmResult;
        ended = { ok: r.stopReason !== "cancelled", toolUse: r.stopReason === "tool_use" || r.content.some((b) => b.type === "tool_use") };
      }
      return result;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      this.log.error("brain request failed", { method, error: e });
      throw new RpcError("unavailable", e instanceof Error ? e.message : String(e));
    } finally {
      this.inflight.delete(key);
      if (reply) this.stream.end(key, ended);
    }
  }

  private pending(rpc: StdioRpc, id: RpcId, ask: Ask): void {
    if (this.rpc !== rpc) return;
    rpc.notify("pending", { id, ask, at: this.now() });
  }

  /** `cancel {id}`: a control action, gated and audited, that aborts the request in flight. */
  private async cancel(params: unknown, id: RpcId): Promise<unknown> {
    const parsed = capabilityRequests.cancel.params.safeParse(params ?? {});
    if (!parsed.success) throw new RpcError("invalid", "bad params for cancel", parsed.error.issues);
    const target = String(parsed.data.id);
    const thread = this.deps.chat.peek();
    return this.deps.gate.run(
      {
        principal: { kind: "brain" },
        action: "cancel",
        args: parsed.data,
        target,
        ...(this.instanceIdValue ? { sessionKey: this.instanceIdValue } : {}),
        ...(this.lastEventId ? { correlation: this.lastEventId } : {}),
        ...(thread ? { thread: thread.id } : {}),
      },
      (gctx) => {
        this.remember(id, gctx.audit.id);
        const f = this.inflight.get(target);
        if (f) f.controller.abort();
        return { cancelled: f !== undefined };
      },
    );
  }
}
