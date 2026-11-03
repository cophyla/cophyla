// A Codex thread's sub-agents and how far each has got, for the chat's agent panel and cards
// (`Session.subagents`): what the thread's own rollout says of each (the `spawn_agent` call, its
// start with a thread of its own, its end), and while one works what its own rollout says it did:
// its tools called, the last in a few words, its model and how full its context is.

import type { SubagentRun } from "@cophyla/protocol";
import { SUBAGENTS_MAX } from "@cophyla/protocol";
import { callWords } from "../claude/subagents.ts";
import { Tail } from "../tail.ts";
import { applyCodexRow, findRollout, newCodexState } from "./rollout.ts";
import type { CodexRolloutState } from "./rollout.ts";

/** How often a working sub-agent's rollout is read: its card and the panel follow its work. */
const LIVE_MS = 3000;
/** How long since its last step a sub-agent that never said it finished still counts as working. */
const LIVE_FOR_MS = 15 * 60_000;
/** How long a sub-agent's rollout is looked for before it is taken to have none (an older Codex). */
const FIND_FOR_MS = 60_000;

interface Child {
  call: string;
  thread?: string;
  path?: string;
  type?: string;
  description?: string;
  file?: string;
  tail?: Tail;
  state?: CodexRolloutState;
  steps: number;
  last?: string;
  model?: string;
  tokens?: number;
  startedAt: number;
  lastAt: number;
  finished?: boolean;
  readAt: number;
  /** When its rollout was first looked for. */
  lookFrom?: number;
}

export class CodexChildren {
  private kids = new Map<string, Child>();

  /** A `spawn_agent` call: its sub-agent's type and task, from its arguments. */
  spawned(call: string, args: unknown, at: number): void {
    const a = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const str = (k: string) => (typeof a[k] === "string" && (a[k] as string).trim() !== "" ? (a[k] as string).trim() : undefined);
    const kid = this.kid(call, at);
    const type = str("agent_type");
    const task = str("task_name");
    if (type) kid.type = type.slice(0, 120);
    if (task) kid.description = task.replace(/_/g, " ").slice(0, 300);
  }

  /** Its start, which names its path and its own thread. */
  started(call: string | undefined, path: string, thread: string | undefined, at: number): void {
    const kid = call !== undefined ? this.kid(call, at) : [...this.kids.values()].find((k) => k.path === path && !k.finished);
    if (!kid) return;
    kid.path = path;
    if (thread) kid.thread = thread;
    kid.finished = false;
    if (kid.description === undefined) kid.description = (path.split("/").pop() ?? path).replace(/_/g, " ").slice(0, 300);
    kid.lastAt = Math.max(kid.lastAt, at);
  }

  /** Its end: the turn its own thread ran is over. */
  completed(path: string, thread: string | undefined, at: number): void {
    for (const kid of this.kids.values()) {
      if ((thread !== undefined && kid.thread === thread) || ((thread === undefined || kid.thread === undefined) && kid.path === path)) {
        kid.finished = true;
        kid.lastAt = Math.max(kid.lastAt, at);
      }
    }
  }

