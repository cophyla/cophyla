// The full-text leg. A query is turned into quoted tokens only, so no input can be a MATCH
// syntax error: every word ANDed first, and when that leaves room under the limit, any
// word as a second pass. Ranked by bm25, with FTS5's own snippet around the match.

import type { Database } from "bun:sqlite";
import { filterSql } from "./filters.ts";
import type { RecallFilter, RecallScope } from "./filters.ts";

export interface FtsHit {
  id: number;
  /** bm25: lower is better. */
  rank: number;
  snippet: string;
}

const WORD = /[\p{L}\p{N}]+/gu;

/** The query's words as FTS5 string tokens; empty when there is no word in it. */
export function ftsTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WORD)) out.push(`"${m[0]}"`);
  return out;
}

/** The AND form, and the OR form when there is more than one word. */
export function ftsQuery(text: string): { and: string; or?: string } | undefined {
  const tokens = ftsTokens(text);
  if (tokens.length === 0) return undefined;
  return tokens.length > 1 ? { and: tokens.join(" "), or: tokens.join(" OR ") } : { and: tokens[0]! };
}

export const SNIPPET_TOKENS = 32;

export function searchFts(db: Database, text: string, filter: RecallFilter, limit: number, scope?: RecallScope): FtsHit[] {
  const q = ftsQuery(text);
  if (!q) return [];
  const f = filterSql(filter, scope);
  const where = ["chunks_fts MATCH $match", ...f.where].join(" AND ");
  const sql = `SELECT c.id AS id, bm25(chunks_fts) AS rank, snippet(chunks_fts, 0, '', '', '…', ${SNIPPET_TOKENS}) AS snippet
    FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
    ${f.joins}
    WHERE ${where}
    ORDER BY rank, c.at DESC, c.id DESC
    LIMIT $limit`;
  const run = (match: string): FtsHit[] => db.query(sql).all({ ...f.params, match, limit }) as FtsHit[];
  const hits = run(q.and);
  if (!q.or || hits.length >= limit) return hits;
  const seen = new Set(hits.map((h) => h.id));
  for (const h of run(q.or)) {
    if (seen.has(h.id)) continue;
    hits.push(h);
    if (hits.length >= limit) break;
  }
  return hits;
}
