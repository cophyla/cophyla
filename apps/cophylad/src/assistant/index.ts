// The assistant: the chat runs in an agent session of its own, on the user's own Claude Code
// or Codex account, and this module is its keeper. It starts with the brain and stops with
// it, so it runs on the primary alone. It picks the harness and the account (what the user
// chose in the app, then config, then the usual account, Claude Code first), asks the brain
// what the session is started with, and starts it through a host: Claude Code as the CLI
// itself in a tether terminal (claude.ts), Codex as a thread on an app-server of cophylad's
// own (codex.ts). A session met again after a daemon restart is adopted; one whose program
// went is started again where it was, with backoff. A brain that comes back with other rules
// (an update) has the session started again under them, where it was, once it is idle.
//
// What reaches the session is typed into it as the user's words, one prompt at a time: a
// user's message from the chat (`user.message` on the bus), or a wake of the brain's
// (`assistant.wake`). A user's message does not wait: it is typed into whatever turn runs,
// the user's own or a wake's, and the harness folds it in, so the one reply serves both. A
// turn is never cut short for it: a tool call cut short reads to the model as one the user
// refused, and the work it was on would be dropped. A chat thread opening
// clears the session's context once it is idle, so a thread is a context. What the user types
// straight into the session's terminal is stored as a chat message of theirs.
//
// The session's turns are told to the brain as they go: a prompt taken (`assistant.prompted`),
// a tool of the harness's own run (`assistant.step`), the words a turn ends with
// (`assistant.replied`), and where the session stands (`assistant.state`). Beside each prompt
// and at each session's start the brain is asked what the session is to be told
// (`assistant.context`); the answer is cut into parts a harness will carry whole
// (context.ts), and the last one that reached the session is named in the next ask, so the
// brain makes up for one that did not. A brain that does not answer in time leaves the
// session with nothing beside its prompt, never waiting.
//
// The session's tool calls come in through the `/mcp` endpoints (`tools`, `call`), behind the
// token of this spawn, or over the Codex connection, and go to the brain as `tool.call`.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcError, ulid } from "@cophyla/protocol";
import type { AssistantHarness, AssistantPrompt, AssistantState, AssistantStatus, BrainRequestName, BrainRequestParams, BrainRequestResult, HarnessProfile, LlmTool, Session, TerminalRef, ToolCallResult } from "@cophyla/protocol";
import type { FeedEvent } from "../brain-link/feed.ts";
import type { Bus } from "../bus.ts";
import type { Chat } from "../chat/index.ts";
import type { AssistantConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";
import { ASSISTANT_PART } from "../sessions/index.ts";
import { unpasted } from "../sessions/injections.ts";
import type { AssistantSpawn } from "../sessions/index.ts";
import type { NormalisedHook } from "../sessions/model.ts";
import type { SendOptions } from "../sessions/index.ts";
import { ASSISTANT_NS } from "../grants/namespaces.ts";
import { claudeArgs, claudeEnvExtra, claudeFiles, writeClaudeSetup } from "./claude.ts";
import { CLAUDE_PART_CHARS, parts } from "./context.ts";

/** The key the user's choice of harness and account is kept under, in the store's `assistant` namespace. */
const PREFS_KEY = "prefs";

/** How long the brain may take to say what the session is told: a hook waits no longer. */
const CONTEXT_TIMEOUT_MS = 3000;
const SETUP_TIMEOUT_MS = 10_000;
const LIST_TIMEOUT_MS = 10_000;
/** A tool may be held on a slow capability for minutes; one held on a person answers at once. */
const CALL_TIMEOUT_MS = 300_000;
/** How long a prompt typed into the session may take to be taken. */
const RECEIPT_TIMEOUT_MS = 45_000;
/** How long a hook that carries a further part waits for the first to have asked the brain. */
const PART_WAIT_MS = 4000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

/** What says the chat has nothing to run on, to the user who wrote to it. */
export const NO_ACCOUNT = "The chat runs on your own Claude Code or Codex account, and none is signed in on this machine. Sign in to one (run `claude` or `codex` in a terminal), then send your message again.";

/** What the user chose in the app; either may be left to cophylad. */
export interface AssistantPrefs {
  harness?: AssistantHarness;
  profile?: string;
}

/** What is known of the session between daemon runs: kept on this machine alone, beside its files. */
interface Saved {
  harness: AssistantHarness;
  profile: string;
  /** The harness's own id of the conversation, to go on with. */
  native: string;
  /** The token of the spawn it runs under. */
  token: string;
  /** The api's port its hooks and its tool server were given. */
  port: number;
  /** The brain's rules it was started with, as a short name for them: a brain with others has it started again. */
  rules?: string;
}

/** What a host tells the module of the session it holds. */
export interface HostEvents {
  /** The session took a prompt: one cophylad sent (`ref`), or words typed into its terminal. What it is told beside it, in parts. */
  prompted(ref: string | undefined, text: string, size: number): Promise<string[]>;
  /** It ran a tool of its harness's own. */
  step(tool: string, input: unknown): void;
  /** Its turn ended with these words. */
  replied(text: string): void;
  /** Its program went. */
  ended(why: string): void;
  /** Its context grew, or its terminal changed. */
  changed(): void;
  /** What it held was cleared or folded away: the next prompt is told the situation whole. */
  forgot(): void;
  /** One of its tool calls, for a host the harness calls back on. */
  call(tool: string, input: unknown): Promise<ToolCallResult>;
  tools(): Promise<LlmTool[]>;
}

/** The session on a harness: started, typed into, cleared and ended. */
export interface AssistantHost {
  readonly harness: AssistantHarness;
  /** Starts it, going on with a conversation when `resume` names one; the conversation's id. */
  start(resume: string | undefined): Promise<{ native: string }>;
  /**
   * Hands it a prompt. `ref` names the prompt to the module; a host whose harness names it
   * otherwise in its receipt answers that name instead.
   */
  send(text: string, ref: string): Promise<{ ref?: string }>;
  /** Gives it a context of its own, the conversation so far left behind. */
  clear(): Promise<void>;
  /** Ends its program; the conversation stays where the harness keeps it. */
  stop(): Promise<void>;
  /** Lets go of it without ending it, as at a daemon stop. */
  release(): Promise<void>;
  native(): string | undefined;
  terminal(): TerminalRef | undefined;
  /** The context it holds now, in tokens. */
  used(): number | undefined;
  /** The size its context is folded at, where that is not the configured one (a model whose window is smaller). */
  limit(): number | undefined;
}

/** What the module asks of the sessions module: the chat's own session in tether. */
export interface AssistantSessions {
  setAssistant(hooks: { hook(hook: NormalisedHook, info: { ref?: string }): Promise<unknown> | unknown; changed(session: Session): void } | undefined): void;
  assistantSession(): Session | undefined;
  /** The context it holds, in tokens. */
  assistantContext(): number | undefined;
  spawnAssistant(p: AssistantSpawn): Promise<Session>;
  claimAssistant(harness: "codex", nativeId: string): void;
  send(id: string, text: string, opts: SendOptions, part: string): Promise<{ status: "queued" | "held"; ref?: string }>;
  stopSession(id: string, opts: { as?: "user" | "brain" }, part: string): Promise<void>;
}

/** The brain as the module reaches it: requests while it is up, events queued for it otherwise. */
export interface AssistantBrain {
  /** It has answered its handshake. */
  readonly up: boolean;
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  send(event: FeedEvent): void;
}

export interface AssistantDeps {
  config: AssistantConfig;
  dataDir: string;
  nodeId: string;
  kv: { get(ns: string, key: string): unknown; put(ns: string, key: string, value: unknown): void; delete(ns: string, key: string): void };
  bus: Bus;
  log: Logger;
  sessions: AssistantSessions;
  profiles: { list(node?: string): HarnessProfile[]; defaultFor(harness: "claude" | "codex"): HarnessProfile | undefined; hooksMode(id: string): "http" | "command"; onChange(fn: () => void): () => void; refresh(): void };
  chat: Pick<Chat, "userMessage" | "say" | "peek">;
  brain: () => AssistantBrain | undefined;
  /** The api's loopback port, once it listens. */
  port: () => number;
  hookToken: string;
  /** Builds the Codex host; absent, a Codex account cannot run the chat here. */
  codex?: (profile: HarnessProfile, events: HostEvents, opts: { config: AssistantConfig; system: string; cwd: string }) => AssistantHost;
  now?: () => number;
  /** A test shortens the waits. */
  timing?: { backoffMs?: number; receiptMs?: number; contextMs?: number };
}

type Item = { kind: "user"; message: string; text: string; tries?: number } | { kind: "wake"; id: string; text: string } | { kind: "clear" };

interface Deferred {
  promise: Promise<string[]>;
  resolve: (parts: string[]) => void;
  at: number;
}

/** A hook's answer that hands the model `text`; nothing when there is none. */
function additional(event: string, text: string | undefined): unknown {
  return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {};
}

/** A short stable name for a prompt's words, to tell two prompts of one turn apart. */
function digest(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export class Assistant {
  private deps: AssistantDeps;
  private log: Logger;
  private status: AssistantStatus = "off";
  private detail?: string;
  private host?: AssistantHost;
  private profile?: HarnessProfile;
  private harness?: AssistantHarness;
  /** The brain's rules and its tool server's instructions, as last asked. */
  private setup?: { system: string; instructions: string };
  /** The rules the running session was started with, by `digest`. */
  private rules?: string;
  private token = "";
  private queue: Item[] = [];
  /** The turn the session is in. */
  private current?: { prompt: AssistantPrompt };
  /** Prompts sent to the session and not yet taken, by the ref each went under. */
  private pending = new Map<string, Item>();
  /** Prompts whose time to be taken ran out, by ref: one taken late all the same is known by it. */
  private late = new Map<string, Item>();
  /** The prompt whose receipt is awaited: nothing else is sent meanwhile. */
  private awaiting?: { ref: string; timer: ReturnType<typeof setTimeout> };
  /** The telling that last reached the session. */
  private have?: number;
  /** Nothing was typed into the session since its context began. */
  private fresh = true;
  /** The chat thread the session's context belongs to. */
  private thread?: string;
  /** A chat message is being stored for words typed into the session's terminal: it is not typed again. */
  private storing = false;
  private draining = false;
  /** A drain was asked for while one ran: it runs again once that one has ended. */
  private again = false;
  /** The brain's rules changed under a running session: it is started again under them once it is idle. */
  private stale = false;
  private sent = 0;
  private bringing?: Promise<void>;
  private backoffMs: number;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private offs: (() => void)[] = [];
  private contexts = new Map<string, Deferred>();
  /** What the brain was last told of the session, so it is told only of a change. */
  private toldBrain = "";
  private toldClients = "";

  constructor(deps: AssistantDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.backoffMs = deps.timing?.backoffMs ?? BACKOFF_MIN_MS;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private get running(): boolean {
    return this.status === "idle" || this.status === "busy";
  }

  // --- lifecycle ------------------------------------------------------------------------

  /** Comes up with the brain: the session is met again or started, and the chat's messages go to it from now on. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.thread = this.deps.chat.peek()?.id;
    this.deps.sessions.setAssistant({ hook: (hook, info) => this.hook(hook, info), changed: (session) => this.sessionChanged(session) });
    this.offs.push(this.deps.bus.on("user.message", (e) => this.onUserMessage(e.message, e.text)));
    this.offs.push(this.deps.bus.on("thread.state", (t) => this.onThread(t.id, t.endedAt === undefined)));
    // A login since: an account to run on may have come.
    this.offs.push(this.deps.profiles.onChange(() => {
      if (this.status === "unavailable") void this.bring();
    }));
    void this.bring();
  }

  /**
   * Goes down with the brain. `keep` leaves the session's program running for the next daemon
   * to meet again; without it (this node gave the role away) the program ends.
   */
  async stop(opts: { keep?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const off of this.offs.splice(0)) off();
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.clearAwaiting();
    await this.bringing?.catch(() => undefined);
    const host = this.host;
    this.host = undefined;
    this.current = undefined;
    this.queue = [];
    this.pending.clear();
    if (host) await (opts.keep ? host.release() : host.stop()).catch((e: unknown) => this.log.debug("the chat's session was not let go cleanly", { error: e instanceof Error ? e.message : String(e) }));
    this.deps.sessions.setAssistant(undefined);
    this.setStatus("off");
  }

  /** The brain answered its handshake: it is told where the session stands, and a start that waited on it goes on. */
  onBrainUp(): void {
    if (this.stopped) return;
    this.toldBrain = "";
    this.tellState();
    if (this.status === "down" || this.status === "starting") void this.bring();
    else if (this.running) void this.checkRules();
  }

  /** A brain that came back while the session runs: one with other rules has the session started again under them. */
  private async checkRules(): Promise<void> {
    const harness = this.harness;
    const had = this.setup;
    if (!harness || !had) return;
    try {
      const setup = await this.ask("assistant.setup", { harness }, SETUP_TIMEOUT_MS);
      if (this.stopped || !this.running || this.setup !== had) return;
      if (setup.system === had.system) {
        this.setup = setup;
        return;
      }
      this.stale = true;
      this.renew();
    } catch (e) {
      this.log.debug("the brain did not say what the chat's session is started with", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Starts a session whose rules are stale again, where it was, when no turn of it runs and nothing waits to be taken. */
  private renew(): void {
    if (!this.stale || this.stopped || !this.running || this.current || this.awaiting) return;
    this.stale = false;
    this.log.info("the brain's rules changed; starting the chat's session again under them");
    void this.restart().catch((e: unknown) => this.log.warn("the chat's session was not started again under the brain's new rules", { error: e instanceof Error ? e.message : String(e) }));
  }

  /** Whether stopping the daemon now would cut a turn short. */
  get busy(): boolean {
    return this.current !== undefined;
  }

  // --- which harness, which account -----------------------------------------------------

  prefs(): AssistantPrefs {
    const v = this.deps.kv.get(ASSISTANT_NS, PREFS_KEY);
    if (!v || typeof v !== "object") return {};
    const p = v as Record<string, unknown>;
    return { ...(p["harness"] === "claude" || p["harness"] === "codex" ? { harness: p["harness"] } : {}), ...(typeof p["profile"] === "string" ? { profile: p["profile"] } : {}) };
  }

  /** The harness and the account the chat runs on: the user's choice, then config, then the usual account, Claude Code first. */
  private choose(): { harness: AssistantHarness; profile: HarnessProfile } | undefined {
    const prefs = this.prefs();
    const here = this.deps.profiles.list(this.deps.nodeId).filter((p) => (p.harness === "claude" || p.harness === "codex") && p.status === "ok");
    const named = prefs.profile ?? this.deps.config.profile;
    const harness = prefs.harness ?? this.deps.config.harness;
    if (named !== undefined) {
      const want = named.trim().toLowerCase();
      const found = here.find((p) => p.id === named) ?? here.find((p) => p.name.toLowerCase() === want && (harness === undefined || p.harness === harness));
      if (found) return { harness: found.harness as AssistantHarness, profile: found };
      this.log.warn("the account named for the chat is not signed in here; the usual one is used", { profile: named });
    }
    for (const h of harness ? [harness] : (["claude", "codex"] as const)) {
      const usual = this.deps.profiles.defaultFor(h);
      const profile = usual && usual.status === "ok" ? usual : here.find((p) => p.harness === h);
      if (profile) return { harness: h, profile };
    }
    return undefined;
  }

  private sessionFile(): string {
    return join(this.deps.dataDir, "assistant", "session.json");
  }

  private saved(): Saved | undefined {
    try {
      const v = JSON.parse(readFileSync(this.sessionFile(), "utf8")) as Partial<Saved>;
      if ((v.harness === "claude" || v.harness === "codex") && typeof v.profile === "string" && typeof v.native === "string" && typeof v.token === "string") return { ...(v as Saved), port: typeof v.port === "number" ? v.port : 0 };
    } catch {
      // none kept, or not one this version wrote
    }
    return undefined;
  }

  private save(): void {
    const native = this.host?.native();
    if (!this.harness || !this.profile || !native) return;
    mkdirSync(join(this.deps.dataDir, "assistant"), { recursive: true });
    const saved: Saved = { harness: this.harness, profile: this.profile.id, native, token: this.token, port: this.deps.port(), ...(this.rules !== undefined ? { rules: this.rules } : {}) };
    writeFileSync(this.sessionFile(), JSON.stringify(saved) + "\n", { encoding: "utf8", mode: 0o600 });
  }

  // --- bringing the session up ------------------------------------------------------------

  /** Brings the session up, once at a time. */
  private bring(): Promise<void> {
    if (this.bringing) return this.bringing;
    this.bringing = this.bringUp().finally(() => {
      this.bringing = undefined;
    });
    return this.bringing;
  }

  private async bringUp(): Promise<void> {
    if (this.stopped || this.running) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    if (!this.deps.config.enabled) return this.setStatus("off", "the chat's session is turned off in config.toml ([assistant] enabled)");
    this.deps.profiles.refresh();
    const chosen = this.choose();
    if (!chosen) {
      this.harness = undefined;
      this.profile = undefined;
      return this.setStatus("unavailable", NO_ACCOUNT);
    }
    this.harness = chosen.harness;
    this.profile = chosen.profile;
    this.setStatus("starting");
    // What it is started with is the brain's to say: a brain still coming up is waited for (`onBrainUp`).
    if (!this.deps.brain()?.up) return;
    try {
      const setup = await this.ask("assistant.setup", { harness: chosen.harness }, SETUP_TIMEOUT_MS);
      this.setup = setup;
      const saved = this.saved();
      const same = saved !== undefined && saved.harness === chosen.harness && saved.profile === chosen.profile.id;
      const host = this.hostFor(chosen.harness, chosen.profile, setup.system);
      // The session of an earlier daemon, still running in its terminal: met again as it is, under the token it was
      // started with. One whose hooks and tool server name a port this daemon does not listen on is started again.
      const live = this.deps.sessions.assistantSession();
      if (live && same && saved.port === this.deps.port() && live.profile === chosen.profile.id && live.native.terminal && host instanceof ClaudeHost) {
        this.token = saved.token;
        // It holds a conversation: a thread opening clears it.
        this.fresh = false;
        host.adopt(live);
        this.log.info("the chat's session met again", { session: live.id, native: live.native.id });
        if (live.status === "busy") this.current = { prompt: { kind: "terminal" } };
        // It runs under the rules it was started with: a brain that has others since has it started again, once it is idle.
        this.rules = saved.rules;
        this.stale = saved.rules !== digest(setup.system);
      } else {
        if (live) await this.deps.sessions.stopSession(live.id, { as: "brain" }, ASSISTANT_PART).catch(() => undefined);
        this.token = randomBytes(24).toString("base64url");
        const resume = same ? saved.native : undefined;
        let resumed = resume !== undefined;
        try {
          await host.start(resume);
        } catch (e) {
          if (resume === undefined) throw e;
          // The conversation it was to go on with is not there to resume: a fresh one.
          this.log.warn("the chat's conversation could not be resumed; starting a fresh one", { error: e instanceof Error ? e.message : String(e) });
          await host.start(undefined);
          resumed = false;
        }
        this.have = undefined;
        // One that goes on with a conversation holds it; one started anew holds nothing yet.
        this.fresh = !resumed;
        this.rules = digest(setup.system);
        this.stale = false;
      }
      if (this.stopped) {
        await host.release();
        return;
      }
      this.host = host;
      this.save();
      this.backoffMs = this.deps.timing?.backoffMs ?? BACKOFF_MIN_MS;
      this.log.info("the chat's session is up", { harness: chosen.harness, profile: chosen.profile.name, native: host.native() });
      this.setStatus(this.current ? "busy" : "idle");
      if (this.stale && this.queue.length === 0) this.renew();
      this.pump();
    } catch (e) {
      if (this.stopped) return;
      const message = e instanceof Error ? e.message : String(e);
      this.log.warn("the chat's session did not start; trying again", { error: message, inMs: this.backoffMs });
      this.setStatus("down", message);
      this.retry = setTimeout(() => {
        this.retry = undefined;
        void this.bring();
      }, this.backoffMs);
      if (typeof this.retry === "object" && "unref" in this.retry) this.retry.unref();
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    }
  }

  private hostFor(harness: AssistantHarness, profile: HarnessProfile, system: string): AssistantHost {
    if (harness === "codex") {
      if (!this.deps.codex) throw new Error("a Codex account cannot run the chat on this node");
      const cwd = claudeFiles(this.deps.dataDir).cwd;
      mkdirSync(cwd, { recursive: true });
      return this.deps.codex(profile, this.events(), { config: this.deps.config, system, cwd });
    }
    return new ClaudeHost({
      sessions: this.deps.sessions,
      spawn: (resume) => {
        const files = writeClaudeSetup({
          dataDir: this.deps.dataDir,
          system,
          port: this.deps.port(),
          hookToken: this.deps.hookToken,
          mcpToken: this.token,
          profileId: profile.id,
          hooksMode: this.deps.profiles.hooksMode(profile.id),
          tools: this.deps.config.tools,
        });
        return { profile, cwd: files.cwd, args: claudeArgs(this.deps.config, files), env: claudeEnvExtra(), ...(resume !== undefined ? { resume } : {}) };
      },
    });
  }

  private events(): HostEvents {
    return {
      prompted: (ref, text, size) => this.prompted(ref, text, size),
      step: (tool, input) => this.step(tool, input),
      replied: (text) => this.replied(text),
      ended: (why) => this.ended(why),
      changed: () => this.tellState(),
      forgot: () => {
        this.have = undefined;
        this.save();
      },
      call: (tool, input) => this.call(tool, input),
      tools: async () => (await this.tools()).tools,
    };
  }

  /** The session's program went: its turn goes with it, and it is started again where it was. */
  private ended(why: string): void {
    if (this.stopped || !this.host) return;
    this.log.warn("the chat's session ended; starting it again", { why });
    this.host = undefined;
    // A turn of the user's that went with it had no answer: they are told, since nothing else will say so.
    if (this.current && this.current.prompt.kind !== "wake") this.deps.chat.say([{ type: "text", text: "The chat's agent stopped before it answered, and is being started again. Send your message again." }]);
    this.abandon();
    this.setStatus("down", "the chat's session ended and is being started again");
    void this.bring();
  }

  /**
   * The session goes, or went, under what it was handed. Its turn is told to the brain as
   * unanswered, and so is a wake it had not taken yet, so the brain owes them again; a user's
   * message it had not taken is typed again once it is back.
   */
  private abandon(): void {
    this.clearAwaiting();
    if (this.current) {
      const turn = this.current;
      this.current = undefined;
      this.tell("assistant.replied", { text: "", prompt: turn.prompt, interrupted: true });
    }
    const owed: Item[] = [];
    for (const item of this.pending.values()) {
      if (item.kind === "user") owed.push(item);
      else if (item.kind === "wake") this.tell("assistant.replied", { text: "", prompt: { kind: "wake", wake: item.id }, interrupted: true });
    }
    this.pending.clear();
    this.queue.unshift(...owed);
  }

  /** The session's row changed: one that ended is started again; a new id after a clear is kept, and its context's size told. */
  private sessionChanged(session: Session): void {
    if (this.stopped || !(this.host instanceof ClaudeHost) || session.id !== this.host.id) return;
    if (session.status === "ended") return this.ended("its program went");
    const before = this.host.native();
    this.host.adopt(session);
    if (before !== session.native.id) this.save();
    this.tellState();
  }

  // --- what the session is handed ---------------------------------------------------------

  private onUserMessage(message: string, text: string): void {
    if (this.stopped || this.storing) return;
    if (this.status === "unavailable" || this.status === "off") {
      if (this.status === "unavailable") this.deps.chat.say([{ type: "text", text: this.detail ?? NO_ACCOUNT }]);
      return;
    }
    this.enqueue({ kind: "user", message, text: text.replace(/^\/quick\s*/i, "") });
  }

  /** A chat thread opened: the session's context is the one before it, and is cleared once it is idle. */
  private onThread(id: string, open: boolean): void {
    if (this.stopped || !open || id === this.thread) return;
    const first = this.thread === undefined;
    this.thread = id;
    if (first || this.queue.some((i) => i.kind === "clear")) return;
    this.enqueue({ kind: "clear" });
  }

  /** A wake of the brain's: taken only while the session is up, since the brain keeps what is not. */
  wake(p: { id: string; text: string }): { queued: boolean } {
    if (this.stopped || !this.running) return { queued: false };
    this.enqueue({ kind: "wake", id: p.id, text: p.text });
    return { queued: true };
  }

  /** A user's message goes ahead of what the brain sent; a clear and what follows it keep their order. */
  private enqueue(item: Item): void {
    if (item.kind === "user") {
      const at = this.queue.findIndex((i) => i.kind === "wake");
      if (at >= 0) this.queue.splice(at, 0, item);
      else this.queue.push(item);
    } else this.queue.push(item);
    this.pump();
  }

  private pump(): void {
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = true;
    void this.drain()
      .catch((e: unknown) => this.log.warn("the chat's queue stopped on an error", { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        this.draining = false;
        // What was queued while this one was ending is not left waiting for the next thing to happen.
        if (this.again) {
          this.again = false;
          this.pump();
        }
      });
  }

  /** Sends what is owed, one prompt at a time; a user's message alone does not wait for a running turn, which it joins. */
  private async drain(): Promise<void> {
    for (;;) {
      const host = this.host;
      const next = this.queue[0];
      if (this.stopped || !host || !this.running || !next || this.awaiting) return;
      if (this.current && next.kind !== "user") return;
      this.queue.shift();
      if (next.kind === "clear") {
        if (this.fresh) continue;
        try {
          await host.clear();
          this.fresh = true;
          this.save();
        } catch (e) {
          this.log.warn("the chat's session kept its context: it could not be cleared", { error: e instanceof Error ? e.message : String(e) });
        }
        continue;
      }
      // Named before it is sent: a harness may take it before the send returns.
      const own = `prompt-${++this.sent}`;
      this.pending.set(own, next);
      try {
        const ref = (await host.send(next.text, own)).ref ?? own;
        if (ref !== own && this.pending.delete(own)) this.pending.set(ref, next);
        // Not taken yet: nothing else goes until its receipt, or its time is up.
        if (this.pending.has(ref)) {
          const timer = setTimeout(() => this.unreceived(ref), this.deps.timing?.receiptMs ?? RECEIPT_TIMEOUT_MS);
          if (typeof timer === "object" && "unref" in timer) timer.unref();
          this.awaiting = { ref, timer };
        }
      } catch (e) {
        this.pending.delete(own);
        this.log.warn("a prompt could not be handed to the chat's session", { kind: next.kind, error: e instanceof Error ? e.message : String(e) });
        this.undelivered(next);
      }
    }
  }

  private clearAwaiting(): void {
    if (this.awaiting) clearTimeout(this.awaiting.timer);
    this.awaiting = undefined;
  }

  /** A prompt typed into the session was never taken. */
  private unreceived(ref: string): void {
    if (this.awaiting?.ref !== ref) return;
    this.awaiting = undefined;
    const item = this.pending.get(ref);
    this.pending.delete(ref);
    this.log.warn("the chat's session did not take a prompt in time", { ref, kind: item?.kind });
    if (item) {
      // It may be taken yet: remembered, so a late receipt is known for what it is. Nothing is typed a
      // second time, since both would land. A wake goes back to the brain; the user is told theirs waits.
      if (this.late.size >= 8) this.late.delete(this.late.keys().next().value!);
      this.late.set(ref, item);
      if (item.kind === "wake") this.tell("assistant.replied", { text: "", prompt: { kind: "wake", wake: item.id }, interrupted: true });
      else if (item.kind === "user") this.deps.chat.say([{ type: "text", text: "Your message has not reached the chat's agent yet. If no answer comes, send it again, or restart the chat agent from the chat's menu." }]);
    }
    this.pump();
  }

  /** A prompt that could not be handed to the session at all: a user's is tried once more, then they are told; a wake goes back to the brain. */
  private undelivered(item: Item): void {
    if (item.kind === "wake") return this.tell("assistant.replied", { text: "", prompt: { kind: "wake", wake: item.id }, interrupted: true });
    if (item.kind !== "user") return;
    if ((item.tries ?? 0) < 1) {
      this.queue.unshift({ ...item, tries: (item.tries ?? 0) + 1 });
      return;
    }
    this.deps.chat.say([{ type: "text", text: "Your message did not reach the chat's session. Send it again; if it keeps happening, restart the chat agent from the chat's menu." }]);
  }

  // --- what the session's host tells ------------------------------------------------------

  /** The session starts or starts over: it is told the situation whole. */
  private async started(source: string, size: number): Promise<string[]> {
    if (source === "startup" || source === "clear") this.fresh = true;
    const told = await this.context({ kind: "start", source });
    return parts(told, size);
  }

  /** The session took a prompt: the brain hears whose it is, and says what the session is told beside it. */
  private async prompted(ref: string | undefined, text: string, size: number): Promise<string[]> {
    let item = ref !== undefined ? this.pending.get(ref) : undefined;
    if (ref !== undefined) {
      this.pending.delete(ref);
      if (this.awaiting?.ref === ref) this.clearAwaiting();
      if (!item) {
        const late = this.late.get(ref);
        // Text of cophylad's own that is no prompt (the `/clear` it types): nothing is told beside it.
        if (!late) return [];
        // Taken after its time was up: a user's message is theirs all the same. A wake the brain was told
        // went unanswered is owed again by it, so this turn is no wake's.
        this.late.delete(ref);
        if (late.kind === "user") item = late;
      }
    }
    let prompt: AssistantPrompt;
    if (item?.kind === "user") prompt = { kind: "user", message: item.message };
    else if (item?.kind === "wake") prompt = { kind: "wake", wake: item.id };
    // A wake the brain was told went unanswered, taken late all the same, or a command of the harness's own typed into its terminal.
    else if (ref !== undefined || unpasted(text).trim() === "" || text.trimStart().startsWith("/")) prompt = { kind: "terminal" };
    else {
      // Typed straight into the session's terminal: the user's message all the same, stored without being typed again.
      this.storing = true;
      try {
        prompt = { kind: "user", message: this.deps.chat.userMessage({ text: unpasted(text).trim(), source: "ui" }).id };
      } finally {
        this.storing = false;
      }
    }
    // Taken into a turn that runs: a wake's turn stays the wake's, whose end settles it; the user's is the latest message's.
    if (this.current && prompt.kind !== "wake") {
      if (this.current.prompt.kind !== "wake") this.current.prompt = prompt;
    } else this.current = { prompt };
    // A context that begins with this prompt, on a harness that says nothing of its start: the brain is told so.
    const begins = this.fresh && this.harness === "codex";
    this.fresh = false;
    this.setStatus("busy");
    this.tell("assistant.prompted", { prompt });
    const told = await this.context({ kind: "prompt", prompt, ...(begins ? { source: "fresh" } : {}) });
    this.pump();
    return parts(told, size);
  }

  private step(tool: string, input: unknown): void {
    this.tell("assistant.step", { tool, input });
  }

  /** The session's turn ended with these words: the brain says them, and the next prompt may go. */
  private replied(text: string): void {
    const turn = this.current;
    this.current = undefined;
    this.tell("assistant.replied", { text, ...(turn ? { prompt: turn.prompt } : {}) });
    if (this.running) this.setStatus("idle");
    if (this.stale && this.queue.length === 0) return this.renew();
    this.pump();
  }

  /** What the brain says the session is told; nothing when it does not answer in time. */
  private async context(p: { kind: "start"; source: string } | { kind: "prompt"; prompt: AssistantPrompt; source?: "fresh" }): Promise<string> {
    try {
      const r = await this.ask("assistant.context", { ...p, ...(this.have !== undefined ? { have: this.have } : {}) }, this.deps.timing?.contextMs ?? CONTEXT_TIMEOUT_MS);
      if (r.seq !== undefined) this.have = r.seq;
      return r.text;
    } catch (e) {
      this.log.warn("the brain did not say what the chat's session is told", { kind: p.kind, error: e instanceof Error ? e.message : String(e) });
      return "";
    }
  }

  // --- the Claude session's hooks -----------------------------------------------------------

  /** A hook of the session in tether: its start, a prompt it took, a tool it ran, its turn's end. */
  private async hook(hook: NormalisedHook, info: { ref?: string }): Promise<unknown> {
    // A Codex thread is heard over its app-server's connection, never through the profile's hooks.
    if (this.stopped || hook.harness !== "claude") return {};
    switch (hook.name) {
      case "SessionStart": {
        const d = this.deferred(`start:${hook.sessionId}`);
        const list = await this.started(hook.source ?? "startup", CLAUDE_PART_CHARS).catch(() => []);
        d.resolve(list);
        return additional("SessionStart", list[0]);
      }
      case "UserPromptSubmit": {
        const d = this.deferred(`prompt:${hook.sessionId}:${hook.promptId ?? ""}:${digest(hook.prompt ?? "")}`);
        const list = await this.prompted(info.ref, hook.prompt ?? "", CLAUDE_PART_CHARS).catch(() => []);
        d.resolve(list);
        return additional("UserPromptSubmit", list[0]);
      }
      case "PostToolUse":
      case "PostToolUseFailure":
        // Cophyla's own tools are told by the brain as it runs them.
        if (hook.toolName && !hook.toolName.startsWith("mcp__")) this.step(hook.toolName, hook.toolInput);
        return {};
      case "Stop":
        this.replied(hook.lastAssistantMessage ?? "");
        return {};
      default:
        return {};
    }
  }

  /** The further part `n` of what a hook's first answer began: asked for by the hooks installed beside it. */
  async part(body: unknown, n: number): Promise<unknown> {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const event = String(b["hook_event_name"] ?? "");
    const session = String(b["session_id"] ?? "");
    const key = event === "SessionStart" ? `start:${session}` : event === "UserPromptSubmit" ? `prompt:${session}:${String(b["prompt_id"] ?? "")}:${digest(String(b["prompt"] ?? ""))}` : undefined;
    if (key === undefined || this.stopped) return {};
    const d = this.deferred(key);
    const list = await Promise.race([d.promise, new Promise<string[]>((resolve) => setTimeout(() => resolve([]), PART_WAIT_MS))]);
    return additional(event, list[n]);
  }

  /** What a hook's parts wait on: made by whichever of them comes first, settled by the first part. */
  private deferred(key: string): Deferred {
    const now = this.now();
    for (const [k, d] of this.contexts) if (now - d.at > 30_000) this.contexts.delete(k);
    let d = this.contexts.get(key);
    if (!d) {
      let resolve!: (parts: string[]) => void;
      const promise = new Promise<string[]>((r) => (resolve = r));
      d = { promise, resolve, at: now };
      this.contexts.set(key, d);
      // A session that starts over under the same id (a compaction) asks afresh.
      if (key.startsWith("start:")) void promise.then(() => setTimeout(() => this.contexts.get(key) === d && this.contexts.delete(key), 5000));
    }
    return d;
  }

  // --- the session's tools ------------------------------------------------------------------

  /** Whether a request to the `/mcp` endpoints is the session's own: it carries the token of its spawn. */
  get mcpToken(): string | undefined {
    return this.token === "" || this.stopped ? undefined : this.token;
  }

  /** The tools the session may call, with what their server says of itself. */
  async tools(): Promise<{ tools: LlmTool[]; instructions?: string }> {
    const r = await this.ask("tools.list", {}, LIST_TIMEOUT_MS);
    return { tools: r.tools, ...(this.setup ? { instructions: this.setup.instructions } : {}) };
  }

  /** One call of the session's, run by the brain; a brain that is not there is an error the model reads. */
  async call(tool: string, input: unknown): Promise<ToolCallResult> {
    try {
      return await this.ask("tool.call", { tool, input }, CALL_TIMEOUT_MS);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.warn("a tool call of the chat's session was not run", { tool, error: message });
      return { content: `${tool} was not run: ${message}. Tell the user in a line and end the turn.`, isError: true };
    }
  }

  // --- the brain -----------------------------------------------------------------------------

  private async ask<N extends BrainRequestName>(method: N, params: BrainRequestParams<N>, timeoutMs: number): Promise<BrainRequestResult<N>> {
    const brain = this.deps.brain();
    if (!brain) throw new RpcError("unavailable", "the brain is not running");
    return (await brain.request(method, params, timeoutMs)) as BrainRequestResult<N>;
  }

  private tell(name: "assistant.prompted" | "assistant.step" | "assistant.replied" | "assistant.state", params: Record<string, unknown>): void {
    const now = this.now();
    this.deps.brain()?.send({ name, params: { at: now, eventId: `evt_${ulid(now)}`, ...params } } as FeedEvent);
  }

  // --- where it stands -----------------------------------------------------------------------

  private setStatus(status: AssistantStatus, detail?: string): void {
    this.status = status;
    this.detail = detail;
    this.tellState();
  }

  /** Where the session stands, as a view shows it. */
  state(): AssistantState {
    const used = this.host?.used();
    const limit = this.harness === undefined ? undefined : (this.host?.limit() ?? this.deps.config.autocompact_tokens);
    const terminal = this.host?.terminal();
    const chosen = this.prefs();
    return {
      status: this.status,
      ...(this.harness ? { harness: this.harness, model: this.harness === "claude" ? this.deps.config.claude_model : this.deps.config.codex_model, effort: this.harness === "claude" ? this.deps.config.claude_effort : this.deps.config.codex_effort } : {}),
      ...(this.profile ? { profile: this.profile.id } : {}),
      ...(used !== undefined && limit !== undefined ? { context: { used, limit } } : {}),
      ...(terminal ? { terminal } : {}),
      ...(chosen.harness !== undefined || chosen.profile !== undefined ? { chosen } : {}),
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    };
  }

  /** Tells the clients and the brain where the session stands, each only of a change. */
  private tellState(): void {
    const state = this.state();
    const clients = JSON.stringify(state);
    if (clients !== this.toldClients) {
      this.toldClients = clients;
      this.deps.bus.emit("assistant.state", state);
    }
    const brain = JSON.stringify([state.status, state.harness, state.profile, state.model]);
    if (brain !== this.toldBrain) {
      this.toldBrain = brain;
      this.tell("assistant.state", { status: state.status, ...(state.harness ? { harness: state.harness } : {}), ...(state.profile ? { profile: state.profile } : {}), ...(state.model ? { model: state.model } : {}) });
    }
  }

  // --- what the user sets ----------------------------------------------------------------------

  /** The user picks the harness or the account: kept, and the session started again under it, with a context of its own. */
  async configure(patch: { harness?: AssistantHarness | null; profile?: string | null }): Promise<AssistantState> {
    const prefs = this.prefs();
    if (patch.harness !== undefined) {
      if (patch.harness === null) delete prefs.harness;
      else prefs.harness = patch.harness;
    }
    if (patch.profile !== undefined) {
      if (patch.profile === null) delete prefs.profile;
      else prefs.profile = patch.profile;
    }
    if (Object.keys(prefs).length === 0) this.deps.kv.delete(ASSISTANT_NS, PREFS_KEY);
    else this.deps.kv.put(ASSISTANT_NS, PREFS_KEY, prefs);
    await this.restart({ fresh: true });
    return this.state();
  }

  /** Ends the session's program and starts it again: where it was, or, `fresh`, with a context of its own. */
  async restart(opts: { fresh?: boolean } = {}): Promise<AssistantState> {
    if (this.stopped) return this.state();
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    await this.bringing?.catch(() => undefined);
    const host = this.host;
    this.host = undefined;
    // Its turn goes with it: the brain is told nothing was said.
    this.abandon();
    if (host) await host.stop().catch((e: unknown) => this.log.debug("the chat's session did not end cleanly", { error: e instanceof Error ? e.message : String(e) }));
    if (opts.fresh) rmSync(this.sessionFile(), { force: true });
    this.stale = false;
    this.status = "down";
    this.backoffMs = this.deps.timing?.backoffMs ?? BACKOFF_MIN_MS;
    await this.bring();
    return this.state();
  }
}

// --- Claude Code in tether ---------------------------------------------------------------------

interface ClaudeHostDeps {
  sessions: AssistantSessions;
  /** What the session is started with, its files written. */
  spawn: (resume: string | undefined) => AssistantSpawn;
}

/** The chat's session as the Claude Code CLI in a tether terminal: typed into as the user, heard through its hooks. */
export class ClaudeHost implements AssistantHost {
  readonly harness = "claude" as const;
  private deps: ClaudeHostDeps;
  private session?: Session;

  constructor(deps: ClaudeHostDeps) {
    this.deps = deps;
  }

  get id(): string | undefined {
    return this.session?.id;
  }

  /** Takes a session as it stands: one met again, or its row as it changed. */
  adopt(session: Session): void {
    this.session = session;
  }

  async start(resume: string | undefined): Promise<{ native: string }> {
    this.session = await this.deps.sessions.spawnAssistant(this.deps.spawn(resume));
    return { native: this.session.native.id };
  }

  private must(): Session {
    if (!this.session) throw new RpcError("unavailable", "the chat's session is not running");
    return this.session;
  }

  async send(text: string, _ref: string): Promise<{ ref?: string }> {
    const r = await this.deps.sessions.send(this.must().id, text, { from: "user" }, ASSISTANT_PART);
    return r.ref !== undefined ? { ref: r.ref } : {};
  }

  async clear(): Promise<void> {
    await this.deps.sessions.send(this.must().id, "", { from: "user", clear: true }, ASSISTANT_PART);
  }

  async stop(): Promise<void> {
    const s = this.session;
    this.session = undefined;
    if (s) await this.deps.sessions.stopSession(s.id, { as: "brain" }, ASSISTANT_PART);
  }

  async release(): Promise<void> {
    this.session = undefined;
  }

  native(): string | undefined {
    return this.session?.native.id;
  }

  terminal(): TerminalRef | undefined {
    return this.session?.native.terminal;
  }

  used(): number | undefined {
    return this.session ? this.deps.sessions.assistantContext() : undefined;
  }

  limit(): number | undefined {
    return undefined;
  }
}

