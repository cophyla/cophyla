// Which node owns a folder: a path inside a lent folder, resolved the way the file system
// resolves it (a junction planted inside, another case, a short 8.3 name, a folder not there
// yet), is the workspace node's; the deepest folder wins; a removed node's id stays private.
// A folder is refused before it is lent when it is the home folder or holds it, holds
// Cophyla's own files or the install, is a drive's root, overlaps another lent folder, or has
// a session of the machine's own running in it.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { newId } from "@cophyla/protocol";
import { Owners } from "../src/nodes/owners.ts";

const WIN = process.platform === "win32";
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** `lent/` the folder lent, `mine/` beside it, a junction inside the one to the other, and a home and a Cophyla home of their own. */
function tree() {
  const root = mkdtempSync(join(tmpdir(), "cophyla-owners-"));
  dirs.push(root);
  const lent = join(root, "work", "lent");
  const mine = join(root, "work", "mine");
  const home = join(root, "home");
  const cophyla = join(home, ".cophyla");
  const install = join(root, "install");
  for (const d of [join(lent, "src"), mine, cophyla, install, join(home, "projects", "p")]) mkdirSync(d, { recursive: true });
  const junction = join(lent, "way-out");
  symlinkSync(mine, junction, WIN ? "junction" : "dir");
  return { root, lent, mine, home, cophyla, install, junction };
}

function shortName(path: string): string | undefined {
  if (!WIN) return undefined;
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-Command", `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${path.replace(/'/g, "''")}').ShortPath`]);
  const out = r.stdout.toString().trim();
  return out && out.toLowerCase() !== path.toLowerCase() && out.includes("~") ? out : undefined;
}

const refusal = (fn: () => unknown): string => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

describe("whose a path is", () => {
  test("inside the lent folder once resolved; the machine's outside it and through a junction out", () => {
    const t = tree();
    const g = newId("node");
    const o = new Owners({ guests: [{ id: g, folder: t.lent }], cophylaHome: t.cophyla, home: t.home });
    expect(o.ownerOf(t.lent)).toBe(g);
    expect(o.ownerOf(join(t.lent, "src"))).toBe(g);
    expect(o.ownerOf(join(t.lent, "not-there-yet", "x.md"))).toBe(g);
    expect(o.ownerOf(t.mine)).toBeUndefined();
    expect(o.ownerOf(join(t.lent, "..", "mine"))).toBeUndefined();
    expect(o.ownerOf(join(t.junction, "x.md"))).toBeUndefined();
    expect(o.ownerOf(`${t.lent}-sibling`)).toBeUndefined();
    expect(o.ownerOf("relative")).toBeUndefined();
    expect(o.ownerOf(undefined)).toBeUndefined();
    expect(o.isGuest(g)).toBe(true);
    expect(o.folderOf(g)?.toLowerCase()).toBe(o.confinement(g)!.roots[0]!.toLowerCase());
    if (WIN) {
      expect(o.ownerOf(join(t.lent.toUpperCase(), "src"))).toBe(g);
      const long = join(t.root, "a folder with a long name");
      mkdirSync(long);
      const short = shortName(long);
      if (short) {
        const h = newId("node");
        const byLong = new Owners({ guests: [{ id: h, folder: long }], cophylaHome: t.cophyla, home: t.home });
        expect(byLong.ownerOf(join(short, "x.md"))).toBe(h);
        const byShort = new Owners({ guests: [{ id: h, folder: short }], cophylaHome: t.cophyla, home: t.home });
        expect(byShort.ownerOf(join(long, "x.md"))).toBe(h);
      }
    }
    // a folder lent through a junction is the folder it leads to
    const viaJunction = new Owners({ guests: [{ id: g, folder: t.junction }], cophylaHome: t.cophyla, home: t.home });
    expect(viaJunction.ownerOf(t.mine)).toBe(g);
    expect(viaJunction.ownerOf(join(t.lent, "src"))).toBeUndefined();
  });

  test("the deepest folder wins", () => {
    const t = tree();
    const outer = newId("node");
    const inner = newId("node");
    const o = new Owners({ guests: [{ id: outer, folder: join(t.root, "work") }, { id: inner, folder: t.lent }], cophylaHome: t.cophyla, home: t.home });
    expect(o.ownerOf(join(t.lent, "src"))).toBe(inner);
    expect(o.ownerOf(t.mine)).toBe(outer);
  });

  test("a removed node's folder is the machine's again, and its id stays private", () => {
    const t = tree();
    const g = newId("node");
    const o = new Owners({ guests: [{ id: g, folder: t.lent }], cophylaHome: t.cophyla, home: t.home });
    expect(o.isPrivate(g)).toBe(true);
    o.retire(g);
    expect(o.ownerOf(join(t.lent, "src"))).toBeUndefined();
    expect(o.isGuest(g)).toBe(false);
    expect(o.isPrivate(g)).toBe(true);
    expect(o.retired()).toEqual([g]);
    expect(o.isPrivate(newId("node"))).toBe(false);
    // and a new start knows it
    expect(new Owners({ retired: [g], cophylaHome: t.cophyla, home: t.home }).isPrivate(g)).toBe(true);
  });
});

