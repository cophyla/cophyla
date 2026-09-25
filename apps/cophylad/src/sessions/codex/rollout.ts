// Codex's rollout: JSONL under `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl`,
// each row an envelope `{timestamp, ordinal, type, payload}`. This parser turns rows into
// normalised items and keeps the running stats from `token_count`, whose totals are
// cumulative and therefore replace rather than add.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStats } from "@cophyla/protocol";

export type CodexItem =
  | { kind: "meta"; sessionId: string; cwd: string; originator?: string; cliVersion?: string; at: number }
  | { kind: "turn_context"; model?: string; approvalPolicy?: string; sandbox?: string; cwd?: string }
  | { kind: "task_started"; turnId: string; at: number }
  | { kind: "task_complete"; turnId: string; lastMessage?: string; at: number }
  | { kind: "user_message"; text: string; clientId?: string; at: number }
  | { kind: "assistant_text"; text: string; at: number }
  | { kind: "tool_call"; callId: string; name: string; input: unknown; at: number }
  | { kind: "tool_result"; callId: string; name?: string; output: unknown; at: number };

export interface CodexRolloutState {
  stats: SessionStats;
  statsChanged: boolean;
  toolCalls: Map<string, string>;
  /** The turn in flight, when the last task event was a start. */
  busyTurn?: string;
  model?: string;
}

export function newCodexState(): CodexRolloutState {
  return { stats: { turns: 0, cost: 0, tokens: { in: 0, out: 0 } }, statsChanged: false, toolCalls: new Map() };
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

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && typeof (b as Row)["text"] === "string")
    .map((b) => (b as Row)["text"] as string)
    .join("\n");
}

