// A binary copied into a folder that never moves, under the same name every version: the
// `tether` command in `<root>/bin/`, and cophyla-net beside it, whose one fixed path is what
// a firewall rule names. Windows neither overwrites nor deletes a running executable but
// does rename one: a new version moves the old file aside and takes its name, and what was
// moved aside goes once nothing runs it.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Makes `<dir>/<name>` a copy of `source` when it is not one already, and removes what earlier
 * versions moved aside. Answers whether the file changed.
 */
export function placeBinary(source: string, dir: string, name: string): boolean {
  const ext = name.endsWith(".exe") ? ".exe" : "";
  const base = ext ? name.slice(0, -ext.length) : name;
  const aside = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.old-\\d+${ext.replace(".", "\\.")}$`);
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) {
    if (!aside.test(entry)) continue;
    try {
      rmSync(join(dir, entry));
    } catch {
      // Something still runs it.
    }
  }
  const dest = join(dir, name);
  const content = readFileSync(source);
  try {
    if (readFileSync(dest).equals(content)) return false;
  } catch {
    // Not there yet.
  }
  const tmp = `${dest}.tmp${process.pid}`;
  copyFileSync(source, tmp);
  if (process.platform !== "win32") chmodSync(tmp, 0o755);
  try {
    renameSync(tmp, dest);
    return true;
  } catch (e) {
    if (!existsSync(dest)) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }
  // Something runs the old file: it moves aside, and goes at a later start.
  const moved = join(dir, `${base}.old-${Date.now()}${ext}`);
  try {
    renameSync(dest, moved);
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    if (!existsSync(dest) && existsSync(moved)) renameSync(moved, dest);
    throw e;
  }
  try {
    rmSync(moved);
  } catch {
    // Still running.
  }
  return true;
}
