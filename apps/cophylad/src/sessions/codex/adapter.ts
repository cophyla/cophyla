// The Codex adapter: an app-server child per profile lists the thread store, the rollout of
// each live thread is tailed for events and stats, messages go in through
// `thread/queue/add`, and liveness comes from hooks when they are trusted and the process is
// known, and from rollout recency otherwise. A thread that ended is listed again for as long
// as it is recent, and resumed only when its rollout grew past where it was recorded to.
//
// A thread enters the store, and fires its first hook, at its first turn: a CLI sitting at an
// empty prompt is known only by its terminal (tether/cli.ts). The session's process is the
// nearest `codex` a hook runs below, unless that is the shared app-server daemon the CLI runs
// its threads in: then the CLI marked in a terminal stands for it, found by the thread's folder.
// Which it is comes from its command line, read once per process (pid and start time); a read
// that fails says nothing, and is asked again a while later, never taken for "not the daemon".
// A record found holding a daemon's pid (from before this was so) lets it go at the next tick.
// A new login rewrites `auth.json`, which an app-server read at its start: it starts again.

import { basename, dirname, join } from "node:path";
import { RpcError, ulid } from "@cophyla/protocol";
import type { HarnessProfile, Session, SessionStatus } from "@cophyla/protocol";
import type { HookMeta } from "../../api/hooks.ts";
import type { Logger } from "../../log.ts";
import type { ProcessArgs, ProcessInfo, ProcessTree } from "../focus.ts";
import { capText, oneLine, rawIfSmall, summariseValue, TOOL_CALL_CAP, TOOL_RESULT_CAP } from "../model.ts";
import type { HarnessAdapter, HookInstallSpec, NormalisedHook, SendOutcome, SessionHost, SessionRecord } from "../model.ts";
import { isWithin } from "../paths.ts";
import type { ProfileChange } from "../profiles.ts";
import { toolResultText } from "../results.ts";
import { mtimeOf } from "../tail.ts";
import { CodexAppServer } from "./appserver.ts";
import { HOOKS_FILENAME, installCodexHooks, trustCodexHooks } from "./hooks.ts";
import type { TrustResult } from "./hooks.ts";
import { applyCodexRow, findRollout, newCodexState, readSessionIndex, statsFor } from "./rollout.ts";
import type { CodexRolloutState } from "./rollout.ts";

const LIST_LIMIT = 50;
const MAX_PAGES = 20;

interface ThreadRow {
  id: string;
  sessionId?: string;
  cwd?: string;
  name?: string | null;
  preview?: string;
  path?: string | null;
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number | null;
  status?: { type?: string };
}

interface ProfileEntry {
  profile: HarnessProfile;
  server: CodexAppServer;
  codexHome: string;
  lastList: number;
  hooksPath?: string;
  trust?: TrustResult;
  names?: Map<string, string>;
}

export interface CodexAdapterOptions {
  host: SessionHost;
  log: Logger;
  version: string;
  /**
   * The process tree: a Codex hook says its shim's parent pid, and the `codex` ancestor is the
   * session's process, unless its command line says it is the shared app-server daemon.
   */
  raiser?: ProcessTree & Partial<ProcessArgs>;
  /** The binary when a profile names none. */
  command?: string;
  env?: Record<string, string | undefined>;
  isAlive?: (pid: number) => boolean;
  /** How long a process that could not be told apart waits before it is asked about again; a test shortens it. */
  retryMs?: number;
}

const RETRY_MS = 15000;

function toMs(seconds: number | null | undefined): number | undefined {
  return typeof seconds === "number" ? (seconds > 1e12 ? seconds : seconds * 1000) : undefined;
}

/** `codex app-server --listen … --managed-daemon`: the app-server a CLI starts and shares, which runs its threads. */
export function isManagedDaemon(argv: string[] | undefined): boolean {
  return argv !== undefined && argv.includes("app-server") && argv.includes("--managed-daemon");
}

/** A thread a Codex desktop app started (`Codex Desktop`, `codex_work_desktop`): shown there, and in no terminal. */
export function desktopOriginated(originator: string | undefined): boolean {
  return originator !== undefined && /desktop/i.test(originator);
}