function parseInput(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

export function applyCodexRow(state: CodexRolloutState, row: unknown): CodexItem[] {
  if (row === null || typeof row !== "object") return [];
  const r = row as Row;
  const p = r["payload"];
  if (p === null || typeof p !== "object") return [];
  const payload = p as Row;
  const when = at(r);
  const items: CodexItem[] = [];
  switch (r["type"]) {
    case "session_meta": {
      const sessionId = payload["session_id"] ?? payload["id"];
      if (typeof sessionId === "string" && typeof payload["cwd"] === "string") {
        const item: CodexItem = { kind: "meta", sessionId, cwd: payload["cwd"], at: when };
        if (typeof payload["originator"] === "string") item.originator = payload["originator"];
        if (typeof payload["cli_version"] === "string") item.cliVersion = payload["cli_version"];
        items.push(item);
      }
      break;
    }
    case "turn_context": {
      const item: CodexItem = { kind: "turn_context" };
      if (typeof payload["model"] === "string") {
        item.model = payload["model"];
        if (state.model !== payload["model"]) state.statsChanged = true;
        state.model = payload["model"];
      }
      if (typeof payload["approval_policy"] === "string") item.approvalPolicy = payload["approval_policy"];
      const sandbox = payload["sandbox_policy"];
      if (sandbox && typeof sandbox === "object" && typeof (sandbox as Row)["type"] === "string") item.sandbox = (sandbox as Row)["type"] as string;
      if (typeof payload["cwd"] === "string") item.cwd = payload["cwd"];
      items.push(item);
      break;
    }
    case "event_msg": {
      switch (payload["type"]) {
        case "task_started": {
          const turnId = String(payload["turn_id"] ?? "");
          state.busyTurn = turnId;
          const window = payload["model_context_window"];
          if (typeof window === "number" && window > 0) {
            state.stats.context = { used: state.stats.context?.used ?? 0, limit: window };
            state.statsChanged = true;
          }
          items.push({ kind: "task_started", turnId, at: when });
          break;
        }
        case "task_complete": {
          const turnId = String(payload["turn_id"] ?? "");
          delete state.busyTurn;
          const item: CodexItem = { kind: "task_complete", turnId, at: when };
          if (typeof payload["last_agent_message"] === "string") item.lastMessage = payload["last_agent_message"];
          items.push(item);
          break;
        }
        case "token_count": {
          const info = payload["info"];
          if (!info || typeof info !== "object") break;
          const i = info as Row;
          const total = i["total_token_usage"] as Row | undefined;
          const last = i["last_token_usage"] as Row | undefined;
          const n = (o: Row | undefined, k: string) => (o && typeof o[k] === "number" ? (o[k] as number) : 0);
          if (total) {
            state.stats.tokens = { in: n(total, "input_tokens"), out: n(total, "output_tokens") };
            if (n(total, "cached_input_tokens")) state.stats.tokens.cacheRead = n(total, "cached_input_tokens");
            if (n(total, "cache_write_input_tokens")) state.stats.tokens.cacheWrite = n(total, "cache_write_input_tokens");
          }
          const window = typeof i["model_context_window"] === "number" ? (i["model_context_window"] as number) : state.stats.context?.limit;
          const used = n(last ?? total, "total_tokens");
          if (window && window > 0) state.stats.context = { used, limit: window };
          state.statsChanged = true;
          break;
        }
        case "item_completed": {
          const item = payload["item"] as Row | undefined;
          if (!item) break;
          if (item["type"] === "UserMessage") {
            const text = textOf(item["content"]);
            const out: CodexItem = { kind: "user_message", text, at: when };
            if (typeof item["client_id"] === "string") out.clientId = item["client_id"];
            else {
              state.stats.turns++;
              state.statsChanged = true;
            }
            items.push(out);
          }
          break;
        }
        default:
          break;
      }
      break;
    }
    case "response_item": {
      switch (payload["type"]) {
        case "message":
          if (payload["role"] === "assistant") {
            const text = textOf(payload["content"]);
            if (text.trim()) items.push({ kind: "assistant_text", text, at: when });
          }
          break;
        case "function_call":
        case "custom_tool_call": {
          const callId = String(payload["call_id"] ?? payload["id"] ?? "");
          const name = String(payload["name"] ?? "tool");
          state.toolCalls.set(callId, name);
          items.push({ kind: "tool_call", callId, name, input: parseInput(payload["type"] === "function_call" ? payload["arguments"] : payload["input"]), at: when });
          break;
        }
        case "function_call_output":
        case "custom_tool_call_output": {
          const callId = String(payload["call_id"] ?? "");
          const item: CodexItem = { kind: "tool_result", callId, output: parseInput(payload["output"]), at: when };
          const name = state.toolCalls.get(callId);
          if (name) item.name = name;
          items.push(item);
          break;
        }
        default:
          break;
      }
      break;
    }
    default:
      break;
  }
  return items;
}

export function statsFor(state: CodexRolloutState): SessionStats {
  const s = state.stats;
  const out: SessionStats = { turns: s.turns, cost: 0, tokens: { ...s.tokens } };
  if (s.context && s.context.limit > 0) out.context = { ...s.context };
  if (state.model !== undefined) out.model = state.model;
  return out;
}

/** The rollout file of a thread, by walking the dated directories newest first. */
export function findRollout(codexHome: string, threadId: string): string | undefined {
  const root = join(codexHome, "sessions");
  const suffix = `-${threadId}.jsonl`;
  const dirs = (p: string) => {
    try {
      return readdirSync(p)
        .filter((n) => /^\d+$/.test(n))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };
  for (const y of dirs(root)) {
    for (const m of dirs(join(root, y))) {
      for (const d of dirs(join(root, y, m))) {
        const dir = join(root, y, m, d);
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          continue;
        }
        const hit = names.find((n) => n.endsWith(suffix));
        if (hit) return join(dir, hit);
      }
    }
  }
  return undefined;
}

/** Thread names from `session_index.jsonl`, latest row per id. */
export function readSessionIndex(codexHome: string): Map<string, string> {
  const out = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(join(codexHome, "session_index.jsonl"), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Row;
      if (typeof row["id"] === "string" && typeof row["thread_name"] === "string") out.set(row["id"], row["thread_name"]);
    } catch {
      // a partial last line
    }
  }
  return out;
}
