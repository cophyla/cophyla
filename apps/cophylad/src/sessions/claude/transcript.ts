// Claude Code's transcript: JSONL under `<configDir>/projects/<cwd>/<sessionId>.jsonl`. This
// parser turns rows into normalised items and keeps the running stats. Usage is counted
// once per message id, because one API message lands as several rows, one per content
// block, each carrying the same usage.

import type { SessionStats } from "@cophyla/protocol";

export type ClaudeItem =
  | { kind: "user_turn"; text: string; at: number; promptId?: string }
  | { kind: "peer"; from: string; text: string; at: number }
  | { kind: "assistant_text"; text: string; at: number }
  | { kind: "tool_call"; id: string; name: string; input: unknown; at: number }
  | { kind: "tool_result"; id: string; name?: string; input?: unknown; content: unknown; isError?: boolean; at: number }
  | { kind: "title"; title: string }
  | { kind: "permission_mode"; mode: string }
  | { kind: "queue"; operation: string; content?: string; at: number };

export interface ClaudeTranscriptState {
  usageSeen: Set<string>;
  toolUses: Map<string, { name: string; input: unknown }>;
  stats: SessionStats;
  statsChanged: boolean;
  /** The model the last assistant row named: what the counters are priced at. */
  model?: string;
  /** Given a name (`--name`, `/rename`): Claude's generated title, which it keeps re-appending, no longer replaces it. */
  named?: boolean;
  /**
   * The conversation went on as another session (`continued-in`: sent to the background, where
   * a job forked from it goes on), and no turn has been taken here since.
   */
  continuedIn?: { to: string; at: number };
}

export function newClaudeState(): ClaudeTranscriptState {
  return { usageSeen: new Set(), toolUses: new Map(), stats: { turns: 0, cost: 0, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } }, statsChanged: false };
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
        let hadResult = false;
        for (const block of content) {
          const b = block as Row;
          if (b["type"] !== "tool_result") continue;
          hadResult = true;
          const id = String(b["tool_use_id"] ?? "");
          const use = state.toolUses.get(id);
          const item: ClaudeItem = { kind: "tool_result", id, content: b["content"], at: when };
          if (use) {
            item.name = use.name;
            item.input = use.input;
          }
          if (b["is_error"] === true) item.isError = true;
          items.push(item);
        }
        if (hadResult) break;
      }
      const origin = r["origin"] as Row | undefined;
      if (origin && origin["kind"] === "peer") {
        items.push({ kind: "peer", from: String(origin["from"] ?? "unknown"), text: textOf(content), at: when });
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
      const usage = message["usage"] as Row | undefined;
      const id = typeof message["id"] === "string" ? message["id"] : undefined;
      if (typeof message["model"] === "string" && message["model"] !== state.model) {
        state.model = message["model"];
        state.statsChanged = true;
      }
      if (usage && (id === undefined || !state.usageSeen.has(id))) {
        if (id !== undefined) state.usageSeen.add(id);
        const n = (k: string) => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
        const t = state.stats.tokens;
        t.in += n("input_tokens");
        t.out += n("output_tokens");
        t.cacheRead = (t.cacheRead ?? 0) + n("cache_read_input_tokens");
        t.cacheWrite = (t.cacheWrite ?? 0) + n("cache_creation_input_tokens");
        const used = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
        if (used > 0) state.stats.context = { used, limit: state.stats.context?.limit ?? Number.MAX_SAFE_INTEGER };
        state.statsChanged = true;
      }
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

/** The stats as the session entity carries them: no `context` until a limit is known, and no zero cache counts. */
export function statsFor(state: ClaudeTranscriptState): SessionStats {
  const s = state.stats;
  const out: SessionStats = { turns: s.turns, cost: 0, tokens: { in: s.tokens.in, out: s.tokens.out } };
  if (s.tokens.cacheRead) out.tokens.cacheRead = s.tokens.cacheRead;
  if (s.tokens.cacheWrite) out.tokens.cacheWrite = s.tokens.cacheWrite;
  if (s.context && s.context.limit !== Number.MAX_SAFE_INTEGER) out.context = { ...s.context };
  if (state.model !== undefined) out.model = state.model;
  return out;
}

/** The window usage on its own, for records that know no limit. */
export function contextUsed(state: ClaudeTranscriptState): number | undefined {
  return state.stats.context?.used;
}
