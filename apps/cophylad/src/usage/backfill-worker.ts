// The spend backfill's reader, in a worker so the daemon's own thread is never held by it:
// finds the Claude transcripts written within the retention under the folders it is given,
// oldest first, and reads each conversation (its own transcript, then its sub-agents') with
// the sessions' own parser, counting into the ledger only what is past the marks it was given.
// A line that cannot count is skipped unread: a tool's result unless it launched a sub-agent,
// and every row that is neither a turn, a reply, a title nor a cost record. One map of message
// ids serves the whole run, so a job's copy of the history it was forked with counts once.
// Each conversation's cells go back priced, with the marks they reach.

import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { isMainThread } from "node:worker_threads";
import { Pricer } from "../metrics/prices.ts";
import type { Price } from "../metrics/prices.ts";
import { subagentInfo, subagentTranscripts } from "../sessions/claude/subagents.ts";
import { applyClaudeCostRecord, applyClaudeRow, applyClaudeUsage, newClaudeState } from "../sessions/claude/transcript.ts";
import type { ClaudeTranscriptState } from "../sessions/claude/transcript.ts";
import type { SpendRow } from "../store/index.ts";
import { conversationKey, spendRows } from "./ledger.ts";
import type { SideSpend, SpendCall, SpendPrice } from "./ledger.ts";

export interface BackfillRequest {
  /** Claude directories whose `projects` folders hold the transcripts. */
  dirs: string[];
  /** Transcripts last written before this are left. */
  since: number;
  /** Conversations read live: left to the adapter. */
  claimed: string[];
  /** The ledger's marks, by key. */
  marks: Record<string, number>;
  prices: [string, Price][];
}

export interface BackfillResult {
  conversation: string;
  rows: SpendRow[];
  marks: [string, number][];
  cwd?: string;
  title?: string;
  firstAt?: number;
  lastAt?: number;
}

export type BackfillMessage = { kind: "result"; result: BackfillResult } | { kind: "end"; read: number; skipped: number; failed: number } | { kind: "error"; message: string };

/** How much of a line is read to tell what it is. */
const HEAD = 1024;
/** A tool's result longer than this launched no sub-agent: a launch's answer is short. */
const LAUNCH_MAX = 64 * 1024;
const CHUNK = 4 * 1024 * 1024;

/**
 * Every complete line of a file with the byte offset it starts at, in chunks: what it hands
 * over is the buffer and the line's bounds in it. Returns where the last complete line ends.
 */
export function eachLine(path: string, fn: (buf: Buffer, start: number, end: number, offset: number) => void): number {
  const fd = openSync(path, "r");
  try {
    let carry: Buffer = Buffer.alloc(0);
    let carryAt = 0;
    let pos = 0;
    const chunk = Buffer.alloc(CHUNK);
    for (;;) {
      const n = readSync(fd, chunk, 0, CHUNK, pos);
      if (n <= 0) break;
      const buf = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      const base = carry.length > 0 ? carryAt : pos;
      pos += n;
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(10, start);
        if (nl < 0) break;
        if (nl > start) fn(buf, start, nl, base + start);
        start = nl + 1;
      }
      carry = Buffer.from(buf.subarray(start));
      carryAt = base + start;
    }
    return carryAt;
  } finally {
    closeSync(fd);
  }
}

/** What a line is, from its head: whether the parser needs it whole. */
function wanted(buf: Buffer, start: number, end: number): boolean {
  const head = buf.toString("utf8", start, Math.min(end, start + HEAD));
  if (head.startsWith('{"type":"cost-state"') || head.startsWith('{"type":"ai-title"') || head.startsWith('{"type":"custom-title"')) return true;
  // A reply's own type comes after its message; the message's role is near the start.
  if (head.includes('"role":"assistant"')) return true;
  if (!head.includes('"type":"user"')) return false;
  if (!head.includes('"tool_result"')) return true;
  // A tool's result: only a sub-agent's launch matters, and its answer is short.
  return end - start <= LAUNCH_MAX && buf.toString("utf8", start, end).includes('"agentId"');
}

