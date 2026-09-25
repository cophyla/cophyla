// `Views`: the view directories the daemon serves through `view.list`, `view.get` and
// `view.setDefault`. Built-in views live in the daemon's own `views/` directory, so every
// host on every machine shows the same ones; the user's live under `~/.cophyla/views`, and a
// user directory named like a built-in view is skipped. Each subdirectory with a valid
// `view.json` whose `id` is the directory's name is a view; the default is remembered in
// `kv` under `views/default`, and moving it raises `view.changed` so a host reloads.
// `versions` is what the editable watcher diffs to notice an edited view.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RpcError, ViewManifest } from "@cophyla/protocol";
import type { ToolSource, ViewContent } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";
import { MANIFEST_FILE, toViewFile, versionOf, walk } from "./files.ts";
import type { Transpile } from "./files.ts";

export const BUILTIN_VIEWS_DIR: string = join(import.meta.dir, "..", "..", "views");

const KV_NS = "views";
const KV_DEFAULT = "default";
const FALLBACK_ID = "default";

const ManifestFile = ViewManifest.pick({ id: true, name: true, entry: true, scopes: true });
type ManifestFile = ReturnType<typeof ManifestFile.parse>;

export interface ViewDir {
  dir: string;
  source: ToolSource;
}

export interface ViewsDeps {
  store: Store;
  log: Logger;
  /** The directories to serve, built-in first; the daemon's own `views/` alone when absent. */
  dirs?: ViewDir[];
  /** Where `view.changed` goes when the default moves. */
  bus?: Bus;
}

interface Found {
  manifest: ManifestFile;
  dir: string;
  source: ToolSource;
}

export class Views {
  private deps: ViewsDeps;
  private dirs: ViewDir[];
  private log: Logger;
  private transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });

  constructor(deps: ViewsDeps) {
    this.deps = deps;
    this.dirs = deps.dirs ?? [{ dir: BUILTIN_VIEWS_DIR, source: "builtin" }];
    this.log = deps.log;
  }

  list(): ViewManifest[] {
    const found = this.scan();
    const def = this.defaultId(found);
    return found.map(({ manifest, dir, source }) => {
      const m: ViewManifest = {
        id: manifest.id,
        name: manifest.name,
        entry: manifest.entry,
        default: manifest.id === def,
        source,
        version: versionOf(walk(dir)),
      };
      if (manifest.scopes !== undefined) m.scopes = manifest.scopes;
      return m;
    });
  }

  /** Every view's version by id: a hash of its files, so an edit anywhere in a view moves it. */
  versions(): Map<string, string> {
    const out = new Map<string, string>();
    for (const { manifest, dir } of this.scan()) out.set(manifest.id, versionOf(walk(dir)));
    return out;
  }

  /** The directories a watcher should watch: every served directory and every view inside it. */
  watchDirs(): string[] {
    const out: string[] = [];
    for (const { dir } of this.dirs) {
      out.push(dir);
      for (const v of this.scan()) if (v.dir.startsWith(dir)) out.push(v.dir);
    }
    return [...new Set(out)];
  }

  get(id: string): ViewContent {
    const view = this.find(id);
    const files = walk(view.dir, { onSkip: (path, reason) => this.log.debug("view file skipped", { view: id, path, reason }) });
    if (!files.some((f) => f.path === view.manifest.entry)) {
      throw new RpcError("not_found", `view ${id}: entry ${view.manifest.entry} is not among its files`);
    }
    return {
      id,
      version: versionOf(files),
      files: files.map((f) => toViewFile(f.path, f.bytes, this.transpile)),
    };
  }

  setDefault(id: string): void {
    this.find(id);
    this.deps.store.kv.put(KV_NS, KV_DEFAULT, id);
    this.deps.bus?.emit("view.changed", { id });
  }

  /** The default view's id, or undefined when there is no view at all. */
  default(): string | undefined {
    return this.defaultId(this.scan());
  }

  private transpile: Transpile = (source, path) => {
    try {
      return this.transpiler.transformSync(source);
    } catch (e) {
      throw new RpcError("invalid", `${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  private find(id: string): Found {
    const view = this.scan().find((v) => v.manifest.id === id);
    if (!view) throw new RpcError("not_found", `no view ${id}`);
    return view;
  }

  private defaultId(found: Found[]): string | undefined {
    const ids = new Set(found.map((v) => v.manifest.id));
    const remembered = this.deps.store.kv.get(KV_NS, KV_DEFAULT);
    if (typeof remembered === "string" && ids.has(remembered)) return remembered;
    if (ids.has(FALLBACK_ID)) return FALLBACK_ID;
    return found[0]?.manifest.id;
  }

  /**
   * Every directory with a valid manifest, sorted by id, the built-in directories scanned
   * first so a user view named like a built-in one is skipped. Invalid ones are logged and
   * left out.
   */
  private scan(): Found[] {
    const out: Found[] = [];
    const seen = new Set<string>();
    for (const { dir: root, source } of this.dirs) {
      for (const found of this.scanDir(root, source)) {
        if (seen.has(found.manifest.id)) {
          this.log.warn("view skipped: a built-in view has its id", { dir: found.dir, id: found.manifest.id });
          continue;
        }
        seen.add(found.manifest.id);
        out.push(found);
      }
    }
    out.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    return out;
  }

  private scanDir(root: string, source: ToolSource): Found[] {
    if (!existsSync(root)) return [];
    const out: Found[] = [];
    for (const name of readdirSync(root).sort()) {
      if (name.startsWith(".")) continue;
      const dir = join(root, name);
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const manifestPath = join(dir, MANIFEST_FILE);
      if (!existsSync(manifestPath)) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch (e) {
        this.log.warn("view manifest is not JSON", { dir, error: e });
        continue;
      }
      const parsed = ManifestFile.safeParse(raw);
      if (!parsed.success) {
        this.log.warn("view manifest is not valid", { dir, issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
        continue;
      }
      const manifest = parsed.data;
      if (manifest.id !== name) {
        this.log.warn("view manifest id does not match its directory", { dir, id: manifest.id });
        continue;
      }
      if (manifest.entry.includes("..") || manifest.entry.startsWith("/") || manifest.entry.includes("\\")) {
        this.log.warn("view entry must be a relative path inside the view", { dir, entry: manifest.entry });
        continue;
      }
      out.push({ manifest, dir, source });
    }
    return out;
  }
}
