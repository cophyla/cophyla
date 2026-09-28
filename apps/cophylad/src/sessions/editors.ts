// The editor opener: a session's terminal opened in a VS Code window, beside the user's own.
//
// Nothing in VS Code can be driven from outside it — its command line opens files and manages
// extensions and nothing else, and the channel the `code` CLI uses to reach a running window
// carries no command of any kind. A terminal in the panel is `window.createTerminal`, which
// only an extension can call. So the daemon does not reach into the editor; the editor
// announces itself, the same way a harness announces its sessions. The extension writes
// `<home>/editors/<pid>.json` with the port it is listening on, a token, and the folders its
// window has open, and takes the file away when the window closes. This module reads that
// directory, picks the window the work belongs to, and asks it.
//
// Which window: the one whose folders contain the session's directory, deepest folder first,
// so a window opened on a subdirectory is preferred to one opened on everything above it. No
// window has it open and no window is asked — a terminal in an unrelated project is worse
// than a terminal of the platform's own, which is what answers next.
//
// Raising a session that runs in an editor's terminal goes through the same door: the process
// tree ends at the editor's app, and raising the app brings its front window, not the one the
// session is in, nor its tab. So every window is asked whether one of its terminals runs a
// process of the session's chain (`/focus`); the one that does shows that terminal and brings
// itself forward, and the platform's raiser then brings the app. A window whose extension
// predates `/focus` answers 404, which reads as "not mine".

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log.ts";
import type { WindowRaiser } from "./focus.ts";
import { isWithin } from "./paths.ts";
import type { TerminalOpener, TerminalRequest } from "./terminals.ts";

/** What an editor window writes about itself. */
export interface EditorEntry {
  pid: number;
  port: number;
  token: string;
  /** The workspace folders the window has open. */
  folders: string[];
  /** What to call it in a log line. */
  name?: string;
}

export type IsAlive = (pid: number) => boolean;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readEntry(path: string): EditorEntry | undefined {
  try {
    const d = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const { pid, port, token } = d;
    if (typeof pid !== "number" || typeof port !== "number" || typeof token !== "string") return undefined;
    const folders = Array.isArray(d["folders"]) ? d["folders"].filter((f): f is string => typeof f === "string") : [];
    return { pid, port, token, folders, ...(typeof d["name"] === "string" ? { name: d["name"] } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * Every window announcing itself, the dead ones swept as they are met: an editor that was
 * killed rather than closed leaves its file behind, and a stale port is worse than none.
 */
export function readEditors(dir: string, isAlive: IsAlive = alive): EditorEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: EditorEntry[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const path = join(dir, name);
    const entry = readEntry(path);
    if (!entry || !isAlive(entry.pid)) {
      try {
        rmSync(path);
      } catch {
        // Another daemon got there first, or it is not ours to remove.
      }
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** The window a directory belongs to: the one holding it in the deepest folder; none holds it, none is picked. */
export function windowFor(editors: readonly EditorEntry[], cwd: string): EditorEntry | undefined {
  let best: { editor: EditorEntry; depth: number } | undefined;
  for (const editor of editors) {
    for (const folder of editor.folders) {
      if (!isWithin(cwd, folder)) continue;
      const depth = folder.length;
      if (!best || depth > best.depth) best = { editor, depth };
    }
  }
  return best?.editor;
}

export interface EditorTerminalOptions {
  /** `<home>/editors`, where windows announce themselves. */
  dir: string;
  log: Logger;
  isAlive?: IsAlive;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** A terminal in the panel of the VS Code window the work belongs to. */
export class EditorTerminalOpener implements TerminalOpener {
  readonly kind = "vscode" as const;
  private opts: EditorTerminalOptions;
  private fetch: typeof globalThis.fetch;

  constructor(opts: EditorTerminalOptions) {
    this.opts = opts;
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  /** A window is listening at all; whether it is the right one is settled when the request is made. */
  async available(): Promise<boolean> {
    return readEditors(this.opts.dir, this.opts.isAlive).length > 0;
  }

  async open(req: TerminalRequest): Promise<void> {
    const editors = readEditors(this.opts.dir, this.opts.isAlive);
    const editor = windowFor(editors, req.cwd);
    if (!editor) throw new Error(`no editor window has ${req.cwd} open`);
    const res = await this.fetch(`http://127.0.0.1:${editor.port}/terminal`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${editor.token}` },
      body: JSON.stringify({ argv: req.argv, cwd: req.cwd, env: req.env, title: req.title }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
    });
    if (!res.ok) throw new Error(`editor window ${editor.name ?? editor.pid} refused: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    this.opts.log.info("terminal opened in an editor window", { window: editor.name ?? String(editor.pid), cwd: req.cwd });
  }
}

export interface EditorFocusOptions {
  /** `<home>/editors`, where windows announce themselves. */
  dir: string;
  log: Logger;
  isAlive?: IsAlive;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Asks every window whether one of its terminals runs one of `pids`; true once the one that does has shown it. */
export async function focusInEditors(pids: number[], opts: EditorFocusOptions): Promise<boolean> {
  const editors = readEditors(opts.dir, opts.isAlive);
  if (editors.length === 0 || pids.length === 0) return false;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const asked = await Promise.all(
    editors.map(async (editor) => {
      try {
        const res = await doFetch(`http://127.0.0.1:${editor.port}/focus`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${editor.token}` },
          body: JSON.stringify({ pids }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
        });
        if (!res.ok) return false;
        const body = (await res.json().catch(() => undefined)) as { focused?: unknown } | undefined;
        if (body?.focused !== true) return false;
        opts.log.info("session shown in an editor window", { window: editor.name ?? String(editor.pid) });
        return true;
      } catch {
        return false;
      }
    }),
  );
  return asked.some(Boolean);
}

/**
 * A raiser that tries the editor windows first: the session's chain goes to every window, the
 * one whose terminal runs it shows it, and the platform's raiser then brings the app forward
 * (its answer no longer matters: the window has been asked to come forward itself).
 */
export function withEditorWindows(raiser: WindowRaiser, opts: EditorFocusOptions): WindowRaiser {
  return {
    ancestors: (pid) => raiser.ancestors(pid),
    ...(raiser.ancestorsOf ? { ancestorsOf: (pids: number[]) => raiser.ancestorsOf!(pids) } : {}),
    commandLine: (pid) => raiser.commandLine(pid),
    async raise(pid) {
      if (readEditors(opts.dir, opts.isAlive).length > 0) {
        const chain = await raiser.ancestors(pid).catch(() => []);
        const pids = chain.length > 0 ? chain.map((p) => p.pid) : [pid];
        if (await focusInEditors(pids, opts)) {
          await raiser.raise(pid).catch(() => "not_found");
          return "raised";
        }
      }
      return raiser.raise(pid);
    },
  };
}
