// `recall`: both legs, fused by reciprocal rank, hydrated into hits. Each leg ranks its own
// candidates; a chunk's fused score is the sum of 1/(k + rank) over the legs it appears in,
// scaled so a chunk first in every leg scores 1. Ties break newest first, then by id, so the
// same store answers the same query the same way. The snippet is FTS5's around the match
// when the full-text leg found the chunk, the head of the text otherwise, capped in
// characters so fifty hits always fit the audit's whole-result cap.

import type { Database } from "bun:sqlite";
import { RpcError } from "@cophyla/protocol";
import type { CapabilityParams, Hit, Source } from "@cophyla/protocol";
import type { ChunkRow } from "./chunks.ts";
import type { Embedder } from "./embed.ts";
import { filterSql } from "./filters.ts";
import type { RecallFilter, RecallScope } from "./filters.ts";
import { searchFts } from "./fts.ts";
import type { VectorIndex } from "./vectors.ts";

export const RECALL_DEFAULT_LIMIT = 10;
export const RECALL_MAX_LIMIT = 50;
export const SNIPPET_MAX_CHARS = 240;
export const RRF_K = 60;

export interface RecallDeps {
  db: Database;
  embedder?: Embedder;
  vectors?: VectorIndex;
  /** Whose rows it answers from; both legs keep to it. */
  scope?: RecallScope;
}

interface Candidate {
  id: number;
  rrf: number;
  snippet?: string;
}

/** The first `max` code points, whitespace collapsed, with an ellipsis when cut. */
export function clipSnippet(text: string, max = SNIPPET_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return chars.slice(0, max - 1).join("") + "…";
}

/** Chunks the filter admits, for the vector leg's masked scan; `undefined` when it admits all. */
function eligible(db: Database, filter: RecallFilter, scope?: RecallScope): Set<number> | undefined {
  const f = filterSql(filter, scope);
  if (f.where.length === 0) return undefined;
  const rows = db.query(`SELECT c.id AS id FROM chunks c ${f.joins} WHERE c.prose = 1 AND ${f.where.join(" AND ")}`).all(f.params) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

function sourceOf(c: ChunkRow): Source {
  switch (c.corpus) {
    case "thread":
      return { kind: "thread", thread: c.thread!, message: c.message! };
    case "session":
      return { kind: "session", session: c.session!, seq: [c.seq!, c.seq!] };
    case "memory":
      return { kind: "memory", name: c.memory!, lines: [c.line_from!, c.line_to!] };
  }
}

interface HydratedRow extends ChunkRow {
  owner_workspace: string | null;
  owner_tags: string | null;
}

export async function recall(deps: RecallDeps, params: CapabilityParams<"recall">): Promise<Hit[]> {
  const query = params.query.trim();
  if (query === "") throw new RpcError("invalid", "recall: empty query");
  const limit = Math.min(RECALL_MAX_LIMIT, Math.max(1, params.limit ?? RECALL_DEFAULT_LIMIT));
  const { query: _q, limit: _l, ...filter } = params;
  void _q;
  void _l;
  const perLeg = limit * 2;

  const candidates = new Map<number, Candidate>();
  const credit = (id: number, rank: number, snippet?: string) => {
    const c = candidates.get(id) ?? { id, rrf: 0 };
    c.rrf += 1 / (RRF_K + rank);
    if (snippet !== undefined && c.snippet === undefined) c.snippet = snippet;
    candidates.set(id, c);
  };

  let legs = 1;
  const fts = searchFts(deps.db, query, filter, perLeg, deps.scope);
  fts.forEach((h, i) => credit(h.id, i + 1, h.snippet));

  if (deps.embedder && deps.vectors && deps.vectors.size > 0) {
    // A hosted embedder with its link down answers nothing: recall stays on the full-text leg.
    let qv: Float32Array | undefined;
    try {
      [qv] = await deps.embedder.embed([query]);
    } catch {
      qv = undefined;
    }
    if (qv) {
      legs = 2;
      const hits = deps.vectors.search(qv, perLeg, eligible(deps.db, filter, deps.scope));
      hits.forEach((h, i) => credit(h.id, i + 1));
    }
  }
  if (candidates.size === 0) return [];

  const ids = Array.from(candidates.keys());
  const rows = deps.db
    .query(
      `SELECT c.*, COALESCE(t.workspace, s.workspace) AS owner_workspace, COALESCE(t.tags, s.tags) AS owner_tags
       FROM chunks c LEFT JOIN threads t ON c.thread = t.id LEFT JOIN harness_sessions s ON c.session = s.id
       WHERE c.id IN (${ids.map((_, i) => `$id${i}`).join(", ")})`,
    )
    .all(Object.fromEntries(ids.map((id, i) => [`id${i}`, id]))) as HydratedRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const top = 1 / (RRF_K + 1);
  const scored = ids
    .map((id) => ({ c: candidates.get(id)!, row: byId.get(id) }))
    .filter((x): x is { c: Candidate; row: HydratedRow } => x.row !== undefined)
    .sort((a, b) => b.c.rrf - a.c.rrf || b.row.at - a.row.at || b.row.id - a.row.id)
    .slice(0, limit);
  return scored.map(({ c, row }) => {
    const hit: Hit = {
      corpus: row.corpus,
      source: sourceOf(row),
      at: row.at,
      snippet: clipSnippet(c.snippet ?? row.text),
      tags: JSON.parse(row.corpus === "memory" ? row.tags : (row.owner_tags ?? "[]")) as string[],
      score: Math.min(1, c.rrf / (legs * top)),
    };
    if (row.corpus !== "memory" && row.owner_workspace !== null) hit.workspace = row.owner_workspace;
    return hit;
  });
}
