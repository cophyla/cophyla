// The Codex adapter: an app-server child per profile lists the thread store, the rollout of
// each live thread is tailed for events and stats, messages go in through
// `thread/queue/add`, and liveness comes from hooks when they are trusted and the process is
// known, and from rollout recency otherwise. A thread that ended is listed again for as long
// as it is recent, and resumed only when its rollout grew past where it was recorded to.
//
// A thread enters the store, and fires its first hook, at its first turn: a CLI sitting at an
// empty prompt is known only by its terminal (tether/cli.ts). The session's process is the
// `codex` a hook runs below, unless that is the shared app-server daemon the CLI runs its
// threads in: then the CLI marked in a terminal stands for it, found by the thread's folder.
// A new login rewrites `auth.json`, which an app-server read at its start: it starts again.

import { basename, dirname, join } from "node:path";
import { RpcError, ulid } from "@cophyla/protocol";
import type { HarnessProfile, Session, SessionStatus } from "@cophyla/protocol";
import type { HookMeta } from "../../api/hooks.ts";
import type { Logger } from "../../log.ts";
import type { ProcessArgs, ProcessTree } from "../focus.ts";
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
}

function toMs(seconds: number | null | undefined): number | undefined {
  return typeof seconds === "number" ? (seconds > 1e12 ? seconds : seconds * 1000) : undefined;
}

/** `codex app-server --listen … --managed-daemon`: the app-server a CLI starts and shares, which runs its threads. */
export function isManagedDaemon(argv: string[] | undefined): boolean {
  return argv !== undefined && argv.includes("app-server") && argv.includes("--managed-daemon");
}

export class CodexAdapter implements HarnessAdapter {
  readonly harness = "codex" as const;
  private host: SessionHost;
  private log: Logger;
  private opts: CodexAdapterOptions;
  private entries = new Map<string, ProfileEntry>();
  private queued = new Map<string, { profile: string; threadId: string; queuedSubmissionId: string }>();
  /** Whether a `codex` process is the managed daemon, read off its command line once per process. */
  private daemons = new Map<number, Promise<boolean>>();

  constructor(opts: CodexAdapterOptions) {
    this.opts = opts;
    this.host = opts.host;
    this.log = opts.log;
  }

  /** The trust outcome per profile, for the log and for tests. */
  trustStatus(profileId: string): TrustResult | undefined {
    return this.entries.get(profileId)?.trust;
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
            break;
          case "turn_context":
            if (item.approvalPolicy) rec.permissionMode = item.approvalPolicy;
            break;
          case "task_started":
            status = "busy";
            if (record) this.host.event(rec, "status", { status: "busy", turn: item.turnId }, rawIfSmall(row), item.at);
            break;
          case "task_complete":
            status = "idle";
            if (record) this.host.event(rec, "status", { status: "idle", turn: item.turnId, ...(item.lastMessage ? { lastAssistantMessage: capText(item.lastMessage, 1000) } : {}) }, rawIfSmall(row), item.at);
            break;
          case "user_message":
            if (item.clientId) {
              if (this.host.receiptByRef(rec, item.clientId) || this.host.isOwnText(rec, item.text)) break;
              if (record) this.host.event(rec, "user_turn", { text: capText(item.text), source: "queued", clientId: item.clientId }, rawIfSmall(row), item.at);
              break;
            }
            if (this.host.isOwnText(rec, item.text)) {
              this.host.receiptByText(rec, item.text);
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
    rec.lastRolloutActivity = this.host.now();
    if (meta.ppid !== undefined && !rec.ancestorsChecked && this.opts.raiser) {
      rec.ancestorsChecked = true;
      const target = rec;
      this.opts.raiser
        .ancestors(meta.ppid)
        .then(async (chain) => {
          const codex = chain.find((p) => /codex/i.test(p.name));
          this.log.debug("a codex hook's ancestors", { session: target.session.id, ppid: meta.ppid, codex: codex?.pid, chain: chain.slice(0, 6).map((p) => p.name) });
          if (!codex) return;
          if (await this.isDaemon(codex.pid)) {
            // Its process is the CLI, which only a terminal's mark tells.
            if (target.hostedBy !== "daemon") this.log.info("codex thread runs in the app-server daemon", { session: target.session.id, daemon: codex.pid });
            target.hostedBy = "daemon";
            if (target.session.status !== "ended") this.host.linkMarked(target);
            return;
          }
          delete target.hostedBy;
          if (target.session.status !== "ended" && target.session.native.pid !== codex.pid) this.host.patch(target, { native: { ...target.session.native, pid: codex.pid } });
        })
        .catch(() => {
          // focus stays unsupported for this session
        });
    }
    return rec;
  }

  /** Whether a `codex` process is the managed daemon; its command line is read once per process. */
  private isDaemon(pid: number): Promise<boolean> {
    const tree = this.opts.raiser;
    if (!tree?.commandLine) return Promise.resolve(false);
    let known = this.daemons.get(pid);
    if (!known) {
      known = tree.commandLine(pid).then(isManagedDaemon, () => false);
      this.daemons.set(pid, known);
    }
    return known;
  }
}
