// The main connection's plan guard: which plans it calls unbounded, that strict mode throws
// where the statement is prepared, that annotated and bounded scans pass, and the slow log.

import { describe, expect, test } from "bun:test";
import { GuardedDatabase, aliases, judge, topLevel } from "../src/store/guard.ts";
import type { GuardReport } from "../src/store/guard.ts";
import { createLogger } from "../src/log.ts";

function db(strict = false): GuardedDatabase {
  const d = new GuardedDatabase(":memory:", { strict: true }, { strict, checkTests: true });
  d.exec("CREATE TABLE big (id INTEGER PRIMARY KEY, k TEXT, at INTEGER, v TEXT)");
  d.exec("CREATE INDEX big_at ON big(at)");
  d.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  d.schemaChanged();
  return d;
}

describe("judge", () => {
  const tables = new Set(["big", "meta", "chunks_fts"]);
  const plan = (...details: string[]) => details.map((detail, i) => ({ id: i + 2, parent: 0, detail }));

  test("a full scan of a big table is a violation, of a small one not", () => {
    expect(judge("SELECT * FROM big WHERE v = $v", plan("SCAN big"), tables)).toBe("full scan of big");
    expect(judge("SELECT * FROM meta", plan("SCAN meta"), tables)).toBeUndefined();
  });

  test("a whole index of a big table is a violation too", () => {
    expect(judge("SELECT COUNT(*) FROM big", plan("SCAN big USING COVERING INDEX big_at"), tables)).toBe("full scan of big (index big_at)");
  });

  test("an ordered walk under a top-level LIMIT is bounded, one that sorts is not", () => {
    expect(judge("SELECT * FROM big ORDER BY at DESC LIMIT 10", plan("SCAN big USING INDEX big_at"), tables)).toBeUndefined();
    expect(judge("SELECT * FROM big ORDER BY v LIMIT 10", plan("SCAN big", "USE TEMP B-TREE FOR ORDER BY"), tables)).toBe("full scan of big");
    // a LIMIT inside a subquery bounds that subquery only
    expect(judge("DELETE FROM big WHERE id NOT IN (SELECT id FROM big ORDER BY at LIMIT 5)", plan("SCAN big", "LIST SUBQUERY 1"), tables)).toBe("full scan of big");
  });

  test("aliases resolve to their tables", () => {
    expect(judge("SELECT c.id FROM big c WHERE c.v = 1", plan("SCAN c"), tables)).toBe("full scan of big");
    expect(aliases("SELECT * FROM big AS b LEFT JOIN meta m ON m.key = b.k WHERE b.id = 1")).toEqual(
      new Map([
        ["big", "big"],
        ["b", "big"],
        ["meta", "meta"],
        ["m", "meta"],
      ]),
    );
  });

  test("virtual tables, constant rows, subqueries and annotated statements pass", () => {
    expect(judge("SELECT * FROM chunks_fts WHERE chunks_fts MATCH $m", plan("SCAN chunks_fts VIRTUAL TABLE INDEX 0:M2"), tables)).toBeUndefined();
    expect(judge("SELECT 1", plan("SCAN CONSTANT ROW"), tables)).toBeUndefined();
    expect(judge("SELECT * FROM (SELECT 1)", plan("SCAN (subquery-1)"), tables)).toBeUndefined();
    expect(judge("SELECT * FROM big /* scan-ok: a one-time fill */", plan("SCAN big"), tables)).toBeUndefined();
  });

  test("the top level leaves out parentheses and strings", () => {
    expect(topLevel("SELECT a FROM t WHERE x IN (SELECT 1 LIMIT 2) AND y = ')' LIMIT 3")).toBe("SELECT a FROM t WHERE x IN  AND y =  LIMIT 3");
  });
});

describe("GuardedDatabase", () => {
  test("strict mode throws where an unbounded statement is prepared", () => {
    const d = db(true);
    expect(() => d.query("SELECT * FROM big WHERE v = $v")).toThrow(/full scan of big/);
    expect(() => d.query("SELECT * FROM big WHERE v = $v /* scan-ok: the test says so */")).not.toThrow();
    d.close();
    // a test's own statements are not checked unless asked
    const plain = new GuardedDatabase(":memory:", { strict: true }, { strict: true });
    plain.exec("CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT)");
    expect(() => plain.query("SELECT * FROM big WHERE v = $v")).not.toThrow();
    plain.close();
  });

  test("violations are reported with their plan; bounded statements are not", () => {
    const d = db(false);
    const seen: GuardReport[] = [];
    d.onViolation = (r) => seen.push(r);
    d.query("SELECT * FROM big WHERE id = $id").get({ id: 1 });
    d.query("SELECT * FROM big WHERE at > $at ORDER BY at LIMIT 5").all({ at: 0 });
    expect(seen).toEqual([]);
    d.close();
  });

  test("a slow statement is logged with its plan, once a minute per text", () => {
    const lines: string[] = [];
    const d = new GuardedDatabase(":memory:", { strict: true }, { slowMs: 0 });
    d.log = createLogger("debug", (l) => lines.push(l));
    d.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    const q = d.query("SELECT value FROM meta WHERE key = $key");
    q.get({ key: "a" });
    q.get({ key: "b" });
    const slow = lines.filter((l) => l.includes("slow statement") && l.includes("SELECT value"));
    expect(slow.length).toBe(1);
    expect(slow[0]).toContain("SEARCH meta");
    d.close();
  });

  test("transactions, cached statements and exec keep working", () => {
    const d = db(true);
    const ins = d.query("INSERT INTO big (k, at, v) VALUES ($k, $at, $v)");
    d.transaction(() => {
      for (let i = 0; i < 5; i++) ins.run({ k: `k${i}`, at: i, v: "x" });
    })();
    expect(d.query("INSERT INTO big (k, at, v) VALUES ($k, $at, $v)")).toBe(ins);
    expect((d.query("SELECT COUNT(*) AS n FROM big WHERE at >= $at").get({ at: 0 }) as { n: number }).n).toBe(5);
    d.exec("PRAGMA user_version = 3");
    expect((d.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
    d.close();
  });
});
