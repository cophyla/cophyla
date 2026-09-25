// The Claude Code adapter: discovery from each profile's session registry, status from the
// registry refined by hooks, the transcript tailed for events and stats, injection over the
// messaging pipe, and cophylad's hooks installed in each profile's settings while it runs. A
// session known only from its hooks has its process looked up through the hook shim's
// ancestors; while none is known it stays live as long as its hooks keep coming.
//
// A conversation sent to the background (`/bg`, or ← into the agents screen) goes on as a job
// under Claude's own daemon, forked under a new session id. Its old transcript says where, in a
// `continued-in` row, and the record follows it there: the tab the user knew carries on as the
// job. The window it left either exits or shows the agents screen, which is a terminal of
// Claude's agents, not a session; the daemon's spare process is no session either.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HarnessProfile, Session, SessionStats, SessionWaiting, TerminalRef } from "@cophyla/protocol";
import type { HookMeta } from "../../api/hooks.ts";
import type { Logger } from "../../log.ts";
import type { ProcessTree } from "../focus.ts";
import { capText, oneLine, rawIfSmall, summariseValue, toolKey, TOOL_CALL_CAP, TOOL_RESULT_CAP } from "../model.ts";
import type { HarnessAdapter, HookInstallSpec, NormalisedHook, SendOutcome, SessionHost, SessionRecord } from "../model.ts";
import { isWithin } from "../paths.ts";
import { acceptsCrossSessionInbound, installClaudeHooks, uninstallClaudeHooks } from "./hooks.ts";
import type { ClaudeHookOwner } from "./hooks.ts";
import { injectClaude } from "./inject.ts";
import { classify, isAlive as defaultIsAlive, jobCreatedAt, readEntry, readRegistry, statusOf, transcriptPathFor, waitingOf } from "./registry.ts";
import type { ClaudeLive, IsAlive } from "./registry.ts";
import { applyClaudeRow, newClaudeState, rowAt, statsFor } from "./transcript.ts";
import type { ClaudeTranscriptState } from "./transcript.ts";

/** A tool result from a hook suppresses the transcript's copy for this long. */
const HOOK_TOOL_TTL_MS = 120000;
/** How long a conversation sent to the background waits for its job to register before it counts as gone. */
const CONTINUE_GRACE_MS = 60000;
/** How long a turn's Stop waits for the registry to say what the session waits on, a read at a time. */
const STOP_POLL_MS = 50;
const STOP_POLLS = 10;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ClaudeAdapterOptions {
  host: SessionHost;
  log: Logger;
  isAlive?: IsAlive;
  inject?: typeof injectClaude;
  /** The shared settings file a bypass session may also load; `~/.claude/settings.json` by default. */
  sharedSettings?: string;
  /** The process tree: a command-mode hook says its shim's parent pid, and the `claude` ancestor is the session's process. */
  raiser?: ProcessTree;
}

/**
 * A session cophylad started in a terminal, waiting to be met in a registry. The session id was
 * decided before the terminal opened, so the entry that carries it is known to be this one
 * and not a session of the user's, and it is seeded with what it was started for.
 */
export interface ExpectedSession {
  workspace?: string;
  task?: string;
  intent?: string;
  /** The tether terminal it was started in. */
  terminal?: TerminalRef;
  /** Given up on after this: the terminal never opened, or the session was closed unread. */
  expiresAt: number;
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly harness = "claude" as const;
  private host: SessionHost;
  private log: Logger;
  private isAlive: IsAlive;
  private inject: typeof injectClaude;
  private raiser: ProcessTree | undefined;
  private profiles: HarnessProfile[] = [];
  private sharedSettings: string;
  /** Sessions cophylad started in a terminal, by the session id it gave them. */
  private expected = new Map<string, ExpectedSession>();
  /** What this daemon wrote, by settings file: one owner per profile installed there. */
  private installed = new Map<string, ClaudeHookOwner[]>();

  constructor(opts: ClaudeAdapterOptions) {
    this.host = opts.host;
    this.log = opts.log;
    this.isAlive = opts.isAlive ?? defaultIsAlive;
    this.inject = opts.inject ?? injectClaude;
    this.sharedSettings = opts.sharedSettings ?? join(homedir(), ".claude", "settings.json");
    this.raiser = opts.raiser;
  }

