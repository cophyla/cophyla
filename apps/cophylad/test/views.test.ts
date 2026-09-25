// The views module: a temporary builtin directory with a fake view, served through `Views`
// directly and through the socket, a user view under the home announced by `view.changed`,
// `~/.cophyla` listed as the `cophyla` workspace, and the real `apps/cophylad/views` checked for
// consistency.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry, ViewContent, ViewManifest, Workspace } from "@cophyla/protocol";
import { ViewManifest as ViewManifestSchema } from "@cophyla/protocol";
import { silentLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";
import { isText, mimeOf, versionOf, walk } from "../src/views/files.ts";
import { BUILTIN_VIEWS_DIR, Views } from "../src/views/index.ts";
import { normalisePath } from "../src/workspaces/index.ts";
import { isMethod, removeHome, stopDaemon, tempHome, testDaemon, TestClient } from "./helpers.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function fakeViews(): string {
  const root = mkdtempSync(join(tmpdir(), "cophyla-views-"));
  const v = join(root, "fake");
  mkdirSync(join(v, "lib"), { recursive: true });
  writeFileSync(join(v, "view.json"), JSON.stringify({ id: "fake", name: "Fake", entry: "index.html", scopes: ["sessions:read"] }));
  writeFileSync(join(v, "index.html"), '<!doctype html><script type="module" src="a.ts"></script>');
  writeFileSync(join(v, "a.ts"), 'import { b } from "./b.ts";\nimport type { Session } from "@cophyla/protocol";\nexport const a: number = b(1 as number);\nexport type S = Session;\n');
  writeFileSync(join(v, "b.ts"), "export function b(x: number): number {\n  return x + 1;\n}\n");
  writeFileSync(join(v, "lib", "c.ts"), "export const c: string = 'c';\n");
  writeFileSync(join(v, "icon.png"), PNG);
  writeFileSync(join(v, ".hidden"), "no");
  mkdirSync(join(v, "node_modules", "x"), { recursive: true });
  writeFileSync(join(v, "node_modules", "x", "index.js"), "no");
  // An invalid manifest, a manifest whose id is not its directory, and a plain file: all left out.
  mkdirSync(join(root, "broken"));
  writeFileSync(join(root, "broken", "view.json"), JSON.stringify({ id: "broken", name: 1 }));
  mkdirSync(join(root, "renamed"));
  writeFileSync(join(root, "renamed", "view.json"), JSON.stringify({ id: "other", name: "Other", entry: "index.html" }));
  writeFileSync(join(root, "renamed", "index.html"), "x");
  writeFileSync(join(root, "stray.txt"), "x");
  return root;
}

