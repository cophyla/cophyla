// The chat's own session on Codex: a thread on an app-server of cophylad's own, under a
// profile of the user's. The app-server is the harness's own program (`codex app-server`),
// signed in as the user is; cophylad is its client, as an editor is. Nothing is typed and no
// hook is needed: a prompt is a `turn/start`, with what the brain says the session is told
// beside it as the turn's `additionalContext` (cut into entries, since each is capped at
// about a thousand tokens); the brain's rules are the thread's `developerInstructions`; and
// Cophyla's tools are the thread's `dynamicTools`, which the app-server calls back on over
// the same connection (`item/tool/call`) and which survive a resume.
//
// The thread starts read-only, with approvals never asked: a write is refused by the sandbox,
// and it has no shell. The harness keeps tools of its own that no setting takes away (a patch
// tool, sub-agents, a question to the user); the rules tell the session to leave them, and
// what they would ask of cophylad is declined. A turn's reply is its last agent message that
// is not commentary. A `turn/start` while a turn runs is steered into that turn by the
// harness, which then ends once, under the first turn's id.
//
// A clear is a thread of its own, the one before left where it is. The app-server going
// away takes the session with it: the module starts it again and resumes the thread.

import { AGENT_MCP_SERVER } from "@cophyla/protocol";
import type { AssistantHarness, HarnessProfile, TerminalRef } from "@cophyla/protocol";
import type { AssistantConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";
import { CODEX_PART_CHARS } from "./context.ts";
import type { AssistantHost, HostEvents } from "./index.ts";

/** The most a Codex thread compacts at: under the window of the models it runs on, which is smaller than Claude's. */
export const CODEX_COMPACT_MAX = 230_000;

/** The app-server as the host uses it: the handshake, requests, and its going away. */
export interface CodexServer {
  /** Its child runs and has answered the handshake. */
  readonly alive: boolean;
  start(): Promise<unknown>;
  call<T = unknown>(method: string, params: unknown): Promise<T>;
  stop(): Promise<void>;
}

export interface CodexServerOptions {
  onNotification: (method: string, params: unknown) => void;
  /** A request of the app-server's: answered when this returns a promise, declined otherwise. */
  onRequest: (method: string, params: unknown) => Promise<unknown> | undefined;
  onExit: () => void;
}

export interface CodexHostDeps {
  profile: HarnessProfile;
  events: HostEvents;
  config: Pick<AssistantConfig, "codex_model" | "codex_effort" | "autocompact_tokens">;
  /** The brain's rules for the session. */
  system: string;
  /** The folder the thread runs in: cophylad's own. */
  cwd: string;
  /** The app-server under the profile. */
  server: (opts: CodexServerOptions) => CodexServer;
  /** A thread id is the chat's own: whatever meets it as a session leaves it out of every list. */
  claim: (thread: string) => void;
  log: Logger;
}

interface Item {
  type?: string;
  text?: string;
  phase?: string | null;
  query?: string;
}

/** What the thread is started and resumed with: read-only, never asking, the brain's rules, and the harness's own tools it can spare switched off. */
export function threadParams(d: Pick<CodexHostDeps, "config" | "system" | "cwd">): Record<string, unknown> {
  return {
    model: d.config.codex_model,
    cwd: d.cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
    developerInstructions: d.system,
    config: {
      model_reasoning_effort: d.config.codex_effort,
      model_auto_compact_token_limit: Math.min(d.config.autocompact_tokens, CODEX_COMPACT_MAX),
      web_search: "live",
      "features.shell_tool": false,
      "features.unified_exec": false,
      "features.multi_agent": false,
      "features.goals": false,
      "features.apps": false,
      "features.plugins": false,
      "features.memories": false,
      // the agents' server the user's own sessions get is no tool of the chat's
      [`mcp_servers.${AGENT_MCP_SERVER}.enabled`]: false,
    },
  };
}

/** A turn's additional context: one entry per part, named so they sort as they were cut. */
export function contextEntries(parts: string[]): Record<string, { value: string; kind: "application" }> {
  return Object.fromEntries(parts.map((value, i) => [`cophyla-${String(i + 1).padStart(2, "0")}`, { value, kind: "application" as const }]));
}

export class CodexHost implements AssistantHost {
  readonly harness: AssistantHarness = "codex";
  private deps: CodexHostDeps;
  private server: CodexServer;
  private thread?: string;
  /** The turn that runs, by the id its first prompt was given. */
  private turn?: string;
  /** The last agent message of the running turn that is not commentary. */
  private last = "";
  private usedTokens?: number;
  private windowTokens?: number;
  private gone = false;

  constructor(deps: CodexHostDeps) {
    this.deps = deps;
    this.server = deps.server({
      onNotification: (method, params) => this.onNotification(method, (params ?? {}) as Record<string, unknown>),
      onRequest: (method, params) => this.onRequest(method, (params ?? {}) as Record<string, unknown>),
      onExit: () => {
        if (this.gone) return;
        this.gone = true;
        // The module starts another host: this one's server is not to come back beside it.
        void this.server.stop().catch(() => undefined);
        this.deps.events.ended("its app-server went");
      },
    });
  }

  async start(resume: string | undefined): Promise<{ native: string }> {
    await this.server.start();
    const params = threadParams(this.deps);
    const tools = (await this.deps.events.tools()).map((t) => ({ type: "function", name: t.name, description: t.description, inputSchema: t.schema }));
    const r = resume !== undefined ? await this.server.call<{ thread: { id: string } }>("thread/resume", { threadId: resume, excludeTurns: true, ...params }) : await this.server.call<{ thread: { id: string } }>("thread/start", { ...params, dynamicTools: tools });
    this.thread = r.thread.id;
    this.deps.claim(this.thread);
    this.deps.log.info("the chat's thread is up", { thread: this.thread, resumed: resume !== undefined, model: this.deps.config.codex_model });
    return { native: this.thread };
  }

  async send(text: string, ref: string): Promise<{ ref?: string }> {
    if (!this.thread || this.gone) throw new Error("the chat's thread is not running");
    // The prompt is taken the moment the turn starts: the brain hears of it first, and says what goes beside it.
    const told = await this.deps.events.prompted(ref, text, CODEX_PART_CHARS);
    const r = await this.server.call<{ turn: { id: string } }>("turn/start", {
      threadId: this.thread,
      input: [{ type: "text", text, text_elements: [] }],
      effort: this.deps.config.codex_effort,
      ...(told.length > 0 ? { additionalContext: contextEntries(told) } : {}),
    });
    // A prompt sent into a running turn is steered into it: the turn ends once, under its first id.
    if (this.turn === undefined) {
      this.turn = r.turn.id;
      this.last = "";
    }
    return { ref };
  }

  /** A context of its own: a new thread, with the same rules and tools. */
  async clear(): Promise<void> {
    await this.start(undefined);
    this.turn = undefined;
    this.usedTokens = undefined;
    this.deps.events.forgot();
  }

  async stop(): Promise<void> {
    this.gone = true;
    // Only of a server that runs: a call to one that is down would start it.
    if (this.server.alive && this.thread && this.turn !== undefined) await this.server.call("turn/interrupt", { threadId: this.thread, turnId: this.turn }).catch(() => undefined);
    await this.server.stop();
  }

  /** The app-server is cophylad's own child: it goes with the daemon, and the thread is resumed by the next. */
  async release(): Promise<void> {
    this.gone = true;
    await this.server.stop();
  }

  native(): string | undefined {
    return this.thread;
  }

  terminal(): TerminalRef | undefined {
    return undefined;
  }

  used(): number | undefined {
    return this.usedTokens;
  }

  /** Folded at the configured size, or sooner: under the most a Codex thread compacts at, and under its model's window. */
  limit(): number | undefined {
    return Math.min(this.deps.config.autocompact_tokens, CODEX_COMPACT_MAX, this.windowTokens ?? Number.MAX_SAFE_INTEGER);
  }

  private onNotification(method: string, p: Record<string, unknown>): void {
    if (p["threadId"] !== this.thread) return;
    switch (method) {
      case "item/completed": {
        const item = (p["item"] ?? {}) as Item;
        if (item.type === "agentMessage" && item.phase !== "commentary" && typeof item.text === "string") this.last = item.text;
        else if (item.type === "webSearch") this.deps.events.step("web_search", { query: item.query });
        // What it held was folded away: the next prompt is told the situation whole.
        else if (item.type === "contextCompaction") this.deps.events.forgot();
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = (p["tokenUsage"] ?? {}) as { last?: { totalTokens?: number }; modelContextWindow?: number | null };
        if (typeof usage.last?.totalTokens === "number") this.usedTokens = usage.last.totalTokens;
        if (typeof usage.modelContextWindow === "number") this.windowTokens = usage.modelContextWindow;
        this.deps.events.changed();
        return;
      }
      case "turn/completed": {
        const turn = (p["turn"] ?? {}) as { id?: string; status?: string; items?: Item[]; error?: { message?: string } | null };
        if (turn.id !== this.turn) return;
        this.turn = undefined;
        const final = (turn.items ?? []).filter((i) => i.type === "agentMessage" && i.phase !== "commentary" && typeof i.text === "string").pop()?.text;
        if (turn.status === "failed") return this.deps.events.replied(`I could not finish that: ${turn.error?.message ?? "the turn failed"}.`);
        this.deps.events.replied(turn.status === "completed" ? (final ?? this.last) : "");
        return;
      }
    }
  }

  /** The app-server's own requests: a tool call of the thread's is run; anything else is declined by the client. */
  private onRequest(method: string, p: Record<string, unknown>): Promise<unknown> | undefined {
    if (method !== "item/tool/call" || p["threadId"] !== this.thread) return undefined;
    return this.deps.events.call(String(p["tool"] ?? ""), p["arguments"] ?? {}).then((r) => ({
      success: r.isError !== true,
      contentItems: [{ type: "inputText", text: r.content }, ...(r.image ? [{ type: "inputImage", imageUrl: `data:${r.image.mime};base64,${r.image.base64}` }] : [])],
    }));
  }
}
