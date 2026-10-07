// The Muse adapter: a `muse serve` host per profile lists the session store, reads the view
// of each live session (the TUI's own, from outside its process), reads the plan's usage,
// and runs the sessions cophylad starts headless. cophylad's plugin brings a TUI session's hooks,
// which are its live status, its asks and its receipts; a session in a tether terminal is
// typed into. Muse makes a session at its first prompt, and its index lists one live in a
// TUI only once it is closed, so a live one is known from its hooks and a listed one is
// mostly a recent one. Liveness comes from the hooks when they came and the process is
// known, and from its recency (the list, the log's writes, the hooks) otherwise. Hooks and
// the view name the same turns and tool calls, so each is recorded once: a turn by the hook's
// `turn_id`, a result by its `tool_use_id`.

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { Ask, HarnessProfile, ProfileLimits, RpcId, Session, SessionStatus, TerminalRef } from "@cophyla/protocol";
import type { HookMeta } from "../../api/hooks.ts";
import { agentTurn } from "../../agentmsg/envelope.ts";
import type { EnvelopeInfo } from "../../agentmsg/envelope.ts";
import type { Asks } from "../../gate/asks.ts";
import type { Logger } from "../../log.ts";
import { scrub } from "../env.ts";
import type { ProcessTree } from "../focus.ts";
import { askShown, capText, oneLine, summariseValue, TOOL_CALL_CAP, TOOL_RESULT_CAP } from "../model.ts";
import type { HarnessAdapter, HeadlessRunner, HeadlessSpawn, HookInstallSpec, NormalisedHook, SendOutcome, SessionHost, SessionRecord, TerminalExpectation } from "../model.ts";
import { plainPath } from "../paths.ts";
import { permissionAsk } from "../permissions.ts";
import { askInputFromQuestion, museAnswer, questionsFromMuse } from "../questions.ts";
import type { MuseAnswer, Question } from "../questions.ts";
import type { ProfileChange } from "../profiles.ts";
import { toolResultText } from "../results.ts";
import { mtimeOf } from "../tail.ts";
import { uuidv7, uuidv7Time } from "../uuidv7.ts";
import { MuseHost, museErrorKind } from "./host.ts";
import { locateMuse } from "./locate.ts";
import type { MuseBinary } from "./locate.ts";
import { ensureMusePlugin, museFiles, museManifest, writeMusePlugin } from "./plugin.ts";
import type { PluginStatus } from "./plugin.ts";
import { applyMuseEvent, newMuseState, parseJson, settledEvents, statsFor } from "./view.ts";
import type { MuseItem, MuseViewState, ViewEvent } from "./view.ts";

const LIST_LIMIT = 200;
const MAX_PAGES = 20;
/** What a session never read before is recorded from: its last events, read back from the head. */
export const REPLAY_EVENTS = 200;
const PAGE_LIMIT = 500;
const MAX_VIEW_PAGES = 20;
const DETAIL_CHARS = 2000;
const DAY_MS = 86_400_000;
/** How many hook session ids are remembered as children's. */
const CHILD_MEMORY = 500;

interface ListRow {
  sessionId?: string;
}

interface ProfileEntry {
  profile: HarnessProfile;
  host: MuseHost;
  env: Record<string, string | undefined>;
  /** `<XDG_DATA_HOME>/muse`, as the host reports it once started. */
  dataHome: string;
  lastList: number;
  plugin?: PluginStatus;
  pluginReady?: Promise<void>;
  /** The last `usage/changed` the host pushed. */
  usage?: ProfileLimits;
}

/** A session in a terminal, read from outside: its view so far and what its hooks recorded. */
interface Attached {
  view: MuseViewState;
  /** The session log's time when the view was last read. */
  logMtime?: number;
  /** Turns whose user turn a hook recorded. */
  hookTurns: Set<string>;
  /** A read is under way. */
  reading?: Promise<void>;
}

interface Expected extends TerminalExpectation {
  ref: TerminalRef;
  rec?: SessionRecord;
}

/** What an open ask of a headless session stands for. */
type Pending =
  | { kind: "approval"; ask: Ask; approvalId: string; requirementId: unknown; choices: Choice[] }
  | { kind: "input"; ask: Ask; userInputId: string; questions: Question[]; index: number; answers: MuseAnswer[]; deadline?: number };

interface Choice {
  choiceId: string;
  label: string;
  decision: string;
  acceptsFeedback?: boolean;
  rulePreview?: string;
}

/** A session cophylad runs headless on a profile's host. */
interface Owned {
  rec: SessionRecord;
  entry: ProfileEntry;
  sessionId: string;
  view: MuseViewState;
  /** The commands cophylad's own turns went out under, whose user turns it recorded itself. */
  commands: Set<string>;
  /** Turns handed to the host and not yet completed. */
  queued: number;
  pending?: Pending;
  stopping: boolean;
}

export interface MuseAdapterOptions {
  host: SessionHost;
  log: Logger;
  version: string;
  /** cophylad's data directory: each profile's plugin is written under `<dataDir>/muse/<profile>/plugin`. */
  dataDir: string;
  /** The process tree: a hook says its shim's parent pid, and the `muse` ancestor is the session's process. */
  raiser?: ProcessTree;
  isAlive?: (pid: number) => boolean;
  /** Asks for the sessions it runs headless. */
  asks?: Asks;
  askTimeoutS?: number;
  /** The daemon's environment; scrubbed, then the profile's own over it. */
  env?: Record<string, string | undefined>;
  /** The binary a profile's host and plugin calls run; a test hands in a fake. */
  locate?: (profile: HarnessProfile) => MuseBinary;
  /** Runs a `muse` command to its end; a test records it. */
  run?: (argv: string[], env: Record<string, string | undefined>) => Promise<{ code: number; out: string }>;
  home?: string;
}

