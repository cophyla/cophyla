// The ACP adapter: starts a Claude Code or Codex session through its ACP adapter package
// (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`) as a child
// speaking JSON-RPC over stdio, prompts it, and turns `session/update`,
// `session/request_permission` and `elicitation/create` into session events and asks. One
// child per session; the stream is the session's only source of status, and the hooks that
// also fire in it are answered `{}` so a permission prompt falls through to ACP. Spike 08
// has the shapes.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { Ask, HarnessProfile, RpcId, Session } from "@cophyla/protocol";
import type { AcpConfig } from "../../config/schema.ts";
import { scrub } from "../env.ts";
import type { Asks } from "../../gate/asks.ts";
import type { Logger } from "../../log.ts";
import { StdioRpc } from "../../rpc/stdio.ts";
import { claudeEnv } from "../claude/start.ts";
import { askShown, capText, rawIfSmall, summariseValue, TOOL_CALL_CAP, TOOL_RESULT_CAP } from "../model.ts";
import type { AttachedHarness, SessionHost, SessionRecord } from "../model.ts";
import { permissionDetail } from "../permissions.ts";
import { askInputFromQuestion, contentForElicitation, questionsFromElicitation } from "../questions.ts";
import type { Question } from "../questions.ts";

/** The harnesses with an ACP adapter package: Muse runs headless on its own host instead. */
export type AcpHarness = Exclude<AttachedHarness, "muse">;

export interface AcpAdapterDeps {
  host: SessionHost;
  asks: Asks;
  config: AcpConfig;
  log: Logger;
  /** The daemon's environment, scrubbed and extended per profile. */
  env: Record<string, string | undefined>;
  /** The directory the adapter packages are resolved from: cophylad's own. */
  packagesDir?: string;
  /** Seconds an ask stays open. */
  askTimeoutS: number;
  bun?: string;
  /** The home directory, whose `.claude` is Claude's own; the user's unless a test says. */
  home?: string;
}

export interface SpawnInput {
  harness: AcpHarness;
  profile: HarnessProfile;
  cwd: string;
  workspace: string;
  prompt: string;
  task?: string;
  model?: string;
  intent?: string;
  /** The mode the session starts in; the adapter's asking mode by default. */
  mode?: string;
}

interface ToolCall {
  id: string;
  name?: string;
  title?: string;
  kind?: string;
  input?: unknown;
  /** The `tool_call` event has been written. */
  announced: boolean;
  done: boolean;
}

interface AcpChild {
  rpc: StdioRpc;
  sessionId: string;
  rec: SessionRecord;
  harness: AcpHarness;
  spawnedAt: number;
  /** Prompts waiting their turn: one `session/prompt` in flight per session. */
  queue: { text: string; ref: string; resolve: () => void }[];
  inFlight?: { ref: string; started: number };
  /** Chunks of the current assistant message. */
  text: string[];
  tools: Map<string, ToolCall>;
  /** The agent's request that an ask stands for, with its resolver. */
  pending?: Pending;
  stats: NonNullable<Session["stats"]>;
  stopping: boolean;
  /** The modes the agent said it offers at `session/new`, when it said. */
  modes?: string[];
}

interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

interface PendingBase {
  ask: Ask;
  resolve: (v: unknown) => void;
  /** The JSON-RPC id of the agent's request, for `$/cancel_request`. */
  requestId?: RpcId;
}

/** A `session/request_permission`: one permission ask with the agent's options. */
interface PendingPermission extends PendingBase {
  kind: "permission";
  options: PermissionOption[];
}

/** An `elicitation/create` form: one ask per question, opened in turn; the values gather in `content`. */
interface PendingForm extends PendingBase {
  kind: "form";
  toolCallId?: string;
  tool: string;
  questions: Question[];
  index: number;
  content: Record<string, unknown>;
  /** When the agent resolves the request on its own (Codex's `autoResolutionMs`). */
  deadline?: number;
}

type Pending = PendingPermission | PendingForm;

const PACKAGES: Record<AcpHarness, string> = {
  claude: "@agentclientprotocol/claude-agent-acp",
  codex: "@agentclientprotocol/codex-acp",
};

