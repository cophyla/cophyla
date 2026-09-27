// Quote by reference. The brain cites a request and lines within its result; brain-link
// expands the quote from the stored result. Both sides project a result into numbered
// entries with this one function, so the number the model saw is the number that is expanded:
// a file line for `fs.read` and `fs.grep`, a session event's `seq` for `session.history`, a
// message's index for `thread.history`, a body line for `memory.read` and `prompt.read`, a
// hit's position for `recall`.

import { ASK_TEXT_OPTION } from "./entities.ts";
import type { Hit, Message, SessionEvent, Source } from "./entities.ts";
import type { NodeId } from "./ids.ts";

export interface QuotableLine {
  /** The number the model cites. */
  n: number;
  text: string;
  /** The message a thread entry came from, so a selection can name it. */
  message?: string;
  /** The line's own source, when each line comes from somewhere else (a recall hit). */
  source?: Source;
}

export interface Quotable {
  lines: QuotableLine[];
  /** Where the result came from; absent for a prompt, which has no source of its own. */
  source?: Source;
}

/** Actions whose results can be quoted. */
export const QUOTABLE_ACTIONS: ReadonlySet<string> = new Set(["tool.run", "session.history", "thread.history", "memory.read", "prompt.read", "recall"]);

const NUMBERED = /^(\d+)\t(.*)$/;

function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "";
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

/** `n\tline` rows, as `fs.read` and `fs.grep` return them, into entries. */
export function numberedLines(text: string): QuotableLine[] {
  const out: QuotableLine[] = [];
  for (const row of text.split("\n")) {
    const m = NUMBERED.exec(row);
    if (m) out.push({ n: Number(m[1]), text: m[2]! });
  }
  return out;
}

/** Body lines numbered from 1, for memory and prompt files. */
export function bodyLines(body: string): QuotableLine[] {
  return body.split(/\r?\n/).map((text, i) => ({ n: i + 1, text }));
}

/**
 * An ask event: the phase and the tool, then what was asked when it opened (the question, the
 * detail under it, the option labels) and what was chosen when it was answered.
 */
function askText(p: Record<string, unknown>): string {
  let text = `? ask ${str(p["phase"])}${p["tool"] ? `: ${str(p["tool"])}` : ""}${p["reason"] ? ` (${str(p["reason"])})` : ""}`;
  if (typeof p["title"] === "string" && p["title"]) text += ` — ${p["title"]}`;
  const answer = record(p["answer"]);
  if (answer) {
    const ids = Array.isArray(answer["options"]) ? answer["options"] : [answer["option"]];
    const chosen = ids.filter((o): o is string => typeof o === "string" && o !== ASK_TEXT_OPTION).join(", ");
    const said = typeof answer["text"] === "string" && answer["text"] ? `"${answer["text"]}"` : "";
    if (chosen || said) text += `: ${[chosen, said].filter(Boolean).join(" — ")}`;
  }
  if (typeof p["detail"] === "string" && p["detail"]) text += `\n${p["detail"]}`;
  const options = Array.isArray(p["options"]) ? p["options"].filter((o): o is string => typeof o === "string") : [];
  if (options.length > 0) text += `\noptions: ${options.join(" | ")}`;
  return text;
}

/** One line of text per session event, so a session's history reads as a transcript. */
export function sessionEventText(e: SessionEvent): string {
  const p = record(e.payload) ?? {};
  switch (e.kind) {
    case "status":
      return `[${str(p["status"])}]`;
    case "user_turn":
      return str(p["text"]);
    case "assistant_text":
      return str(p["text"]);
    case "tool_call":
      return `→ ${str(p["tool"])} ${str(p["args"] ?? p["input"])}`.trimEnd();
    case "tool_result":
      return `← ${str(p["tool"])}${p["isError"] ? " (error)" : ""}: ${str(p["result"])}`;
    case "ask":
      return askText(p);
    case "notification":
      return `· ${str(p["type"])}${p["message"] ? `: ${str(p["message"])}` : p["text"] ? `: ${str(p["text"])}` : ""}`;
    case "ended":
      return `· ended${p["reason"] ? ` (${str(p["reason"])})` : ""}`;
  }
}