  /** Says that a session with this id is being started in a terminal, and what for. */
  expect(sessionId: string, what: ExpectedSession): void {
    this.expected.set(sessionId, what);
  }

  /** Stops waiting for one: it arrived, or it never will. */
  unexpect(sessionId: string): void {
    this.expected.delete(sessionId);
  }

  /** What a registry entry was started for, once, and only while it is still owed. */
  private claimExpected(sessionId: string, now: number): ExpectedSession | undefined {
    const what = this.expected.get(sessionId);
    if (!what) return undefined;
    this.expected.delete(sessionId);
    return what.expiresAt >= now ? what : undefined;
  }

  async start(profiles: HarnessProfile[], hooks: HookInstallSpec | undefined): Promise<void> {
    this.profiles = profiles.filter((p) => p.status !== "missing");
    if (!hooks) return;
    for (const p of this.profiles) this.install(p, hooks);
  }

  /**
   * The profiles were rebuilt: the registries read are the ones there now, and a directory that
   * came since gets cophylad's hooks. One already holding them is left alone.
   */
  async sync(profiles: HarnessProfile[], hooks: HookInstallSpec | undefined): Promise<void> {
    this.profiles = profiles.filter((p) => p.status !== "missing");
    if (!hooks) return;
    for (const p of this.profiles) if (!this.installed.has(join(p.configDir, "settings.json"))) this.install(p, hooks);
  }

