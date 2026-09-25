// The built-in tools over a temporary tree: numbered rows with long lines cut, offsets and
// caps, grep, glob and outline honouring the root .gitignore, workspace-relative paths, the
// JSON Schema the brain sees, and http.get against a local server with redirects and a cap.
// Then the registry with editable tools: the risk raised to exec, JSON Schema arguments
// checked with the key named, a safeParse schema accepted, built-in names protected.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, RpcError } from "@cophyla/protocol";
import type { Workspace } from "@cophyla/protocol";
import { parseConfig } from "../src/config/load.ts";
import { silentLogger } from "../src/log.ts";
import { gitignore, outlineMarkdown } from "../src/tools/builtin.ts";
import { effectiveRisk, Tools } from "../src/tools/index.ts";
import type { Tool } from "../src/tools/index.ts";
import { checkStructure, compileSchema } from "../src/tools/schema.ts";
import { normalisePath } from "../src/workspaces/index.ts";
import { removeHome, tempHome } from "./helpers.ts";

let root: string;
let ws: Workspace;
let tools: Tools;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  root = normalisePath(join(tempHome(), "tree"));
  mkdirSync(join(root, "docs", "deep"), { recursive: true });
  mkdirSync(join(root, "node_modules", "x"), { recursive: true });
  mkdirSync(join(root, "build"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "# comment\nbuild/\n*.log\n/secret.md\n");
  writeFileSync(join(root, "a.txt"), ["alpha", "beta gamma", "x".repeat(50), "delta", "epsilon"].join("\n") + "\n");
  writeFileSync(join(root, "docs", "plan.md"), "---\ntitle: The Plan\ntags: [a, b]\n---\n\n# Plan\n\nIntro line.\n\n## Phase one\n\n```\n# not a heading\n```\n\n## Phase two\n\nText about the gate.\n");
  writeFileSync(join(root, "docs", "deep", "notes.md"), "no heading here, just gate notes\n");
  writeFileSync(join(root, "docs", "other.md"), "# Other\n\n### Deep heading\n");
  writeFileSync(join(root, "secret.md"), "# Secret\n");
  writeFileSync(join(root, "build", "out.md"), "# Built\n");
  writeFileSync(join(root, "node_modules", "x", "readme.md"), "# Dep\n");
  writeFileSync(join(root, "trace.log"), "log\n");
  ws = { id: newId("workspace"), node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV", path: root, name: "tree", origin: "user", tags: [], lastActivity: 0 };
  const config = parseConfig("[tools]\nline_max_chars = 20\nread_max_lines = 3\nhttp_max_bytes = 64\nhttp_timeout_ms = 2000\n").tools;
  tools = new Tools({ nodeId: ws.node, config, workspaces: { get: (id) => (id === ws.id ? ws : undefined) }, log: silentLogger, home: root });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/hello") return new Response("hello " + (req.headers.get("x-test") ?? ""), { headers: { "content-type": "text/plain" } });
      if (url.pathname === "/big") return new Response("y".repeat(500));
      if (url.pathname === "/redirect") return new Response("", { status: 302, headers: { location: "/hello" } });
      if (url.pathname === "/loop") return new Response("", { status: 302, headers: { location: "/loop" } });
      if (url.pathname === "/slow") return new Promise((r) => setTimeout(() => r(new Response("late")), 4000));
      return new Response("nope", { status: 404 });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
  removeHome(join(root, ".."));
  rmSync(join(root, ".."), { recursive: true, force: true });
});