  /**
   * Reads on the rollouts of the sub-agents still working, each at most every `LIVE_MS`, the file
   * looked for under `codexHome` until it is found. Whether any run changed.
   */
  read(codexHome: string | undefined, now: number): boolean {
    let changed = false;
    for (const kid of this.kids.values()) {
      if (kid.finished || kid.thread === undefined || now - kid.readAt < LIVE_MS) continue;
      if (now - Math.max(kid.lastAt, kid.startedAt) > LIVE_FOR_MS) continue;
      kid.readAt = now;
      if (!kid.tail) {
        // Looked for a while only: a Codex that writes none for its sub-agents is not walked for every read.
        kid.lookFrom ??= now;
        const file = codexHome !== undefined && now - kid.lookFrom < FIND_FOR_MS ? findRollout(codexHome, kid.thread) : undefined;
        if (!file) continue;
        kid.file = file;
        kid.tail = new Tail(file);
        kid.state = newCodexState();
      }
      for (const line of kid.tail.read()) {
        let row: unknown;
        try {
          row = JSON.parse(line.text);
        } catch {
          continue;
        }
        for (const item of applyCodexRow(kid.state!, row)) {
          if (item.kind === "tool_call") {
            kid.steps += 1;
            kid.last = codexCallWords(item.name, item.input);
            kid.lastAt = Math.max(kid.lastAt, item.at);
            changed = true;
          } else if (item.kind === "task_complete" || item.kind === "turn_aborted") {
            kid.finished = true;
            kid.lastAt = Math.max(kid.lastAt, item.at);
            changed = true;
          } else if (item.kind === "task_started") kid.lastAt = Math.max(kid.lastAt, item.at);
        }
        const model = kid.state!.model;
        if (model !== undefined && model !== kid.model) {
          kid.model = model;
          changed = true;
        }
        const tokens = kid.state!.stats.context?.used;
        if (tokens !== undefined && tokens > 0 && tokens !== kid.tokens) {
          kid.tokens = tokens;
          changed = true;
        }
      }
    }
    return changed;
  }

  /** Whether one is still at work, so its rollout is read on. */
  get working(): boolean {
    return [...this.kids.values()].some((k) => !k.finished);
  }

  /** The runs as a session's `subagents` lists them: the newest last, as many as the protocol takes. */
  list(): SubagentRun[] {
    const runs = [...this.kids.values()].sort((a, b) => a.startedAt - b.startedAt);
    return runs.slice(-SUBAGENTS_MAX).map((k) => ({
      call: k.call,
      ...(k.thread !== undefined ? { agent: k.thread } : {}),
      ...(k.type !== undefined ? { type: k.type } : {}),
      ...(k.description !== undefined ? { description: k.description } : {}),
      steps: k.steps,
      ...(k.last !== undefined ? { last: k.last } : {}),
      ...(k.model !== undefined ? { model: k.model } : {}),
      ...(k.tokens !== undefined ? { tokens: k.tokens } : {}),
      startedAt: k.startedAt,
      lastAt: Math.max(k.lastAt, k.startedAt),
      ...(k.finished ? { finished: true } : {}),
    }));
  }

  get size(): number {
    return this.kids.size;
  }

  private kid(call: string, at: number): Child {
    let kid = this.kids.get(call);
    if (!kid) {
      kid = { call, steps: 0, startedAt: at, lastAt: at, readAt: -Infinity };
      this.kids.set(call, kid);
    }
    return kid;
  }
}

/**
 * A Codex tool call in a few words: code mode's script (`exec`) by the first tool it calls, a
 * command by its command line, anything else as a Claude step would read.
 */
export function codexCallWords(name: string, input: unknown): string {
  if (name === "exec" && typeof input === "string") {
    const tool = /tools\.([a-z_]\w*)\(/.exec(input)?.[1];
    if (tool === "exec_command") {
      const cmd = /["']?cmd["']?\s*:\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/.exec(input)?.[2];
      return cmd ? callWords("Run", { command: cmd.replace(/\\n/g, "\n").replace(/\\(["'`\\])/g, "$1") }) : "Run a command";
    }
    if (tool === "apply_patch") return "Edit files";
    if (tool === "view_image") return "View an image";
    return tool ? (tool.startsWith("mcp__") ? tool.split("__").slice(2).join(" ") || tool : tool) : "exec";
  }
  const a = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (Array.isArray(a["command"])) return callWords("Run", { command: (a["command"] as unknown[]).map(String).join(" ") });
  if (name === "shell" || name === "exec_command" || name === "shell_command") {
    const cmd = typeof a["cmd"] === "string" ? a["cmd"] : a["command"];
    if (typeof cmd === "string") return callWords("Run", { command: cmd });
  }
  if (name === "apply_patch") return "Edit files";
  return callWords(name, input);
}
