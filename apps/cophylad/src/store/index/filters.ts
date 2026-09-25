// The recall filters as SQL over a `chunks c` row: joins to the owning thread or session and
// its workspace, and predicates that each narrow only the corpus they speak about (a
// workspace narrows threads and sessions, a node narrows sessions; memory answers only to
// `in`, the time bounds and the tags). Tags are read off the owner row, the memory file's
// own column and the owner's workspace at query time, so an `annotate` is visible on the
// next query with no reindex. Shared by the full-text leg, the vector leg's eligible set
// and the hydration of hits.

import type { CapabilityParams } from "@cophyla/protocol";

export type RecallFilter = Omit<CapabilityParams<"recall">, "query" | "limit">;

export interface FilterSql {
  /** The LEFT JOINs after `FROM chunks c`. */
  joins: string;
  /** Predicates to AND together; empty when the filter is empty. */
  where: string[];
  params: Record<string, string | number>;
}

export const OWNER_JOINS = `LEFT JOIN threads t ON c.thread = t.id
  LEFT JOIN harness_sessions s ON c.session = s.id
  LEFT JOIN workspaces w ON w.id = COALESCE(t.workspace, s.workspace)`;

const tagIn = (column: string, param: string) => `EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ${param})`;

export function filterSql(f: RecallFilter): FilterSql {
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (f.in && f.in.length > 0) {
    where.push(`c.corpus IN (${f.in.map((_, i) => `$in${i}`).join(", ")})`);
    f.in.forEach((v, i) => (params[`in${i}`] = v));
  }
  if (f.workspace !== undefined) {
    where.push("(c.corpus = 'memory' OR COALESCE(t.workspace, s.workspace) = $workspace)");
    params["workspace"] = f.workspace;
  }
  if (f.node !== undefined) {
    where.push("(c.corpus != 'session' OR s.node = $node)");
    params["node"] = f.node;
  }
  if (f.harness !== undefined) {
    where.push("(c.corpus != 'session' OR s.harness = $harness)");
    params["harness"] = f.harness;
  }
  if (f.session !== undefined) {
    where.push("(c.corpus != 'session' OR c.session = $session)");
    params["session"] = f.session;
  }
  if (f.thread !== undefined) {
    where.push("(c.corpus != 'thread' OR c.thread = $thread)");
    params["thread"] = f.thread;
  }
  if (f.task !== undefined) {
    where.push("(c.corpus != 'session' OR s.task = $task)");
    params["task"] = f.task;
  }
  if (f.since !== undefined) {
    where.push("c.at >= $since");
    params["since"] = f.since;
  }
  if (f.until !== undefined) {
    where.push("c.at <= $until");
    params["until"] = f.until;
  }
  if (f.tags && f.tags.length > 0) {
    f.tags.forEach((tag, i) => {
      const p = `$tag${i}`;
      where.push(`(${tagIn("c.tags", p)} OR ${tagIn("COALESCE(t.tags, s.tags, '[]')", p)} OR ${tagIn("COALESCE(w.tags, '[]')", p)})`);
      params[`tag${i}`] = tag;
    });
  }
  return { joins: OWNER_JOINS, where, params };
}

/** `true` when the filter narrows anything, so the vector leg needs an eligible set. */
export function narrows(f: RecallFilter): boolean {
  return filterSql(f).where.length > 0;
}
