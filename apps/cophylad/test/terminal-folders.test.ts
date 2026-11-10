// New terminal's picker: the folders in one folder of this computer. Folders and links to
// folders by name, numbers in order; no files, no dot folders, nothing the computer hides;
// the parent, none at a root; the home without a path, and `~` under it; a folder that is not
// there, or a file, refused. Through the daemon the listing is audited without the names.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { listFolders } from "../src/sessions/tether/folders.ts";
import { SAFE_NODES, SAFE_SESSIONS, SAFE_UPDATE, stopDaemon, tempHome, testDaemon, TestClient } from "./helpers.ts";

describe("the folders a terminal may start in", () => {
  let home: string;

  beforeAll(() => {
    home = tempHome();
    for (const d of ["src", "Docs", "a10", "a9", ".config", "secret", "src/app"]) mkdirSync(join(home, d), { recursive: true });
    writeFileSync(join(home, "notes.txt"), "x");
    // a junction on Windows, which needs no privilege; a link elsewhere
    symlinkSync(join(home, "src"), join(home, "linked"), process.platform === "win32" ? "junction" : "dir");
  });

  test("folders and links to them, by name, without files, dot folders or what the computer hides", async () => {
    const r = await listFolders(home, { home, hidden: (p) => p.endsWith("secret") });
    expect(r.folders.map((f) => f.name)).toEqual(["a9", "a10", "Docs", "linked", "src"]);
    expect(r.folders.find((f) => f.name === "src")?.path).toBe(join(home, "src"));
    expect(r.path).toBe(home);
    expect(r.parent).toBe(join(home, ".."));
    expect(r.home).toBe(home);
    expect(r.truncated).toBeUndefined();
  });

  test("the home without a path, `~` under it, and a relative path from it", async () => {
    expect((await listFolders(undefined, { home })).path).toBe(home);
    expect((await listFolders("~", { home })).path).toBe(home);
    expect((await listFolders("~/src", { home })).folders.map((f) => f.name)).toEqual(["app"]);
    expect((await listFolders("src", { home })).path).toBe(join(home, "src"));
  });

  test("a root has no parent, and is among the roots", async () => {
    const root = parse(home).root;
    const r = await listFolders(root, { home });
    expect(r.parent).toBeUndefined();
    expect(r.roots).toContain(root);
  });

  test("a folder that is not there, or a file, is refused", async () => {
    await expect(listFolders(join(home, "gone"), { home })).rejects.toMatchObject({ code: "not_found" });
    await expect(listFolders(join(home, "notes.txt"), { home })).rejects.toMatchObject({ code: "invalid" });
  });

  test("asked for them, its files too, by name with their sizes, by the same rule: no dot files, nothing hidden", async () => {
    const dir = join(home, "Docs");
    writeFileSync(join(dir, "b10.txt"), "12345");
    writeFileSync(join(dir, "b9.md"), "");
    writeFileSync(join(dir, ".env"), "SECRET=1");
    writeFileSync(join(dir, "hidden.txt"), "x");
    mkdirSync(join(dir, "inner"));
    const r = await listFolders(dir, { home, hidden: (p) => p.endsWith("hidden.txt") }, { files: true });
    expect(r.folders.map((f) => f.name)).toEqual(["inner"]);
    expect(r.files).toEqual([
      { name: "b9.md", path: join(dir, "b9.md"), size: 0 },
      { name: "b10.txt", path: join(dir, "b10.txt"), size: 5 },
    ]);
    // without asking, the picker's folders alone
    expect((await listFolders(dir, { home })).files).toBeUndefined();
  });
});

describe("terminal.folders through the daemon", () => {
  let d: Awaited<ReturnType<typeof testDaemon>>;
  let c: TestClient;
  let dir: string;

  beforeAll(async () => {
    dir = tempHome();
    mkdirSync(join(dir, "private-project"), { recursive: true });
    d = await testDaemon(`${SAFE_SESSIONS}${SAFE_UPDATE}${SAFE_NODES}`);
    c = await TestClient.connect(d.api.url);
    await c.hello(d.token);
  }, 30_000);

  afterAll(async () => {
    c.close();
    await stopDaemon(d);
  });

  test("lists this node's folder, with no tether here, and audits the folder and the count, not the names", async () => {
    const r = await c.request<{ path: string; folders: { name: string }[] }>("terminal.folders", { path: dir });
    expect(r.folders.map((f) => f.name)).toEqual(["private-project"]);
    const row = d.store.audit.list({ limit: 50 }).find((e) => e.action === "terminal.folders" && e.outcome === "ok")!;
    expect(row.target).toBe(dir);
    expect(JSON.stringify(row)).not.toContain("private-project");
    // and nothing to start a shell with
    const spawn = await c.call("terminal.spawn", { cwd: dir });
    expect("error" in spawn && spawn.error.data?.code).toBe("unsupported");
  });

  test("with its files for a viewer, and a file anywhere read by its full path with no terminal; audited without the names or the text", async () => {
    const project = join(dir, "private-project");
    writeFileSync(join(project, "shot-notes.txt"), "pixels");
    const listed = await c.request<{ folders: unknown[]; files: { name: string; size: number }[] }>("terminal.folders", { path: project, files: true });
    expect(listed.files).toEqual([{ name: "shot-notes.txt", path: join(project, "shot-notes.txt"), size: 6 }] as never);
    const row = d.store.audit.list({ limit: 50 }).find((e) => e.action === "terminal.folders" && e.target === project && e.outcome === "ok")!;
    expect(JSON.stringify(row)).not.toContain("shot-notes");
    const file = await c.request<{ text: string }>("terminal.file", { path: join(project, "shot-notes.txt") });
    expect(file.text).toBe("pixels");
    const read = d.store.audit.list({ limit: 50 }).find((e) => e.action === "terminal.file" && e.outcome === "ok")!;
    expect(read.target).toBe(join(project, "shot-notes.txt"));
    expect(JSON.stringify(read)).not.toContain("pixels");
    // a relative path names nowhere without a terminal
    const relative = await c.call("terminal.file", { path: "shot-notes.txt" });
    expect("error" in relative && relative.error.data?.code).toBe("invalid");
  });
});
