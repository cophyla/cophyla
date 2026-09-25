// Filling the index from what the store already holds: messages, then session events, in
// batches, newest first, skipping rows that already have a chunk (an anti-join on the
// chunk key), so a stopped sweep resumes where it left off and a finished one is marked
// in `meta` and never repeated. Memory files are reconciled by mtime at every start, until
// the milestone-7 watcher reports changes as they happen.

import type { Database } from "bun:sqlite";
import type { Memory, Message, SessionEvent } from "@cophyla/protocol";
import type { Logger } from "../../log.ts";
import { Chunks } from "./chunks.ts";

export const BACKFILL_META_KEY = "index.backfill.v1";

export interface BackfillDeps {
  db: Database;
  chunks: Chunks;
  log: Logger;
  batch: number;
  /** Aborts between batches. */
  stopped: () => boolean;
}

interface MessageRow {
  id: string;
  thread: string;
  at: number;
  role: string;
  source: string;
  content: string;
  streaming: number;
}

interface EventRow {
  session: string;
  seq: number;
  at: number;
  kind: string;
  payload: string;
}

/** A turn of the event loop between batches; `stopped()` is read right after it. */
const yieldNow = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Sweeps the store; `true` when it ran to the end. */
export async function backfill(deps: BackfillDeps): Promise<boolean> {
  const { db, chunks, log, batch } = deps;
  const done = db.query("SELECT value FROM meta WHERE key = $key").get({ key: BACKFILL_META_KEY }) as { value: string } | null;
  if (done?.value === "done") return true;
  const started = performance.now();
  let n = 0;
  for (;;) {
    if (deps.stopped()) return false;
    const rows = db
      .query(
        `SELECT m.* FROM messages m WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.key = 'msg:' || m.id)
         AND m.streaming = 0 ORDER BY m.at DESC, m.id DESC LIMIT $limit`,
      )
      .all({ limit: batch }) as MessageRow[];
    if (rows.length === 0) break;
    db.transaction(() => {
      for (const r of rows) {
        const m: Message = { id: r.id, thread: r.thread, at: r.at, role: r.role as Message["role"], source: r.source as Message["source"], content: JSON.parse(r.content) as Message["content"] };
        chunks.putMessage(m);
        // A message with no text gets no chunk; mark it so the sweep moves on.
        db.query("INSERT OR IGNORE INTO chunks (key, corpus, thread, message, at, text, prose) VALUES ($key, 'thread', $thread, $message, $at, '', 0)").run({ key: `msg:${r.id}`, thread: r.thread, message: r.id, at: r.at });
      }
    })();
    n += rows.length;
    await yieldNow();
  }
  for (;;) {
    if (deps.stopped()) return false;
    const rows = db
      .query(
        `SELECT e.session, e.seq, e.at, e.kind, e.payload FROM session_events e
         WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.key = 'ev:' || e.session || ':' || e.seq)
         ORDER BY e.at DESC, e.seq DESC LIMIT $limit`,
      )
      .all({ limit: batch }) as EventRow[];
    if (rows.length === 0) break;
    db.transaction(() => {
      for (const r of rows) {
        const e: SessionEvent = { session: r.session, seq: r.seq, at: r.at, kind: r.kind as SessionEvent["kind"], payload: JSON.parse(r.payload) as unknown };
        chunks.putEvent(e);
        db.query("INSERT OR IGNORE INTO chunks (key, corpus, session, seq, at, text, prose) VALUES ($key, 'session', $session, $seq, $at, '', 0)").run({ key: `ev:${r.session}:${r.seq}`, session: r.session, seq: r.seq, at: r.at });
      }
    })();
    n += rows.length;
    await yieldNow();
  }
  db.query("INSERT INTO meta (key, value) VALUES ($key, 'done') ON CONFLICT(key) DO UPDATE SET value = 'done'").run({ key: BACKFILL_META_KEY });
  if (n > 0) log.info("index backfilled", { rows: n, ms: Math.round(performance.now() - started) });
  return true;
}

/** Re-splits every memory file whose mtime differs from what is indexed, and drops the chunks of files that are gone. */
export function reconcileMemory(chunks: Chunks, all: Memory[]): { updated: number; removed: number } {
  let updated = 0;
  let removed = 0;
  const present = new Set<string>();
  for (const m of all) {
    present.add(m.name);
    if (chunks.memoryAt(m.name) === m.updatedAt) continue;
    chunks.putMemory(m);
    updated++;
  }
  for (const name of chunks.memoryNames()) {
    if (present.has(name)) continue;
    chunks.deleteMemory(name);
    removed++;
  }
  return { updated, removed };
}
