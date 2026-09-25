// The editable layer: `~/.cophyla` watched and reloaded. A scan diffs each area against its
// last snapshot and acts on what moved: a tool file is imported afresh and registered, a
// broken one leaves the tool it replaced in place and is reported as a problem beside the
// file's name; a hook file is loaded or unloaded, its events entering the catalogue; a prompt
// file's change is announced; a memory file's change is reindexed for recall and announced;
// a view whose files changed is announced to the clients. Each area sends one notice per
// scan: `tools.changed`, `events.changed`, `prompts.changed`, `memory.changed` (to the brain)
// and `view.changed {id}` (to the clients). The first scan at start is silent: nothing has
// changed yet, the brain asks for its lists at the handshake. Scans are serialised; the
// watcher and the safety poll both call `rescan`, and so do the tests, which need no timer.

import type { Memory } from "@cophyla/protocol";
import type { EditableProblem } from "@cophyla/protocol";
import { relative } from "node:path";
import type { Bus } from "../bus.ts";
import type { EventCatalogue } from "../events/catalogue.ts";
import type { Logger } from "../log.ts";
import type { Tools } from "../tools/index.ts";
import type { Views } from "../views/index.ts";
import type { Hooks } from "./hooks.ts";
import type { MemoryFiles } from "./memory.ts";
import { describeImportError, ModuleLoader, stemOf } from "./modules.ts";
import { loadTool } from "./tools.ts";
import { diff, DirWatcher, isMarkdownFile, isModuleFile, snapshotFiles, snapshotTree } from "./watcher.ts";
import type { Diff, Snapshot } from "./watcher.ts";

export interface EditablePaths {
  home: string;
  tools: string;
  hooks: string;
  prompts: string;
  memory: string;
  views: string;
}

export interface EditableDeps {
  paths: EditablePaths;
  tools: Tools;
  hooks: Hooks;
  catalogue: EventCatalogue;
  views: Views;
  memory: MemoryFiles;
  /** A memory file changed on disk: the recall index's `reindexMemory`. */
  onMemory: (name: string, memory: Memory | undefined) => void;
  bus: Bus;
  log: Logger;
  /** Milliseconds between safety scans; 0 turns the poll off. */
  pollMs: number;
  loader?: ModuleLoader;
  now?: () => number;
  /** Whether hooks run here now: only where the brain runs. Off, every hook is unloaded and none is loaded. */
  hooksActive?: () => boolean;
  /** A file of the editable layer changed or went, relative to the home: what a backup is sent. */
  onFile?: (rel: string, kind: "changed" | "removed") => void;
}

export class Editable {
  private deps: EditableDeps;
  private loader: ModuleLoader;
  private watcher: DirWatcher;
  private toolsSnap: Snapshot = new Map();
  private hooksSnap: Snapshot = new Map();
  private promptsSnap: Snapshot = new Map();
  private memorySnap: Snapshot = new Map();
  private viewVersions = new Map<string, string>();
  private viewsSnap: Snapshot = new Map();
  /** The tool name each tool file registered, so a rename or a removal unregisters the right one. */
  private toolNames = new Map<string, string>();
  private toolProblems = new Map<string, string>();
  private hookProblems = new Map<string, string>();
  private current?: Promise<void>;
  private pending?: Promise<void>;
  private started = false;