/** The text of a message's blocks, quotes and references included. */
export function messageText(m: Message): string {
  const parts: string[] = [];
  for (const b of m.content) {
    switch (b.type) {
      case "text":
        parts.push(b.text);
        break;
      case "quote":
        parts.push(`> ${b.text.replace(/\n/g, "\n> ")}`);
        break;
      case "ref":
        parts.push(`[ref ${b.session ?? b.thread ?? b.task ?? b.ask ?? b.audit ?? b.file?.path ?? ""}]`);
        break;
      case "audio":
        parts.push("[audio]");
        break;
    }
  }
  return parts.join("\n");
}

/**
 * Projects a request's result into numbered entries and a source. `result` is the request's
 * result as the capability protocol defines it (and the audit table stores it). `undefined`
 * when the action is not quotable or the result has no lines.
 */
export function quotable(action: string, params: unknown, result: unknown, node: NodeId): Quotable | undefined {
  const p = record(params) ?? {};
  const r = record(result) ?? {};
  switch (action) {
    case "tool.run": {
      const name = p["name"];
      if (name !== "fs.read" && name !== "fs.grep") return undefined;
      const inner = record(r["result"]);
      if (!inner || typeof inner["text"] !== "string") return undefined;
      const lines = numberedLines(inner["text"]);
      const path = typeof inner["path"] === "string" ? inner["path"] : undefined;
      return path ? { lines, source: { kind: "file", node, path } } : { lines };
    }
    case "session.history": {
      const events = Array.isArray(r["events"]) ? (r["events"] as SessionEvent[]) : undefined;
      if (!events) return undefined;
      const lines = events.map((e) => ({ n: e.seq, text: sessionEventText(e) }));
      const session = typeof p["id"] === "string" ? p["id"] : events[0]?.session;
      return session ? { lines, source: { kind: "session", session } } : { lines };
    }
    case "thread.history": {
      const messages = Array.isArray(r["messages"]) ? (r["messages"] as Message[]) : undefined;
      if (!messages) return undefined;
      const lines = messages.map((m, i) => ({ n: i, text: messageText(m), message: m.id }));
      const thread = typeof p["id"] === "string" ? p["id"] : messages[0]?.thread;
      return thread ? { lines, source: { kind: "thread", thread } } : { lines };
    }
    case "memory.read": {
      const memory = record(r["memory"]);
      if (!memory || typeof memory["body"] !== "string") return undefined;
      const name = typeof memory["name"] === "string" ? memory["name"] : typeof p["name"] === "string" ? p["name"] : "";
      return { lines: bodyLines(memory["body"]), source: { kind: "memory", name } };
    }
    case "prompt.read": {
      const prompt = record(r["prompt"]);
      if (!prompt || typeof prompt["body"] !== "string") return undefined;
      return { lines: bodyLines(prompt["body"]) };
    }
    case "recall": {
      // One line per hit, numbered from 1 in result order; each line carries the hit's own
      // source, so a single-hit quote lands on the exact seq, message or memory lines.
      const hits = Array.isArray(r["hits"]) ? (r["hits"] as Hit[]) : undefined;
      if (!hits) return undefined;
      return { lines: hits.map((h, i) => ({ n: i + 1, text: h.snippet, source: h.source })) };
    }
    default:
      return undefined;
  }
}

export interface Selection {
  text: string;
  source?: Source;
}

/**
 * The entries with `a ≤ n ≤ b`, joined, and the source narrowed to the range actually
 * selected. `undefined` when nothing falls in the range. Without a result-wide source, the
 * source is the picked line's own when exactly one line carries one; several lines are text
 * only, so a view marks the quote unsourced rather than fusing two hits' ranges.
 */
export function selectLines(q: Quotable, range: [number, number] | undefined): Selection | undefined {
  const [a, b] = range ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const picked = q.lines.filter((l) => l.n >= lo && l.n <= hi);
  if (picked.length === 0) return undefined;
  const text = picked.map((l) => l.text).join("\n");
  if (!q.source) {
    const own = picked.length === 1 ? picked[0]!.source : undefined;
    return own ? { text, source: own } : { text };
  }
  const first = picked[0]!.n;
  const last = picked[picked.length - 1]!.n;
  let source: Source;
  switch (q.source.kind) {
    case "file":
      source = { ...q.source, lines: [first, last] };
      break;
    case "session":
      source = { ...q.source, seq: [first, last] };
      break;
    case "memory":
      source = { ...q.source, lines: [first, last] };
      break;
    case "thread": {
      const message = picked[0]!.message;
      source = message ? { ...q.source, message } : { ...q.source };
      break;
    }
  }
  return { text, source };
}
