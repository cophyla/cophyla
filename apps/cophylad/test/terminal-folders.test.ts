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
});