/** Reads one conversation, its sub-agents after its own lines; what is past the marks goes to the ledger. */
export function readConversation(path: string, marks: Record<string, number>, price: SpendPrice, seen: Map<string, number>): BackfillResult {
  const conversation = conversationKey("claude", basename(path, ".jsonl"));
  const state: ClaudeTranscriptState = newClaudeState();
  // The run's message ids: a copy of history another conversation counted counts nothing.
  state.usageSeen = seen;
  const calls: SpendCall[] = [];
  const side: SideSpend[] = [];
  const out: [string, number][] = [];
  let cwd: string | undefined;
  let title: string | undefined;
  let named = false;
  let firstAt: number | undefined;
  let lastAt: number | undefined;
  let record: { row: unknown; at?: number; counts: boolean } | undefined;
  let usageAfter = false;
  let counts = false;
  state.onUsage = (u) => {
    usageAfter = true;
    if (counts) calls.push(u);
  };
  const mark = marks[conversation] ?? 0;
  const end = eachLine(path, (buf, start, stop, offset) => {
    if (!wanted(buf, start, stop)) return;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(buf.toString("utf8", start, stop)) as Record<string, unknown>;
    } catch {
      return;
    }
    counts = offset >= mark;
    const at = typeof row["timestamp"] === "string" ? Date.parse(row["timestamp"]) : NaN;
    if (!Number.isNaN(at)) {
      firstAt ??= at;
      lastAt = at;
    }
    if (cwd === undefined && typeof row["cwd"] === "string" && row["cwd"] !== "") cwd = row["cwd"];
    if (row["type"] === "cost-state") {
      record = { row, ...(lastAt !== undefined ? { at: lastAt } : {}), counts };
      usageAfter = false;
      return;
    }
    if (row["type"] === "custom-title" && typeof row["customTitle"] === "string") {
      title = row["customTitle"];
      named = true;
    } else if (row["type"] === "ai-title" && typeof row["aiTitle"] === "string" && !named) title = row["aiTitle"];
    applyClaudeRow(state, row);
  });
  if (end > mark) out.push([conversation, end]);
  // Whether the record came after all its own transcript's spend: the sub-agents read next count too.
  const last = record && !usageAfter ? record : undefined;
  for (const file of subagentTranscripts(path)) {
    const info = subagentInfo(path, file);
    const key = `${conversation}/${info.key}`;
    const subMark = marks[key] ?? 0;
    const origin = { agent: info.agent, trigger: state.agentTriggers.get(info.id) ?? "other" };
    let subEnd = 0;
    try {
      subEnd = eachLine(file, (buf, start, stop, offset) => {
        const head = buf.toString("utf8", start, Math.min(stop, start + HEAD));
        if (!head.includes('"role":"assistant"')) return;
        counts = offset >= subMark;
        try {
          applyClaudeUsage(state, JSON.parse(buf.toString("utf8", start, stop)), origin);
        } catch {
          // a line that is not JSON counts nothing
        }
      });
    } catch {
      continue;
    }
    if (subEnd > subMark) out.push([key, subEnd]);
  }
  // The last cost record, when nothing was spent after it: what it holds beyond is side spend.
  if (last && last.counts && applyClaudeCostRecord(state, last.row, price) && state.unrecorded) {
    const u = state.unrecorded;
    side.push({ at: last.at ?? lastAt ?? Date.now(), model: state.model ?? "unknown", cost: u.cost, tokens: { in: u.in, out: u.out, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite } });
  }
  return {
    conversation,
    rows: spendRows(calls, side, price),
    marks: out,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(firstAt !== undefined ? { firstAt } : {}),
    ...(lastAt !== undefined ? { lastAt } : {}),
  };
}

/** The main transcripts under the directories' `projects`, written since `since`, the oldest first: each folder read once however many directories lead to it. */
export function findTranscripts(dirs: string[], since: number): string[] {
  const roots = new Set<string>();
  for (const d of dirs) {
    try {
      roots.add(realpathSync.native(join(d, "projects")));
    } catch {
      // no projects folder there
    }
  }
  const found: { path: string; born: number }[] = [];
  for (const root of roots) {
    let projects: string[] = [];
    try {
      projects = readdirSync(root);
    } catch {
      continue;
    }
    for (const project of projects) {
      let files: string[] = [];
      try {
        files = readdirSync(join(root, project)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        const path = join(root, project, f);
        try {
          const st = statSync(path);
          if (st.mtimeMs >= since) found.push({ path, born: st.birthtimeMs || st.ctimeMs });
        } catch {
          // gone meanwhile
        }
      }
    }
  }
  return found.sort((a, b) => a.born - b.born).map((f) => f.path);
}

/** Whether a conversation's transcripts all end where the ledger's marks are: nothing to read. */
function upToDate(path: string, conversation: string, marks: Record<string, number>): boolean {
  const mark = marks[conversation];
  if (mark === undefined) return false;
  try {
    if (statSync(path).size !== mark) return false;
    for (const file of subagentTranscripts(path)) {
      const key = `${conversation}/${subagentInfo(path, file).key}`;
      if (statSync(file).size !== (marks[key] ?? -1)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** A whole run: every transcript found read, each result posted as it is ready. */
export function run(req: BackfillRequest, post: (m: BackfillMessage) => void): void {
  const pricer = new Pricer(new Map(req.prices));
  const price: SpendPrice = (model, tokens) => pricer.cost(model, tokens);
  const claimed = new Set(req.claimed);
  const seen = new Map<string, number>();
  let read = 0;
  let skipped = 0;
  let failed = 0;
  for (const path of findTranscripts(req.dirs, req.since)) {
    const conversation = conversationKey("claude", basename(path, ".jsonl"));
    if (claimed.has(conversation) || upToDate(path, conversation, req.marks)) {
      skipped++;
      continue;
    }
    try {
      post({ kind: "result", result: readConversation(path, req.marks, price, seen) });
      read++;
    } catch {
      failed++;
    }
  }
  post({ kind: "end", read, skipped, failed });
}

declare const self: Worker;
if (!isMainThread) {
  self.onmessage = (ev: MessageEvent<BackfillRequest>) => {
    try {
      run(ev.data, (m) => self.postMessage(m));
    } catch (e) {
      self.postMessage({ kind: "error", message: e instanceof Error ? e.message : String(e) } satisfies BackfillMessage);
    }
  };
}