describe("tools", () => {
  test("list carries JSON Schema without $schema and the risk class", () => {
    const list = tools.list();
    expect(list.map((t) => t.name)).toEqual(["fs.read", "fs.grep", "fs.glob", "fs.outline", "http.get"]);
    const read = list.find((t) => t.name === "fs.read")!;
    expect(read.risk).toBe("read");
    expect(read.source).toBe("builtin");
    expect(read.schema["$schema"]).toBeUndefined();
    expect((read.schema["properties"] as Record<string, unknown>)["path"]).toBeDefined();
    expect(list.find((t) => t.name === "http.get")!.risk).toBe("network");
    expect(tools.risk("fs.grep")).toBe("read");
    expect(tools.risk("nope")).toBeUndefined();
  });

  test("fs.read numbers lines, cuts long ones, honours offset and the cap, and takes workspace-relative paths", async () => {
    const r = (await tools.run("fs.read", { path: join(root, "a.txt") })) as { path: string; from: number; to: number; total: number; truncated?: boolean; text: string };
    expect(r.from).toBe(1);
    expect(r.to).toBe(3);
    expect(r.total).toBe(5);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe("1\talpha\n2\tbeta gamma\n3\t" + "x".repeat(19) + "…");
    const rest = (await tools.run("fs.read", { path: "a.txt", workspace: ws.id, offset: 4, lines: 10 })) as typeof r;
    expect(rest.text).toBe("4\tdelta\n5\tepsilon");
    expect(rest.path).toBe(normalisePath(join(root, "a.txt")));
    await expect(tools.run("fs.read", { path: "a.txt" })).rejects.toMatchObject({ code: "invalid" });
    await expect(tools.run("fs.read", { path: "nope.txt", workspace: ws.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(tools.run("fs.read", { path: "docs", workspace: ws.id })).rejects.toMatchObject({ code: "invalid" });
    await expect(tools.run("fs.read", { path: "a.txt", workspace: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB9" })).rejects.toMatchObject({ code: "not_found" });
    await expect(tools.run("fs.read", {})).rejects.toBeInstanceOf(RpcError);
    await expect(tools.run("nope", {})).rejects.toMatchObject({ code: "not_found" });
  });

  test("fs.grep returns matching rows, case-insensitively when asked, capped", async () => {
    const r = (await tools.run("fs.grep", { path: "a.txt", workspace: ws.id, pattern: "^[ae]" })) as { matches: number; text: string; truncated?: boolean };
    expect(r.matches).toBe(2);
    expect(r.text).toBe("1\talpha\n5\tepsilon");
    const ci = (await tools.run("fs.grep", { path: "a.txt", workspace: ws.id, pattern: "ALPHA|delta", ignoreCase: true, max: 1 })) as typeof r;
    expect(ci.matches).toBe(2);
    expect(ci.truncated).toBe(true);
    expect(ci.text).toBe("1\talpha");
    await expect(tools.run("fs.grep", { path: "a.txt", workspace: ws.id, pattern: "(" })).rejects.toMatchObject({ code: "invalid" });
  });

  test("fs.glob skips .git, node_modules and the root .gitignore entries", async () => {
    const r = (await tools.run("fs.glob", { workspace: ws.id, pattern: "**/*.md" })) as { root: string; files: string[] };
    expect(r.root).toBe(root);
    expect(r.files).toEqual(["docs/deep/notes.md", "docs/other.md", "docs/plan.md"]);
    const all = (await tools.run("fs.glob", { root, pattern: "**/*" })) as typeof r;
    expect(all.files).toEqual(["a.txt", "docs/deep/notes.md", "docs/other.md", "docs/plan.md"]);
    const capped = (await tools.run("fs.glob", { root, pattern: "**/*.md", max: 2 })) as typeof r & { truncated?: boolean };
    expect(capped.files).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    await expect(tools.run("fs.glob", { pattern: "*" })).rejects.toMatchObject({ code: "invalid" });
    const ig = gitignore(root);
    expect(ig.ignores("build", true)).toBe(true);
    expect(ig.ignores("build/out.md", false)).toBe(true);
    expect(ig.ignores("secret.md", false)).toBe(true);
    expect(ig.ignores("docs/secret.md", false)).toBe(false);
    expect(ig.ignores("deep/trace.log", false)).toBe(true);
    expect(ig.ignores("docs/plan.md", false)).toBe(false);
  });

  test("fs.outline titles files from the first heading, the frontmatter or the name, lists headings with lines, and ranks by query", async () => {
    const all = (await tools.run("fs.outline", { workspace: ws.id })) as { files: { path: string; title: string; headings: { level: number; text: string; line: number }[]; score: number }[] };
    expect(all.files.map((f) => f.path)).toEqual(["docs/deep/notes.md", "docs/other.md", "docs/plan.md"]);
    const plan = all.files.find((f) => f.path === "docs/plan.md")!;
    expect(plan.title).toBe("Plan");
    expect(plan.headings).toEqual([
      { level: 1, text: "Plan", line: 6 },
      { level: 2, text: "Phase one", line: 10 },
      { level: 2, text: "Phase two", line: 16 },
    ]);
    expect(all.files.find((f) => f.path === "docs/deep/notes.md")!.title).toBe("notes");
    expect(outlineMarkdown("---\ntitle: From Front\n---\nbody\n", "x.md").title).toBe("From Front");
    const ranked = (await tools.run("fs.outline", { workspace: ws.id, query: "phase plan" })) as typeof all;
    expect(ranked.files.map((f) => f.path)).toEqual(["docs/plan.md"]);
    expect(ranked.files[0]!.score).toBe(3 + 2 + 1 + 2);
    const byPath = (await tools.run("fs.outline", { root, query: "other" })) as typeof all;
    expect(byPath.files.map((f) => f.path)).toEqual(["docs/other.md"]);
  });

  test("http.get follows redirects, passes headers, caps the body, refuses loops and other schemes, times out", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const r = (await tools.run("http.get", { url: `${base}/redirect`, headers: { "x-test": "h" } })) as { url: string; status: number; text: string; bytes: number; contentType?: string };
    expect(r.status).toBe(200);
    expect(r.text).toBe("hello h");
    expect(r.url).toBe(`${base}/hello`);
    expect(r.contentType).toContain("text/plain");
    const big = (await tools.run("http.get", { url: `${base}/big` })) as typeof r & { truncated?: boolean };
    expect(big.bytes).toBe(64);
    expect(big.truncated).toBe(true);
    expect(big.text).toBe("y".repeat(64));
    const small = (await tools.run("http.get", { url: `${base}/big`, maxBytes: 8 })) as typeof r;
    expect(small.text).toBe("y".repeat(8));
    await expect(tools.run("http.get", { url: `${base}/loop` })).rejects.toMatchObject({ code: "unavailable" });
    await expect(tools.run("http.get", { url: "ftp://example.com/x" })).rejects.toMatchObject({ code: "invalid" });
    await expect(tools.run("http.get", { url: `${base}/slow` })).rejects.toMatchObject({ code: "timeout" });
    const ac = new AbortController();
    const p = tools.run("http.get", { url: `${base}/slow` }, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("tools: the registry with editable tools", () => {
  const fresh = () => {
    const config = parseConfig("").tools;
    return new Tools({ nodeId: ws.node, config, workspaces: { get: () => undefined }, log: silentLogger, home: root });
  };

  test("an editable tool's read or write is raised to exec; network stays; the list reports the effective class and source", () => {
    expect(effectiveRisk("read", "editable")).toBe("exec");
    expect(effectiveRisk("write", "editable")).toBe("exec");
    expect(effectiveRisk("exec", "editable")).toBe("exec");
    expect(effectiveRisk("network", "editable")).toBe("network");
    expect(effectiveRisk("read", "builtin")).toBe("read");
    const t = fresh();
    expect(t.register({ name: "my.count", description: "counts", schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, risk: "read", run: (a) => (a as { text: string }).text.length }, "editable")).toBe(true);
    expect(t.register({ name: "my.fetch", description: "fetches", schema: { type: "object" }, risk: "network", run: () => 1 }, "editable")).toBe(true);
    expect(t.risk("my.count")).toBe("exec");
    expect(t.risk("my.fetch")).toBe("network");
    expect(t.risk("fs.read")).toBe("read");
    expect(t.source("my.count")).toBe("editable");
    expect(t.source("fs.read")).toBe("builtin");
    expect(t.source("nope")).toBeUndefined();
    const listed = t.list().find((d) => d.name === "my.count")!;
    expect(listed).toMatchObject({ source: "editable", risk: "exec", schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } });
    expect(t.list().find((d) => d.name === "fs.read")!.source).toBe("builtin");
  });

  test("JSON Schema arguments are checked at the top level and the error names the key; a safeParse schema is accepted too", async () => {
    const t = fresh();
    t.register(
      {
        name: "my.count",
        description: "counts",
        schema: { type: "object", properties: { text: { type: "string" }, mode: { type: "string", enum: ["words", "chars"] }, n: { type: ["integer", "null"] } }, required: ["text"], additionalProperties: false },
        risk: "read",
        run: (a) => ({ got: a }),
      },
      "editable",
    );
    expect(await t.run("my.count", { text: "ab", mode: "words", n: null })).toEqual({ got: { text: "ab", mode: "words", n: null } });
    await expect(t.run("my.count", {})).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("text: required") });
    await expect(t.run("my.count", { text: 1 })).rejects.toMatchObject({ message: expect.stringContaining("text: expected string") });
    await expect(t.run("my.count", { text: "a", mode: "lines" })).rejects.toMatchObject({ message: expect.stringContaining('mode: expected one of "words", "chars"') });
    await expect(t.run("my.count", { text: "a", n: 1.5 })).rejects.toMatchObject({ message: expect.stringContaining("n: expected integer or null") });
    await expect(t.run("my.count", { text: "a", extra: 1 })).rejects.toMatchObject({ message: expect.stringContaining("extra: unknown argument") });
    await expect(t.run("my.count", "text")).rejects.toMatchObject({ message: expect.stringContaining("expected an object") });
    expect(checkStructure({ type: "object" }, { anything: 1 })).toEqual([]);
    expect(checkStructure({ properties: { a: { type: "number" } } }, { a: "x" })).toEqual([{ path: ["a"], message: "expected number" }]);
    const zodLike = { safeParse: (v: unknown) => (typeof v === "object" && v !== null && "q" in v ? { success: true as const, data: v } : { success: false as const, error: { issues: [{ path: ["q"], message: "needed" }] } }) };
    t.register({ name: "my.zodlike", description: "z", schema: zodLike as unknown as Tool["schema"], risk: "exec", run: (a) => a }, "editable");
    expect(t.list().find((d) => d.name === "my.zodlike")!.schema).toEqual({ type: "object" });
    expect(await t.run("my.zodlike", { q: 1 })).toEqual({ q: 1 });
    await expect(t.run("my.zodlike", {})).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("q: needed") });
    expect(() => compileSchema("nope")).toThrow(/safeParse/);
    expect(() => t.register({ name: "my.bad", description: "b", schema: 42 as unknown as Tool["schema"], risk: "exec", run: () => 1 }, "editable")).toThrow();
  });

  test("a built-in name is never replaced or removed; an editable entry is replaced and removed; the context carries log and home", async () => {
    const t = fresh();
    const before = t.list().length;
    expect(t.register({ name: "fs.read", description: "fake", schema: { type: "object" }, risk: "exec", run: () => "fake" }, "editable")).toBe(false);
    expect(t.get("fs.read")!.description).not.toBe("fake");
    expect(t.unregister("fs.read")).toBe(false);
    expect(t.unregister("nope")).toBe(false);
    expect(t.list().length).toBe(before);
    let seen: { home: string; hasLog: boolean } | undefined;
    t.register({ name: "my.one", description: "first", schema: { type: "object" }, risk: "exec", run: (_a, ctx) => ((seen = { home: ctx.home, hasLog: typeof ctx.log.info === "function" }), 1) }, "editable");
    expect(await t.run("my.one", {})).toBe(1);
    expect(seen).toEqual({ home: root, hasLog: true });
    t.register({ name: "my.one", description: "second", schema: { type: "object" }, risk: "exec", run: () => 2 }, "editable");
    expect(t.get("my.one")!.description).toBe("second");
    expect(await t.run("my.one", {})).toBe(2);
    expect(t.list().filter((d) => d.name === "my.one")).toHaveLength(1);
    expect(t.unregister("my.one")).toBe(true);
    expect(t.get("my.one")).toBeUndefined();
    await expect(t.run("my.one", {})).rejects.toMatchObject({ code: "not_found" });
  });
});