describe("views: files", () => {
  test("mime and text classes", () => {
    expect(mimeOf("a/b.ts")).toBe("text/javascript");
    expect(mimeOf("x.HTML")).toBe("text/html");
    expect(mimeOf("x.woff2")).toBe("font/woff2");
    expect(mimeOf("x.bin")).toBe("application/octet-stream");
    expect(isText("text/css")).toBe(true);
    expect(isText("image/svg+xml")).toBe(true);
    expect(isText("image/png")).toBe(false);
  });

  test("walk lists regular files with forward-slash paths and skips dotfiles, node_modules and the manifest", () => {
    const root = fakeViews();
    try {
      const skipped: string[] = [];
      const files = walk(join(root, "fake"), { onSkip: (p, r) => skipped.push(`${p}:${r}`) });
      expect(files.map((f) => f.path)).toEqual(["a.ts", "b.ts", "icon.png", "index.html", "lib/c.ts"]);
      expect(skipped.sort()).toEqual([".hidden:dotfile", "node_modules:node_modules", "view.json:manifest"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("versionOf is 16 hex, order-independent, and moves with one byte", () => {
    const a = [
      { path: "a", bytes: Buffer.from("1") },
      { path: "b", bytes: Buffer.from("2") },
    ];
    const v = versionOf(a);
    expect(v).toMatch(/^[0-9a-f]{16}$/);
    expect(versionOf([a[1]!, a[0]!])).toBe(v);
    expect(versionOf([a[0]!, { path: "b", bytes: Buffer.from("3") }])).not.toBe(v);
    expect(versionOf([{ path: "ab", bytes: Buffer.from("") }])).not.toBe(versionOf([{ path: "a", bytes: Buffer.from("b") }]));
  });
});

describe("views: the module over a fake builtin directory", () => {
  let root: string;
  let store: Store;
  let views: Views;

  beforeAll(() => {
    root = fakeViews();
    store = new Store(":memory:");
    store.migrate();
    views = new Views({ store, log: silentLogger, dirs: [{ dir: root, source: "builtin" }] });
  });
  afterAll(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("list: the valid view, builtin, default by fallback, with a version", () => {
    const list = views.list();
    expect(list).toHaveLength(1);
    const m = list[0]!;
    expect(ViewManifestSchema.safeParse(m).success).toBe(true);
    expect(m).toMatchObject({ id: "fake", name: "Fake", entry: "index.html", source: "builtin", default: true, scopes: ["sessions:read"] });
    expect(m.version).toMatch(/^[0-9a-f]{16}$/);
  });

  test("get: TypeScript is stripped and served as JavaScript under its own path, specifiers intact, binaries as base64", () => {
    const content = views.get("fake");
    expect(content.id).toBe("fake");
    expect(content.version).toBe(views.list()[0]!.version!);
    const a = content.files.find((f) => f.path === "a.ts")!;
    expect(a.mime).toBe("text/javascript");
    expect(a.text).toContain('from "./b.ts"');
    expect(a.text).not.toContain(": number");
    expect(a.text).not.toContain("as number");
    expect(a.text).not.toContain("import type");
    expect(a.text).not.toContain("@cophyla/protocol");
    const c = content.files.find((f) => f.path === "lib/c.ts")!;
    expect(c.text).toBe("export const c = \"c\";\n");
    const png = content.files.find((f) => f.path === "icon.png")!;
    expect(png.mime).toBe("image/png");
    expect(png.base64).toBe(PNG.toString("base64"));
    expect(png.text).toBeUndefined();
    const html = content.files.find((f) => f.path === "index.html")!;
    expect(html.mime).toBe("text/html");
    expect(html.text).toContain("<!doctype html>");
    expect(content.files.some((f) => f.path === "view.json")).toBe(false);
  });

  test("the version is stable across calls and changes with one byte", () => {
    const before = views.get("fake").version;
    expect(views.get("fake").version).toBe(before);
    writeFileSync(join(root, "fake", "b.ts"), "export function b(x: number): number {\n  return x + 2;\n}\n");
    const after = views.get("fake").version;
    expect(after).not.toBe(before);
    expect(views.list()[0]!.version).toBe(after);
  });

  test("get on an unknown id, and setDefault on one, are not_found", () => {
    expect(() => views.get("nope")).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => views.setDefault("nope")).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => views.get("broken")).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => views.get("other")).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  test("a missing entry is not_found", () => {
    const v = join(root, "noentry");
    mkdirSync(v);
    writeFileSync(join(v, "view.json"), JSON.stringify({ id: "noentry", name: "No entry", entry: "missing.html" }));
    writeFileSync(join(v, "index.html"), "x");
    expect(views.list().map((m) => m.id)).toEqual(["fake", "noentry"]);
    expect(() => views.get("noentry")).toThrow(expect.objectContaining({ code: "not_found" }));
    rmSync(v, { recursive: true, force: true });
  });

  test("setDefault persists in kv and survives a new Views over the same store", () => {
    const v = join(root, "second");
    mkdirSync(v);
    writeFileSync(join(v, "view.json"), JSON.stringify({ id: "second", name: "Second", entry: "index.html" }));
    writeFileSync(join(v, "index.html"), "x");
    expect(views.list().find((m) => m.default)!.id).toBe("fake");
    views.setDefault("second");
    expect(views.list().find((m) => m.default)!.id).toBe("second");
    expect(store.kv.get("views", "default")).toBe("second");
    const again = new Views({ store, log: silentLogger, dirs: [{ dir: root, source: "builtin" }] });
    expect(again.default()).toBe("second");
    // A remembered default that no longer exists falls back.
    rmSync(v, { recursive: true, force: true });
    expect(again.default()).toBe("fake");
  });

  test("an empty or absent directory lists nothing", () => {
    const none = new Views({ store, log: silentLogger, dirs: [{ dir: join(root, "does-not-exist"), source: "builtin" }] });
    expect(none.list()).toEqual([]);
    expect(none.default()).toBeUndefined();
  });
});

describe("views: over the socket", () => {
  test("view.list, view.get and view.setDefault succeed, persist across a restart in the same home, and are audited", async () => {
    const root = fakeViews();
    const home = tempHome();
    const { startDaemon } = await import("../src/daemon.ts");
    let d = Object.assign(await startDaemon({ home, port: 0, log: silentLogger, builtinViews: root, brain: false }), { home });
    try {
      const c = await TestClient.connect(d.api.url);
      await c.hello(d.token, { name: "views" });
      const { views } = await c.request<{ views: ViewManifest[] }>("view.list", {});
      expect(views.map((v) => v.id)).toEqual(["fake"]);
      expect(views[0]!.default).toBe(true);
      const content = await c.request<ViewContent>("view.get", { id: "fake" });
      expect(content.files.map((f) => f.path)).toEqual(["a.ts", "b.ts", "icon.png", "index.html", "lib/c.ts"]);
      const missing = await c.call("view.get", { id: "missing" });
      expect("error" in missing && missing.error.data?.code).toBe("not_found");

      mkdirSync(join(root, "second"));
      writeFileSync(join(root, "second", "view.json"), JSON.stringify({ id: "second", name: "Second", entry: "index.html" }));
      writeFileSync(join(root, "second", "index.html"), "x");
      expect(await c.request<Record<string, never>>("view.setDefault", { id: "second" })).toEqual({});
      const audited = d.store.audit.list({ limit: 50 });
      for (const a of ["view.list", "view.get", "view.setDefault"]) expect(audited.map((e: AuditEntry) => e.action)).toContain(a);
      expect(audited.find((e) => e.action === "view.setDefault")!.target).toBe("second");
      expect(audited.find((e) => e.action === "view.get" && e.outcome === "ok")!.target).toBe("fake");
      c.close();
      await d.stop();

      d = Object.assign(await startDaemon({ home, port: 0, log: silentLogger, builtinViews: root, brain: false }), { home });
      const c2 = await TestClient.connect(d.api.url);
      await c2.hello(d.token);
      const after = await c2.request<{ views: ViewManifest[] }>("view.list", {});
      expect(after.views.find((v) => v.default)!.id).toBe("second");
      c2.close();
    } finally {
      await stopDaemon(d);
      removeHome(root);
    }
  });

  test("a client with the views scope hears view.changed when the default moves and when a user view is edited; ~/.cophyla is the cophyla workspace", async () => {
    const root = fakeViews();
    const d = await testDaemon("", { builtinViews: root });
    try {
      const c = await TestClient.connect(d.api.url);
      await c.hello(d.token, { name: "views" });
      const mine = join(d.home, "views", "mine");
      mkdirSync(mine, { recursive: true });
      writeFileSync(join(mine, "view.json"), JSON.stringify({ id: "mine", name: "Mine", entry: "index.html" }));
      writeFileSync(join(mine, "index.html"), "<p>mine</p>");
      await d.editable.rescan();
      await c.next(isMethod("view.changed", (p) => (p as { id: string }).id === "mine"));
      const { views } = await c.request<{ views: ViewManifest[] }>("view.list", {});
      expect(views.map((v) => [v.id, v.source])).toEqual([
        ["fake", "builtin"],
        ["mine", "editable"],
      ]);
      await c.request("view.setDefault", { id: "mine" });
      expect(c.notifications.filter((n) => n.method === "view.changed")).toHaveLength(2);
      const { workspaces } = await c.request<{ workspaces: Workspace[] }>("workspace.list", {});
      const cophyla = workspaces.find((w) => w.name === "cophyla")!;
      expect(cophyla).toBeDefined();
      expect(cophyla.path.toLowerCase()).toBe(normalisePath(d.home).toLowerCase());
      expect(cophyla.origin).toBe("scope");
      expect(d.workspaces.home(d.home).id).toBe(cophyla.id);
      expect(d.workspaces.list().filter((w) => w.name === "cophyla")).toHaveLength(1);
      c.close();
    } finally {
      await stopDaemon(d);
      removeHome(root);
    }
  });
});

describe("views: the real built-in directory", () => {
  const store = new Store(":memory:");
  store.migrate();
  const views = new Views({ store, log: silentLogger });

  test("every directory has a valid manifest and serves its entry", () => {
    const dirs = readdirSync(BUILTIN_VIEWS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
    expect(dirs).toContain("default");
    const listed = views.list();
    expect(listed.map((v) => v.id).sort()).toEqual(dirs.sort());
    for (const m of listed) {
      expect(ViewManifestSchema.safeParse(m).success).toBe(true);
      const content = views.get(m.id);
      expect(content.files.some((f) => f.path === m.entry)).toBe(true);
    }
    expect(listed.find((v) => v.default)!.id).toBe("default");
  });

  test("every built-in view offers Change view and Settings: something in it asks the host for each", () => {
    // A view without them leaves the user no way to another view, or to the settings, from inside it (the ~/.cophyla README says the same to whoever writes one).
    for (const m of views.list()) {
      const sources = views.get(m.id).files.filter((f) => f.mime === "text/javascript" || f.mime === "text/html").map((f) => f.text ?? "");
      expect(sources.some((t) => t.includes('"host.chooseView"'))).toBe(true);
      expect(sources.some((t) => t.includes('"host.settings"'))).toBe(true);
    }
  });

  test("every src and href in the default view's entry names a served file, and every .ts transpiles", () => {
    const content = views.get("default");
    const served = new Set(content.files.map((f) => f.path));
    const html = content.files.find((f) => f.path === "index.html")!.text!;
    const refs = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(served.has(ref)).toBe(true);
    for (const f of content.files) {
      if (f.path.endsWith(".ts")) {
        expect(f.mime).toBe("text/javascript");
        expect(typeof f.text).toBe("string");
        // Still TypeScript on disk: the served text is what was stripped.
        expect(readFileSync(join(BUILTIN_VIEWS_DIR, "default", f.path), "utf8")).toBeDefined();
      }
    }
  });
});