/** The mode each adapter is put in so the agent's prompts reach the queue. */
const ASK_MODE: Record<AcpHarness, string> = { claude: "default", codex: "read-only" };

const DETAIL_CHARS = 2000;

/** `node` when it is on PATH, else the daemon's own Bun. */
export function pickRuntime(preferred: "node" | "bun", bun: string, which: (cmd: string) => string | null = Bun.which): string {
  if (preferred === "bun") return bun;
  return which("node") ?? bun;
}

export class AcpAdapter {
  private deps: AcpAdapterDeps;
  private children = new Map<string, AcpChild>();
  private log: Logger;

  constructor(deps: AcpAdapterDeps) {
    this.deps = deps;
    this.log = deps.log;
  }

  /** The children by session id. */
  get sessions(): string[] {
    return [...this.children.keys()];
  }

  private packageEntry(harness: AcpHarness): string | undefined {
    const base = this.deps.packagesDir ?? resolve(import.meta.dir, "..", "..", "..");
    const direct = join(base, "node_modules", PACKAGES[harness], "dist", "index.js");
    if (existsSync(direct)) return direct;
    try {
      return Bun.resolveSync(`${PACKAGES[harness]}/dist/index.js`, base);
    } catch {
      return undefined;
    }
  }

  private commandFor(harness: AcpHarness): { command: string; args: string[] } {
    const configured = this.deps.config[harness];
    if (configured) {
      const cmd = configured.command;
      if (/\.(ts|js|mjs)$/i.test(cmd) && !cmd.includes(" ")) return { command: this.deps.bun ?? process.execPath, args: [cmd, ...configured.args] };
      return { command: cmd, args: configured.args };
    }
    const entry = this.packageEntry(harness);
    if (!entry) throw new RpcError("unavailable", `the ${PACKAGES[harness]} package is not installed`);
    return { command: pickRuntime(this.deps.config.runtime, this.deps.bun ?? process.execPath), args: [entry] };
  }

  /** The adapter's environment: the daemon's, scrubbed, with the profile's directory named as `claudeEnv` names it (Claude's own by leaving it unset). */
  private envFor(input: SpawnInput): Record<string, string | undefined> {
    const env = scrub(this.deps.env);
    Object.assign(env, input.profile.env);
    if (input.harness === "claude") {
      const dir = claudeEnv(input.profile.configDir, this.deps.home);
      Object.assign(env, dir.set);
      for (const k of dir.unset) delete env[k];
    } else env["CODEX_HOME"] = input.profile.configDir;
    const execVar = input.harness === "claude" ? "CLAUDE_CODE_EXECUTABLE" : "CODEX_PATH";
    env[execVar] = input.profile.exec?.command ?? (input.harness === "claude" ? Bun.which("claude") ?? "claude" : Bun.which("codex") ?? "codex");
    return env;
  }

  // --- spawn -------------------------------------------------------------------------------