  constructor(deps: EditableDeps) {
    this.deps = deps;
    this.loader = deps.loader ?? new ModuleLoader();
    this.watcher = new DirWatcher({
      dirs: () => [deps.paths.tools, deps.paths.hooks, deps.paths.prompts, deps.paths.memory, ...deps.views.watchDirs()],
      onChange: () => void this.rescan(),
      log: deps.log,
      pollMs: deps.pollMs,
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Loads everything once, silently, then watches. */
  async start(): Promise<void> {
    await this.scan(false);
    this.started = true;
    this.watcher.start();
  }

  /** Diffs every area and announces what moved. Serialised: a call during a scan runs one more after it. */
  rescan(): Promise<void> {
    if (!this.current) {
      this.current = this.scan(true)
        .catch((e: unknown) => this.deps.log.error("scan failed", { error: e instanceof Error ? e.message : String(e) }))
        .finally(() => {
          this.current = undefined;
        });
      return this.current;
    }
    if (!this.pending) {
      this.pending = this.current.then(() => {
        this.pending = undefined;
        return this.rescan();
      });
    }
    return this.pending;
  }

  /** The files that did not load, tools first, each relative to the home. */
  problems(): EditableProblem[] {
    const out: EditableProblem[] = [];
    for (const map of [this.toolProblems, this.hookProblems]) {
      for (const [file, message] of [...map].sort(([a], [b]) => a.localeCompare(b))) out.push({ file: this.rel(file), message });
    }
    return out;
  }

  private rel(file: string): string {
    return relative(this.deps.paths.home, file).replace(/\\/g, "/");
  }

  private problemsOf(map: Map<string, string>): EditableProblem[] {
    return [...map].sort(([a], [b]) => a.localeCompare(b)).map(([file, message]) => ({ file: this.rel(file), message }));
  }

  private async scan(notify: boolean): Promise<void> {
    await this.scanTools(notify);
    await this.scanHooks(notify);
    this.scanMarkdown(notify);
    this.scanViews(notify);
    if (this.started) this.watcher.refresh();
  }

  private announceFiles(d: Diff): void {
    if (!this.deps.onFile) return;
    for (const file of [...d.added, ...d.changed]) this.deps.onFile(this.rel(file), "changed");
    for (const file of d.removed) this.deps.onFile(this.rel(file), "removed");
  }

  private async scanTools(notify: boolean): Promise<void> {
    const after = snapshotFiles(this.deps.paths.tools, isModuleFile);
    const d = diff(this.toolsSnap, after);
    this.toolsSnap = after;
    if (d.added.length + d.changed.length + d.removed.length === 0) return;
    this.announceFiles(d);
    for (const file of d.removed) {
      this.toolProblems.delete(file);
      const name = this.toolNames.get(file);
      if (name === undefined) continue;
      this.toolNames.delete(file);
      this.deps.tools.unregister(name);
      this.deps.log.info("tool removed", { name, file: this.rel(file) });
    }
    for (const file of [...d.added, ...d.changed].sort()) {
      let mod: Record<string, unknown>;
      try {
        mod = await this.loader.load(file);
      } catch (e) {
        this.problem(this.toolProblems, file, describeImportError(file, e));
        continue;
      }
      const loaded = loadTool(file, mod);
      if ("problem" in loaded) {
        this.problem(this.toolProblems, file, loaded.problem);
        continue;
      }
      const { tool } = loaded;
      const holder = [...this.toolNames].find(([f, n]) => n === tool.name && f !== file)?.[0];
      if (holder !== undefined) {
        this.problem(this.toolProblems, file, `${stemOf(file)}: name ${tool.name} is taken by ${this.rel(holder)}`);
        continue;
      }
      const previous = this.toolNames.get(file);
      if (previous !== undefined && previous !== tool.name) this.deps.tools.unregister(previous);
      let registered: boolean;
      try {
        registered = this.deps.tools.register(tool, "editable");
      } catch (e) {
        this.problem(this.toolProblems, file, `${stemOf(file)}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (!registered) {
        this.problem(this.toolProblems, file, `${stemOf(file)}: name ${tool.name} is built in`);
        continue;
      }
      this.toolProblems.delete(file);
      this.toolNames.set(file, tool.name);
      this.deps.log.info(previous === undefined ? "tool loaded" : "tool reloaded", { name: tool.name, file: this.rel(file), risk: this.deps.tools.risk(tool.name) });
    }
    if (notify) {
      const problems = this.problemsOf(this.toolProblems);
      this.deps.bus.emit("tools.changed", { at: this.now(), ...(problems.length > 0 ? { problems } : {}) });
    }
  }

  private async scanHooks(notify: boolean): Promise<void> {
    const after = snapshotFiles(this.deps.paths.hooks, isModuleFile);
    const active = this.deps.hooksActive?.() ?? true;
    if (!active) {
      // Hooks run only where the brain runs: everything loaded goes, and the files are announced but not loaded.
      const d = diff(this.hooksSnap, after);
      this.announceFiles(d);
      const loaded = [...this.hooksSnap.keys()];
      this.hooksSnap = new Map();
      this.hookProblems.clear();
      if (loaded.length === 0) return;
      await this.deps.catalogue.batch(
        async () => {
          for (const file of loaded) if (await this.deps.hooks.unload(file)) this.deps.log.info("hook unloaded: not the primary", { file: this.rel(file) });
        },
        notify ? { problems: () => [], force: true } : { silent: true },
      );
      return;
    }
    const d = diff(this.hooksSnap, after);
    this.hooksSnap = after;
    if (d.added.length + d.changed.length + d.removed.length === 0) return;
    this.announceFiles(d);
    const work = async () => {
      for (const file of d.removed) {
        this.hookProblems.delete(file);
        if (await this.deps.hooks.unload(file)) this.deps.log.info("hook removed", { file: this.rel(file) });
      }
      for (const file of [...d.added, ...d.changed].sort()) {
        let mod: Record<string, unknown>;
        try {
          mod = await this.loader.load(file);
        } catch (e) {
          this.problem(this.hookProblems, file, describeImportError(file, e));
          continue;
        }
        const loaded = await this.deps.hooks.load(file, mod);
        if ("problem" in loaded) {
          this.problem(this.hookProblems, file, loaded.problem);
          continue;
        }
        this.hookProblems.delete(file);
        this.deps.log.info("hook loaded", { name: loaded.hook.name, file: this.rel(file), events: loaded.hook.events });
      }
    };
    if (notify) await this.deps.catalogue.batch(work, { problems: () => this.problemsOf(this.hookProblems), force: true });
    else await this.deps.catalogue.batch(work, { silent: true });
  }

  private scanMarkdown(notify: boolean): void {
    const prompts = snapshotFiles(this.deps.paths.prompts, isMarkdownFile);
    const pd = diff(this.promptsSnap, prompts);
    this.promptsSnap = prompts;
    this.announceFiles(pd);
    if (notify && pd.added.length + pd.changed.length + pd.removed.length > 0) this.deps.bus.emit("prompts.changed", { at: this.now() });

    const memory = snapshotFiles(this.deps.paths.memory, isMarkdownFile);
    const md = diff(this.memorySnap, memory);
    this.memorySnap = memory;
    if (md.added.length + md.changed.length + md.removed.length === 0) return;
    this.announceFiles(md);
    if (!notify) return;
    for (const file of [...md.added, ...md.changed]) {
      const name = stemOf(file);
      try {
        this.deps.onMemory(name, this.deps.memory.read(name));
      } catch (e) {
        this.deps.log.warn("memory file not reindexed", { file: this.rel(file), error: e instanceof Error ? e.message : String(e) });
      }
    }
    for (const file of md.removed) this.deps.onMemory(stemOf(file), undefined);
    this.deps.bus.emit("memory.changed", { at: this.now() });
  }

  private scanViews(notify: boolean): void {
    const after = this.deps.views.versions();
    const before = this.viewVersions;
    this.viewVersions = after;
    if (this.deps.onFile) {
      const tree = snapshotTree(this.deps.paths.views);
      this.announceFiles(diff(this.viewsSnap, tree));
      this.viewsSnap = tree;
    }
    if (!notify) return;
    for (const [id, version] of after) {
      if (before.get(id) !== version) this.deps.bus.emit("view.changed", { id });
    }
    for (const id of before.keys()) if (!after.has(id)) this.deps.bus.emit("view.changed", { id });
  }

  private problem(map: Map<string, string>, file: string, message: string): void {
    if (map.get(file) !== message) this.deps.log.warn("editable file not loaded", { file: this.rel(file), message });
    map.set(file, message);
  }

  async stop(): Promise<void> {
    this.watcher.stop();
    this.started = false;
    if (this.current) await this.current.catch(() => undefined);
  }
}
