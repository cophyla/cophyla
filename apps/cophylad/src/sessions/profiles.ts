// Harness profiles: the discovered installation of each harness (its own directory, and the
// one the daemon's environment names when that is another) plus the ones the user declared in
// config. A Muse installation is its two homes, `<XDG_CONFIG_HOME>/muse` (the profile's
// directory, with its login) and `<XDG_DATA_HOME>/muse` (its sessions), so a declared one sets
// `XDG_CONFIG_HOME` from its directory and names `XDG_DATA_HOME` in its env. Profiles are not a
// table; discovery rebuilds them from files at start, at every `profile.list`, and when a login
// file changes: `check` stats each installation's directory and login file, a few calls apiece,
// and rebuilds only when one of them moved. Whoever listens hears what changed, so a harness
// installed or first signed in after the daemon started gets its hooks and its host without a
// restart.
// Their ids are stable across restarts because sessions reference them: the `profiles`
// namespace in `kv` maps `<harness>:<configDir>` to a `prof_` id, minted once.
//
// Each harness has a usual account on the node, the profile a session cophylad starts runs under
// when none is named: the one the user picked in the app, else `default = true` in config,
// else the profile of the user's own latest session of that harness here, else the
// discovered one, else the first. A Claude profile also has a launch, what cophylad starts its
// sessions with: what the user set in the app, else `[[profiles]].args`, else the flags of
// the user's own last session under it (`launch-args.ts`). Both are worked out when asked,
// so they follow what the user does without a restart.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { newId, RpcError } from "@cophyla/protocol";
import type { DefaultBy, HarnessKind, HarnessProfile, LaunchMode, NodeId, ProfileLaunch, ProfileStatus } from "@cophyla/protocol";
import type { Config, ProfileConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";
import { isClaudeHome } from "./claude/start.ts";
import { launchProblem, splitMode } from "./claude/launch-args.ts";
import type { Launch } from "./claude/launch-args.ts";
import { isWithin, pathKey } from "./paths.ts";

export type ProfileHarness = "claude" | "codex" | "muse";
export type HooksMode = "http" | "command";

export interface ProfilesDeps {
  store: Store;
  nodeId: NodeId;
  config: Config;
  log: Logger;
  /** Overrides for tests: the home directory and the environment discovery reads. */
  home?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Whether the macOS Keychain holds a generic password under a service name; asked on darwin only. */
  keychainHas?: (service: string) => boolean;
}

const KV_NS = "profiles";
/** `<harness>` → the profile the user picked in the app as its usual account. */
export const KV_USUAL = "profiles.usual";
/** `<profile id>` → the launch the user set in the app: `{mode?, args}`. */
export const KV_LAUNCH = "profiles.launch";
/** `<profile id>` → the launch of the user's own last session under it: `{mode?, args, at, session}`. */
export const KV_MIRROR = "profiles.mirror";
/** Every kv namespace that is this node's own: profile ids and what hangs off them mean nothing on another machine. */
export const PROFILE_KV_NS = [KV_NS, KV_USUAL, KV_LAUNCH, KV_MIRROR];

/** Where Claude Code keeps its OAuth credentials on macOS, instead of `.credentials.json`. */
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * The Keychain items a Claude login under a directory may be kept in. Claude Code (2.1.28x)
 * names the item `Claude Code-credentials` while CLAUDE_CONFIG_DIR is unset, and otherwise
 * appends `-` and the first 8 hex digits of the variable's SHA-256, taken of its value as set
 * (NFC, not resolved): the value the user's shell set is not known here, so the directory as
 * configured and as resolved, with and without a trailing slash, are each asked. Claude's own
 * `~/.claude` is also the unset name.
 */
export function claudeKeychainServices(configured: string, resolved: string, home: boolean): string[] {
  const values = new Set([configured, resolved, resolved.replace(/\/+$/, "") + "/"].map((v) => v.normalize("NFC")));
  const hashed = [...values].map((v) => `${CLAUDE_KEYCHAIN_SERVICE}-${createHash("sha256").update(v).digest("hex").slice(0, 8)}`);
  return home ? [CLAUDE_KEYCHAIN_SERVICE, ...hashed] : hashed;
}

/**
 * `security find-generic-password -s <service>` exits 0 when an item exists: metadata only,
 * no `-w`, so the keychain is never asked to reveal the secret and never prompts.
 */
export function keychainHas(service: string): boolean {
  try {
    return spawnSync("security", ["find-generic-password", "-s", service], { stdio: "ignore", timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/**
 * macOS: the text of the Keychain item a Claude login under `configDir` is kept in, read with
 * `security … -w` as Claude Code reads it (the item's access list trusts `/usr/bin/security`,
 * so it never prompts); undefined when there is none. The text is a secret: never logged.
 */
export async function claudeKeychainSecret(configDir: string, home = homedir()): Promise<string | undefined> {
  for (const service of claudeKeychainServices(configDir, configDir, isClaudeHome(configDir, home))) {
    const proc = Bun.spawn(["/usr/bin/security", "find-generic-password", "-w", "-s", service], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 5000);
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    if (code === 0 && text.trim()) return text.trim();
  }
  return undefined;
}

/** The directory as a key: resolved, and case-folded where the filesystem is (`pathKey`). */
export function profileKey(harness: ProfileHarness, configDir: string): string {
  return `${harness}:${pathKey(configDir)}`;
}

/**
 * The global config Claude reads under a directory: `~/.claude.json` for its own
 * `~/.claude` (CLAUDE_CONFIG_DIR unset), `<dir>/.claude.json` for any other.
 */
export function claudeGlobalConfig(configDir: string, home: string): string {
  return isClaudeHome(configDir, home) ? join(home, ".claude.json") : join(configDir, ".claude.json");
}

/** `hasCompletedOnboarding` in a global config, cached by the file's size and time: the file can run to megabytes. */
const onboardedCache = new Map<string, { size: number; mtimeMs: number; onboarded: boolean }>();
function onboarded(path: string): boolean {
  let st: { size: number; mtimeMs: number };
  try {
    st = statSync(path);
  } catch {
    return false;
  }
  const hit = onboardedCache.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.onboarded;
  let value = false;
  try {
    value = (JSON.parse(readFileSync(path, "utf8")) as { hasCompletedOnboarding?: unknown }).hasCompletedOnboarding === true;
  } catch {
    // Unreadable or mid-write: not onboarded as far as can be told.
  }
  onboardedCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, onboarded: value });
  return value;
}

/**
 * A login, and a global config that went through Claude's first run: without one, the CLI
 * shows its login screen whatever credentials it has.
 */
function claudeStatus(dir: string, home: string, env: Record<string, string | undefined>, keychain: (() => boolean) | undefined): ProfileStatus {
  if (!existsSync(dir)) return "missing";
  const login = existsSync(join(dir, ".credentials.json")) || !!env["ANTHROPIC_API_KEY"] || !!env["CLAUDE_CODE_OAUTH_TOKEN"] || keychain?.() === true;
  return login && onboarded(claudeGlobalConfig(dir, home)) ? "ok" : "unauthenticated";
}

function codexStatus(dir: string, env: Record<string, string | undefined>): ProfileStatus {
  if (!existsSync(dir)) return "missing";
  if (existsSync(join(dir, "auth.json")) || env["OPENAI_API_KEY"]) return "ok";
  return "unauthenticated";
}

/** A Meta login in `auth.json`: the provider's entry is looked for, and what it holds is never read. */
function museStatus(dir: string): ProfileStatus {
  if (!existsSync(dir)) return "missing";
  try {
    const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")) as { providers?: Record<string, unknown> };
    if (auth.providers && typeof auth.providers === "object" && "meta" in auth.providers) return "ok";
  } catch {
    // no login yet, or one mid-write
  }
  return "unauthenticated";
}

/** Where Muse keeps a login's configuration: `<XDG_CONFIG_HOME>/muse`, `~/.config/muse` by default. */
export function museConfigDir(home: string, env: Record<string, string | undefined>): string {
  return join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "muse");
}

/** What changed between two rebuilds. */
export interface ProfileChange {
  added: HarnessProfile[];
  removed: HarnessProfile[];
  status: { id: string; from: ProfileStatus; to: ProfileStatus }[];
  /** Codex and Muse profiles whose `auth.json` changed: a new login, which an app-server or a `muse serve` started before it does not hold. */
  login: string[];
}

/** An installation as discovery or config names it, before it is built. */
interface Candidate {
  harness: ProfileHarness;
  pc: ProfileConfig;
  origin: HarnessProfile["origin"];
}

/**
 * What a login changes on disk for one installation: whether its directory is there, and the
 * time and size of its login file. Claude's global config counts only while the profile is not
 * signed in, since a running session rewrites it all the time.
 */
interface Stamp {
  key: string;
  dir: boolean;
  login: string;
  global?: string;
}

function statOf(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
}

/** A profile as discovery and config make it, before the usual account and the launch are worked out. */
interface Entry {
  profile: HarnessProfile;
  /** `default = true` in config. */
  configDefault: boolean;
  /** `[[profiles]].args`. */
  configArgs: string[];
}

/** What `profile.update` changes; `null` hands a setting back to cophylad. */
export interface ProfilePatch {
  usual?: boolean | null;
  launch?: { mode?: LaunchMode; args: string[] } | null;
}

/** A mirrored launch as kv keeps it. */
interface Mirror {
  mode?: LaunchMode;
  args: string[];
  at: number;
  session: string;
}

function isMirror(v: unknown): v is Mirror {
  const m = v as Mirror | undefined;
  return !!m && typeof m === "object" && Array.isArray(m.args) && typeof m.at === "number";
}

function isLaunch(v: unknown): v is Launch {
  const l = v as Launch | undefined;
  return !!l && typeof l === "object" && Array.isArray(l.args) && l.args.every((a) => typeof a === "string");
}

export class Profiles {
  private deps: ProfilesDeps;
  private entries: Entry[] = [];
  private modes = new Map<string, HooksMode>();
  /** Each installation's stamp at the last rebuild, and all of them as `check` compares them. */
  private stamps = new Map<string, Stamp>();
  private print = "";
  private built = false;
  private listeners = new Set<(change: ProfileChange) => void>();

  constructor(deps: ProfilesDeps) {
    this.deps = deps;
    this.refresh();
  }

  private get home(): string {
    return this.deps.home ?? homedir();
  }

  /** Called with what changed, whenever a rebuild changed something. */
  onChange(fn: (change: ProfileChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Rebuilds the list when an installation's directory or login file changed since the last
   * rebuild, and otherwise reads nothing but their stats: cheap enough for every few seconds.
   */
  check(): void {
    if (this.printOf(this.stampAll(this.candidates())) !== this.print) this.refresh();
  }

  /** Rebuilds the list: discovered installations first, then config, with config winning on a shared directory. */
  refresh(): void {
    const env = this.deps.env ?? process.env;
    const candidates = this.candidates();
    // Stamped before anything is read: a file that changes during the read moves the next check.
    const stamps = this.stampAll(candidates);
    const out = new Map<string, Entry>();
    const modes = new Map<string, HooksMode>();
    for (const c of candidates) {
      const e = this.build(c.harness, c.pc, c.origin, env);
      out.set(profileKey(c.harness, c.pc.config_dir), e);
      modes.set(e.profile.id, c.origin === "user" ? c.pc.hooks : "http");
    }
    const before = this.entries;
    const stampsBefore = this.stamps;
    this.entries = [...out.values()];
    this.modes = modes;
    this.stamps = stamps;
    this.print = this.printOf(stamps);
    this.deps.log.debug("profiles", { profiles: this.entries.map(({ profile: p }) => ({ id: p.id, harness: p.harness, name: p.name, dir: p.configDir, status: p.status })) });
    if (!this.built) {
      this.built = true;
      return;
    }
    const change = this.diff(before, stampsBefore);
    if (change.added.length + change.removed.length + change.status.length + change.login.length === 0) return;
    this.deps.log.info("profile changed", {
      ...(change.added.length ? { added: change.added.map((p) => p.id) } : {}),
      ...(change.removed.length ? { removed: change.removed.map((p) => p.id) } : {}),
      ...(change.status.length ? { status: change.status } : {}),
      ...(change.login.length ? { login: change.login } : {}),
    });
    for (const fn of this.listeners) {
      try {
        fn(change);
      } catch (e) {
        this.deps.log.warn("a profile listener failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /** What changed from the entries and stamps before this rebuild to the ones now. */
  private diff(before: Entry[], stampsBefore: Map<string, Stamp>): ProfileChange {
    const was = new Map(before.map((e) => [e.profile.id, e.profile]));
    const now = new Map(this.entries.map((e) => [e.profile.id, e.profile]));
    const change: ProfileChange = { added: [], removed: [], status: [], login: [] };
    for (const [id, p] of now) {
      const old = was.get(id);
      if (!old) {
        change.added.push(p);
        continue;
      }
      if (old.status !== p.status) change.status.push({ id, from: old.status, to: p.status });
      if (p.harness !== "codex" && p.harness !== "muse") continue;
      const key = profileKey(p.harness, p.configDir);
      const a = stampsBefore.get(key);
      const b = this.stamps.get(key);
      if (a && b && a.login !== b.login) change.login.push(id);
    }
    for (const [id, p] of was) if (!now.has(id)) change.removed.push(p);
    return change;
  }

  /** The installations discovery and config name, discovered ones first. */
  private candidates(): Candidate[] {
    const { config } = this.deps;
    const env = this.deps.env ?? process.env;
    const out: Candidate[] = [];
    if (config.sessions.discover) {
      // The harness's own directory always, so a daemon launched from a shell that points
      // CLAUDE_CONFIG_DIR elsewhere neither loses the installation every other shell uses nor
      // leaves the hooks it once installed there behind with a token this daemon will refuse.
      // The directory the environment names is a second installation when it is another.
      const found: [ProfileHarness, string, string][] = [
        ["claude", join(this.home, ".claude"), "default"],
        ["codex", join(this.home, ".codex"), "default"],
        ["muse", museConfigDir(this.home, env), "default"],
      ];
      for (const [harness, named] of [
        ["claude", env["CLAUDE_CONFIG_DIR"]],
        ["codex", env["CODEX_HOME"]],
      ] as const) {
        if (named && !found.some(([h, dir]) => h === harness && profileKey(h, dir) === profileKey(h, named))) found.push([harness, named, basename(resolve(named)) || "env"]);
      }
      for (const [harness, dir, name] of found) out.push({ harness, pc: { name, config_dir: dir, args: [], env: {}, default: false, hooks: "http", harness }, origin: "discovered" });
    }
    for (const pc of config.profiles) out.push({ harness: pc.harness, pc, origin: "user" });
    return out;
  }

  /** Each installation's stamp, by its key: three `stat` calls for a Claude one, two for Codex or Muse. */
  private stampAll(candidates: Candidate[]): Map<string, Stamp> {
    const out = new Map<string, Stamp>();
    for (const { harness, pc } of candidates) {
      const dir = resolve(pc.config_dir);
      const key = profileKey(harness, dir);
      const there = existsSync(dir);
      out.set(key, harness !== "claude" ? { key, dir: there, login: statOf(join(dir, "auth.json")) } : { key, dir: there, login: statOf(join(dir, ".credentials.json")), global: statOf(claudeGlobalConfig(dir, this.home)) });
    }
    return out;
  }

  /** The stamps as one string, a Claude profile's global config left out once it is signed in. */
  private printOf(stamps: Map<string, Stamp>): string {
    const status = new Map(this.entries.map((e) => [profileKey(e.profile.harness as ProfileHarness, e.profile.configDir), e.profile.status]));
    return [...stamps.values()].map((s) => [s.key, s.dir ? 1 : 0, s.login, s.global !== undefined && status.get(s.key) !== "ok" ? s.global : ""].join("|")).join(";");
  }

  private build(harness: ProfileHarness, pc: ProfileConfig, origin: HarnessProfile["origin"], env: Record<string, string | undefined>): Entry {
    const configDir = resolve(pc.config_dir);
    // A declared directory is named to the harness, but Claude's own `~/.claude` only by leaving
    // the variable unset (`claudeEnv`), and Muse's by the XDG home it sits in.
    const named = harness !== "claude" || !isClaudeHome(configDir, this.home);
    const dirVar: Record<ProfileHarness, { key: string; value: string }> = {
      claude: { key: "CLAUDE_CONFIG_DIR", value: configDir },
      codex: { key: "CODEX_HOME", value: configDir },
      muse: { key: "XDG_CONFIG_HOME", value: dirname(configDir) },
    };
    const p: HarnessProfile = {
      id: this.stableId(harness, configDir),
      node: this.deps.nodeId,
      harness,
      name: pc.name,
      configDir,
      env: origin === "user" && named ? { [dirVar[harness].key]: dirVar[harness].value, ...pc.env } : { ...pc.env },
      origin,
      status: harness === "claude" ? claudeStatus(configDir, this.home, env, this.keychain(pc.config_dir, configDir)) : harness === "codex" ? codexStatus(configDir, env) : museStatus(configDir),
    };
    if (pc.command !== undefined) p.exec = { command: pc.command, args: pc.args };
    return { profile: p, configDefault: pc.default, configArgs: [...pc.args] };
  }

  /**
   * The Keychain probe on macOS, where a login leaves no `.credentials.json`: the profile's own
   * item, since Claude Code keeps one per config directory (`claudeKeychainServices`).
   */
  private keychain(configured: string, configDir: string): (() => boolean) | undefined {
    if ((this.deps.platform ?? process.platform) !== "darwin") return undefined;
    const has = this.deps.keychainHas ?? keychainHas;
    const services = claudeKeychainServices(configured, configDir, isClaudeHome(configDir, this.home));
    return () => services.some((s) => has(s));
  }

  private stableId(harness: ProfileHarness, configDir: string): string {
    const key = profileKey(harness, configDir);
    const existing = this.deps.store.kv.get(KV_NS, key);
    if (typeof existing === "string" && existing.startsWith("prof_")) return existing;
    const id = newId("profile");
    this.deps.store.kv.put(KV_NS, key, id);
    return id;
  }

  /** The profiles as a client or the brain sees them: the usual account marked, and each Claude profile's launch. */
  list(node?: string): HarnessProfile[] {
    const usual = new Map<string, { id: string; by: DefaultBy }>();
    const auto = new Map<string, { id: string; by: DefaultBy }>();
    for (const harness of ["claude", "codex", "muse"] as const) {
      const u = this.usual(harness);
      if (u) usual.set(harness, u);
      const a = u?.by === "you" ? this.automatic(harness) : u;
      if (a) auto.set(harness, a);
    }
    return this.entries.filter((e) => node === undefined || e.profile.node === node).map((e) => this.view(e, usual.get(e.profile.harness), auto.get(e.profile.harness)));
  }

  private view(e: Entry, usual: { id: string; by: DefaultBy } | undefined, auto: { id: string; by: DefaultBy } | undefined): HarnessProfile {
    const out: HarnessProfile = { ...e.profile };
    if (usual?.id === e.profile.id) {
      out.default = true;
      out.defaultBy = usual.by;
    }
    if (auto?.id === e.profile.id) out.automatic = auto.by;
    const launch = this.launch(e.profile.id);
    if (launch) out.launch = launch;
    return out;
  }

  /** The profile as discovered or declared, with no usual mark or launch: what a session needs to run under it. */
  get(id: string): HarnessProfile | undefined {
    return this.entries.find((e) => e.profile.id === id)?.profile;
  }

  byHarness(harness: HarnessKind): HarnessProfile[] {
    return this.list().filter((p) => p.harness === harness);
  }

  /** Its harness's usual account on this node: what session.spawn uses when none is named. */
  defaultFor(harness: HarnessKind): HarnessProfile | undefined {
    const u = this.usual(harness);
    return u ? this.get(u.id) : undefined;
  }

  /** The usual account and why: picked in the app, config, the user's latest session, discovery, or the first declared. */
  usual(harness: HarnessKind): { id: string; by: DefaultBy } | undefined {
    const picked = this.deps.store.kv.get(KV_USUAL, harness);
    if (typeof picked === "string" && this.entries.some((e) => e.profile.harness === harness && e.profile.id === picked)) return { id: picked, by: "you" };
    return this.automatic(harness);
  }

  /** The usual account as cophylad picks it when the user has picked none. */
  private automatic(harness: HarnessKind): { id: string; by: DefaultBy } | undefined {
    const mine = this.entries.filter((e) => e.profile.harness === harness);
    if (mine.length === 0) return undefined;
    const declared = mine.find((e) => e.configDefault);
    if (declared) return { id: declared.profile.id, by: "config" };
    for (const id of this.deps.store.sessions.recentProfiles(this.deps.nodeId, harness)) {
      if (mine.some((e) => e.profile.id === id)) return { id, by: "recent" };
    }
    const discovered = mine.find((e) => e.profile.origin === "discovered");
    if (discovered) return { id: discovered.profile.id, by: "discovered" };
    // Discovery off: every profile is declared, and the first stands.
    return { id: mine[0]!.profile.id, by: "config" };
  }

  /** What a Claude session cophylad starts under a profile is started with: set in the app, config, or mirrored; `undefined` for nothing. */
  launch(id: string): ProfileLaunch | undefined {
    const e = this.entries.find((x) => x.profile.id === id);
    if (!e || e.profile.harness !== "claude") return undefined;
    const set = this.deps.store.kv.get(KV_LAUNCH, id);
    if (isLaunch(set)) return { ...(set.mode ? { mode: set.mode } : {}), args: [...set.args], source: "you" };
    if (e.configArgs.length > 0) return { ...splitMode(e.configArgs), source: "config" };
    const mirror = this.deps.store.kv.get(KV_MIRROR, id);
    if (isMirror(mirror)) return { ...(mirror.mode ? { mode: mirror.mode } : {}), args: [...mirror.args], source: "mirrored", at: mirror.at };
    return undefined;
  }

  /** The mirrored launch's own time, so a mirror is replaced only by a newer session's. */
  mirroredAt(id: string): number | undefined {
    const m = this.deps.store.kv.get(KV_MIRROR, id);
    return isMirror(m) ? m.at : undefined;
  }

  /** Records the launch of the user's own session under a profile, when it is newer than the one recorded. */
  mirror(id: string, launch: Launch, at: number, session: string): boolean {
    if (!this.get(id)) return false;
    const was = this.mirroredAt(id);
    if (was !== undefined && was > at) return false;
    const row: Mirror = { ...(launch.mode ? { mode: launch.mode } : {}), args: launch.args, at, session };
    this.deps.store.kv.put(KV_MIRROR, id, row);
    this.deps.log.info("launch mirrored", { profile: id, session, mode: launch.mode, args: launch.args.length });
    return true;
  }

  /** What the user set in the app: the usual account, and a Claude profile's launch. Answers the profile as `list` shows it. */
  update(id: string, patch: ProfilePatch): HarnessProfile {
    const e = this.entries.find((x) => x.profile.id === id);
    if (!e) throw new RpcError("not_found", `no profile ${id}`);
    const harness = e.profile.harness;
    if (patch.launch && harness !== "claude") throw new RpcError("invalid", `a ${harness} profile has no launch settings`);
    if (patch.usual === true && e.profile.status === "missing") throw new RpcError("invalid", `profile ${e.profile.name} has no configuration directory`);
    let launch: Launch | undefined;
    if (patch.launch) {
      const split = splitMode(patch.launch.args);
      const problem = launchProblem(split.args);
      if (problem) throw new RpcError("invalid", problem);
      // A mode picked beside the flags wins over one typed among them.
      const mode = patch.launch.mode ?? split.mode;
      launch = { ...(mode ? { mode } : {}), args: split.args };
    }
    if (patch.usual === true) this.deps.store.kv.put(KV_USUAL, harness, id);
    else if (patch.usual === false || patch.usual === null) {
      if (this.deps.store.kv.get(KV_USUAL, harness) === id) this.deps.store.kv.delete(KV_USUAL, harness);
    }
    if (launch) this.deps.store.kv.put(KV_LAUNCH, id, launch);
    else if (patch.launch === null) this.deps.store.kv.delete(KV_LAUNCH, id);
    this.deps.log.info("profile updated", { profile: id, usual: patch.usual, launch: patch.launch === null ? "reset" : launch ? { mode: launch.mode, args: launch.args.length } : undefined });
    return this.list().find((p) => p.id === id)!;
  }

  /** The profile whose directory holds a path, such as a transcript or rollout file. */
  byDir(harness: HarnessKind, path: string): HarnessProfile | undefined {
    return this.entries.find((e) => e.profile.harness === harness && isWithin(path, e.profile.configDir))?.profile;
  }

  hooksMode(id: string): HooksMode {
    return this.modes.get(id) ?? "http";
  }

  /** The harness kinds this node can run: those with a profile in status `ok`. */
  harnessesOk(): HarnessKind[] {
    const kinds: HarnessKind[] = [];
    for (const { profile: p } of this.entries) if (p.status === "ok" && !kinds.includes(p.harness)) kinds.push(p.harness);
    return kinds;
  }
}
