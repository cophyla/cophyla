// The editor opener over a directory of announcements and a fetch that answers from a table:
// no editor is needed, and no terminal is opened. What a real VS Code window does with the
// request is the rehearsal's job.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log.ts";
import { EditorTerminalOpener, readEditors, windowFor } from "../src/sessions/editors.ts";
import type { EditorEntry } from "../src/sessions/editors.ts";

const log = createLogger("error");

function dirWith(entries: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "cophyla-editors-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(entries)) writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return dir;
}

const entry = (over: Partial<EditorEntry> = {}): EditorEntry => ({ pid: 4242, port: 51234, token: "t0ken", folders: ["C:\\D\\app"], name: "app", ...over });

describe("reading what windows announce", () => {
  test("a window that is there is read whole", () => {
    const dir = dirWith({ "4242.json": entry() });
    expect(readEditors(dir, () => true)).toEqual([entry()]);
  });

  test("a window that was killed rather than closed leaves a file, which is swept", () => {
    const dir = dirWith({ "4242.json": entry(), "7.json": entry({ pid: 7 }) });
    expect(readEditors(dir, (pid) => pid === 4242).map((e) => e.pid)).toEqual([4242]);
    // A stale port is worse than none, so the file goes rather than being skipped.
    expect(existsSync(join(dir, "7.json"))).toBe(false);
    expect(existsSync(join(dir, "4242.json"))).toBe(true);
  });

  test("anything that is not an announcement is not one", () => {
    const dir = dirWith({ "4242.json": "{ not json", "notes.txt": "hello", "9.json": { pid: 9, port: "no" } });
    expect(readEditors(dir, () => true)).toEqual([]);
  });

  test("a directory that is not there holds no windows", () => {
    expect(readEditors(join(tmpdir(), "cophyla-editors-missing-" + Math.random()))).toEqual([]);
  });
});

describe("picking the window the work belongs to", () => {
  const outer = entry({ pid: 1, folders: ["C:\\D"] });
  const inner = entry({ pid: 2, folders: ["C:\\D\\app"] });
  const other = entry({ pid: 3, folders: ["C:\\elsewhere"] });

  test("the window holding it in the deepest folder wins", () => {
    expect(windowFor([outer, inner, other], "C:\\D\\app\\src")?.pid).toBe(2);
    expect(windowFor([inner, outer], "C:\\D\\app\\src")?.pid).toBe(2);
  });

  test("the directory itself counts as held", () => {
    expect(windowFor([inner], "C:\\D\\app")?.pid).toBe(2);
  });

  test("no window holding it means no window is asked", () => {
    expect(windowFor([other], "C:\\D\\app")).toBeUndefined();
    expect(windowFor([], "C:\\D\\app")).toBeUndefined();
    // A sibling whose name merely starts the same is not a parent.
    expect(windowFor([entry({ folders: ["C:\\D\\app-other"] })], "C:\\D\\app")).toBeUndefined();
  });
});

describe("asking a window", () => {
  const request = { argv: ["claude", "--session-id", "abc"], cwd: "C:\\D\\app", env: { CLAUDE_CONFIG_DIR: "C:\\c" }, title: "fix the build" };

  test("the command goes to the window that has it open, with its token", async () => {
    const dir = dirWith({ "4242.json": entry() });
    const calls: { url: string; init: RequestInit }[] = [];
    const opener = new EditorTerminalOpener({
      dir,
      log,
      isAlive: () => true,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response("ok", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await opener.available()).toBe(true);
    await opener.open(request);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:51234/terminal");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer t0ken");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(request);
  });

  test("no window with it open is not this opener's to answer", async () => {
    const dir = dirWith({ "4242.json": entry({ folders: ["C:\\elsewhere"] }) });
    const opener = new EditorTerminalOpener({ dir, log, isAlive: () => true, fetch: (async () => new Response("ok")) as unknown as typeof fetch });
    // It is available — a window is listening — and refuses this one, so the next opener answers.
    expect(await opener.available()).toBe(true);
    await expect(opener.open(request)).rejects.toThrow("no editor window has C:\\D\\app open");
  });

  test("a window that refuses says so", async () => {
    const dir = dirWith({ "4242.json": entry() });
    const opener = new EditorTerminalOpener({ dir, log, isAlive: () => true, fetch: (async () => new Response("bad token", { status: 401 })) as unknown as typeof fetch });
    await expect(opener.open(request)).rejects.toThrow("401");
  });

  test("no window listening at all", async () => {
    const dir = dirWith({});
    const opener = new EditorTerminalOpener({ dir, log, isAlive: () => true });
    expect(await opener.available()).toBe(false);
  });
});