describe("what may be lent", () => {
  test("a folder of work, alone; never home, Cophyla's own files, the install, a drive's root, or one overlapping another", () => {
    const t = tree();
    const g = newId("node");
    const o = new Owners({ guests: [{ id: g, folder: t.lent }], cophylaHome: t.cophyla, home: t.home, installRoot: t.install });
    expect(refusal(() => o.check(t.mine))).toBe("ok");
    expect(refusal(() => o.check(join(t.home, "projects", "p")))).toBe("ok");
    expect(refusal(() => o.check("relative/folder"))).toMatch(/full path/);
    expect(refusal(() => o.check(join(t.root, "not-there")))).toMatch(/no folder/);
    expect(refusal(() => o.check(parse(t.root).root))).toMatch(/drive's root/);
    expect(refusal(() => o.check(t.home))).toMatch(/home folder or holds it/);
    expect(refusal(() => o.check(t.root))).toMatch(/home folder or holds it/);
    expect(refusal(() => o.check(t.cophyla))).toMatch(/Cophyla's own files/);
    expect(refusal(() => o.check(join(t.cophyla)))).toMatch(/Cophyla's own files/);
    expect(refusal(() => o.check(t.install))).toMatch(/install/);
    expect(refusal(() => o.check(t.lent))).toMatch(/overlaps/);
    expect(refusal(() => o.check(join(t.lent, "src")))).toMatch(/overlaps/);
    expect(refusal(() => o.check(join(t.root, "work")))).toMatch(/overlaps/);
    // its own folder, for the node itself
    expect(refusal(() => o.check(t.lent, { except: g }))).toBe("ok");
    // a junction to a folder already lent is that folder
    const other = join(t.root, "elsewhere");
    mkdirSync(other);
    symlinkSync(t.lent, join(other, "to-lent"), WIN ? "junction" : "dir");
    expect(refusal(() => o.check(join(other, "to-lent")))).toMatch(/overlaps/);
    if (WIN) expect(refusal(() => o.check(t.lent.toUpperCase()))).toMatch(/overlaps/);
  });

  test("a folder with the machine's own sessions running in it is refused until they end", () => {
    const t = tree();
    const o = new Owners({ cophylaHome: t.cophyla, home: t.home });
    const cwds = [join(t.mine, "deep"), t.lent];
    const count = (inside: (path: string) => boolean) => cwds.filter(inside).length;
    expect(refusal(() => o.check(t.mine, { machineSessionsIn: count }))).toMatch(/a session of yours runs in .*end it first/);
    cwds.push(join(t.mine, "other"));
    expect(refusal(() => o.check(t.mine, { machineSessionsIn: count }))).toMatch(/2 sessions of yours run/);
    expect(refusal(() => o.check(join(t.lent, "src"), { machineSessionsIn: count }))).toBe("ok");
  });
});
