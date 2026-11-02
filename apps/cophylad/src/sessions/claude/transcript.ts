// Claude Code's transcript: JSONL under `<configDir>/projects/<cwd>/<sessionId>.jsonl`. This
// parser turns rows into normalised items and keeps the running stats. Usage is counted
// once per message id, because one API message lands as several rows, one per content
// block: each carries the same input and cache counts, but the output count as it stood
// when that block was written, so a later row adds only the output the earlier ones had not
// counted yet. Usage is kept per model too, with the cache writes kept
// an hour apart, so each model's tokens are priced at its own rates: a session's sub-agents
// often run another model than its own, and Claude Code keeps its cache writes an hour.
// Sub-agents write transcripts of their own beside the session's; their rows count towards
// the session's usage alone (`applyClaudeUsage`), and a fork's copy of the message it was
// forked from carries that message's id, so it is not counted twice. The transcript names no
// context window: `statsFor` leaves `context` out unless asked to infer one
// (`[sessions].claude_window_and_effort`).

import type { SessionStats } from "@cophyla/protocol";
import { lastLineWhere } from "../tail.ts";
import { permissionModeOf } from "./launch.ts";
import type { PermissionMode } from "./launch.ts";

export type ClaudeItem =
  | { kind: "user_turn"; text: string; at: number; promptId?: string }
  | { kind: "peer"; from: string; text: string; at: number }
  | { kind: "assistant_text"; text: string; at: number }
  | { kind: "tool_call"; id: string; name: string; input: unknown; at: number }
  /** `response` is the row's `toolUseResult`, the object a PostToolUse hook carries, when the row holds one result. */
  | { kind: "tool_result"; id: string; name?: string; input?: unknown; content: unknown; response?: unknown; isError?: boolean; at: number }
  | { kind: "title"; title: string }
  /** A plan's clear-context row opened the conversation to carry the plan out; `heading` is the plan's first line. */
  | { kind: "plan"; heading: string }
  | { kind: "permission_mode"; mode: string }
  | { kind: "queue"; operation: string; content?: string; at: number };