async function runCommand(argv: string[], env: Record<string, string | undefined>): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(argv, { env: env as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const timer = setTimeout(() => p.kill(), 60000);
  try {
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out: out.trim() ? out : err };
  } finally {
    clearTimeout(timer);
  }
}

function sameTerminal(a: TerminalRef | undefined, b: TerminalRef | undefined): boolean {
  return a !== undefined && b !== undefined && a.host === b.host && a.id === b.id;
}

/** `YYYY/MM/DD` of a time, as local and UTC days: Muse files a session under one of them. */
function days(t: number): string[] {
  const out = new Set<string>();
  for (const d of [new Date(t)]) {
    out.add(`${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`);
    out.add(`${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`);
  }
  return [...out];
}

/** A root session's log, by the day its UUIDv7 says it was made (a day either way); a child has none. */
export function findSessionLog(dataHome: string, sessionId: string): string | undefined {
  const t = uuidv7Time(sessionId);
  if (t === undefined) return undefined;
  for (const offset of [0, -DAY_MS, DAY_MS]) {
    for (const day of days(t + offset)) {
      const path = join(dataHome, "sessions", ...day.split("/"), sessionId, "session.jsonl");
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

/** A profile's data directory before its host has said: `XDG_DATA_HOME`, else `~/.local/share`. */
export function museDataHome(profile: Pick<HarnessProfile, "env">, env: Record<string, string | undefined>, home: string = homedir()): string {
  return join(profile.env["XDG_DATA_HOME"] ?? env["XDG_DATA_HOME"] ?? join(home, ".local", "share"), "muse");
}

export class MuseAdapter implements HarnessAdapter {
  readonly harness = "muse" as const;
  readonly headless: HeadlessRunner;
  private host: SessionHost;
  private log: Logger;
  private opts: MuseAdapterOptions;
  private entries = new Map<string, ProfileEntry>();
  private owned = new Map<string, Owned>();
  private expected: Expected[] = [];
  /** Hook session ids known to be children's, newest last. */
  private children = new Set<string>();

  constructor(opts: MuseAdapterOptions) {
    this.opts = opts;
    this.host = opts.host;
    this.log = opts.log;
    this.headless = {
      owns: (rec) => this.owned.has(rec.session.native.id) && rec.session.harness === "muse",
      spawn: (input) => this.spawnHeadless(input),
      prompt: (rec, text, ref, agent) => this.prompt(rec, text, ref, agent),
      cancel: (rec) => this.cancel(rec),
      stop: (rec) => this.stopOwned(rec),
      inFlight: () => [...this.owned.values()].reduce((n, o) => n + o.queued, 0),
    };
  }

  /** The plugin's state per profile, for the log and for tests. */
  pluginStatus(profileId: string): PluginStatus | undefined {
    return this.entries.get(profileId)?.plugin;
  }

  /** Resolves once every profile's plugin was installed or refused. */
  async pluginsReady(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.pluginReady));
  }

  /** Whether the profile's plugin is installed and approved, once its install has settled: without it a TUI's session is never seen. */
  async hooked(profileId: string): Promise<boolean> {
    const entry = this.entries.get(profileId);
    await entry?.pluginReady;
    return entry?.plugin?.approved === true;
  }

  async start(profiles: HarnessProfile[], hooks: HookInstallSpec | undefined): Promise<void> {
    for (const profile of profiles) if (profile.status !== "missing") await this.add(profile, hooks);
  }

  /**
   * The profiles were rebuilt. A home that came since gets a host and cophylad's plugin; one that
   * went takes its host with it; a new login starts the host again, since it holds the login it
   * read at its start (one running cophylad's headless sessions waits for the next), and has the
   * plugin installed and approved where it was not.
   */
  async sync(profiles: HarnessProfile[], hooks: HookInstallSpec | undefined, change: ProfileChange): Promise<void> {
    const live = new Map(profiles.filter((p) => p.status !== "missing").map((p) => [p.id, p]));
    for (const [id, entry] of [...this.entries]) {
      if (live.has(id)) continue;
      this.entries.delete(id);
      await entry.host.stop();
      this.log.info("muse profile gone; its host stopped", { profile: id });
    }
    for (const profile of live.values()) {
      const entry = this.entries.get(profile.id);
      if (!entry) {
        this.log.info("muse profile came", { profile: profile.id, dir: profile.configDir });
        await this.add(profile, hooks);
        continue;
      }
      entry.profile = profile;
      if (!change.login.includes(profile.id)) continue;
      if (![...this.owned.values()].some((o) => o.entry === entry)) {
        await entry.host.stop();
        await entry.host.start().catch((e: unknown) => this.log.warn("muse serve did not start; will retry", { profile: profile.id, error: e instanceof Error ? e.message : String(e) }));
        this.log.info("muse host restarted for a new login", { profile: profile.id });
      }
      if (hooks && !entry.plugin?.approved) entry.pluginReady = this.installPlugin(entry, hooks);
    }
  }

  /** A profile's host, started, and its plugin installed and approved in the background. */
  private async add(profile: HarnessProfile, hooks: HookInstallSpec | undefined): Promise<void> {
    const base = scrub(this.opts.env ?? process.env);
    const env: Record<string, string | undefined> = { ...base, ...profile.env, MUSE_NO_AUTO_UPDATE: "1" };
    const entry: ProfileEntry = {
      profile,
      env,
      dataHome: museDataHome(profile, base, this.opts.home),
      lastList: 0,
      host: new MuseHost({
        binary: () => this.binaryFor(entry.profile),
        env,
        log: this.log.child(profile.name),
        version: this.opts.version,
        onNotification: (method, params) => this.onNotification(entry, method, params),
        onRequest: (method, params, id) => this.onRequest(entry, method, params, id),
        onExit: () => this.onHostExit(entry),
      }),
    };
    this.entries.set(profile.id, entry);
    try {
      const init = await entry.host.start();
      if (init.museHome) entry.dataHome = normalize(init.museHome);
    } catch (e) {
      this.log.warn("muse serve did not start; will retry", { profile: profile.id, error: e instanceof Error ? e.message : String(e) });
    }
    if (hooks) entry.pluginReady = this.installPlugin(entry, hooks);
  }

  private binaryFor(profile: HarnessProfile): MuseBinary {
    return (this.opts.locate ?? locateMuse)(profile);
  }

  /** Writes the profile's plugin and has Muse install and approve it; after a refusal the profile's TUI sessions go unseen, and cophylad starts its own headless. */
  private async installPlugin(entry: ProfileEntry, hooks: HookInstallSpec): Promise<void> {
    const { profile } = entry;
    const dir = join(this.opts.dataDir, "muse", profile.id, "plugin");
    try {
      const want = this.host.agentInstall();
      const agents = want?.kind === "install" ? [want.spec.command, ...want.spec.args("muse", profile.id)] : undefined;
      const files = museFiles(museManifest((shim) => hooks.argv("muse", profile.id, shim), hooks.timeoutS, this.opts.version.replace(/[^0-9.]/g, "") || "0.1.0", agents));
      writeMusePlugin(dir, files);
      const bin = this.binaryFor(profile);
      const named = Object.entries(profile.env)
        .filter(([k]) => k.startsWith("XDG_"))
        .map(([k, v]) => `${k}=${v}`);
      entry.plugin = await ensureMusePlugin({
        dir,
        files,
        log: this.log.child(profile.name),
        run: (args) => (this.opts.run ?? runCommand)([bin.command, ...bin.args, "plugins", ...args, "--json"], entry.env),
        approveHint: `${named.length > 0 ? `${named.join(" ")} ` : ""}muse plugins approve cophylad`,
      });
    } catch (e) {
      entry.plugin = { installed: false, approved: false, refused: e instanceof Error ? e.message : String(e) };
      this.log.error("muse plugin install failed", { profile: profile.id, dir, error: entry.plugin.refused });
    }
  }

  async stop(): Promise<void> {
    for (const o of [...this.owned.values()]) this.finish(o, "daemon_stop");
    for (const entry of this.entries.values()) await entry.host.stop();
  }

  // --- discovery ---------------------------------------------------------------------------

  async tick(now: number): Promise<void> {
    for (const entry of this.entries.values()) {
      if (now - entry.lastList >= this.host.config.muse_list_ms) {
        entry.lastList = now;
        try {
          await this.listSessions(entry, now);
        } catch (e) {
          this.log.warn("session/list failed", { profile: entry.profile.id, error: e instanceof Error ? e.message : String(e) });
        }
        await entry.host.refresh([...this.owned.values()].some((o) => o.entry === entry)).catch((e: unknown) => this.log.warn("muse serve restart failed", { error: e instanceof Error ? e.message : String(e) }));
      }
    }
    for (const rec of this.host.records("muse")) {
      if (this.owned.has(rec.session.native.id)) continue;
      const entry = this.entries.get(rec.session.profile);
      if (entry) await this.readView(rec, entry, now);
      this.checkLiveness(rec, now);
    }
    this.expected = this.expected.filter((x) => x.expiresAt > now);
  }

  private async listSessions(entry: ProfileEntry, now: number): Promise<void> {
    const updatedAfter = new Date(now - this.host.config.muse_recent_ms).toISOString();
    const asked = this.host.now();
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await entry.host.call<{ sessions?: ListRow[]; nextCursor?: string | null }>("session/list", { limit: LIST_LIMIT, updatedAfter, ...(cursor ? { cursor } : {}) });
      for (const row of r?.sessions ?? []) this.listed(row, asked);
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
  }

  /**
   * One row of the list. Muse lists a session only once no TUI has it open, so one cophylad
   * follows that is listed has closed (its SessionEnd missed, or its TUI gone on to another
   * session) and ends, unless it sent a hook since the list was asked. One cophylad never
   * followed is left alone: it is not live, and one cophylad runs itself is its host's.
   */
  private listed(row: ListRow, asked: number): void {
    const id = row.sessionId;
    if (!id || this.owned.has(id)) return;
    const rec = this.host.find("muse", id);
    if (!rec || rec.session.status === "ended" || (rec.lastHookAt ?? 0) >= asked) return;
    this.log.info("muse session listed, so closed", { session: rec.session.id, native: id });
    this.host.end(rec, "closed", this.host.now());
  }

  // --- the view ----------------------------------------------------------------------------

  private attached(rec: SessionRecord): Attached {
    if (!rec.parser) {
      const mark = this.host.viewMark(rec);
      rec.parser = { view: newMuseState(mark?.cursor), hookTurns: new Set() } satisfies Attached;
    }
    return rec.parser as Attached;
  }

  /** Reads what the view has past the last read, when the session's log was written since. */
  private async readView(rec: SessionRecord, entry: ProfileEntry, now: number, force = false): Promise<void> {
    const a = this.attached(rec);
    if (a.reading) return a.reading;
    let path = rec.session.transcript?.path;
    if (!path) {
      path = findSessionLog(entry.dataHome, rec.session.native.id);
      if (!path) return;
      this.host.patch(rec, { transcript: { path } }, now);
    }
    const mtime = mtimeOf(path);
    if (mtime === undefined) return;
    if (!force && a.logMtime !== undefined && mtime <= a.logMtime) return;
    // The log written is the session at work, which keeps one known without hooks alive.
    if (a.logMtime !== undefined || now - mtime <= this.host.config.muse_recent_ms) rec.lastRolloutActivity = Math.max(rec.lastRolloutActivity ?? 0, Math.min(mtime, now));
    this.host.watch(dirname(path));
    a.reading = this.page(rec, entry, a, path, mtime, now).finally(() => {
      a.reading = undefined;
    });
    return a.reading;
  }

  private async page(rec: SessionRecord, entry: ProfileEntry, a: Attached, path: string, mtime: number, now: number): Promise<void> {
    const sessionId = rec.session.native.id;
    const events: ViewEvent[] = [];
    try {
      if (a.view.cursor === undefined) {
        const r = await entry.host.call<{ events?: ViewEvent[] }>("view/page", { sessionId, limit: REPLAY_EVENTS, direction: "backward" });
        events.push(...(r?.events ?? []));
      } else {
        let cursor = a.view.cursor;
        for (let n = 0; n < MAX_VIEW_PAGES; n++) {
          const r = await entry.host.call<{ events?: ViewEvent[]; nextCursor?: string | null }>("view/page", { sessionId, limit: PAGE_LIMIT, cursor });
          events.push(...(r?.events ?? []));
          if (!r?.nextCursor || (r.events ?? []).length === 0) break;
          cursor = r.nextCursor;
        }
      }
    } catch (e) {
      const kind = museErrorKind(e);
      // Listed before its log has a view to page: the next write tries again.
      if (kind !== "sessionNotFound" && kind !== "notFound") this.log.warn("view/page failed", { session: rec.session.id, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    a.logMtime = mtime;
    this.fold(rec, a.view, settledEvents(events), now, { hookTurns: a.hookTurns });
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // gone: the mark keeps the cursor
    }
    if (a.view.cursor !== undefined) this.host.setViewMark(rec, { path, offset: size, cursor: a.view.cursor });
  }

  /**
   * Records what the view's events stand for. A user turn a hook recorded, or cophylad sent
   * itself, is not recorded again, and neither is a tool result a hook recorded. The last
   * turn event read sets the status: hooks say it first, and a turn cancelled in the TUI
   * sends no Stop.
   */
  private fold(rec: SessionRecord, view: MuseViewState, events: ViewEvent[], now: number, opts: { hookTurns?: Set<string>; commands?: Set<string> }): void {
    const patch: Partial<Session> = {};
    let status: SessionStatus | undefined;
    for (const e of events) {
      for (const item of applyMuseEvent(view, e, now)) {
        const s = this.record(rec, item, opts, patch);
        if (s) status = s;
      }
    }
    if (view.statsChanged) {
      view.statsChanged = false;
      patch.stats = statsFor(view);
    }
    if (Object.keys(patch).length > 0) this.host.patch(rec, patch, now);
    if (status && rec.session.status !== "ended") this.host.setStatus(rec, status, now);
  }

  /** One item into the record; the status a turn event leaves the session in. */
  private record(rec: SessionRecord, item: MuseItem, opts: { hookTurns?: Set<string>; commands?: Set<string> }, patch: Partial<Session>): SessionStatus | undefined {
    switch (item.kind) {
      case "user_turn": {
        if (item.commandId && opts.commands?.has(item.commandId)) return undefined;
        if (item.turnId && opts.hookTurns?.has(item.turnId)) return undefined;
        if (this.host.isOwnText(rec, item.text)) {
          if (!this.host.receiptByText(rec, item.text, item.turnId)) this.host.agentEcho(rec, item.text, undefined, item.at);
          return undefined;
        }
        if (rec.session.intent === undefined && patch.intent === undefined) patch.intent = oneLine(item.text);
        this.host.event(rec, "user_turn", { text: capText(item.text), source: "typed" }, undefined, item.at);
        return undefined;
      }
      case "assistant_text":
        this.host.event(rec, "assistant_text", { text: capText(item.text) }, undefined, item.at);
        return undefined;
      case "tool_call": {
        const args = summariseValue(item.args, TOOL_CALL_CAP);
        this.host.event(rec, "tool_call", { tool: item.tool, id: item.callId, args: args.value, ...(args.truncated ? { truncated: true } : {}) }, undefined, item.at);
        return undefined;
      }
      case "tool_result": {
        if (rec.hookTools.has(item.callId)) {
          rec.hookTools.delete(item.callId);
          return undefined;
        }
        const result = summariseValue(toolResultText("muse", item.tool, item.output), TOOL_RESULT_CAP);
        this.host.event(rec, "tool_result", { tool: item.tool, id: item.callId, result: result.value, ...(result.truncated ? { truncated: true } : {}), ...(item.isError ? { isError: true } : {}) }, undefined, item.at);
        return undefined;
      }
      case "turn_started":
        return "busy";
      case "turn_completed":
        if (item.terminal !== "completed") this.host.event(rec, "notification", { type: `turn_${item.terminal}`, turn: item.turnId, ...(item.error || item.reason ? { message: item.error ?? item.reason } : {}) }, undefined, item.at);
        return "idle";
    }
  }

  drain(rec: SessionRecord, now: number): void {
    // The view is read afresh, after the end if need be: its last turn is still recorded.
    const entry = this.entries.get(rec.session.profile);
    if (entry && !this.owned.has(rec.session.native.id)) void this.readView(rec, entry, now, true).catch(() => undefined);
  }

  /**
   * With hooks and its process known, a session is live until SessionEnd, a dead process or
   * the list showing it; otherwise while its log was written within the window, each hook
   * counting as activity.
   */
  private checkLiveness(rec: SessionRecord, now: number): void {
    const pid = rec.session.native.pid;
    if (rec.liveness === "hook" && pid !== undefined) {
      if (this.opts.isAlive && !this.opts.isAlive(pid)) this.host.end(rec, "gone", now);
      return;
    }
    const last = rec.lastRolloutActivity ?? rec.session.lastActivity;
    if (now - last > this.host.config.muse_recent_ms) this.host.end(rec, "inactive", now);
  }

  // --- hooks -------------------------------------------------------------------------------

  /** Whether a hook's session id is a reminder's or a subagent's: not v7, named in a view, or not filed as a root. */
  private isChild(sessionId: string): boolean {
    if (this.children.has(sessionId) || uuidv7Time(sessionId) === undefined) return true;
    for (const rec of this.host.records("muse")) {
      const a = rec.parser as Attached | undefined;
      if (a?.view.children.has(sessionId)) return true;
    }
    for (const o of this.owned.values()) if (o.view.children.has(sessionId)) return true;
    return false;
  }

  private rememberChild(sessionId: string): void {
    this.children.add(sessionId);
    if (this.children.size > CHILD_MEMORY) this.children.delete(this.children.values().next().value!);
  }

  onHook(hook: NormalisedHook, rec: SessionRecord | undefined, meta: HookMeta): SessionRecord | undefined | null {
    if (this.owned.has(hook.sessionId)) return null;
    const now = this.host.now();
    if (!rec) {
      if (this.isChild(hook.sessionId)) {
        this.rememberChild(hook.sessionId);
        return null;
      }
      const entry = (meta.profile ? this.entries.get(meta.profile) : undefined) ?? [...this.entries.values()].find((e) => e.profile.default) ?? [...this.entries.values()][0];
      if (!entry) return undefined;
      const path = findSessionLog(entry.dataHome, hook.sessionId);
      // Only a SessionStart makes a session of an id with no log filed: anything else under
      // such an id is a child's, whose hooks fire under ids of their own.
      if (!path && hook.name !== "SessionStart") {
        this.rememberChild(hook.sessionId);
        return null;
      }
      this.log.info("muse session known from its hook", { session: hook.sessionId, profile: entry.profile.id, event: hook.name });
      rec = this.host.ensure({
        harness: "muse",
        nativeId: hook.sessionId,
        profile: entry.profile.id,
        cwd: hook.cwd ? plainPath(hook.cwd) : entry.dataHome,
        transport: "msp",
        status: hook.name === "SessionStart" ? "idle" : "busy",
        ...(path ? { transcriptPath: path } : {}),
        handles: { configDir: entry.profile.configDir },
        liveness: "hook",
      });
    }
    rec.liveness = "hook";
    rec.lastRolloutActivity = now;
    rec.lastHookAt = now;
    if (hook.name === "UserPromptSubmit" && hook.promptId) this.attached(rec).hookTurns.add(hook.promptId);
    if (meta.ppid !== undefined && !rec.ancestorsChecked && this.opts.raiser) {
      rec.ancestorsChecked = true;
      const target = rec;
      this.opts.raiser
        .ancestors(meta.ppid)
        .then((chain) => {
          const muse = chain.find((p) => /muse/i.test(p.name));
          const pids = new Set(chain.map((p) => p.pid));
          const x = this.expected.find((e) => !e.rec && e.pid !== undefined && pids.has(e.pid));
          if (x) this.claim(x, target, muse?.pid);
          else if (muse && target.session.native.pid !== muse.pid) this.host.patch(target, { native: { ...target.session.native, pid: muse.pid } });
        })
        .catch(() => {
          // focus and the terminal stay unknown for this session
        });
    }
    return rec;
  }

  // --- terminals cophylad starts ---------------------------------------------------------------

  expectTerminal(ref: TerminalRef, what: TerminalExpectation): void {
    this.expected = this.expected.filter((x) => !sameTerminal(x.ref, ref));
    this.expected.push({ ...what, ref });
  }

  claimed(ref: TerminalRef): SessionRecord | undefined {
    const rec = this.expected.find((x) => sameTerminal(x.ref, ref))?.rec;
    return rec && rec.session.status !== "ended" ? rec : undefined;
  }

  /** A session is the one a terminal cophylad started: it carries what the terminal was started for. */
  private claim(x: Expected, rec: SessionRecord, pid: number | undefined): void {
    x.rec = rec;
    const s = rec.session;
    const patch: Partial<Session> = { origin: "orchestrator", native: { ...s.native, terminal: x.ref, ...(pid !== undefined ? { pid } : {}) } };
    if (x.workspace !== undefined) patch.workspace = x.workspace;
    if (x.task !== undefined) patch.task = x.task;
    if (x.intent !== undefined && s.intent === undefined) patch.intent = x.intent;
    this.host.patch(rec, patch);
    this.log.info("muse session claimed for its terminal", { session: s.id, native: s.native.id, terminal: x.ref.id });
  }

  // --- messages ------------------------------------------------------------------------------

  async send(_rec: SessionRecord, _text: string, _ref: string): Promise<SendOutcome> {
    throw new RpcError("unsupported", "Muse takes messages only in a terminal cophylad can type into");
  }

  // --- the plan's usage ------------------------------------------------------------------------

  /** A profile's plan limits as its host last observed them; `undefined` when it has observed none. */
  async limits(profileId: string): Promise<ProfileLimits | undefined> {
    const entry = this.entries.get(profileId);
    if (!entry) return undefined;
    const r = await entry.host.call<{ usage?: unknown }>("usage/read");
    const limits = usageLimits(r?.usage);
    if (limits) entry.usage = limits;
    return limits ?? entry.usage;
  }

  // --- headless sessions ---------------------------------------------------------------------

  private async spawnHeadless(input: HeadlessSpawn): Promise<SessionRecord> {
    const entry = this.entries.get(input.profile.id);
    if (!entry) throw new RpcError("unavailable", `no muse host for profile ${input.profile.name}`);
    const now = this.host.now();
    const sessionId = uuidv7(now);
    let started: { session?: { path?: string; modelId?: string | null }; viewCursor?: string };
    try {
      started = await entry.host.call("session/start", { commandId: uuidv7(now), sessionId, workspaceRoot: input.cwd, ...(input.model ? { modelId: input.model } : {}) });
    } catch (e) {
      throw new RpcError("unavailable", `muse could not start a session: ${e instanceof Error ? e.message : String(e)}`, { provider: "muse" });
    }
    const rec = this.host.ensure({
      harness: "muse",
      nativeId: sessionId,
      profile: input.profile.id,
      cwd: input.cwd,
      transport: "msp",
      origin: "orchestrator",
      workspace: input.workspace,
      ...(input.task !== undefined ? { task: input.task } : {}),
      status: "idle",
      intent: input.intent ?? oneLine(input.prompt),
      startedAt: now,
      ...(started.session?.path ? { transcriptPath: normalize(started.session.path) } : {}),
    });
    const owned: Owned = { rec, entry, sessionId, view: newMuseState(started.viewCursor), commands: new Set(), queued: 0, stopping: false };
    if (started.session?.modelId) owned.view.stats.model = started.session.modelId;
    this.owned.set(sessionId, owned);
    this.log.info("muse session started headless", { session: rec.session.id, native: sessionId, cwd: input.cwd });
    await this.prompt(rec, input.prompt, `cophylad-spawn-${sessionId}`);
    return rec;
  }

  private ownedOf(rec: SessionRecord): Owned {
    const o = this.owned.get(rec.session.native.id);
    if (!o || o.stopping) throw new RpcError("conflict", `session ${rec.session.id} is not running here`);
    return o;
  }

  /** A turn behind the one in flight; the session is resumed on its host first when the host let it go. */
  private async prompt(rec: SessionRecord, text: string, ref: string, agent?: { info: EnvelopeInfo; text: string }): Promise<void> {
    const o = this.ownedOf(rec);
    const now = this.host.now();
    const commandId = uuidv7(now);
    o.commands.add(commandId);
    const params = { commandId, sessionId: o.sessionId, input: [{ type: "text", text }], ifBusy: "queue" };
    this.host.event(rec, "user_turn", agent ? agentTurn(agent.info, agent.text, ref) : { text: capText(text), source: "orchestrator", ref }, undefined, now);
    this.host.setStatus(rec, "busy", now);
    o.queued += 1;
    try {
      await o.entry.host.call("turn/start", params).catch(async (e: unknown) => {
        if (museErrorKind(e) !== "sessionNotLoaded") throw e;
        await o.entry.host.call("session/resume", { commandId: uuidv7(), sessionId: o.sessionId });
        return o.entry.host.call("turn/start", params);
      });
    } catch (e) {
      o.queued = Math.max(0, o.queued - 1);
      const message = e instanceof Error ? e.message : String(e);
      this.log.warn("turn/start failed", { session: rec.session.id, error: message });
      this.host.event(rec, "notification", { type: "turn_failed", message }, undefined, this.host.now());
      if (o.queued === 0) this.host.setStatus(rec, "idle");
      throw new RpcError("unavailable", `muse did not take the message: ${message}`);
    }
  }

  private cancel(rec: SessionRecord): boolean {
    const o = this.owned.get(rec.session.native.id);
    if (!o || o.stopping || o.view.open.size === 0) return false;
    void o.entry.host.call("turn/interrupt", { commandId: uuidv7(), sessionId: o.sessionId }).catch((e: unknown) => this.log.debug("turn/interrupt refused", { error: e instanceof Error ? e.message : String(e) }));
    return true;
  }

  private async stopOwned(rec: SessionRecord): Promise<void> {
    const o = this.ownedOf(rec);
    o.stopping = true;
    if (o.view.open.size > 0 || o.queued > 0) {
      await o.entry.host.call("turn/interrupt", { commandId: uuidv7(), sessionId: o.sessionId }).catch((e: unknown) => this.log.debug("turn/interrupt refused", { error: e instanceof Error ? e.message : String(e) }));
    }
    this.finish(o, "stopped");
  }

  /** The session is no longer cophylad's to run: its ask closes and its record ends. */
  private finish(o: Owned, reason: string): void {
    if (this.owned.get(o.sessionId) !== o) return;
    if (o.pending) this.closePending(o, "stopped");
    this.owned.delete(o.sessionId);
    this.host.end(o.rec, reason, this.host.now());
  }

  private onHostExit(entry: ProfileEntry): void {
    for (const o of [...this.owned.values()]) if (o.entry === entry) this.finish(o, "exited");
  }

  private onNotification(entry: ProfileEntry, method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === "usage/changed") {
      const limits = usageLimits(p);
      if (limits) entry.usage = limits;
      return;
    }
    const sessionId = typeof p["sessionId"] === "string" ? p["sessionId"] : undefined;
    const o = sessionId ? this.owned.get(sessionId) : undefined;
    if (!o || o.entry !== entry) return;
    const now = this.host.now();
    switch (method) {
      case "approval/updated":
        if (o.pending?.kind === "approval" && o.pending.approvalId === p["approvalId"]) {
          if (p["currentRequirementId"] !== undefined) o.pending.requirementId = p["currentRequirementId"];
          if (Array.isArray(p["availableChoices"])) o.pending.choices = p["availableChoices"] as Choice[];
        }
        return;
      case "approval/resolved":
        if (o.pending?.kind === "approval" && o.pending.approvalId === p["approvalId"]) this.closePending(o, "resolved", false);
        return;
      case "userInput/settled":
        if (o.pending?.kind === "input" && o.pending.userInputId === p["userInputId"]) this.closePending(o, "resolved", false);
        return;
      case "turn/completed":
        o.queued = Math.max(0, o.queued - 1);
        break;
      default:
        break;
    }
    this.fold(o.rec, o.view, [{ method, params: p }], now, { commands: o.commands });
  }

  // --- the host's requests: approvals and questions -----------------------------------------

  private onRequest(entry: ProfileEntry, method: string, params: unknown, _id: RpcId): unknown {
    const p = (params ?? {}) as Record<string, unknown>;
    const o = typeof p["sessionId"] === "string" ? this.owned.get(p["sessionId"]) : undefined;
    if (method !== "approval/request" && method !== "userInput/request") throw new RpcError("unsupported", `cophylad does not serve ${method}`);
    // The receipt goes back at once; the answer travels as a command of its own.
    if (o && o.entry === entry && !o.stopping) {
      if (method === "approval/request") this.openApproval(o, p);
      else this.openInput(o, p);
    }
    return {};
  }

  private where(rec: SessionRecord): string {
    return rec.session.title ?? rec.session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? rec.session.cwd;
  }

  /** A permission ask with the host's own choices; a re-issued request for the one open joins it. */
  private openApproval(o: Owned, p: Record<string, unknown>): void {
    const approvalId = String(p["approvalId"] ?? "");
    if (!approvalId || !this.opts.asks) return;
    if (o.pending?.kind === "approval" && o.pending.approvalId === approvalId) {
      o.pending.requirementId = p["currentRequirementId"];
      return;
    }
    if (o.pending) this.closePending(o, "stopped");
    const now = this.host.now();
    const choices = (Array.isArray(p["availableChoices"]) ? p["availableChoices"] : []) as Choice[];
    const tool = typeof p["toolName"] === "string" ? p["toolName"] : undefined;
    const input = parseJson(p["rawArgs"]);
    const shape = permissionAsk(tool, input, this.where(o.rec), DETAIL_CHARS);
    const ask = this.opts.asks.open(
      {
        type: "permission",
        source: { kind: "harness", session: o.rec.session.id },
        title: shape.title,
        detail: shape.detail,
        options: choices.map((c) => ({ id: c.choiceId, label: c.label, style: c.decision.startsWith("approved") ? ("primary" as const) : ("danger" as const), ...(c.rulePreview && c.rulePreview !== c.label ? { description: c.rulePreview } : {}) })),
        ...(choices.some((c) => c.acceptsFeedback) ? { allowsText: true } : {}),
        answerableBy: ["user", "brain"],
        expiresAt: now + (this.opts.askTimeoutS ?? 7200) * 1000,
      },
      now,
    );
    const pending: Pending = { kind: "approval", ask, approvalId, requirementId: p["currentRequirementId"], choices };
    o.pending = pending;
    this.host.patch(o.rec, { ask: ask.id }, now);
    this.host.setStatus(o.rec, "needs_permission", now);
    this.host.event(o.rec, "ask", { ask: ask.id, phase: "opened", tool, ...(typeof p["toolCallId"] === "string" ? { id: p["toolCallId"] } : {}), ...askShown(ask) }, undefined, now);
    this.log.info("muse permission ask opened", { session: o.rec.session.id, ask: ask.id, tool });
    void this.opts.asks.wait(ask.id).then((settled) => {
      if (o.pending !== pending) return;
      if (settled.status === "answered" && settled.answer) void this.decide(o, pending, settled);
      else this.closePending(o, settled.status === "expired" ? "expired" : "cancelled");
    });
  }

  /** Sends the chosen choice; a note goes with a choice that takes one. */
  private async decide(o: Owned, pending: Extract<Pending, { kind: "approval" }>, settled: Ask): Promise<void> {
    o.pending = undefined;
    const now = this.host.now();
    const answer = settled.answer!;
    const choice = pending.choices.find((c) => c.choiceId === answer.option) ?? pending.choices.find((c) => c.decision === "abort" || c.decision === "denied");
    this.host.event(o.rec, "ask", { ask: pending.ask.id, phase: "answered", answer }, undefined, now);
    this.host.patch(o.rec, { ask: undefined }, now);
    if (o.rec.session.status === "needs_permission") this.host.setStatus(o.rec, "busy", now);
    if (!choice) return;
    const feedback = choice.acceptsFeedback && answer.text?.trim() ? answer.text.trim() : undefined;
    await o.entry.host
      .call("approval/decide", { commandId: uuidv7(), sessionId: o.sessionId, approvalId: pending.approvalId, choiceId: choice.choiceId, requirementId: pending.requirementId, ...(feedback ? { feedback } : {}) })
      .catch((e: unknown) => this.log.warn("approval/decide failed", { session: o.rec.session.id, approval: pending.approvalId, error: e instanceof Error ? e.message : String(e) }));
    this.log.info("muse permission ask answered", { session: o.rec.session.id, ask: pending.ask.id, choice: choice.choiceId, by: answer.by.kind });
  }

  /** One choice ask per question, opened in turn; the answers go back together. */
  private openInput(o: Owned, p: Record<string, unknown>): void {
    const userInputId = String(p["userInputId"] ?? "");
    if (!userInputId || !this.opts.asks) return;
    if (o.pending?.kind === "input" && o.pending.userInputId === userInputId) return;
    const questions = questionsFromMuse(p);
    const now = this.host.now();
    if (!questions) {
      void o.entry.host.call("userInput/cancel", { commandId: uuidv7(), sessionId: o.sessionId, userInputId, reason: "no question cophylad can show" }).catch(() => undefined);
      return;
    }
    if (o.pending) this.closePending(o, "stopped");
    const auto = typeof p["autoResolutionMs"] === "number" ? (p["autoResolutionMs"] as number) : undefined;
    this.openQuestion(o, { kind: "input", userInputId, questions, index: 0, answers: [], ...(auto !== undefined ? { deadline: now + auto } : {}) }, now);
  }

  private openQuestion(o: Owned, form: Omit<Extract<Pending, { kind: "input" }>, "ask">, now: number): void {
    const asks = this.opts.asks!;
    const q = form.questions[form.index]!;
    const expiresAt = Math.min(now + (this.opts.askTimeoutS ?? 7200) * 1000, form.deadline ?? Number.POSITIVE_INFINITY);
    const ask = asks.open(askInputFromQuestion(q, { session: o.rec.session.id, index: form.index, count: form.questions.length, expiresAt }), now);
    const pending: Pending = { ...form, ask };
    o.pending = pending;
    this.host.patch(o.rec, { ask: ask.id }, now);
    this.host.setStatus(o.rec, "needs_input", now);
    this.host.event(o.rec, "ask", { ask: ask.id, phase: "opened", question: form.index + 1, of: form.questions.length, ...askShown(ask) }, undefined, now);
    void asks.wait(ask.id).then((settled) => {
      if (o.pending !== pending) return;
      if (settled.status !== "answered" || !settled.answer) {
        this.closePending(o, settled.status === "expired" ? "expired" : "cancelled");
        return;
      }
      const at = this.host.now();
      pending.answers.push(museAnswer(q, settled.answer));
      this.host.event(o.rec, "ask", { ask: ask.id, phase: "answered", answer: settled.answer }, undefined, at);
      if (pending.index + 1 < pending.questions.length) {
        this.openQuestion(o, { ...pending, index: pending.index + 1 }, at);
        return;
      }
      o.pending = undefined;
      this.host.patch(o.rec, { ask: undefined }, at);
      if (o.rec.session.status === "needs_input") this.host.setStatus(o.rec, "busy", at);
      void o.entry.host
        .call("userInput/answer", { commandId: uuidv7(), sessionId: o.sessionId, userInputId: pending.userInputId, answers: pending.answers })
        .catch((e: unknown) => this.log.warn("userInput/answer failed", { session: o.rec.session.id, error: e instanceof Error ? e.message : String(e) }));
    });
  }

  /**
   * Closes the open ask with no answer. The host is told unless it settled the request
   * itself (`tell` false): a permission gets its reject choice, a question is cancelled.
   */
  private closePending(o: Owned, reason: string, tell = true): void {
    const pending = o.pending;
    if (!pending) return;
    o.pending = undefined;
    const now = this.host.now();
    const asks = this.opts.asks;
    if (asks && asks.getAny(pending.ask.id)?.status === "open") asks.cancel(pending.ask.id);
    if (tell) {
      if (pending.kind === "approval") {
        const reject = pending.choices.find((c) => c.decision === "abort") ?? pending.choices.find((c) => c.decision === "denied");
        if (reject) void o.entry.host.call("approval/decide", { commandId: uuidv7(), sessionId: o.sessionId, approvalId: pending.approvalId, choiceId: reject.choiceId, requirementId: pending.requirementId }).catch(() => undefined);
      } else {
        void o.entry.host.call("userInput/cancel", { commandId: uuidv7(), sessionId: o.sessionId, userInputId: pending.userInputId, reason }).catch(() => undefined);
      }
    }
    this.host.event(o.rec, "ask", { ask: pending.ask.id, phase: "closed", reason }, undefined, now);
    this.host.patch(o.rec, { ask: undefined }, now);
    const status = o.rec.session.status;
    if (status === "needs_permission" || status === "needs_input") this.host.setStatus(o.rec, "busy", now);
  }
}

/** `{window, weekly}` as usage/read and usage/changed carry them, as a profile's limits. */
export function usageLimits(v: unknown): ProfileLimits | undefined {
  if (!v || typeof v !== "object") return undefined;
  const u = v as { observedAtMs?: unknown; window?: { usedPercent?: unknown; resetsAtMs?: unknown }; weekly?: { usedPercent?: unknown; resetsAtMs?: unknown } };
  const at = typeof u.observedAtMs === "number" ? u.observedAtMs : Date.now();
  const limits: ProfileLimits = { at };
  for (const [key, w] of [
    ["session", u.window],
    ["weekly", u.weekly],
  ] as const) {
    if (!w || typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) continue;
    limits[key] = { percent: Math.max(0, w.usedPercent), ...(typeof w.resetsAtMs === "number" ? { resetsAt: w.resetsAtMs } : {}) };
  }
  return limits.session || limits.weekly ? limits : undefined;
}