  async spawn(input: SpawnInput): Promise<SessionRecord> {
    const { command, args } = this.commandFor(input.harness);
    const env = this.envFor(input);
    const log = this.log.child(input.harness);
    let child: AcpChild | undefined;
    const rpc = new StdioRpc({
      command,
      args,
      cwd: input.cwd,
      env,
      log,
      onRequest: (method, params, id) => this.onRequest(child, method, params, id),
      onNotification: (method, params) => this.onNotification(child, method, params),
      onExit: (code, signal) => this.onExit(child, code, signal),
      onStderr: (line) => log.debug("adapter stderr", { line: line.slice(0, 300) }),
    });
    const timeout = this.deps.config.spawn_timeout_ms;
    try {
      const init = (await rpc.request(
        "initialize",
        // Form elicitation is what lets Claude's `AskUserQuestion` and Codex's `request_user_input` reach cophylad.
        { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } }, clientInfo: { name: "cophylad", version: "0.1.0" } },
        { timeoutMs: timeout },
      )) as { authMethods?: { id: string }[]; agentInfo?: { name?: string } } | null;
      const created = (await rpc.request("session/new", { cwd: input.cwd, mcpServers: [], ...(input.harness === "claude" && input.model ? { _meta: { claudeCode: { options: { model: input.model } } } } : {}) }, { timeoutMs: timeout }).catch(async (e: unknown) => {
        // An agent that wants authentication first is given its first method once.
        const first = init?.authMethods?.[0];
        if (first && e instanceof RpcError) {
          await rpc.request("authenticate", { methodId: first.id }, { timeoutMs: timeout });
          return rpc.request("session/new", { cwd: input.cwd, mcpServers: [] }, { timeoutMs: timeout });
        }
        throw e;
      })) as { sessionId: string; modes?: { availableModes?: { id: string }[] }; models?: { availableModels?: { modelId: string }[]; currentModelId?: string } };
      const sessionId = created.sessionId;
      const now = this.deps.host.now();
      const rec = this.deps.host.ensure({
        harness: input.harness,
        nativeId: sessionId,
        profile: input.profile.id,
        cwd: input.cwd,
        transport: "acp",
        ...(rpc.pid !== undefined ? { pid: rpc.pid } : {}),
        origin: "orchestrator",
        workspace: input.workspace,
        ...(input.task !== undefined ? { task: input.task } : {}),
        status: "idle",
        intent: input.intent ?? capText(input.prompt.replace(/\s+/g, " ").trim(), 200),
        startedAt: now,
      });
      // The model the counters are priced at: the one asked for, or the agent's current one when it names it.
      const model = input.model ?? created.models?.currentModelId;
      const modes = created.modes?.availableModes?.map((m) => m.id);
      child = { rpc, sessionId, rec, harness: input.harness, spawnedAt: now, queue: [], text: [], tools: new Map(), stats: { turns: 0, cost: 0, tokens: { in: 0, out: 0 }, ...(model ? { model } : {}) }, stopping: false, ...(modes ? { modes } : {}) };
      this.children.set(rec.session.id, child);
      // Prompts must reach the queue: put the agent in its asking mode unless another was asked
      // for (a plan approved to go on unasked), and pick the model where the agent takes one.
      const modeId = input.mode ?? ASK_MODE[input.harness];
      await rpc.request("session/set_mode", { sessionId, modeId }, { timeoutMs: timeout }).then(
        () => this.deps.host.noteMode(rec, modeId, now),
        (e: unknown) => {
          if (input.mode) log.warn("set_mode refused", { mode: modeId, error: String(e) });
          else log.debug("set_mode refused", { error: String(e) });
        },
      );
      if (input.harness === "codex" && input.model) {
        const models = created.models?.availableModels ?? [];
        const match = models.find((m) => m.modelId === input.model) ?? models.find((m) => m.modelId.startsWith(input.model + "["));
        if (match) {
          await rpc.request("session/set_model", { sessionId, modelId: match.modelId }, { timeoutMs: timeout }).catch((e: unknown) => log.debug("set_model refused", { error: String(e) }));
          child.stats.model = match.modelId;
        }
      }
      log.info("acp session started", { session: rec.session.id, native: sessionId, agent: init?.agentInfo?.name, pid: rpc.pid, cwd: input.cwd });
      this.prompt(rec.session.id, input.prompt, `cophylad-spawn-${sessionId}`);
      return rec;
    } catch (e) {
      rpc.kill();
      if (child) this.children.delete(child.rec.session.id);
      const tail = rpc.stderr.trim().split(/\r?\n/).slice(-5).join("\n");
      const message = e instanceof Error ? e.message : String(e);
      throw new RpcError("unavailable", `${input.harness} ACP adapter failed to start: ${message}${tail ? `\n${tail}` : ""}`, { provider: PACKAGES[input.harness] });
    }
  }

  // --- prompt ----------------------------------------------------------------------------

  /** Queues a prompt behind the turn in flight; `sent` resolves when it goes out. */
  prompt(sessionId: string, text: string, ref: string): { sent: Promise<void> } {
    const child = this.children.get(sessionId);
    if (!child) throw new RpcError("not_found", `no ACP session ${sessionId}`);
    if (!child.rpc.alive || child.stopping) throw new RpcError("conflict", `ACP session ${sessionId} has ended`);
    const sent = new Promise<void>((resolve) => {
      child.queue.push({ text, ref, resolve });
    });
    this.pump(child);
    return { sent };
  }

  private pump(child: AcpChild): void {
    if (child.inFlight || child.queue.length === 0 || !child.rpc.alive || child.stopping) return;
    const next = child.queue.shift()!;
    const now = this.deps.host.now();
    child.inFlight = { ref: next.ref, started: now };
    this.deps.host.setStatus(child.rec, "busy", now);
    this.deps.host.event(child.rec, "user_turn", { text: capText(next.text), source: "orchestrator", ref: next.ref }, undefined, now);
    next.resolve();
    child.rpc
      .request("session/prompt", { sessionId: child.sessionId, prompt: [{ type: "text", text: next.text }] })
      .then((result) => this.onTurnEnd(child, result as { stopReason?: string; usage?: Record<string, number> }))
      .catch((e: unknown) => {
        if (!child.rpc.alive) return;
        this.log.warn("session/prompt failed", { session: child.rec.session.id, error: e instanceof Error ? e.message : String(e) });
        this.onTurnEnd(child, { stopReason: "error", error: e instanceof Error ? e.message : String(e) });
      });
  }

  private onTurnEnd(child: AcpChild, result: { stopReason?: string; usage?: Record<string, number>; error?: string }): void {
    const now = this.deps.host.now();
    this.flushText(child, now);
    child.inFlight = undefined;
    if (result.usage) {
      const u = result.usage;
      child.stats.turns += 1;
      child.stats.tokens.in += u["inputTokens"] ?? 0;
      child.stats.tokens.out += u["outputTokens"] ?? 0;
      const cacheRead = u["cachedReadTokens"] ?? u["cachedInputTokens"];
      if (cacheRead !== undefined) child.stats.tokens.cacheRead = (child.stats.tokens.cacheRead ?? 0) + cacheRead;
      if (u["cachedWriteTokens"] !== undefined) child.stats.tokens.cacheWrite = (child.stats.tokens.cacheWrite ?? 0) + u["cachedWriteTokens"]!;
      this.deps.host.patch(child.rec, { stats: { ...child.stats, tokens: { ...child.stats.tokens } } }, now);
    }
    if (child.pending) this.closePending(child, "stopped");
    this.deps.host.event(child.rec, "status", { status: "idle", stopReason: result.stopReason ?? "unknown", ...(result.error ? { error: result.error } : {}) }, undefined, now);
    this.deps.host.setStatus(child.rec, "idle", now);
    this.pump(child);
  }

  private flushText(child: AcpChild, now: number): void {
    if (child.text.length === 0) return;
    const text = child.text.join("");
    child.text = [];
    if (text.trim()) this.deps.host.event(child.rec, "assistant_text", { text: capText(text) }, undefined, now);
  }

  // --- mode ------------------------------------------------------------------------------

  /** Puts a session in one of its agent's modes; one the agent does not offer, or refuses, is `unsupported`. */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    const child = this.children.get(sessionId);
    if (!child) throw new RpcError("not_found", `no ACP session ${sessionId}`);
    if (!child.rpc.alive || child.stopping) throw new RpcError("conflict", `ACP session ${sessionId} has ended`);
    if (child.modes && !child.modes.includes(modeId)) throw new RpcError("unsupported", `the agent offers no ${modeId} mode, only ${child.modes.join(", ")}`);
    try {
      await child.rpc.request("session/set_mode", { sessionId: child.sessionId, modeId }, { timeoutMs: this.deps.config.spawn_timeout_ms });
    } catch (e) {
      throw new RpcError("unsupported", `the agent refused the ${modeId} mode: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.deps.host.noteMode(child.rec, modeId);
    this.log.info("acp session mode set", { session: child.rec.session.id, mode: modeId });
  }

  // --- stop ------------------------------------------------------------------------------

  async stop(sessionId: string): Promise<void> {
    const child = this.children.get(sessionId);
    if (!child) throw new RpcError("not_found", `no ACP session ${sessionId}`);
    child.stopping = true;
    if (child.inFlight && child.rpc.alive) child.rpc.notify("session/cancel", { sessionId: child.sessionId });
    for (const q of child.queue) q.resolve();
    child.queue = [];
    if (child.pending) this.closePending(child, "stopped");
    await child.rpc.stop(1500);
    this.finish(child, "stopped");
  }

  /** Cancels the turn in flight without ending the session. */
  cancel(sessionId: string): boolean {
    const child = this.children.get(sessionId);
    if (!child || !child.inFlight || !child.rpc.alive) return false;
    return child.rpc.notify("session/cancel", { sessionId: child.sessionId });
  }

  private onExit(child: AcpChild | undefined, code: number | null, signal: NodeJS.Signals | null): void {
    if (!child || !this.children.has(child.rec.session.id)) return;
    this.log.info("acp adapter exited", { session: child.rec.session.id, code, signal });
    this.finish(child, child.stopping ? "stopped" : "exited");
  }

  private finish(child: AcpChild, reason: string): void {
    if (!this.children.has(child.rec.session.id)) return;
    this.children.delete(child.rec.session.id);
    const now = this.deps.host.now();
    this.flushText(child, now);
    child.inFlight = undefined;
    if (child.pending) this.closePending(child, "stopped");
    this.deps.host.end(child.rec, reason, now);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.children.keys()].map((id) => this.stop(id).catch(() => undefined)));
  }

  /** Turns in flight plus prompts waiting their turn, over every child. */
  inFlightCount(): number {
    let n = 0;
    for (const child of this.children.values()) n += (child.inFlight ? 1 : 0) + child.queue.length;
    return n;
  }

  /** ACP records from a previous daemon run: their children are gone with it. */
  isOwned(sessionId: string): boolean {
    return this.children.has(sessionId);
  }

  // --- the stream ----------------------------------------------------------------------

  private onNotification(child: AcpChild | undefined, method: string, params: unknown): void {
    if (!child) return;
    if (method === "$/cancel_request") {
      // The agent gave up on its own request: a turn cancelled under a prompt, or Codex resolving a question itself.
      const requestId = (params as { requestId?: RpcId } | undefined)?.requestId;
      if (child.pending && child.pending.requestId !== undefined && child.pending.requestId === requestId) this.closePending(child, "cancelled");
      return;
    }
    if (method !== "session/update") return;
    const p = params as { sessionId?: string; update?: Record<string, unknown> } | undefined;
    const u = p?.update;
    if (!u || typeof u["sessionUpdate"] !== "string") return;
    const now = this.deps.host.now();
    const raw = rawIfSmall(u);
    switch (u["sessionUpdate"]) {
      case "agent_message_chunk": {
        const content = u["content"] as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && typeof content.text === "string") child.text.push(content.text);
        return;
      }
      case "tool_call": {
        const id = String(u["toolCallId"] ?? "");
        if (!id) return;
        this.flushText(child, now);
        const call: ToolCall = { id, announced: false, done: false };
        this.mergeTool(call, u);
        child.tools.set(id, call);
        if (this.hasInput(call)) this.announce(child, call, raw, now);
        return;
      }
      case "tool_call_update": {
        const id = String(u["toolCallId"] ?? "");
        if (!id) return;
        let call = child.tools.get(id);
        if (!call) {
          call = { id, announced: false, done: false };
          child.tools.set(id, call);
        }
        this.mergeTool(call, u);
        const status = u["status"];
        if (status === "completed" || status === "failed") {
          if (!call.announced) this.announce(child, call, undefined, now);
          if (call.done) return;
          call.done = true;
          const result = summariseValue(u["rawOutput"] ?? (u["content"] as unknown) ?? null, TOOL_RESULT_CAP);
          this.deps.host.event(
            child.rec,
            "tool_result",
            { id, tool: call.name ?? call.kind ?? "tool", ...(call.title ? { title: call.title } : {}), result: result.value, ...(result.truncated ? { truncated: true } : {}), ...(status === "failed" ? { isError: true } : {}) },
            raw,
            now,
          );
          child.tools.delete(id);
        } else if (!call.announced && this.hasInput(call)) {
          this.announce(child, call, raw, now);
        }
        return;
      }
      case "plan": {
        const entries = Array.isArray(u["entries"]) ? (u["entries"] as { content?: string; status?: string; priority?: string }[]).map((e) => ({ content: capText(String(e.content ?? ""), 500), status: e.status, priority: e.priority })) : [];
        this.deps.host.event(child.rec, "notification", { type: "plan", entries: entries.slice(0, 50) }, raw, now);
        return;
      }
      case "current_mode_update":
        this.deps.host.event(child.rec, "notification", { type: "mode", mode: u["currentModeId"] }, raw, now);
        if (typeof u["currentModeId"] === "string") this.deps.host.noteMode(child.rec, u["currentModeId"], now);
        return;
      case "usage_update": {
        const used = u["used"];
        const size = u["size"];
        if (typeof used === "number" && typeof size === "number" && size > 0) child.stats.context = { used, limit: size };
        const cost = u["cost"] as { amount?: number } | undefined;
        if (cost && typeof cost.amount === "number") child.stats.cost = cost.amount;
        this.deps.host.patch(child.rec, { stats: { ...child.stats, tokens: { ...child.stats.tokens }, ...(child.stats.context ? { context: { ...child.stats.context } } : {}) } }, now);
        return;
      }
      case "session_info_update": {
        const title = u["title"];
        if (typeof title === "string" && title && child.rec.session.title !== title) this.deps.host.patch(child.rec, { title: capText(title, 200) }, now);
        const meta = u["_meta"] as { codex?: { threadStatus?: { type?: string; activeFlags?: string[] } } } | undefined;
        const ts = meta?.codex?.threadStatus;
        if (ts?.type === "active" && ts.activeFlags?.includes("waitingOnApproval") && !child.pending) {
          // Codex can surface an approval after the prompt returned (spike 08); the request follows.
          this.deps.host.setStatus(child.rec, "busy", now);
        }
        return;
      }
      default:
        // Thoughts, user chunks, command lists and config options: dropped.
        return;
    }
  }

  private mergeTool(call: ToolCall, u: Record<string, unknown>): void {
    if (typeof u["name"] === "string") call.name = u["name"];
    else if (!call.name) {
      const meta = u["_meta"] as { claudeCode?: { toolName?: string } } | undefined;
      if (meta?.claudeCode?.toolName) call.name = meta.claudeCode.toolName;
    }
    if (typeof u["title"] === "string") call.title = u["title"];
    if (typeof u["kind"] === "string") call.kind = u["kind"];
    const input = u["rawInput"];
    if (input !== undefined && input !== null && !(typeof input === "object" && Object.keys(input as object).length === 0)) call.input = input;
  }

  private hasInput(call: ToolCall): boolean {
    return call.input !== undefined;
  }

  private announce(child: AcpChild, call: ToolCall, raw: unknown, now: number): void {
    if (call.announced) return;
    call.announced = true;
    const input = summariseValue(call.input ?? {}, TOOL_CALL_CAP);
    this.deps.host.event(
      child.rec,
      "tool_call",
      { id: call.id, tool: call.name ?? call.kind ?? "tool", ...(call.title ? { title: call.title } : {}), ...(call.kind ? { kind: call.kind } : {}), input: input.value, ...(input.truncated ? { truncated: true } : {}) },
      raw,
      now,
    );
  }

  // --- the agent's requests ------------------------------------------------------------

  private onRequest(child: AcpChild | undefined, method: string, params: unknown, id: RpcId): Promise<unknown> | unknown {
    if (!child) throw new RpcError("unavailable", "session not ready");
    if (method === "session/request_permission") return this.onPermission(child, params, id);
    if (method === "elicitation/create") return this.onElicitation(child, params, id);
    throw new RpcError("unsupported", `cophylad does not serve ${method}`);
  }

  /** The tool call a request names, announced if the stream has not yet. */
  private toolCallFor(child: AcpChild, id: string, merge: Record<string, unknown> | undefined, now: number): ToolCall {
    let call = child.tools.get(id);
    if (!call) {
      call = { id, announced: false, done: false };
      child.tools.set(id, call);
    }
    if (merge) this.mergeTool(call, merge);
    if (!call.announced) this.announce(child, call, undefined, now);
    return call;
  }

  // --- permissions ----------------------------------------------------------------------

  private onPermission(child: AcpChild, params: unknown, requestId: RpcId): Promise<unknown> {
    const p = params as { toolCall?: Record<string, unknown>; options?: PermissionOption[] } | undefined;
    const toolCall = p?.toolCall ?? {};
    const options = Array.isArray(p?.options) ? p!.options! : [];
    const now = this.deps.host.now();
    if (child.pending) this.closePending(child, "stopped");
    this.flushText(child, now);
    const id = String(toolCall["toolCallId"] ?? "");
    if (id) this.toolCallFor(child, id, toolCall, now);
    const title = typeof toolCall["title"] === "string" && toolCall["title"] ? toolCall["title"] : String(toolCall["name"] ?? toolCall["kind"] ?? "tool");
    const where = child.rec.session.title ?? child.rec.session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? child.rec.session.cwd;
    const tool = typeof toolCall["name"] === "string" ? (toolCall["name"] as string) : undefined;
    const ask = this.deps.asks.open(
      {
        type: "permission",
        source: { kind: "harness", session: child.rec.session.id },
        title: `${title} in ${where}`,
        detail: permissionDetail(tool, toolCall["rawInput"], DETAIL_CHARS),
        options: options.map((o) => ({ id: o.optionId, label: o.name, style: o.kind.startsWith("allow") ? ("primary" as const) : ("danger" as const) })),
        answerableBy: ["user", "brain"],
        expiresAt: now + this.deps.askTimeoutS * 1000,
      },
      now,
    );
    this.deps.host.patch(child.rec, { ask: ask.id }, now);
    this.deps.host.setStatus(child.rec, "needs_permission", now);
    this.deps.host.event(child.rec, "ask", { ask: ask.id, phase: "opened", tool: toolCall["name"] ?? toolCall["kind"], ...(id ? { id } : {}), ...askShown(ask) }, undefined, now);
    this.log.info("acp permission ask opened", { session: child.rec.session.id, ask: ask.id, title });
    return new Promise<unknown>((resolve) => {
      const pending: PendingPermission = { kind: "permission", ask, resolve, requestId, options };
      child.pending = pending;
      void this.deps.asks.wait(ask.id).then((settled) => {
        if (child.pending !== pending) return;
        if (settled.status === "answered" && settled.answer) this.settlePermission(child, pending, settled);
        else this.closePending(child, settled.status === "expired" ? "expired" : "cancelled");
      });
    });
  }

  /** Answers the agent with the chosen option. */
  private settlePermission(child: AcpChild, pending: PendingPermission, settled: Ask): void {
    child.pending = undefined;
    const now = this.deps.host.now();
    const option = settled.answer!.option;
    pending.resolve({ outcome: { outcome: "selected", optionId: option } });
    this.deps.host.event(child.rec, "ask", { ask: pending.ask.id, phase: "answered", answer: settled.answer }, undefined, now);
    this.deps.host.patch(child.rec, { ask: undefined }, now);
    if (child.rec.session.status === "needs_permission") this.deps.host.setStatus(child.rec, "busy", now);
    this.log.info("acp permission ask answered", { session: child.rec.session.id, ask: pending.ask.id, option, by: settled.answer!.by.kind });
  }

  // --- questions ----------------------------------------------------------------------------

  /**
   * A form elicitation: the agent's `AskUserQuestion`, Codex's `request_user_input`, an
   * MCP server's form or the CLI's own dialogs. One ask per question, opened in turn; the
   * values go back together. A form that cannot be shown as asks is declined at once.
   */
  private onElicitation(child: AcpChild, params: unknown, requestId: RpcId): Promise<unknown> | unknown {
    const form = questionsFromElicitation(params);
    if (!form) {
      const p = params as { mode?: unknown; requestedSchema?: { properties?: Record<string, unknown> } } | undefined;
      this.log.info("elicitation declined: no ask for it", { session: child.rec.session.id, mode: p?.mode, fields: Object.keys(p?.requestedSchema?.properties ?? {}) });
      return { action: "decline" };
    }
    const now = this.deps.host.now();
    if (child.pending) this.closePending(child, "stopped");
    this.flushText(child, now);
    let tool = "elicitation";
    if (form.toolCallId !== undefined) {
      const call = this.toolCallFor(child, form.toolCallId, undefined, now);
      tool = call.name ?? call.kind ?? tool;
    }
    return new Promise<unknown>((resolve) => {
      this.openQuestion(
        child,
        {
          kind: "form",
          resolve,
          requestId,
          ...(form.toolCallId !== undefined ? { toolCallId: form.toolCallId } : {}),
          tool,
          questions: form.questions,
          index: 0,
          content: {},
          ...(form.autoResolutionMs !== undefined ? { deadline: now + form.autoResolutionMs } : {}),
        },
        now,
      );
    });
  }

  /** Opens the ask for the form's question at `index` and waits on it. */
  private openQuestion(child: AcpChild, form: Omit<PendingForm, "ask">, now: number): void {
    const q = form.questions[form.index]!;
    const expiresAt = Math.min(now + this.deps.askTimeoutS * 1000, form.deadline ?? Number.POSITIVE_INFINITY);
    const ask = this.deps.asks.open(askInputFromQuestion(q, { session: child.rec.session.id, index: form.index, count: form.questions.length, expiresAt }), now);
    const pending: PendingForm = { ...form, ask };
    child.pending = pending;
    this.deps.host.patch(child.rec, { ask: ask.id }, now);
    this.deps.host.setStatus(child.rec, "needs_input", now);
    const place = { tool: form.tool, question: form.index + 1, of: form.questions.length, ...(form.toolCallId !== undefined ? { id: form.toolCallId } : {}) };
    this.deps.host.event(child.rec, "ask", { ask: ask.id, phase: "opened", ...place, ...askShown(ask) }, undefined, now);
    this.log.info("acp question ask opened", { session: child.rec.session.id, ask: ask.id, type: ask.type, ...place });
    void this.deps.asks.wait(ask.id).then((settled) => {
      if (child.pending !== pending) return;
      if (settled.status === "answered" && settled.answer) this.answeredForm(child, pending, settled);
      else this.closePending(child, settled.status === "expired" ? "expired" : "cancelled");
    });
  }

  /** The answer goes into the form's content; the next question opens, or the form is accepted. */
  private answeredForm(child: AcpChild, pending: PendingForm, settled: Ask): void {
    const now = this.deps.host.now();
    contentForElicitation(pending.questions[pending.index]!, settled.answer!, pending.content);
    this.deps.host.event(child.rec, "ask", { ask: pending.ask.id, phase: "answered", answer: settled.answer }, undefined, now);
    this.log.info("acp question ask answered", { session: child.rec.session.id, ask: pending.ask.id, option: settled.answer!.option, by: settled.answer!.by.kind });
    pending.index += 1;
    if (pending.index < pending.questions.length) {
      this.openQuestion(child, pending, now);
      return;
    }
    child.pending = undefined;
    pending.resolve({ action: "accept", content: pending.content });
    this.deps.host.patch(child.rec, { ask: undefined }, now);
    if (child.rec.session.status === "needs_input") this.deps.host.setStatus(child.rec, "busy", now);
  }

  /**
   * Closes the pending request without an answer: a permission gets its first reject
   * option, else a cancel; a form is declined (a cancel would abort the tool use). The open
   * ask is cancelled; of a form's sequence the answered asks stay answered.
   */
  private closePending(child: AcpChild, reason: string): void {
    const pending = child.pending;
    if (!pending) return;
    child.pending = undefined;
    const now = this.deps.host.now();
    if (this.deps.asks.getAny(pending.ask.id)?.status === "open") this.deps.asks.cancel(pending.ask.id);
    let outcome: unknown;
    if (pending.kind === "permission") {
      const reject = pending.options.find((o) => o.kind.startsWith("reject"));
      outcome = reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
    } else {
      outcome = { action: "decline" };
    }
    pending.resolve(outcome);
    this.deps.host.event(child.rec, "ask", { ask: pending.ask.id, phase: "closed", reason }, undefined, now);
    this.deps.host.patch(child.rec, { ask: undefined }, now);
    const status = child.rec.session.status;
    if (status === "needs_permission" || status === "needs_input") this.deps.host.setStatus(child.rec, "busy", now);
    this.log.info("acp ask closed", { session: child.rec.session.id, ask: pending.ask.id, kind: pending.kind, reason });
  }
}

