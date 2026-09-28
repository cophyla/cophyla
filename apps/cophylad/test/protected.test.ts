// macOS's protected folders (Desktop, Documents, Downloads, iCloud Drive, volumes): the first
// read of each is made off the thread and nothing reads one synchronously before it settles, so
// a permission prompt nobody has answered holds no client, hook or ask. A session met in one
// is listed at once and gets its workspace when the folder settles; off macOS nothing waits.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@cophyla/protocol";
import type { Workspace } from "@cophyla/protocol";
import { Bus } from "../src/bus.ts";
import { NotSettled, ProtectedFolders } from "../src/sessions/protected.ts";
import { Store } from "../src/store/index.ts";
import { Workspaces } from "../src/workspaces/index.ts";
import { miniSessions, tempHome, waitFor } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

/** A first read the test lets go of: `release()` answers every folder asked so far. */
function heldReads() {
  const asked: string[] = [];
  const waiting: (() => void)[] = [];
  return {
    asked,
    firstRead: (dir: string) => {
      asked.push(dir);
      return new Promise<void>((resolve) => waiting.push(resolve));
    },
    release: () => {
      for (const r of waiting.splice(0)) r();
    },
  };
}

describe("protected folders", () => {
  test("off macOS nothing is protected and nothing is read first", async () => {
    const reads = heldReads();
    const g = new ProtectedFolders({ platform: "linux", home: "/home/u", firstRead: reads.firstRead });
    expect(g.rootOf("/home/u/Desktop/x")).toBeUndefined();
    expect(g.settled("/home/u/Desktop/x")).toBe(true);
    await g.settle("/home/u/Documents");
    expect(reads.asked).toEqual([]);
  });

  // macOS's paths as literals, which a Windows runner resolves onto its own drive
  test.skipIf(process.platform === "win32")("macOS: the home's four and every volume; a folder's first read is made once, and it settles either way", async () => {
    const reads = heldReads();
    const g = new ProtectedFolders({ platform: "darwin", home: "/Users/u", firstRead: reads.firstRead });
    expect(g.rootOf("/Users/u/Desktop/proj/src")).toBe("/Users/u/Desktop");
    expect(g.rootOf("/Users/u/Documents")).toBe("/Users/u/Documents");
    expect(g.rootOf("/Users/u/Downloads/a b")).toBe("/Users/u/Downloads");
    expect(g.rootOf("/Users/u/Library/Mobile Documents/com~apple~CloudDocs/x")).toBe("/Users/u/Library/Mobile Documents");
    expect(g.rootOf("/Volumes/USB/work")).toBe("/Volumes/USB");
    expect(g.rootOf("/Users/u/code/proj")).toBeUndefined();
    expect(g.rootOf("/Users/u/DesktopNotes")).toBeUndefined();
    expect(g.settled("/Users/u/code/proj")).toBe(true);

    const settledRoots: string[] = [];
    g.onSettled((root) => settledRoots.push(root));
    expect(g.settled("/Users/u/Desktop/a")).toBe(false);
    expect(g.settled("/Users/u/Desktop/b")).toBe(false);
    const waiting = g.settle("/Users/u/Desktop/c");
    expect(reads.asked).toEqual(["/Users/u/Desktop"]);
    reads.release();
    await waiting;
    expect(g.settled("/Users/u/Desktop/a")).toBe(true);
    expect(settledRoots).toEqual(["/Users/u/Desktop"]);

    // refused (EPERM): settled all the same, a synchronous read fails at once now
    const refused = new ProtectedFolders({ platform: "darwin", home: "/Users/u", firstRead: () => Promise.reject(Object.assign(new Error("EPERM"), { code: "EPERM" })) });
    await refused.settle("/Users/u/Downloads/x");
    expect(refused.settled("/Users/u/Downloads/x")).toBe(true);
  });

  test("a workspace is not looked up in a folder that has not settled; it is once it has", async () => {
    const home = realpathSync(tempHome());
    const desk = join(home, "Desktop", "proj");
    mkdirSync(join(desk, ".git"), { recursive: true });
    const reads = heldReads();
    const guard = new ProtectedFolders({ platform: "darwin", home, firstRead: reads.firstRead });
    const store = new Store(":memory:");
    store.migrate();
    const ws = new Workspaces({ store, nodeId: newId("node"), bus: new Bus(), guard });
    expect(() => ws.fromSession(desk)).toThrow(NotSettled);
    reads.release();
    await ws.settle(desk);
    const w: Workspace = ws.fromSession(desk);
    expect(w.path).toBe(desk);
    ws.dispose();
    store.close();
  });
});

describe("a session in a folder macOS has not been asked about", () => {
  let mini: Mini | undefined;
  afterEach(async () => {
    await mini?.stop();
    mini = undefined;
  });

  test("is listed at once and gets its workspace when the folder settles, without counting as activity", async () => {
    const reads = heldReads();
    const userHome = realpathSync(tempHome());
    const guard = new ProtectedFolders({ platform: "darwin", home: userHome, firstRead: reads.firstRead });
    mini = await miniSessions("", () => [], { guard });
    const cwd = join(userHome, "Desktop", "claude");
    mkdirSync(cwd, { recursive: true });
    const profile = newId("profile");
    const rec = mini.sessions.ensure({ harness: "claude", nativeId: "native-1", profile, cwd, transport: "pipe", pid: 4242 });
    expect(rec.session.workspace).toBeUndefined();
    const before = rec.session.lastActivity;
    expect(reads.asked).toEqual([join(userHome, "Desktop")]);
    reads.release();
    await waitFor(() => mini!.store.sessions.get(rec.session.id)?.workspace);
    const workspace = mini.workspaces.get(mini.store.sessions.get(rec.session.id)!.workspace!);
    expect(workspace?.path).toBe(cwd);
    expect(mini.store.sessions.get(rec.session.id)!.lastActivity).toBe(before);
  });
});