export class CodexAdapter implements HarnessAdapter {
  readonly harness = "codex" as const;
  private host: SessionHost;
  private log: Logger;
  private opts: CodexAdapterOptions;
  private entries = new Map<string, ProfileEntry>();
  private queued = new Map<string, { profile: string; threadId: string; queuedSubmissionId: string }>();
  /** Whether a `codex` process is the managed daemon, by `pid:startedAt`: read off its command line once, and kept only when told. */
  private daemons = new Map<string, boolean>();
  /** The reads in flight, by the same key: one read for every hook that asks meanwhile. */
  private reading = new Map<string, Promise<boolean | undefined>>();
  /** When a read last failed to tell, by the same key: not asked again until `retryMs` after. */
  private unknownAt = new Map<string, number>();
  /** A record whose process could not be told apart: its hooks ask again from then on. */
  private retryAt = new WeakMap<SessionRecord, number>();
  /** Records whose process was told apart, or is being: the tick's look at a held pid is made once. */
  private classified = new WeakSet<SessionRecord>();
  private retryMs: number;

  constructor(opts: CodexAdapterOptions) {
    this.opts = opts;
    this.host = opts.host;
    this.log = opts.log;
    this.retryMs = opts.retryMs ?? RETRY_MS;
  }

  /** The trust outcome per profile, for the log and for tests. */
  trustStatus(profileId: string): TrustResult | undefined {
    return this.entries.get(profileId)?.trust;
  }

  /** Whether a profile's threads report through cophylad's hooks, trusted: only a hook finds a thread in its terminal. */
  async hooked(profileId: string): Promise<boolean> {
    const trust = this.entries.get(profileId)?.trust;
    return trust !== undefined && trust.refused === undefined && trust.trusted > 0;
  }

  async start(profiles: HarnessProfile[], hooks: HookInstallSpec | undefined): Promise<void> {
    for (const profile of profiles) if (profile.status !== "missing") await this.add(profile, hooks);
  }

  /**
   * The profiles were rebuilt. A directory that came since gets an app-server and cophylad's
   * hooks; one that went takes its app-server with it; a new login starts the app-server
   * again, since it holds the tokens it read at its start.
   */
  async sync(profiles: HarnessProfile[], hooks: HookInstallSpec | undefined, change: ProfileChange): Promise<void> {
    const live = new Map(profiles.filter((p) => p.status !== "missing").map((p) => [p.id, p]));
    for (const [id, entry] of [...this.entries]) {
      if (live.has(id)) continue;
      this.entries.delete(id);
      await entry.server.stop();
      this.log.info("codex profile gone; its app-server stopped", { profile: id });
    }
    for (const profile of live.values()) {
      const entry = this.entries.get(profile.id);
      if (!entry) {
        this.log.info("codex profile came", { profile: profile.id, dir: profile.configDir });
        await this.add(profile, hooks);
        continue;
      }
      entry.profile = profile;
      if (change.login.includes(profile.id)) await this.relogin(entry, hooks);
    }
  }