/** One model's tokens in a session, as a price takes them: `cacheWrite1h` is the part of `cacheWrite` kept an hour. */
export interface ModelTokens {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

/** What a model's tokens cost; undefined for a model with no price. */
export type ClaudePrice = (model: string, tokens: ModelTokens) => number | undefined;

export interface ClaudeTranscriptState {
  /** Each message id counted, with the output tokens counted for it so far. */
  usageSeen: Map<string, number>;
  toolUses: Map<string, { name: string; input: unknown }>;
  stats: SessionStats;
  /** The usage counted in `stats.tokens`, by the model each message names. */
  byModel: Map<string, ModelTokens>;
  statsChanged: boolean;
  /** The model the last assistant row named: what the counters are priced at. */
  model?: string;
  /** The reasoning effort the last assistant row ran at (`high`). */
  effort?: string;
  /** Given a name (`--name`, `/rename`): Claude's generated title, which it keeps re-appending, no longer replaces it. */
  named?: boolean;
  /**
   * The conversation went on as another session (`continued-in`: sent to the background, where
   * a job forked from it goes on), and no turn has been taken here since.
   */
  continuedIn?: { to: string; at: number };
  /**
   * What Claude's own cost record holds beyond the usage the transcripts carry: its side calls
   * (compaction, background agents' summaries, memory extraction, titles) reach no transcript.
   * The most any record of the conversation showed; added to its stats.
   */
  unrecorded?: UnrecordedSpend;
  /** A cost record was read and no usage counted since: nothing Claude spent is left to come. */
  settled?: boolean;
  /** What started the turn the conversation is in (`UsageDimension` `trigger`): `other` before any. */
  trigger: string;
  /** What started the turn each sub-agent was launched in, by its agent id. */
  agentTriggers: Map<string, string>;
  /** Hears each call's usage as it is counted, while set: the spend ledger's feed. */
  onUsage?: (u: CountedUsage) => void;
}

/**
 * A model call's usage as it is counted: its message's first row (`first`), or the output a
 * later row of it adds.
 */
export interface CountedUsage {
  at: number;
  model: string;
  /** `main`, or the sub-agent its row came from (`sub:<type>`). */
  agent: string;
  /** What started the turn the call was made in. */
  trigger: string;
  /** What the call carried of context: input, cache read and cache write. */
  context: number;
  first: boolean;
  tokens: ModelTokens;
}

/** Who made a sub-agent's calls and what started the turn it was launched in. */
export interface UsageOrigin {
  agent: string;
  trigger: string;
}

/** Spend a conversation's cost record holds that its transcripts do not. */
export interface UnrecordedSpend {
  cost: number;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

export function newClaudeState(): ClaudeTranscriptState {
  return { usageSeen: new Map(), toolUses: new Map(), stats: { turns: 0, cost: 0, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } }, byModel: new Map(), statsChanged: false, trigger: "other", agentTriggers: new Map() };
}

/**
 * Counts an assistant message's usage once per message id, in the totals and under its model;
 * a later row of the same message adds only the output tokens not counted yet. Returns the
 * context the message filled (input, cache read and cache write), or undefined when the
 * message was counted before.
 */
function countUsage(state: ClaudeTranscriptState, message: Row, when: number, origin: UsageOrigin): number | undefined {
  const usage = message["usage"] as Row | undefined;
  if (!usage) return undefined;
  const id = typeof message["id"] === "string" ? message["id"] : undefined;
  const n = (from: Row | undefined, k: string) => (from && typeof from[k] === "number" ? (from[k] as number) : 0);
  const out = n(usage, "output_tokens");
  const model = typeof message["model"] === "string" ? message["model"] : "unknown";
  const context = n(usage, "input_tokens") + n(usage, "cache_read_input_tokens") + n(usage, "cache_creation_input_tokens");
  const counted = id !== undefined ? state.usageSeen.get(id) : undefined;
  if (counted !== undefined) {
    if (out > counted) {
      state.usageSeen.set(id!, out);
      state.stats.tokens.out += out - counted;
      const cur = state.byModel.get(model);
      if (cur) cur.out += out - counted;
      else state.byModel.set(model, { in: 0, out: out - counted, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
      state.statsChanged = true;
      state.settled = false;
      state.onUsage?.({ at: when, model, ...origin, context, first: false, tokens: { in: 0, out: out - counted, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } });
    }
    return undefined;
  }
  if (id !== undefined) state.usageSeen.set(id, out);
  const write = n(usage, "cache_creation_input_tokens");
  const add: ModelTokens = {
    in: n(usage, "input_tokens"),
    out,
    cacheRead: n(usage, "cache_read_input_tokens"),
    cacheWrite: write,
    cacheWrite1h: Math.min(write, n(usage["cache_creation"] as Row | undefined, "ephemeral_1h_input_tokens")),
  };
  const t = state.stats.tokens;
  t.in += add.in;
  t.out += add.out;
  t.cacheRead = (t.cacheRead ?? 0) + add.cacheRead;
  t.cacheWrite = (t.cacheWrite ?? 0) + add.cacheWrite;
  if (add.in + add.out + add.cacheRead + add.cacheWrite > 0) {
    const cur = state.byModel.get(model) ?? { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
    state.byModel.set(model, { in: cur.in + add.in, out: cur.out + add.out, cacheRead: cur.cacheRead + add.cacheRead, cacheWrite: cur.cacheWrite + add.cacheWrite, cacheWrite1h: cur.cacheWrite1h + add.cacheWrite1h });
  }
  state.statsChanged = true;
  state.settled = false;
  state.onUsage?.({ at: when, model, ...origin, context, first: true, tokens: add });
  return add.in + add.cacheRead + add.cacheWrite;
}

/**
 * Feeds one row of a sub-agent's transcript: its usage counts towards the session's, and
 * nothing else of it does. `origin` says which sub-agent made the call and what started the
 * turn it was launched in, for the ledger; `sub` and the conversation's turn when not given.
 */
export function applyClaudeUsage(state: ClaudeTranscriptState, row: unknown, origin?: UsageOrigin): void {
  if (row === null || typeof row !== "object" || (row as Row)["type"] !== "assistant") return;
  const message = (row as Row)["message"] as Row | undefined;
  if (message) countUsage(state, message, at(row as Row), origin ?? { agent: "sub", trigger: state.trigger });
}

/**
 * What started a turn, from the row that opened it (`UsageDimension` `trigger`), or undefined
 * for a row that opens none: a tool's result, a note the harness adds, an echo.
 */
function turnTrigger(row: Row, content: unknown): string | undefined {
  const origin = row["origin"] as Row | undefined;
  const kind = origin?.["kind"];
  const text = textOf(content).trimStart();
  if (kind === "peer" || kind === "coordinator" || text.startsWith("<cophyla-message")) return "peer";
  if (kind === "task-notification" || text.startsWith("<task-notification")) return text.includes("<event>") || text.includes("<summary>Monitor ") ? "monitor" : "task";
  if (text.startsWith("This session is being continued from a previous conversation")) return "compact";
  if (kind === "auto-continuation") return "typed";
  if (text.startsWith("<command-name>")) return "command";
  if (isHumanTurn(row, content) && text.length > 0) return "typed";
  return undefined;
}

/** A row of Claude's own cost record (`cost-state`), written as a conversation exits, clears or resumes another. */
export function isCostRecord(row: unknown): boolean {
  return row !== null && typeof row === "object" && (row as Row)["type"] === "cost-state";
}

/**
 * Reads Claude's own cost record against the usage counted so far, priced the same way: what
 * it holds beyond that is the conversation's side calls, kept in `unrecorded`. The record is
 * cumulative over the conversation's runs when a resume restores it; a record costing less (a
 * resume that did not) adds nothing, tokens neither, and the most any record showed stays. The usage counted
 * must include the sub-agents' up to the record. Returns whether the stats moved.
 */
export function applyClaudeCostRecord(state: ClaudeTranscriptState, row: unknown, price: ClaudePrice): boolean {
  if (!isCostRecord(row)) return false;
  const r = row as Row;
  const total = r["totalCostUSD"];
  if (typeof total !== "number" || !Number.isFinite(total)) return false;
  state.settled = true;
  const n = (from: Row, k: string) => (typeof from[k] === "number" && Number.isFinite(from[k]) ? (from[k] as number) : 0);
  const claude = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  const models = r["modelUsage"];
  if (models && typeof models === "object") {
    for (const u of Object.values(models as Record<string, unknown>)) {
      if (!u || typeof u !== "object") continue;
      claude.in += n(u as Row, "inputTokens");
      claude.out += n(u as Row, "outputTokens");
      claude.cacheRead += n(u as Row, "cacheReadInputTokens");
      claude.cacheWrite += n(u as Row, "cacheCreationInputTokens");
    }
  }
  let counted = 0;
  for (const [model, tokens] of state.byModel) counted += price(model, tokens) ?? 0;
  // Less than counted: Claude's totals cover only part of the conversation (a run whose resume
  // did not restore them), so none of its counts says what the transcripts lack.
  if (total < counted) return false;
  const t = state.stats.tokens;
  const was = state.unrecorded ?? { cost: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  const next: UnrecordedSpend = {
    cost: Math.max(was.cost, Math.round((total - counted) * 1e6) / 1e6),
    in: Math.max(was.in, claude.in - t.in),
    out: Math.max(was.out, claude.out - t.out),
    cacheRead: Math.max(was.cacheRead, claude.cacheRead - (t.cacheRead ?? 0)),
    cacheWrite: Math.max(was.cacheWrite, claude.cacheWrite - (t.cacheWrite ?? 0)),
  };
  if (next.cost === was.cost && next.in === was.in && next.out === was.out && next.cacheRead === was.cacheRead && next.cacheWrite === was.cacheWrite) return false;
  state.unrecorded = next;
  state.statsChanged = true;
  return true;
}

type Row = Record<string, unknown>;

function at(row: Row): number {
  const t = row["timestamp"];
  if (typeof t === "string") {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}

/** When a row was written, when it says. */
export function rowAt(row: unknown): number | undefined {
  const t = row !== null && typeof row === "object" ? (row as Row)["timestamp"] : undefined;
  const ms = typeof t === "string" ? Date.parse(t) : NaN;
  return Number.isNaN(ms) ? undefined : ms;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === "object" && (b as Row)["type"] === "text" && typeof (b as Row)["text"] === "string")
      .map((b) => (b as Row)["text"] as string)
      .join("\n");
  }
  return "";
}

/** A row is `isMeta`, a slash command, or a local-command echo: not something the user typed to the model. */
function isHumanTurn(row: Row, content: unknown): boolean {
  if (row["isMeta"] === true) return false;
  const origin = row["origin"] as Row | undefined;
  if (origin && origin["kind"] !== "human") return false;
  const source = row["promptSource"];
  if (source !== undefined && source !== "typed") return false;
  const text = textOf(content).trimStart();
  if (text.startsWith("<command-") || text.startsWith("<local-command")) return false;
  return true;
}

/** Feeds one parsed row. Returns the items it yields; stats land in `state.stats`. */
export function applyClaudeRow(state: ClaudeTranscriptState, row: unknown): ClaudeItem[] {
  if (row === null || typeof row !== "object") return [];
  const r = row as Row;
  const items: ClaudeItem[] = [];
  if (r["type"] === "user" || r["type"] === "assistant") delete state.continuedIn;
  switch (r["type"]) {
    case "user": {
      const message = r["message"] as Row | undefined;
      const content = message?.["content"];
      const when = at(r);
      if (Array.isArray(content)) {
        const results = content.filter((b) => (b as Row)?.["type"] === "tool_result") as Row[];
        for (const b of results) {
          const id = String(b["tool_use_id"] ?? "");
          const use = state.toolUses.get(id);
          const item: ClaudeItem = { kind: "tool_result", id, content: b["content"], at: when };
          if (use) {
            item.name = use.name;
            item.input = use.input;
          }
          if (results.length === 1 && r["toolUseResult"] !== undefined) item.response = r["toolUseResult"];
          if (b["is_error"] === true) item.isError = true;
          items.push(item);
        }
        // A sub-agent launched: its calls belong to the turn that launched it.
        const launched = (r["toolUseResult"] as Row | undefined)?.["agentId"];
        if (typeof launched === "string") state.agentTriggers.set(launched, state.trigger);
        if (results.length > 0) break;
      }
      const trigger = turnTrigger(r, content);
      if (trigger !== undefined) state.trigger = trigger;
      const origin = r["origin"] as Row | undefined;
      if (origin && origin["kind"] === "peer") {
        items.push({ kind: "peer", from: String(origin["from"] ?? "unknown"), text: textOf(content), at: when });
        break;
      }
      if (origin && origin["kind"] === "auto-continuation" && typeof r["planContent"] === "string") {
        const heading = r["planContent"].split(/\r?\n/).map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l !== "");
        if (heading) items.push({ kind: "plan", heading });
        break;
      }
      if (isHumanTurn(r, content)) {
        const text = textOf(content);
        if (text.trim().length > 0) {
          state.stats.turns++;
          state.statsChanged = true;
          const item: ClaudeItem = { kind: "user_turn", text, at: when };
          if (typeof r["promptId"] === "string") item.promptId = r["promptId"];
          items.push(item);
        }
      }
      break;
    }
    case "assistant": {
      const message = r["message"] as Row | undefined;
      if (!message) break;
      const when = at(r);
      const content = message["content"];
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Row;
          if (b["type"] === "text" && typeof b["text"] === "string" && b["text"].trim()) items.push({ kind: "assistant_text", text: b["text"], at: when });
          else if (b["type"] === "tool_use") {
            const id = String(b["id"] ?? "");
            const name = String(b["name"] ?? "tool");
            state.toolUses.set(id, { name, input: b["input"] });
            items.push({ kind: "tool_call", id, name, input: b["input"], at: when });
          }
        }
      }
      if (typeof message["model"] === "string" && message["model"] !== state.model) {
        state.model = message["model"];
        state.statsChanged = true;
      }
      if (typeof r["effort"] === "string" && r["effort"] !== "" && r["effort"] !== state.effort) {
        state.effort = r["effort"];
        state.statsChanged = true;
      }
      const used = countUsage(state, message, when, { agent: "main", trigger: state.trigger });
      if (used !== undefined && used > 0) state.stats.context = { used, limit: state.stats.context?.limit ?? Number.MAX_SAFE_INTEGER };
      break;
    }
    case "ai-title":
      if (typeof r["aiTitle"] === "string" && !state.named) items.push({ kind: "title", title: r["aiTitle"] });
      break;
    case "custom-title":
      if (typeof r["customTitle"] === "string") {
        state.named = true;
        items.push({ kind: "title", title: r["customTitle"] });
      }
      break;
    case "permission-mode":
      if (typeof r["permissionMode"] === "string") items.push({ kind: "permission_mode", mode: r["permissionMode"] });
      break;
    case "continued-in":
      if (typeof r["continuedInSessionId"] === "string" && r["continuedInSessionId"] !== "") state.continuedIn = { to: r["continuedInSessionId"], at: at(r) };
      break;
    case "queue-operation": {
      const item: ClaudeItem = { kind: "queue", operation: String(r["operation"] ?? ""), at: at(r) };
      if (typeof r["content"] === "string") item.content = r["content"];
      items.push(item);
      break;
    }
    default:
      break;
  }
  return items;
}

/** Claude's context windows: the usual one, and the one a `[1m]` model has. */
export const CLAUDE_WINDOW = 200_000;
export const CLAUDE_WINDOW_1M = 1_000_000;

/** What `statsFor` adds, with `[sessions].claude_window_and_effort`. */
export interface ClaudeStatsOptions {
  /** The effort, and a context window where none is known: 1M for a `[1m]` model or past 200K used, else 200K. */
  infer?: boolean;
  /** The session's settings name a `[1m]` model, which its transcript does not show. */
  oneM?: boolean;
}

/**
 * The stats as the session entity carries them: no `context` until a limit is known (or
 * inferred, `opts`), and no zero cache counts. With a price, the cost is each model's tokens
 * at that model's rates; a model with no price adds nothing to it.
 */
export function statsFor(state: ClaudeTranscriptState, price?: ClaudePrice, opts: ClaudeStatsOptions = {}): SessionStats {
  const s = state.stats;
  let cost = 0;
  if (price) for (const [model, tokens] of state.byModel) cost += price(model, tokens) ?? 0;
  // Claude's side calls, known from its cost record: in the counts, and in the cost when priced.
  const u = state.unrecorded;
  if (price && u) cost += u.cost;
  const out: SessionStats = { turns: s.turns, cost: Math.round(cost * 1e6) / 1e6, tokens: { in: s.tokens.in + (u?.in ?? 0), out: s.tokens.out + (u?.out ?? 0) } };
  const cacheRead = (s.tokens.cacheRead ?? 0) + (u?.cacheRead ?? 0);
  const cacheWrite = (s.tokens.cacheWrite ?? 0) + (u?.cacheWrite ?? 0);
  if (cacheRead) out.tokens.cacheRead = cacheRead;
  if (cacheWrite) out.tokens.cacheWrite = cacheWrite;
  if (s.context && s.context.limit !== Number.MAX_SAFE_INTEGER) out.context = { ...s.context };
  else if (s.context && opts.infer) {
    const big = opts.oneM === true || /\[1m\]/i.test(state.model ?? "") || s.context.used > CLAUDE_WINDOW;
    out.context = { used: s.context.used, limit: big ? CLAUDE_WINDOW_1M : CLAUDE_WINDOW };
  }
  if (state.model !== undefined) out.model = state.model;
  if (opts.infer && state.effort !== undefined) out.effort = state.effort;
  return out;
}

/** The window usage on its own, for records that know no limit. */
export function contextUsed(state: ClaudeTranscriptState): number | undefined {
  return state.stats.context?.used;
}

/**
 * The permission mode a conversation was last in, as its transcript last saved it: Claude
 * writes the mode on each prompt it is given and in a `permission-mode` row after each turn.
 * `undefined` when the transcript holds none, or cannot be read.
 */
export function lastPermissionMode(path: string): PermissionMode | undefined {
  const line = lastLineWhere(path, (text) => modeOfLine(text) !== undefined);
  return line !== undefined ? modeOfLine(line) : undefined;
}

function modeOfLine(text: string): PermissionMode | undefined {
  if (!text.includes('"permissionMode"')) return undefined;
  try {
    const r = JSON.parse(text) as Row;
    return r["type"] === "permission-mode" || r["type"] === "user" ? permissionModeOf(r["permissionMode"]) : undefined;
  } catch {
    return undefined;
  }
}
