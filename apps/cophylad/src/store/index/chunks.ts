// The chunk rows: one per message, per session event and per memory heading section. The
// text is the same projection a quote uses (`messageText`, `sessionEventText`), so what
// recall finds is what a citation shows. `prose` marks what gets a vector: messages, the
// user's and the agent's turns, memory sections; tool calls, status changes, asks and the
// like are found by full text only. A write that leaves the text as it was leaves the
// vector too: `text` stays out of the UPDATE, so the trigger that drops it never fires.

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { messageText, sessionEventText } from "@cophyla/protocol";
import type { Memory, Message, SessionEvent } from "@cophyla/protocol";
import { splitSections } from "./sections.ts";

export type ChunkCorpus = "thread" | "session" | "memory";

export interface ChunkRow {
  id: number;
  key: string;
  corpus: ChunkCorpus;
  thread: string | null;
  message: string | null;
  session: string | null;
  seq: number | null;
  memory: string | null;
  line_from: number | null;
  line_to: number | null;
  tags: string;
  kind: string | null;
  at: number;
  text: string;
  prose: number;
}

interface ChunkInput {
  key: string;
  corpus: ChunkCorpus;
  thread?: string;
  message?: string;
  session?: string;
  seq?: number;
  memory?: string;
  line_from?: number;
  line_to?: number;
  tags?: string[];
  kind?: string;
  at: number;
  text: string;
  prose: boolean;
}

/** Session event kinds whose text is prose worth a vector. */
const PROSE_EVENTS = new Set<SessionEvent["kind"]>(["user_turn", "assistant_text"]);

export const messageKey = (id: string): string => `msg:${id}`;
export const eventKey = (session: string, seq: number): string => `ev:${session}:${seq}`;
const sectionKey = (name: string, text: string): string => `mem:${name}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;

export class Chunks {
  private db: Database;
  private onStale?: (id: number) => void;

  /** `onStale` hears every chunk whose vector is no longer valid: its text changed or it went. */
  constructor(db: Database, onStale?: (id: number) => void) {
    this.db = db;
    if (onStale) this.onStale = onStale;
  }

  private deleteWhere(sql: string, params: Record<string, string | number>): void {
    const rows = this.db.query(`SELECT id FROM chunks WHERE ${sql}`).all(params) as { id: number }[];
    if (rows.length === 0) return;
    this.db.query(`DELETE FROM chunks WHERE ${sql}`).run(params);
    if (this.onStale) for (const r of rows) this.onStale(r.id);
  }

  /** Inserts, or updates the row under `key`; the text column is touched only when it changed. */
  private put(c: ChunkInput): number {
    const cols = {
      key: c.key,
      corpus: c.corpus,
      thread: c.thread ?? null,
      message: c.message ?? null,
      session: c.session ?? null,
      seq: c.seq ?? null,
      memory: c.memory ?? null,
      line_from: c.line_from ?? null,
      line_to: c.line_to ?? null,
      tags: JSON.stringify(c.tags ?? []),
      kind: c.kind ?? null,
      at: c.at,
      prose: c.prose ? 1 : 0,
    };
    const existing = this.db.query("SELECT id, text FROM chunks WHERE key = $key").get({ key: c.key }) as { id: number; text: string } | null;
    if (!existing) {
      const r = this.db
        .query(
          `INSERT INTO chunks (key, corpus, thread, message, session, seq, memory, line_from, line_to, tags, kind, at, text, prose)
           VALUES ($key, $corpus, $thread, $message, $session, $seq, $memory, $line_from, $line_to, $tags, $kind, $at, $text, $prose)`,
        )
        .run({ ...cols, text: c.text });
      return Number(r.lastInsertRowid);
    }
    const same = existing.text === c.text;
    this.db
      .query(
        `UPDATE chunks SET corpus = $corpus, thread = $thread, message = $message, session = $session, seq = $seq, memory = $memory,
           line_from = $line_from, line_to = $line_to, tags = $tags, kind = $kind, at = $at, prose = $prose${same ? "" : ", text = $text"}
         WHERE id = $id`,
      )
      .run(same ? { ...cols, id: existing.id } : { ...cols, text: c.text, id: existing.id });
    if (!same) this.onStale?.(existing.id);
    return existing.id;
  }

  /** The message's chunk; a message with no text loses its chunk. */
  putMessage(m: Message): void {
    const text = messageText(m);
    if (text.trim() === "") {
      this.deleteWhere("key = $key", { key: messageKey(m.id) });
      return;
    }
    this.put({ key: messageKey(m.id), corpus: "thread", thread: m.thread, message: m.id, kind: m.role, at: m.at, text, prose: true });
  }

  putEvent(e: SessionEvent): void {
    const text = sessionEventText(e);
    if (text.trim() === "") return;
    this.put({ key: eventKey(e.session, e.seq), corpus: "session", session: e.session, seq: e.seq, kind: e.kind, at: e.at, text, prose: PROSE_EVENTS.has(e.kind) });
  }

  /**
   * The file's heading sections. A section is keyed by its text, so one whose text is
   * unchanged keeps its row and its vector across a re-split, wherever it moved to; the
   * rest are inserted or dropped.
   */
  putMemory(mem: Memory): void {
    const sections = splitSections(mem.body);
    const keep = new Set<string>();
    const tx = this.db.transaction(() => {
      for (const s of sections) {
        const key = sectionKey(mem.name, s.text);
        if (keep.has(key)) continue;
        keep.add(key);
        this.put({ key, corpus: "memory", memory: mem.name, line_from: s.from, line_to: s.to, tags: mem.tags, kind: mem.kind, at: mem.updatedAt, text: s.text, prose: true });
      }
      const rows = this.db.query("SELECT key FROM chunks WHERE memory = $memory").all({ memory: mem.name }) as { key: string }[];
      for (const r of rows) if (!keep.has(r.key)) this.deleteWhere("key = $key", { key: r.key });
    });
    tx();
  }

  /** Every chunk of one corpus: what a replica drops before it takes a snapshot's rows. */
  deleteCorpus(corpus: "thread" | "session" | "memory"): void {
    this.deleteWhere("corpus = $corpus", { corpus });
  }

  /** Every chunk of one session's events: a workspace node's, purged. */
  deleteSession(session: string): void {
    this.deleteWhere("session = $session", { session });
  }

  deleteMemory(name: string): void {
    this.deleteWhere("memory = $memory", { memory: name });
  }

  /** The newest `at` indexed for a memory file, for the reconcile by mtime. */
  memoryAt(name: string): number | undefined {
    const row = this.db.query("SELECT MAX(at) AS at FROM chunks WHERE memory = $memory").get({ memory: name }) as { at: number | null };
    return row.at ?? undefined;
  }

  memoryNames(): string[] {
    return (this.db.query("SELECT DISTINCT memory FROM chunks WHERE corpus = 'memory' ORDER BY memory").all() as { memory: string }[]).map((r) => r.memory);
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
  }
}
