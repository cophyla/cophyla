// The editable layer over a temporary home, the graph built by hand and driven by
// `rescan()`, so no timer and no `fs.watch` is involved and the run is the same on every
// OS: a tool file appears, is rewritten, breaks (the old one stays, the problem names the
// file), is deleted, takes a built-in or another file's name; a hook declares an event that
// enters the catalogue under it, hears a custom event and a built-in one, emits an
// undeclared event, never hears its own, stops a ping-pong at the depth cap, survives a
// throwing handler, runs its disposer on a rewrite and at stop, and is absent when `start`
// throws; a memory file's change is reindexed and announced; a prompt file's change is
// announced; a view directory's arrival and edit raise `view.changed`, a built-in name is
// skipped; the README is written once. One test runs the real watcher with a fast poll.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Memory } from "@cophyla/protocol";
import { Bus } from "../src/bus.ts";
import type { ChangedEvent } from "../src/bus.ts";
import { parseConfig } from "../src/config/load.ts";
import { ensureDirs, paths } from "../src/config/load.ts";
import { Hooks, MAX_EMIT_DEPTH } from "../src/editable/hooks.ts";
import { Editable } from "../src/editable/index.ts";
import { MemoryFiles } from "../src/editable/memory.ts";
import { ensureReadme, README_MD } from "../src/editable/readme.ts";
import { diff, isMarkdownFile, isModuleFile, snapshotFiles, snapshotTree } from "../src/editable/watcher.ts";
import { EventCatalogue } from "../src/events/catalogue.ts";
import { EventStream } from "../src/events/stream.ts";
import type { StreamEvent } from "../src/events/stream.ts";
import { createLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";
import { Tools } from "../src/tools/index.ts";
import { Views } from "../src/views/index.ts";
import { removeHome, sleep, tempHome, waitFor } from "./helpers.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";

interface Graph {
  home: string;
  p: ReturnType<typeof paths>;
  store: Store;
  bus: Bus;
  tools: Tools;
  stream: EventStream;
  catalogue: EventCatalogue;
  hooks: Hooks;
  views: Views;
  editable: Editable;
  events: StreamEvent[];
  notices: { name: string; params: ChangedEvent | { id: string } }[];
  reindexed: [string, Memory | undefined][];
  lines: string[];
  builtinViews: string;
}

async function graph(opts: { pollMs?: number } = {}): Promise<Graph> {
  const home = tempHome();
  const p = paths(home);
  ensureDirs(p);
  const store = new Store(":memory:");
  store.migrate();
  const bus = new Bus();
  const lines: string[] = [];
  const log = createLogger("debug", (l) => lines.push(l));
  const config = parseConfig("");
  const tools = new Tools({ nodeId: NODE, config: config.tools, workspaces: { get: () => undefined }, log, home });
  const stream = new EventStream({ bus, sessions: { get: () => undefined, list: () => [] }, log });
  stream.start([]);
  const events: StreamEvent[] = [];
  stream.on((e) => events.push(e));
  const catalogue = new EventCatalogue({ node: NODE, bus });
  const hooks = new Hooks({ stream, catalogue, log, home, node: NODE });
  const builtinViews = join(home, "builtin-views");
  mkdirSync(join(builtinViews, "default"), { recursive: true });
  writeFileSync(join(builtinViews, "default", "view.json"), JSON.stringify({ id: "default", name: "Chat", entry: "index.html" }));
  writeFileSync(join(builtinViews, "default", "index.html"), "<p>builtin</p>");
  const views = new Views({ store, log, bus, dirs: [{ dir: builtinViews, source: "builtin" }, { dir: p.views, source: "editable" }] });
  const memory = new MemoryFiles(p.memory);
  const reindexed: [string, Memory | undefined][] = [];
  const notices: Graph["notices"] = [];
  for (const name of ["tools.changed", "prompts.changed", "memory.changed", "events.changed", "view.changed"] as const) bus.on(name, (params) => notices.push({ name, params }));
  const editable = new Editable({ paths: p, tools, hooks, catalogue, views, memory, onMemory: (name, m) => reindexed.push([name, m]), bus, log, pollMs: opts.pollMs ?? 0 });
  return { home, p, store, bus, tools, stream, catalogue, hooks, views, editable, events, notices, reindexed, lines, builtinViews };
}

let g: Graph;

beforeEach(async () => {
  g = await graph();
});

afterEach(async () => {
  await g.editable.stop();
  await g.hooks.dispose();
  g.stream.dispose();
  g.store.close();
  removeHome(g.home);
});

const TOOL = (name: string, body = "return { n: (args.text ?? '').length }") =>
  `export const name = ${JSON.stringify(name)};\nexport const description = "counts";\nexport const risk = "read";\nexport const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };\nexport function run(args: { text: string }) { ${body}; }\n`;

const write = (rel: string, text: string) => {
  const file = join(g.home, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

const noticed = (name: string) => g.notices.filter((n) => n.name === name);
const custom = () => g.events.filter((e) => e.name === "event.custom").map((e) => (e.params as { name: string; payload: unknown; at: number }));

describe("editable layer: tools", () => {
  test("a tool file appears, is rewritten, breaks with the old one kept, and is deleted; each scan sends one tools.changed", async () => {
    await g.editable.start();
    expect(noticed("tools.changed")).toEqual([]);
    write("tools/my.count.ts", TOOL("my.count"));
    await g.editable.rescan();
    expect(g.tools.list().find((t) => t.name === "my.count")).toMatchObject({ source: "editable", risk: "exec", node: NODE });
    expect(await g.tools.run("my.count", { text: "abc" })).toEqual({ n: 3 });
    expect(noticed("tools.changed")).toHaveLength(1);
    expect(noticed("tools.changed")[0]!.params).toEqual({ at: expect.any(Number) });
    // A rewrite is seen.
    await sleep(15);
    write("tools/my.count.ts", TOOL("my.count", "return { n: 100 }"));
    await g.editable.rescan();
    expect(await g.tools.run("my.count", { text: "abc" })).toEqual({ n: 100 });
    expect(noticed("tools.changed")).toHaveLength(2);
    // Nothing changed: nothing sent.
    await g.editable.rescan();
    expect(noticed("tools.changed")).toHaveLength(2);
    // A broken file keeps the last good tool and reports the problem under the file's path.
    await sleep(15);
    write("tools/my.count.ts", "export const name = ;\n");
    await g.editable.rescan();
    expect(await g.tools.run("my.count", { text: "abc" })).toEqual({ n: 100 });
    const problems = (noticed("tools.changed")[2]!.params as ChangedEvent).problems!;
    expect(problems).toHaveLength(1);
    expect(problems[0]!.file).toBe("tools/my.count.ts");
    expect(problems[0]!.message).toMatch(/^my\.count\.ts: /);
    expect(g.editable.problems()).toEqual(problems);
    // Not a tool at all.
    write("tools/bad.ts", "export const name = 'bad';\n");
    write("tools/notool.ts", "export const x = 1;\n");
    await g.editable.rescan();
    expect(g.editable.problems().map((p) => p.file)).toEqual(["tools/bad.ts", "tools/my.count.ts", "tools/notool.ts"]);
    expect(g.editable.problems()[0]!.message).toMatch(/namespaced/);
    expect(g.editable.problems()[2]!.message).toMatch(/name/);
    // Fixed again, and deleted.
    await sleep(15);
    write("tools/my.count.ts", TOOL("my.count"));
    rmSync(join(g.home, "tools", "bad.ts"));
    rmSync(join(g.home, "tools", "notool.ts"));
    await g.editable.rescan();
    expect(g.editable.problems()).toEqual([]);
    expect(await g.tools.run("my.count", { text: "ab" })).toEqual({ n: 2 });
    rmSync(join(g.home, "tools", "my.count.ts"));
    await g.editable.rescan();
    expect(g.tools.get("my.count")).toBeUndefined();
    expect(noticed("tools.changed")).toHaveLength(6);
  });

  test("a built-in name, a name another file holds, and a helper file; a renamed tool unregisters its old name; default export works", async () => {
    write("tools/_lib.ts", "export const double = (n: number) => n * 2;\n");
    write("tools/fs.read.ts", TOOL("fs.read"));
    write("tools/uses.ts", 'import { double } from "./_lib.ts";\nexport default { name: "my.double", description: "doubles", risk: "write", run: (a: { n: number }) => double(a.n) };\n');
    await g.editable.start();
    expect(g.tools.get("fs.read")!.description).not.toBe("counts");
    expect(g.editable.problems()).toEqual([{ file: "tools/fs.read.ts", message: "fs.read: name fs.read is built in" }]);
    expect(await g.tools.run("my.double", { n: 4 })).toBe(8);
    expect(g.tools.risk("my.double")).toBe("exec");
    write("tools/second.ts", TOOL("my.double"));
    await g.editable.rescan();
    expect(g.editable.problems().map((p) => p.file)).toEqual(["tools/fs.read.ts", "tools/second.ts"]);
    expect(g.editable.problems()[1]!.message).toBe("second: name my.double is taken by tools/uses.ts");
    await sleep(15);
    write("tools/uses.ts", TOOL("my.other"));
    await g.editable.rescan();
    expect(g.tools.get("my.double")).toBeUndefined();
    expect(g.tools.get("my.other")).toBeDefined();
    expect(g.tools.get("_lib")).toBeUndefined();
  });
});

const HOOK = (name: string, extra = "") =>
  `export const name = ${JSON.stringify(name)};\nexport const events = [{ name: "${name}.ping", description: "a ping", payload: { type: "object" } }];\n${extra}\n`;

describe("editable layer: hooks", () => {
  test("a hook's declared event enters the catalogue under it; its handler hears a custom event and a built-in one; an undeclared emit is added; it never hears itself", async () => {
    write("hooks/watch.ts", HOOK("watch", `export const on = {
  start(ctx) { ctx.emit("watch.ping", { branch: "main" }); },
  "watch.ping"(payload, ctx) { ctx.log.info("self " + JSON.stringify(payload)); },
  "other.pong"(payload, ctx) { ctx.emit("watch.undeclared", { got: payload }); },
  "prompts.changed"(payload, ctx) { ctx.emit("watch.prompts", payload); },
};`));
    await g.editable.start();
    expect(g.hooks.list()).toEqual([{ name: "watch", file: join(g.home, "hooks", "watch.ts"), events: ["watch.ping"] }]);
    expect(g.catalogue.list().find((e) => e.name === "watch.ping")).toEqual({ name: "watch.ping", description: "a ping", payload: { type: "object" }, source: { hook: "watch" }, node: NODE });
    expect(noticed("events.changed")).toEqual([]);
    await sleep(20);
    expect(custom()).toEqual([{ at: expect.any(Number), name: "watch.ping", payload: { branch: "main" } }]);
    expect(g.events[0]!.origin).toBe("watch");
    expect(g.lines.some((l) => l.includes("self "))).toBe(false);
    g.stream.custom("other.pong", { x: 1 }, { origin: "other" });
    await waitFor(() => custom().some((e) => e.name === "watch.undeclared"));
    expect(custom()[2]).toEqual({ at: expect.any(Number), name: "watch.undeclared", payload: { got: { x: 1 } } });
    expect(g.catalogue.list().find((e) => e.name === "watch.undeclared")).toEqual({ name: "watch.undeclared", description: "raised by the watch hook", source: { hook: "watch" }, node: NODE });
    expect(noticed("events.changed")).toHaveLength(1);
    expect(g.lines.filter((l) => l.includes("emitted without being declared"))).toHaveLength(1);
    g.bus.emit("prompts.changed", { at: 7 });
    await waitFor(() => custom().some((e) => e.name === "watch.prompts"));
    expect(custom().find((e) => e.name === "watch.prompts")!.payload).toEqual({ at: 7 });
  });

  test("a ping-pong between two hooks stops at the depth cap; a throwing handler does not break the next", async () => {
    write("hooks/a.ts", `export const events = [{ name: "a.ping" }];\nexport const on = { "b.pong"(n, ctx) { ctx.emit("a.ping", n + 1); } };\n`);
    write("hooks/b.ts", `export const events = [{ name: "b.pong" }];\nexport const on = { "a.ping"(n, ctx) { if (n === 0) throw new Error("first one fails"); ctx.emit("b.pong", n + 1); } };\n`);
    write("hooks/c.ts", `export const on = { "a.ping"(n, ctx) { ctx.log.info("c saw " + n); } };\n`);
    await g.editable.start();
    // b throws on the first ping; c still hears it.
    g.stream.custom("a.ping", 0, { origin: "test" });
    await sleep(50);
    expect(g.lines.some((l) => l.includes("handler failed") && l.includes("first one fails"))).toBe(true);
    expect(g.lines.some((l) => l.includes("c saw 0"))).toBe(true);
    // A ping that b answers starts the chain; depths climb by one per hop until the cap, where the emit is dropped.
    g.stream.custom("a.ping", 1, { origin: "test" });
    await sleep(200);
    const chain = g.events.filter((e) => e.name === "event.custom" && (e.origin === "a" || e.origin === "b"));
    expect(Math.max(...chain.map((e) => e.depth ?? 0))).toBe(MAX_EMIT_DEPTH);
    expect(chain).toHaveLength(MAX_EMIT_DEPTH);
    expect(chain.map((e) => (e.params as { payload: number }).payload)).toEqual(chain.map((_e, i) => i + 2));
    expect(g.lines.filter((l) => l.includes("too deep"))).toHaveLength(1);
    expect(g.catalogue.list().find((e) => e.name === "a.ping")!.description).toBe("raised by the a hook");
  });

  test("the start disposer runs on a rewrite and at stop; a start that throws leaves nothing loaded; a bad module is a problem", async () => {
    const marker = join(g.home, "disposed.txt");
    write("hooks/timer.ts", `import { writeFileSync } from "node:fs";\nexport const on = { start() { return () => writeFileSync(${JSON.stringify(marker)}, "v1"); } };\n`);
    await g.editable.start();
    expect(g.hooks.list().map((h) => h.name)).toEqual(["timer"]);
    await sleep(15);
    write("hooks/timer.ts", `import { writeFileSync } from "node:fs";\nexport const on = { start() { return () => writeFileSync(${JSON.stringify(marker)}, "v2"); } };\n`);
    await g.editable.rescan();
    expect(readFileSync(marker, "utf8")).toBe("v1");
    expect(noticed("events.changed")).toHaveLength(1);
    write("hooks/broken.ts", `export const on = { start() { throw new Error("no way"); } };\n`);
    write("hooks/notahook.ts", `export const x = 1;\n`);
    write("hooks/taken.ts", `export const name = "timer";\nexport const on = {};\n`);
    write("hooks/claims.ts", `export const events = [{ name: "session.ask" }];\nexport const on = {};\n`);
    await g.editable.rescan();
    expect(g.hooks.list().map((h) => h.name)).toEqual(["timer"]);
    const changed = noticed("events.changed")[1]!.params as ChangedEvent;
    expect(changed.problems!.map((p) => p.file)).toEqual(["hooks/broken.ts", "hooks/claims.ts", "hooks/notahook.ts", "hooks/taken.ts"]);
    expect(changed.problems![0]!.message).toBe("broken.ts: start failed: no way");
    expect(changed.problems![1]!.message).toMatch(/built in/);
    expect(changed.problems![2]!.message).toMatch(/on/);
    expect(changed.problems![3]!.message).toBe("taken.ts: hook name timer is taken by timer.ts");
    expect(g.editable.problems()).toEqual(changed.problems!);
    await g.hooks.dispose();
    expect(readFileSync(marker, "utf8")).toBe("v2");
    expect(g.hooks.list()).toEqual([]);
  });
});

describe("editable layer: markdown and views", () => {
  test("a memory file written by hand is reindexed and announced; a deleted one is removed; a prompt file is announced", async () => {
    await g.editable.start();
    write("memory/user.md", "---\ndescription: who\nkind: user\ntags: [a]\n---\nA solo developer.\n");
    write("prompts/review.md", "Review {{diff}}\n");
    write("memory/README.txt", "not markdown");
    write("memory/Bad Name.md", "ignored");
    await g.editable.rescan();
    expect(g.reindexed).toHaveLength(1);
    expect(g.reindexed[0]![0]).toBe("user");
    expect(g.reindexed[0]![1]).toMatchObject({ name: "user", kind: "user", tags: ["a"], body: "A solo developer.\n" });
    expect(noticed("memory.changed")).toHaveLength(1);
    expect(noticed("prompts.changed")).toHaveLength(1);
    await g.editable.rescan();
    expect(noticed("memory.changed")).toHaveLength(1);
    rmSync(join(g.home, "memory", "user.md"));
    await g.editable.rescan();
    expect(g.reindexed[1]).toEqual(["user", undefined]);
    expect(noticed("memory.changed")).toHaveLength(2);
    expect(noticed("prompts.changed")).toHaveLength(1);
  });

  test("a view directory that appears or changes raises view.changed for its id; a built-in id is skipped; the default moving raises it too", async () => {
    await g.editable.start();
    expect(g.views.list().map((v) => [v.id, v.source])).toEqual([["default", "builtin"]]);
    write("views/mine/view.json", JSON.stringify({ id: "mine", name: "Mine", entry: "index.html" }));
    write("views/mine/index.html", "<p>one</p>");
    write("views/default/view.json", JSON.stringify({ id: "default", name: "Fake", entry: "index.html" }));
    write("views/default/index.html", "<p>fake</p>");
    await g.editable.rescan();
    expect(noticed("view.changed").map((n) => n.params)).toEqual([{ id: "mine" }]);
    expect(g.views.list().map((v) => [v.id, v.source, v.name])).toEqual([["default", "builtin", "Chat"], ["mine", "editable", "Mine"]]);
    expect(g.lines.some((l) => l.includes("view skipped") && l.includes("default"))).toBe(true);
    expect(g.views.get("mine").files.find((f) => f.path === "index.html")!.text).toBe("<p>one</p>");
    write("views/mine/index.html", "<p>two</p>");
    await g.editable.rescan();
    expect(noticed("view.changed")).toHaveLength(2);
    await g.editable.rescan();
    expect(noticed("view.changed")).toHaveLength(2);
    g.views.setDefault("mine");
    expect(noticed("view.changed")[2]!.params).toEqual({ id: "mine" });
    rmSync(join(g.home, "views", "mine"), { recursive: true });
    await g.editable.rescan();
    expect(noticed("view.changed")).toHaveLength(4);
    expect(g.views.list().map((v) => v.id)).toEqual(["default"]);
  });

  test("snapshots and filters: module files skip dot and underscore prefixes, markdown follows the name rule, the tree walk skips node_modules", () => {
    expect(isModuleFile("my.tool.ts")).toBe(true);
    expect(isModuleFile("x.mjs")).toBe(true);
    expect(isModuleFile("x.js")).toBe(true);
    expect(isModuleFile("_lib.ts")).toBe(false);
    expect(isModuleFile(".hidden.ts")).toBe(false);
    expect(isModuleFile("notes.md")).toBe(false);
    expect(isModuleFile("x.d.ts")).toBe(true);
    expect(isMarkdownFile("user.md")).toBe(true);
    expect(isMarkdownFile("Bad Name.md")).toBe(false);
    expect(isMarkdownFile("x.txt")).toBe(false);
    write("tree/a.ts", "1");
    write("tree/sub/b.ts", "2");
    write("tree/node_modules/c.ts", "3");
    write("tree/.dot/d.ts", "4");
    const tree = snapshotTree(join(g.home, "tree"));
    expect([...tree.keys()].map((k) => k.slice(g.home.length + 1).replace(/\\/g, "/")).sort()).toEqual(["tree/a.ts", "tree/sub/b.ts"]);
    const files = snapshotFiles(join(g.home, "tree"), isModuleFile);
    expect(files.size).toBe(1);
    const after = new Map(files);
    after.set(join(g.home, "tree", "a.ts"), { mtimeMs: 1, size: 9 });
    after.set("new", { mtimeMs: 1, size: 1 });
    expect(diff(files, after)).toEqual({ added: ["new"], changed: [join(g.home, "tree", "a.ts")], removed: [] });
    expect(diff(after, files)).toEqual({ added: [], changed: [join(g.home, "tree", "a.ts")], removed: ["new"] });
    expect(snapshotFiles(join(g.home, "nowhere"), isModuleFile).size).toBe(0);
  });

  test("the README is written once and left alone after", () => {
    expect(existsSync(g.p.readme)).toBe(false);
    expect(ensureReadme(g.p.readme)).toBe(true);
    expect(readFileSync(g.p.readme, "utf8")).toBe(README_MD);
    writeFileSync(g.p.readme, "mine");
    expect(ensureReadme(g.p.readme)).toBe(false);
    expect(readFileSync(g.p.readme, "utf8")).toBe("mine");
    for (const word of ["tools/", "hooks/", "views/", "exec", "emit(", "disposer", "`_`"]) expect(README_MD).toContain(word);
  });
});

describe("editable layer: the real watcher", () => {
  test("a tool written after start is loaded without a rescan call, by the watcher or the poll", async () => {
    await g.editable.stop();
    g.store.close();
    removeHome(g.home);
    g = await graph({ pollMs: 100 });
    await g.editable.start();
    write("tools/my.late.ts", TOOL("my.late"));
    await waitFor(() => g.tools.get("my.late") !== undefined, 5000);
    expect(noticed("tools.changed")).toHaveLength(1);
    await g.editable.stop();
  });
});