  /** A profile's app-server, its hooks installed, and trusted through it. */
  private async add(profile: HarnessProfile, hooks: HookInstallSpec | undefined): Promise<void> {
    const server = new CodexAppServer({
      command: profile.exec?.command ?? this.opts.command ?? "codex",
      args: profile.exec?.args ?? [],
      env: { ...(this.opts.env ?? process.env), ...profile.env, CODEX_HOME: profile.configDir },
      log: this.log.child(basename(profile.configDir) || profile.name),
      version: this.opts.version,
    });
    const entry: ProfileEntry = { profile, server, codexHome: profile.configDir, lastList: 0 };
    this.entries.set(profile.id, entry);
    try {
      const init = await server.start();
      if (init.codexHome) entry.codexHome = init.codexHome;
    } catch (e) {
      this.log.warn("codex app-server did not start; will retry", { profile: profile.id, error: e instanceof Error ? e.message : String(e) });
    }
    if (!hooks) return;
    const path = join(entry.codexHome, HOOKS_FILENAME);
    try {
      installCodexHooks(path, {
        command: hooks.command("codex", profile.id, "sh"),
        commandWindows: hooks.command("codex", profile.id, "powershell"),
        timeoutS: hooks.timeoutS,
      });
      entry.hooksPath = path;
      this.log.info("codex hooks installed", { profile: profile.id, file: path });
    } catch (e) {
      this.log.error("codex hook install failed", { profile: profile.id, file: path, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (server.alive) entry.trust = await trustCodexHooks(server, { hooksPath: path, codexHome: entry.codexHome, log: this.log });
  }

  /** A new login: the app-server starts again, and hooks never trusted for want of one are trusted now. */
  private async relogin(entry: ProfileEntry, hooks: HookInstallSpec | undefined): Promise<void> {
    await entry.server.restart();
    this.log.info("codex app-server restarted for a new login", { profile: entry.profile.id });
    if (!hooks || !entry.hooksPath || entry.trust) return;
    try {
      await entry.server.start();
    } catch (e) {
      this.log.warn("codex app-server did not start; will retry", { profile: entry.profile.id, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    entry.trust = await trustCodexHooks(entry.server, { hooksPath: entry.hooksPath, codexHome: entry.codexHome, log: this.log });
  }

  async stop(): Promise<void> {
    for (const entry of this.entries.values()) await entry.server.stop();
  }

  async tick(now: number): Promise<void> {
    for (const entry of this.entries.values()) {
      if (now - entry.lastList >= this.host.config.codex_list_ms) {
        entry.lastList = now;
        try {
          await this.listThreads(entry, now);
        } catch (e) {
          this.log.warn("thread/list failed", { profile: entry.profile.id, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    for (const rec of this.host.records("codex")) {
      const entry = this.entries.get(rec.session.profile);
      this.tailRollout(rec, entry, now);
      this.checkLiveness(rec, now);
      this.heal(rec);
    }
    // What was learnt of a process goes with it.
    const isAlive = this.opts.isAlive;
    if (isAlive) {
      for (const key of [...this.daemons.keys(), ...this.unknownAt.keys()]) {
        if (isAlive(Number(key.split(":")[0]))) continue;
        this.daemons.delete(key);
        this.unknownAt.delete(key);
      }
    }
  }

  private async listThreads(entry: ProfileEntry, now: number): Promise<void> {
    entry.names = readSessionIndex(entry.codexHome);
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await entry.server.call<{ data?: ThreadRow[]; nextCursor?: string | null }>("thread/list", {
        limit: LIST_LIMIT,
        ...(cursor ? { cursor } : {}),
        sortKey: "updated_at",
        sortDirection: "desc",
        useStateDbOnly: true,
      });
      const rows = r?.data ?? [];
      let stop = rows.length === 0;
      for (const t of rows) {
        if (!t.id) continue;
        const updated = toMs(t.updatedAt) ?? toMs(t.recencyAt) ?? 0;
        const known = this.host.find("codex", t.id);
        if (known && known.session.native.transport === "acp") continue;
        const recent = now - updated <= this.host.config.codex_recent_ms;
        // Rows come newest first: past a stale one, only threads still live are refreshed.
        if (!recent && (!known || known.session.status === "ended")) {
          stop = true;
          continue;
        }
        const title = t.name ?? entry.names.get(t.id);
        const rec = this.host.ensure({
          harness: "codex",
          nativeId: t.id,
          profile: entry.profile.id,
          cwd: t.cwd ?? known?.session.cwd ?? entry.codexHome,
          transport: "app-server",
          ...(t.path ? { transcriptPath: t.path } : {}),
          ...(title ? { title } : {}),
          ...(t.preview ? { intent: oneLine(t.preview) } : {}),
          ...(toMs(t.createdAt) !== undefined ? { startedAt: toMs(t.createdAt)! } : {}),
          ...(updated > 0 ? { activeAt: updated } : {}),
          handles: { configDir: entry.codexHome },
        });
        // Listed again with nothing new since it ended: it stays ended.
        if (rec.session.status === "ended") continue;
        rec.lastRolloutActivity = Math.max(rec.lastRolloutActivity ?? 0, updated);
        if (title && rec.session.title !== title) this.host.patch(rec, { title }, now);
        if (t.status?.type === "active") this.host.setStatus(rec, "busy", now);
      }
      cursor = r?.nextCursor;
      if (stop || !cursor) break;
    }
  }

  private tailRollout(rec: SessionRecord, entry: ProfileEntry | undefined, now: number): void {
    let path = rec.session.transcript?.path;
    if (!path && entry) {
      const found = findRollout(entry.codexHome, rec.session.native.id);
      if (found) {
        this.host.patch(rec, { transcript: { path: found } }, now);
        path = found;
      }
    }
    if (!path) return;
    let tail = rec.tail;
    if (!tail || tail.path !== path) {
      tail = this.host.openTail(rec, path);
      rec.parser = newCodexState();
      this.host.watch(dirname(path));
      // What a fresh tail reads first is history: it counts by when the file last changed.
      const mtime = mtimeOf(path);
      if (mtime !== undefined) rec.lastRolloutActivity = Math.max(rec.lastRolloutActivity ?? 0, mtime);
    }
    const state = rec.parser as CodexRolloutState;
    const lines = tail.read();
    if (lines.length === 0) return;
    if (lines.some((l) => l.offset >= tail.initialSize)) rec.lastRolloutActivity = now;
    const recordFrom = tail.recordFrom;
    const patch: Partial<Session> = {};
    let status: SessionStatus | undefined;
    for (const line of lines) {
      let row: unknown;
      try {
        row = JSON.parse(line.text);
      } catch {
        continue;
      }
      const record = line.offset >= recordFrom;
      for (const item of applyCodexRow(state, row)) {
        switch (item.kind) {
          case "meta":
            if (rec.session.cwd !== item.cwd) patch.cwd = item.cwd;
            if (item.originator !== undefined && rec.originator !== item.originator) {
              rec.originator = item.originator;
              // A desktop app's thread that took a CLI's terminal gives it back, and the CLI's pid.
              if (desktopOriginated(item.originator) && rec.hostedBy && rec.session.native.terminal) {
                const { terminal: _terminal, pid: _pid, ...native } = rec.session.native;
                patch.native = native;
              }
            }
            break;
          case "turn_context":
            if (item.approvalPolicy) rec.permissionMode = item.approvalPolicy;
            if (item.sandbox) rec.sandbox = item.sandbox;
            break;
          case "task_started":
            status = "busy";
            if (record) this.host.event(rec, "status", { status: "busy", turn: item.turnId }, rawIfSmall(row), item.at);
            break;
          case "task_complete":
            status = "idle";
            if (record) this.host.event(rec, "status", { status: "idle", turn: item.turnId, ...(item.lastMessage ? { lastAssistantMessage: capText(item.lastMessage, 2000) } : {}) }, rawIfSmall(row), item.at);
            break;
          case "user_message":
            if (item.clientId) {
              if (this.host.receiptByRef(rec, item.clientId)) break;
              if (this.host.isOwnText(rec, item.text)) {
                if (!this.host.receiptByText(rec, item.text) && record) this.host.agentEcho(rec, item.text, rawIfSmall(row), item.at);
                break;
              }
              if (record) this.host.event(rec, "user_turn", { text: capText(item.text), source: "queued", clientId: item.clientId }, rawIfSmall(row), item.at);
              break;
            }
            if (this.host.isOwnText(rec, item.text)) {
              if (!this.host.receiptByText(rec, item.text) && record) this.host.agentEcho(rec, item.text, rawIfSmall(row), item.at);
              break;
            }
            if (rec.session.intent === undefined && patch.intent === undefined && item.text.trim()) patch.intent = oneLine(item.text);
            else if (rec.session.intent !== undefined && !rec.parser) patch.intent = oneLine(item.text);
            if (record) this.host.event(rec, "user_turn", { text: capText(item.text), source: "typed" }, rawIfSmall(row), item.at);
            break;
          case "assistant_text":
            if (record) this.host.event(rec, "assistant_text", { text: capText(item.text) }, rawIfSmall(row), item.at);
            break;
          case "tool_call": {
            if (!record) break;
            const input = summariseValue(item.input, TOOL_CALL_CAP);
            this.host.event(rec, "tool_call", { tool: item.name, id: item.callId, args: input.value, ...(input.truncated ? { truncated: true } : {}) }, rawIfSmall(row), item.at);
            break;
          }
          case "tool_result": {
            if (!record) break;
            const fromHook = rec.hookTools.get(item.callId);
            if (fromHook !== undefined) {
              rec.hookTools.delete(item.callId);
              break;
            }
            const result = summariseValue(toolResultText("codex", item.name, item.output), TOOL_RESULT_CAP);
            this.host.event(rec, "tool_result", { tool: item.name, id: item.callId, result: result.value, ...(result.truncated ? { truncated: true } : {}) }, rawIfSmall(row), item.at);
            break;
          }
        }
      }
    }
    if (state.statsChanged) {
      state.statsChanged = false;
      patch.stats = statsFor(state);
    }
    if (Object.keys(patch).length > 0) this.host.patch(rec, patch, now);
    if (status) this.host.setStatus(rec, status, now);
    this.host.tailed(rec);
  }

  drain(rec: SessionRecord, now: number): void {
    this.tailRollout(rec, this.entries.get(rec.session.profile), now);
  }

  readNow(rec: SessionRecord, now: number): void {
    this.tailRollout(rec, this.entries.get(rec.session.profile), now);
  }

  /**
   * Without a hook, a thread is live while its rollout moved within the window; with one and
   * its process known, until SessionEnd or a dead process. A hook session whose process is not
   * known (not found yet, or a resume) is judged by the window too, each hook counting as
   * activity, or nothing would ever end it.
   */
  private checkLiveness(rec: SessionRecord, now: number): void {
    const pid = rec.session.native.pid;
    if (rec.liveness === "hook" && pid !== undefined) {
      if (this.opts.isAlive && !this.opts.isAlive(pid)) this.host.end(rec, "gone", now);
      return;
    }
    const last = rec.lastRolloutActivity ?? rec.session.lastActivity;
    if (now - last > this.host.config.codex_recent_ms) this.host.end(rec, "inactive", now);
  }

  async send(rec: SessionRecord, text: string, ref: string): Promise<SendOutcome> {
    const entry = this.entries.get(rec.session.profile);
    if (!entry) throw new RpcError("unavailable", "no app-server for the session's profile");
    const threadId = rec.session.native.id;
    const r = await entry.server.call<{ queuedSubmission?: { id: string } }>("thread/queue/add", {
      threadId,
      clientUserMessageId: ref,
      input: [{ type: "text", text }],
    });
    const id = r?.queuedSubmission?.id ?? ref;
    this.queued.set(ref, { profile: entry.profile.id, threadId, queuedSubmissionId: id });
    return { status: "queued" };
  }

  async withdraw(rec: SessionRecord, ref: string): Promise<void> {
    const q = this.queued.get(ref);
    this.queued.delete(ref);
    const entry = this.entries.get(q?.profile ?? rec.session.profile);
    if (!q || !entry) return;
    await entry.server.call("thread/queue/delete", { threadId: q.threadId, queuedSubmissionId: q.queuedSubmissionId });
  }

  onHook(hook: NormalisedHook, rec: SessionRecord | undefined, meta: HookMeta): SessionRecord | undefined {
    if (!rec) {
      // A CLI quit before its first prompt ends a thread that never started: no session.
      if (hook.name === "SessionEnd") return undefined;
      const byHint = meta.profile ? this.entries.get(meta.profile) : undefined;
      const byDir = hook.transcriptPath ? [...this.entries.values()].find((e) => isWithin(hook.transcriptPath!, e.codexHome)) : undefined;
      const entry = byHint ?? byDir ?? [...this.entries.values()].find((e) => e.profile.default) ?? [...this.entries.values()][0];
      if (!entry) return undefined;
      this.log.info("codex session known from its hook", { session: hook.sessionId, profile: entry.profile.id, event: hook.name });
      rec = this.host.ensure({
        harness: "codex",
        nativeId: hook.sessionId,
        profile: entry.profile.id,
        cwd: hook.cwd ?? entry.codexHome,
        transport: "app-server",
        status: hook.name === "SessionStart" ? "idle" : "busy",
        ...(hook.transcriptPath ? { transcriptPath: hook.transcriptPath } : {}),
        handles: { configDir: entry.codexHome },
        liveness: "hook",
      });
    }
    rec.liveness = "hook";
    const now = this.host.now();
    rec.lastRolloutActivity = now;
    if (meta.ppid !== undefined && !rec.ancestorsChecked && this.opts.raiser && (this.retryAt.get(rec) ?? -Infinity) <= now) {
      rec.ancestorsChecked = true;
      const target = rec;
      this.classify(target, meta.ppid, this.opts.raiser).catch((e: unknown) => this.log.warn("a codex hook's process was not told apart", { session: target.session.id, error: e instanceof Error ? e.message : String(e) }));
    }
    return rec;
  }

  /**
   * The nearest `codex` above a hook's shim, which is what ran the hook: the daemon makes the
   * record hosted, and its terminal and process the CLI's; any other `codex` (the CLI itself,
   * or a `codex exec` a daemon thread runs as a tool) is the session's process. What cannot be
   * told yet changes nothing, and a hook asks again once `retryMs` has passed.
   */
  private async classify(target: SessionRecord, ppid: number, tree: ProcessTree & Partial<ProcessArgs>): Promise<void> {
    const unknown = () => {
      target.ancestorsChecked = false;
      this.retryAt.set(target, this.host.now() + this.retryMs);
    };
    let chain: ProcessInfo[];
    try {
      chain = await tree.ancestors(ppid);
    } catch {
      return unknown();
    }
    if (chain.length === 0) return unknown();
    const codex = chain.find((p) => /codex/i.test(p.name));
    this.log.debug("a codex hook's ancestors", { session: target.session.id, ppid, codex: codex?.pid, chain: chain.slice(0, 6).map((p) => p.name) });
    if (!codex) return;
    const daemon = await this.isDaemon(codex.pid, codex.startedAt);
    if (daemon === undefined) return unknown();
    this.classified.add(target);
    if (daemon) return this.hosted(target, codex.pid, true);
    const was = target.hostedBy;
    delete target.hostedBy;
    if (target.session.status === "ended" || target.session.native.pid === codex.pid) return;
    // A terminal a CLI's mark gave it goes with the CLI's pid.
    const { terminal: _cli, ...native } = target.session.native;
    this.host.patch(target, { native: { ...(was ? native : target.session.native), pid: codex.pid } });
  }

  /**
   * A record whose thread the daemon runs: its process is the CLI, which only a terminal's mark
   * tells. A pid it holds that is a daemon's (this one, or the one an update replaced) is let go
   * with any terminal found by it, then the CLI's terminal is looked for.
   */
  private async hosted(target: SessionRecord, daemon: number, handOver: boolean): Promise<void> {
    if (target.hostedBy !== "daemon") this.log.info("codex thread runs in the app-server daemon", { session: target.session.id, daemon });
    target.hostedBy = "daemon";
    // Asked again after each wait: the record may have ended meanwhile.
    const ended = () => target.session.status === "ended";
    if (ended()) return;
    const pid = target.session.native.pid;
    if (pid !== undefined && (pid === daemon || (await this.isDaemon(pid)) === true) && target.session.native.pid === pid && !ended()) {
      const { pid: _daemon, terminal: _terminal, ...native } = target.session.native;
      this.host.patch(target, { native });
      this.log.info("a codex session held a daemon's pid; let go", { session: target.session.id, pid });
    }
    if (!ended()) this.host.linkMarked(target, { handOver });
  }

  /**
   * A live record holding a pid no hook has told apart (one met again from the store, say) is
   * looked at once: a daemon's pid makes it hosted, never its process to end.
   */
  private heal(rec: SessionRecord): void {
    const pid = rec.session.native.pid;
    if (pid === undefined || rec.hostedBy || rec.session.status === "ended" || this.classified.has(rec) || !this.opts.raiser?.commandLine) return;
    this.classified.add(rec);
    this.isDaemon(pid)
      .then((daemon) => {
        if (daemon === undefined) this.classified.delete(rec);
        else if (daemon && rec.session.native.pid === pid && rec.session.status !== "ended") return this.hosted(rec, pid, false);
      })
      .catch((e: unknown) => this.log.warn("a codex session's pid was not told apart", { session: rec.session.id, error: e instanceof Error ? e.message : String(e) }));
  }

  /**
   * Whether a `codex` process is the managed daemon, from its command line: `undefined` when
   * that could not be read, which is not taken for an answer. One read per process (its pid and
   * start time), shared by everything asking meanwhile; after one that failed, none for `retryMs`.
   */
  private isDaemon(pid: number, startedAt?: number): Promise<boolean | undefined> {
    const tree = this.opts.raiser;
    if (!tree?.commandLine) return Promise.resolve(false);
    const key = `${pid}:${startedAt ?? ""}`;
    const known = this.daemons.get(key);
    if (known !== undefined) return Promise.resolve(known);
    const reading = this.reading.get(key);
    if (reading) return reading;
    const failed = this.unknownAt.get(key);
    if (failed !== undefined && this.host.now() - failed < this.retryMs) return Promise.resolve(undefined);
    const read = tree
      .commandLine(pid)
      .then(
        (argv) => (argv === undefined ? undefined : isManagedDaemon(argv)),
        () => undefined,
      )
      .then((answer) => {
        this.reading.delete(key);
        if (answer !== undefined) {
          this.daemons.set(key, answer);
          this.unknownAt.delete(key);
        } else {
          if (!this.unknownAt.has(key)) this.log.info("a codex process's command line could not be read; asked again later", { pid });
          this.unknownAt.set(key, this.host.now());
        }
        return answer;
      });
    this.reading.set(key, read);
    return read;
  }
}