  private install(p: HarnessProfile, hooks: HookInstallSpec): void {
    const settings = join(p.configDir, "settings.json");
    const mode = hooks.mode(p.id);
    const url = hooks.url + "claude";
    const command = mode === "command" ? hooks.command("claude", p.id) : undefined;
    try {
      installClaudeHooks(settings, {
        mode,
        url,
        token: hooks.token,
        timeoutS: hooks.timeoutS,
        profileId: p.id,
        ...(command !== undefined ? { command } : {}),
      });
      const owners = this.installed.get(settings) ?? [];
      owners.push({ url, ...(command !== undefined ? { command } : {}) });
      this.installed.set(settings, owners);
      this.log.info("claude hooks installed", { profile: p.id, settings, mode });
    } catch (e) {
      this.log.error("claude hook install failed", { profile: p.id, settings, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Takes the hooks back out. A dead endpoint is not silent: Claude Code reports a hook error
   * in the session on every event it cannot deliver, so a daemon that leaves its own behind
   * makes noise in every session for as long as it is down. It watches `settings.json`, so an
   * open session falls quiet within seconds of this, and picks the hooks up again within
   * seconds of the next start. Only this daemon's handlers go; another daemon against the same
   * file keeps its own, and so does every other tool.
   */
  async stop(): Promise<void> {
    for (const [settings, owners] of this.installed) {
      try {
        uninstallClaudeHooks(settings, owners);
        this.log.info("claude hooks removed", { settings });
      } catch (e) {
        this.log.error("claude hook removal failed", { settings, error: e instanceof Error ? e.message : String(e) });
      }
    }
    this.installed.clear();
  }

  async tick(now: number): Promise<void> {
    const seen = new Set<string>();
    const spares = new Set<number>();
    const windows: { pid: number }[] = [];
    for (const profile of this.profiles) {
      const dir = join(profile.configDir, "sessions");
      // Every write there reaches the rail at once, not on the next poll.
      this.host.watch(dir);
      const entries = classify(readRegistry(dir, this.isAlive));
      for (const s of entries.spares) spares.add(s.pid);
      const running = new Set(entries.sessions.map((e) => e.sessionId));
      // Before the sessions, so a job whose window parked meets the record that followed it.
      for (const w of entries.parked) {
        this.parked(w, entries.sessions, profile, now);
        windows.push({ pid: w.pid });
      }
      for (const live of entries.sessions) {
        const rec = this.meet(live, profile, running, now);
        if (rec && rec.session.status !== "ended") seen.add(rec.session.id);
      }
    }
    this.host.agentWindows("claude", windows);
    for (const rec of this.host.records("claude")) {
      if (seen.has(rec.session.id)) continue;
      const pid = rec.session.native.pid;
      // A record of the daemon's spare, from before spares were told apart.
      if (pid !== undefined && spares.has(pid)) {
        this.host.end(rec, "spare", now);
        continue;
      }
      // Its conversation went on as a job that has not registered yet: its process may be gone.
      if (rec.continuing) {
        if (now <= rec.continuing.until) continue;
        this.log.warn("a conversation sent to the background never turned up as a job", { session: rec.session.id, job: rec.continuing.to });
        delete rec.continuing;
        this.host.end(rec, "gone", now);
        continue;
      }
      if (pid !== undefined) {
        if (!this.isAlive(pid)) this.host.end(rec, "gone", now);
        continue;
      }
      // Known only from its hooks, with no process to watch: live while they keep coming.
      const last = rec.lastHookAt ?? rec.session.lastActivity;
      if (now - last > this.host.config.claude_hook_grace_ms) this.host.end(rec, "inactive", now);
    }
    for (const rec of this.host.records("claude")) this.tailTranscript(rec, now);
  }

  /**
   * A conversation's entry, met: the record it stands for, made or refreshed, with its status and
   * what it waits on; an ended one as it is (a hook may revive it). `undefined` for one the ACP
   * adapter owns, and for a job held back a moment (`continuation`).
   */
  private meet(live: ClaudeLive, profile: HarnessProfile, running: Set<string>, now: number, transcriptPath?: string): SessionRecord | undefined {
    const continued = this.host.find("claude", live.sessionId) ? undefined : this.continuation(live, running, now);
    if (continued === "wait") return undefined;
    const owned = this.host.find("claude", live.sessionId) ?? this.followRekey(live, now);
    if (owned && owned.session.native.transport === "acp") return undefined;
    // A session cophylad opened a terminal for is met here like any other, and is told apart
    // from the user's own only by the id it was started with.
    const expected = owned ? undefined : this.claimExpected(live.sessionId, now);
    const rec = this.host.ensure({
      harness: "claude",
      nativeId: live.sessionId,
      profile: profile.id,
      cwd: live.cwd,
      transport: "pipe",
      pid: live.pid,
      startedAt: live.startedAt,
      status: statusOf(live),
      ...(live.name ? { title: live.name } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
      // A job that was a spare ran since its record ended as one.
      ...(live.jobId !== undefined ? { job: live.jobId, ...(live.statusUpdatedAt !== undefined ? { activeAt: live.statusUpdatedAt } : {}) } : {}),
      ...(expected ? { origin: "orchestrator" as const, ...(expected.workspace !== undefined ? { workspace: expected.workspace } : {}), ...(expected.task !== undefined ? { task: expected.task } : {}), ...(expected.intent !== undefined ? { intent: expected.intent } : {}), ...(expected.terminal ? { terminal: expected.terminal } : {}) } : {}),
      handles: { pipe: live.messagingSocketPath, token: live.peerToken, configDir: profile.configDir, startedAt: live.startedAt, ...(live.procStart !== undefined ? { procStart: live.procStart } : {}) },
    });
    // Still listed under the process it ended in: a session on its way out, not a resume.
    if (rec.session.status === "ended") return rec;
    if (expected) this.log.info("terminal session met", { session: rec.session.id, native: live.sessionId, pid: live.pid, workspace: expected.workspace, task: expected.task });
    // A job's transcript opens with the history it was forked with, already recorded.
    if (live.jobId !== undefined && rec.copiedBefore === undefined) rec.copiedBefore = jobCreatedAt(profile.configDir, live.jobId) ?? 0;
    this.host.setStatus(rec, statusOf(live), now, { waiting: waitingOf(live) });
    if (!rec.session.transcript) {
      const path = transcriptPathFor(profile.configDir, live.cwd, live.sessionId);
      if (existsSync(path)) this.host.patch(rec, { transcript: { path } }, now);
    }
    return rec;
  }

  /**
   * The record a new job is the continuation of: one whose transcript said its conversation went
   * on under the job's session id. Its window has let go of it by now (exited, or parked on the
   * agents screen); while the window still runs it as a session, the job waits (`wait`) for
   * the window to catch up, and past the grace period it is a session of its own after all.
   */
  private continuation(live: ClaudeLive, running: Set<string>, now: number): SessionRecord | "wait" | undefined {
    const rec = this.host.records("claude").find((r) => r.continuing?.to === live.sessionId);
    if (!rec?.continuing) return undefined;
    if (running.has(rec.session.native.id)) {
      if (now <= rec.continuing.until) return "wait";
      delete rec.continuing;
      return undefined;
    }
    this.log.info("conversation went on as a background job", { session: rec.session.id, from: rec.session.native.id, to: live.sessionId, job: live.jobId, pid: live.pid });
    this.host.background(rec, live.sessionId, now);
    return rec;
  }

  /**
   * A window showing the agents screen. Its conversation's record goes on as the job it parked,
   * when that job's entry is there: moved onto it, or, when the job has a record already (met
   * before the window's transcript said where it went, or by an older daemon), merged into that
   * one. Until the job registers the record is left as it is, and takes no status from the window.
   */
  private parked(w: ClaudeLive, sessions: ClaudeLive[], profile: HarnessProfile, now: number): void {
    const rec = this.host.records("claude").find((r) => r.session.native.pid === w.pid && r.session.native.id === w.sessionId);
    const job = sessions.find((e) => e.jobId === w.parkedJobId);
    if (!rec || !job) return;
    const other = this.host.find("claude", job.sessionId);
    if (other === rec) return;
    if (other) {
      this.log.info("a parked conversation's job has a record of its own; merged into it", { session: rec.session.id, into: other.session.id, job: w.parkedJobId });
      this.host.merge(rec, other, now);
      return;
    }
    this.log.info("parked conversation follows its job", { session: rec.session.id, job: w.parkedJobId, to: job.sessionId });
    this.host.background(rec, job.sessionId, now);
    rec.copiedBefore = jobCreatedAt(profile.configDir, job.jobId!) ?? 0;
  }

  /**
   * A transcript said its conversation went on as `to` (a job forked from it) and no turn was
   * taken here since. Only a row the record's own process wrote counts: one from before it
   * started is an old sending-off of a conversation resumed here since. When the job has a
   * record already, that one takes this one's place; else this one waits for the job.
   */
  private continued(rec: SessionRecord, on: { to: string; at: number }, now: number): void {
    if (rec.continuing?.to === on.to || on.to === rec.session.native.id) return;
    if (rec.handles.startedAt !== undefined && on.at < rec.handles.startedAt) return;
    const other = this.host.find("claude", on.to);
    if (other === rec) return;
    if (other) {
      if (other.session.status === "ended") return;
      this.log.info("a conversation went on as a job that has a record already; merged into it", { session: rec.session.id, into: other.session.id });
      this.host.merge(rec, other, now);
      return;
    }
    this.log.info("conversation sent to the background; waiting for its job", { session: rec.session.id, to: on.to });
    rec.continuing = { to: on.to, at: on.at, until: now + CONTINUE_GRACE_MS };
  }

  /**
   * What a session whose turn just stopped waits on, by its registry entry. Read at once, and
   * while the entry still says busy, again every 50 ms for up to half a second: Claude writes it
   * about when the Stop hook fires, now just before, now just after.
   */
  afterStop(rec: SessionRecord): SessionWaiting | undefined | Promise<SessionWaiting | undefined> {
    const pid = rec.session.native.pid;
    const dir = rec.handles.configDir;
    if (pid === undefined || !dir) return undefined;
    const read = (): { settled: boolean; waiting?: SessionWaiting } => {
      const e = readEntry(join(dir, "sessions"), pid);
      if (!e || e.sessionId !== rec.session.native.id) return { settled: true };
      if (e.status === "busy") return { settled: false };
      const waiting = waitingOf(e);
      return { settled: true, ...(waiting ? { waiting } : {}) };
    };
    const first = read();
    if (first.settled) return first.waiting;
    return (async () => {
      for (let i = 0; i < STOP_POLLS; i++) {
        await sleep(STOP_POLL_MS);
        const r = read();
        if (r.settled) return r.waiting;
      }
      return undefined;
    })();
  }

  /**
   * A registry entry with an id nobody has, written by a process a record already stands
   * for: the session cleared its context (`/clear`, or a plan's clear-context row) or resumed
   * another, and the CLI rewrote its entry under the new id. The record follows it. The
   * process start time, when the registry gives one, tells the same process from a new one
   * that reused the pid.
   */
  private followRekey(live: ClaudeLive, now: number): SessionRecord | undefined {
    const rec = this.host.records("claude").find((r) => r.session.native.pid === live.pid && r.session.native.id !== live.sessionId && (r.handles.procStart === undefined || live.procStart === undefined || r.handles.procStart === live.procStart));
    if (!rec) return undefined;
    this.log.info("session id changed in the same process", { session: rec.session.id, from: rec.session.native.id, to: live.sessionId, pid: live.pid });
    this.host.rekey(rec, live.sessionId, now);
    return rec;
  }

  private tailTranscript(rec: SessionRecord, now: number): void {
    const path = rec.session.transcript?.path;
    if (!path) return;
    let tail = rec.tail;
    if (!tail || tail.path !== path) {
      tail = this.host.openTail(rec, path);
      rec.parser = newClaudeState();
      this.host.watch(dirname(path));
    }
    const state = rec.parser as ClaudeTranscriptState;
    const lines = tail.read();
    if (lines.length === 0) return;
    const recordFrom = tail.recordFrom;
    const patch: Partial<Session> = {};
    for (const line of lines) {
      let row: unknown;
      try {
        row = JSON.parse(line.text);
      } catch {
        continue;
      }
      const record = line.offset >= recordFrom;
      // History a job was forked with: counted in its stats, but recorded under the old id already.
      const copied = rec.copiedBefore !== undefined && (rowAt(row) ?? Infinity) < rec.copiedBefore;
      for (const item of applyClaudeRow(state, row)) {
        if (copied) continue;
        switch (item.kind) {
          case "user_turn":
            if (this.host.isOwnText(rec, item.text, item.promptId)) {
              this.host.receiptByText(rec, item.text, item.promptId);
              break;
            }
            if (rec.session.intent === undefined && patch.intent === undefined) patch.intent = oneLine(item.text);
            if (record) this.host.event(rec, "user_turn", { text: capText(item.text), source: "typed", ...(item.promptId ? { promptId: item.promptId } : {}) }, rawIfSmall(row), item.at);
            break;
          case "peer":
            if (item.from === "cophylad" || this.host.isOwnText(rec, item.text)) {
              this.host.receiptByText(rec, item.text);
              break;
            }
            if (record) this.host.event(rec, "user_turn", { text: capText(item.text), source: "peer", from: item.from }, rawIfSmall(row), item.at);
            break;
          case "assistant_text":
            if (record) this.host.event(rec, "assistant_text", { text: capText(item.text) }, rawIfSmall(row), item.at);
            break;
          case "tool_call": {
            if (!record) break;
            const input = summariseValue(item.input, TOOL_CALL_CAP);
            this.host.event(rec, "tool_call", { tool: item.name, id: item.id, args: input.value, ...(input.truncated ? { truncated: true } : {}) }, rawIfSmall(row), item.at);
            break;
          }
          case "tool_result": {
            if (!record) break;
            const key = toolKey(item.name, item.input);
            const fromHook = rec.hookTools.get(key);
            if (fromHook !== undefined && now - fromHook <= HOOK_TOOL_TTL_MS) {
              rec.hookTools.delete(key);
              break;
            }
            const result = summariseValue(item.content, TOOL_RESULT_CAP);
            this.host.event(rec, "tool_result", { tool: item.name, id: item.id, result: result.value, ...(result.truncated ? { truncated: true } : {}), ...(item.isError ? { isError: true } : {}) }, rawIfSmall(row), item.at);
            break;
          }
          case "title":
            patch.title = item.title;
            break;
          case "permission_mode":
            rec.permissionMode = item.mode;
            (rec.modesSeen ??= new Set()).add(item.mode);
            break;
          case "queue":
            if (record && item.operation === "enqueue" && item.content && !this.host.isOwnText(rec, item.content)) {
              this.host.event(rec, "notification", { type: "queued", text: capText(item.content, 1000) }, rawIfSmall(row), item.at);
            }
            break;
        }
      }
    }
    if (state.statsChanged) {
      state.statsChanged = false;
      patch.stats = countOn(rec.statsBase, statsFor(state));
    }
    if (Object.keys(patch).length > 0) this.host.patch(rec, patch, now);
    this.host.tailed(rec);
    if (state.continuedIn) this.continued(rec, state.continuedIn, now);
    // A turn taken here since: the conversation goes on in its window after all.
    else if (rec.continuing) delete rec.continuing;
  }

  drain(rec: SessionRecord, now: number): void {
    this.tailTranscript(rec, now);
  }

  async send(rec: SessionRecord, text: string, _ref: string): Promise<SendOutcome> {
    const pipe = rec.handles.pipe;
    const token = rec.handles.token;
    if (!pipe || !token) throw new Error("the session's messaging pipe is not known yet");
    await this.inject(pipe, token, text);
    const held = rec.permissionMode === "bypassPermissions" && !this.acceptsInbound(rec);
    return { status: held ? "held" : "queued" };
  }

  private acceptsInbound(rec: SessionRecord): boolean {
    const dirs = new Set<string>();
    if (rec.handles.configDir) dirs.add(join(rec.handles.configDir, "settings.json"));
    dirs.add(this.sharedSettings);
    for (const path of dirs) if (acceptsCrossSessionInbound(path)) return true;
    return false;
  }

  onHook(hook: NormalisedHook, rec: SessionRecord | undefined, meta: HookMeta): SessionRecord | undefined {
    const found = rec ?? this.resolve(hook, meta);
    if (!found) return undefined;
    found.lastHookAt = this.host.now();
    this.findProcess(found, meta);
    return found;
  }

  /**
   * A record with no process, met through a command-mode hook: the shim's parent is the shell
   * Claude spawned, and the nearest `claude` above it is the session's process. Looked for once
   * per process; an http hook says no pid, and the grace period stands in.
   */
  private findProcess(rec: SessionRecord, meta: HookMeta): void {
    if (rec.session.native.pid !== undefined || meta.ppid === undefined || rec.ancestorsChecked || !this.raiser) return;
    rec.ancestorsChecked = true;
    this.raiser
      .ancestors(meta.ppid)
      .then((chain) => {
        const claude = chain.find((p) => /claude/i.test(p.name));
        if (claude && rec.session.native.pid === undefined && rec.session.status !== "ended") this.host.patch(rec, { native: { ...rec.session.native, pid: claude.pid } });
      })
      .catch(() => {
        // the grace period stands in
      });
  }

  private resolve(hook: NormalisedHook, meta: HookMeta): SessionRecord | undefined {
    // A hook can arrive before the next registry poll: read the registries now.
    for (const profile of this.profiles) {
      const entries = classify(readRegistry(join(profile.configDir, "sessions"), this.isAlive));
      // A spare's own start, or a window on the agents screen: no session.
      if ([...entries.spares, ...entries.parked].some((l) => l.sessionId === hook.sessionId)) return undefined;
      const live = entries.sessions.find((l) => l.sessionId === hook.sessionId);
      if (!live) continue;
      const running = new Set(entries.sessions.map((e) => e.sessionId));
      return this.meet(live, profile, running, this.host.now(), hook.transcriptPath);
    }
    // Not in any registry. The agents screen and `claude attach` register nothing, yet send a
    // Notification (a job done) and a SessionEnd of their own: neither is a conversation.
    if (hook.name === "Notification" || hook.name === "SessionEnd") return undefined;
    // The transcript path names the directory the profile owns.
    const byDir = hook.transcriptPath ? this.profiles.find((p) => isWithin(hook.transcriptPath!, p.configDir)) : undefined;
    const profile = byDir ?? this.profiles.find((p) => p.id === meta.profile) ?? this.profiles.find((p) => p.default) ?? this.profiles[0];
    if (!profile || !hook.cwd) return undefined;
    this.log.info("claude session known only from its hook", { session: hook.sessionId, profile: profile.id });
    return this.host.ensure({
      harness: "claude",
      nativeId: hook.sessionId,
      profile: profile.id,
      cwd: hook.cwd,
      transport: "pipe",
      status: "busy",
      ...(hook.transcriptPath ? { transcriptPath: hook.transcriptPath } : {}),
      handles: { configDir: profile.configDir },
    });
  }
}

/**
 * A session's stats counted on from what it spent before its context was cleared: turns and
 * tokens add up, the context window is the new transcript's own. A cost of 0 is left for the
 * price table to fill from the summed tokens.
 */
export function countOn(base: SessionStats | undefined, now: SessionStats): SessionStats {
  if (!base) return now;
  const sum = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  const cacheRead = sum(base.tokens.cacheRead, now.tokens.cacheRead);
  const cacheWrite = sum(base.tokens.cacheWrite, now.tokens.cacheWrite);
  const model = now.model ?? base.model;
  return {
    turns: base.turns + now.turns,
    cost: now.cost === 0 ? 0 : base.cost + now.cost,
    tokens: { in: base.tokens.in + now.tokens.in, out: base.tokens.out + now.tokens.out, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) },
    ...(now.context ? { context: now.context } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}
