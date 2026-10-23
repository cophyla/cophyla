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
//
// A session belongs to the profile whose registry lists it, else the one whose directory holds
// its transcript; the profile a hook names is a hint. A transcript in a Claude directory no
// profile has is an account cophylad was not told of: the session is listed under the profile
// its hooks name, its timeline and the log say so, and the registry moves it to its own profile
// once there is one.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { HarnessProfile, Session, SessionStats, SessionWaiting, TerminalRef } from "@cophyla/protocol";
import type { HookMeta } from "../../api/hooks.ts";
import type { Logger } from "../../log.ts";
import type { ProcessTree } from "../focus.ts";
import { capText, oneLine, rawIfSmall, summariseValue, toolKey, TOOL_CALL_CAP, TOOL_RESULT_CAP } from "../model.ts";
import type { HarnessAdapter, HookInstallSpec, NormalisedHook, SendOutcome, SessionHost, SessionRecord } from "../model.ts";
import { isWithin, pathKey } from "../paths.ts";
import { toolResultText } from "../results.ts";
import { Tail } from "../tail.ts";
import { acceptsCrossSessionInbound, installClaudeHooks, uninstallClaudeHooks } from "./hooks.ts";
import type { ClaudeHookOwner } from "./hooks.ts";
import { injectClaude } from "./inject.ts";
import { classify, isAlive as defaultIsAlive, jobCreatedAt, readEntry, readRegistry, statusOf, transcriptPathFor, waitingOf } from "./registry.ts";
import type { ClaudeLive, IsAlive } from "./registry.ts";
import { conversationKey } from "../../usage/ledger.ts";
import type { SideSpend, SpendCall, SpendSink } from "../../usage/ledger.ts";
import { subagentInfo, subagentTranscripts } from "./subagents.ts";
import type { SubagentInfo } from "./subagents.ts";
import { applyClaudeCostRecord, applyClaudeRow, applyClaudeUsage, isCostRecord, newClaudeState, rowAt, statsFor } from "./transcript.ts";
import type { ClaudePrice, ClaudeTranscriptState } from "./transcript.ts";

export { subagentTranscripts };

/** A tool result from a hook with no call id suppresses the transcript's copy of the same tool and input for this long. */
const HOOK_TOOL_TTL_MS = 120000;
/** How long a conversation sent to the background waits for its job to register before it counts as gone. */
const CONTINUE_GRACE_MS = 60000;
/** How long a turn's Stop waits for the registry to say what the session waits on, a read at a time. */
const STOP_POLL_MS = 50;
const STOP_POLLS = 10;
/** How often a session's sub-agents' transcripts are read: a sub-agent works while its session waits, its own transcript still. */
const SUBAGENT_READ_MS = 10000;
/** How long a transcript left behind (the session ended, cleared, or resumed another) is read on for Claude's cost record. */
const CLOSING_READ_MS = 30000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The sub-agents' transcripts read into one parser's usage, and when they were last read. */
interface SubagentTails {
  tails: Map<string, Tail>;
  readAt: number;
  /** What each is, how far the spend ledger has it, and what started the turn it was first seen in. */
  info: Map<string, SubagentInfo & { mark: number; trigger: string }>;
}

/**
 * What one parser feeds the spend ledger: its conversation, how far the ledger has its own
 * transcript, and what a pass counted past the marks, written at the pass's end.
 */
interface SpendFeed {
  key: string;
  mark: number;
  calls: SpendCall[];
  side: SideSpend[];
  marks: Map<string, number>;
  /** When the last row read was written: a cost record's time, which it does not say. */
  lastAt?: number;
}

/**
 * A transcript its record has left (ended, cleared, resumed another) before Claude's cost
 * record was read: Claude writes the record as it leaves, sometimes just after. Read on until
 * the record turns up or `until`. With `tail`, the record moved on to another transcript, and
 * `counted` is the old one's stats as the record last had them; without, it ended, its own tail read on.
 */
interface Closing {
  rec: SessionRecord;
  tail?: Tail;
  state: ClaudeTranscriptState;
  counted?: SessionStats;
  until: number;
}

/**
 * The Claude directory a transcript is in: Claude keeps one at
 * `<configDir>/projects/<project>/<session>.jsonl`, a sub-agent's further down. `undefined`
 * for a path of no such shape.
 */
export function claudeConfigDirOf(transcriptPath: string): string | undefined {
  let dir = dirname(transcriptPath);
  for (let up = dirname(dir); up !== dir; dir = up, up = dirname(up)) {
    if (basename(up) === "projects") return dirname(up);
  }
  return undefined;
}

/** Whose a session is by its transcript: a profile's, or a Claude directory's that no profile has. */
type Account = { profile: HarnessProfile; dir?: undefined } | { profile?: undefined; dir: string };

export interface ClaudeAdapterOptions {
  host: SessionHost;
  log: Logger;
  isAlive?: IsAlive;
  inject?: typeof injectClaude;
  /** The shared settings file a bypass session may also load; `~/.claude/settings.json` by default. */
  sharedSettings?: string;
  /** The process tree: a command-mode hook says its shim's parent pid, and the `claude` ancestor is the session's process. */
  raiser?: ProcessTree;
  /** Prices each model's tokens in a session's cost; without it the host prices them all at the session's model. */
  price?: ClaudePrice;
  /** The spend ledger, fed every call counted past its marks. */
  ledger?: SpendSink;
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
  /** What `checkAccount` has logged: a directory no profile has, a profile and the one its hooks named. */
  private logged = new Set<string>();
  private price: ClaudePrice | undefined;
  /** By the parser they feed: a parser made again (a cleared context, a transcript read again) reads them again from the start. */
  private subagents = new WeakMap<ClaudeTranscriptState, SubagentTails>();
  private closing: Closing[] = [];
  private ledger: SpendSink | undefined;
  /** By the parser that feeds it. */
  private feeds = new WeakMap<ClaudeTranscriptState, SpendFeed>();

  constructor(opts: ClaudeAdapterOptions) {
    this.host = opts.host;
    this.log = opts.log;
    this.isAlive = opts.isAlive ?? defaultIsAlive;
    this.inject = opts.inject ?? injectClaude;
    this.sharedSettings = opts.sharedSettings ?? join(homedir(), ".claude", "settings.json");
    this.raiser = opts.raiser;
    this.price = opts.price;
    this.ledger = opts.ledger;
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
    this.readClosing(now);
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
      ...(live.name ? { title: live.name, name: live.name } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
      // A job that was a spare ran since its record ended as one.
      ...(live.jobId !== undefined ? { job: live.jobId, ...(live.statusUpdatedAt !== undefined ? { activeAt: live.statusUpdatedAt } : {}) } : {}),
      ...(expected ? { origin: "orchestrator" as const, ...(expected.workspace !== undefined ? { workspace: expected.workspace } : {}), ...(expected.task !== undefined ? { task: expected.task } : {}), ...(expected.intent !== undefined ? { intent: expected.intent } : {}), ...(expected.terminal ? { terminal: expected.terminal } : {}) } : {}),
      handles: { pipe: live.messagingSocketPath, token: live.peerToken, configDir: profile.configDir, startedAt: live.startedAt, ...(live.procStart !== undefined ? { procStart: live.procStart } : {}) },
    });
    // Still listed under the process it ended in: a session on its way out, not a resume.
    if (rec.session.status === "ended") return rec;
    // Listed under another profile while its own was not known: the registry says whose it is.
    // Never away from a profile that holds its transcript, so two profiles that share a registry
    // do not toss it between them.
    if (rec.session.profile !== profile.id) {
      const filed = this.profiles.find((p) => p.id === rec.session.profile);
      const transcript = rec.session.transcript?.path;
      if (!(filed && transcript && isWithin(transcript, filed.configDir))) {
        this.log.info("claude session moved to the profile whose registry lists it", { session: rec.session.id, from: rec.session.profile, to: profile.id });
        this.host.patch(rec, { profile: profile.id }, rec.session.lastActivity);
      }
    }
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
      // A name the user gave outlives a cleared context: the host keeps it on the parser it drops.
      const named = (rec.parser as { named?: boolean } | undefined)?.named === true;
      rec.parser = newClaudeState();
      if (named) (rec.parser as ClaudeTranscriptState).named = true;
      this.host.watch(dirname(path));
    }
    const state = rec.parser as ClaudeTranscriptState;
    const feed = this.feedOf(state, path);
    const lines = tail.read();
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
      // The ledger has what is before its mark, and the history a job was forked with is its parent's.
      if (feed) this.feedLine(state, feed, row, line.offset >= feed.mark && !copied);
      if (isCostRecord(row)) this.settleCost(state, path, row, now);
      for (const item of applyClaudeRow(state, row)) {
        if (copied) continue;
        switch (item.kind) {
          case "user_turn":
            if (this.host.isOwnText(rec, item.text, item.promptId)) {
              if (!this.host.receiptByText(rec, item.text, item.promptId) && record) this.host.agentEcho(rec, item.text, rawIfSmall(row), item.at);
              break;
            }
            if (rec.session.intent === undefined && patch.intent === undefined) patch.intent = oneLine(item.text);
            if (record) this.host.event(rec, "user_turn", { text: capText(item.text), source: "typed", ...(item.promptId ? { promptId: item.promptId } : {}) }, rawIfSmall(row), item.at);
            break;
          case "peer":
            if (item.from === "cophylad" || this.host.isOwnText(rec, item.text)) {
              if (!this.host.receiptByText(rec, item.text) && record) this.host.agentEcho(rec, item.text, rawIfSmall(row), item.at);
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
            // Recorded from its hook already: by the call's id, or by tool and input from a CLI whose hooks carry none.
            if (item.id && rec.hookTools.delete(item.id)) break;
            const key = toolKey(item.name, item.input);
            const fromHook = rec.hookTools.get(key);
            if (fromHook !== undefined && now - fromHook <= HOOK_TOOL_TTL_MS) {
              rec.hookTools.delete(key);
              break;
            }
            // An error's text is the block's; the row's `toolUseResult` then says `Error: ` before it.
            const result = summariseValue(toolResultText("claude", item.name, item.isError ? item.content : (item.response ?? item.content)), TOOL_RESULT_CAP);
            this.host.event(rec, "tool_result", { tool: item.name, id: item.id, result: result.value, ...(result.truncated ? { truncated: true } : {}), ...(item.isError ? { isError: true } : {}) }, rawIfSmall(row), item.at);
            break;
          }
          case "title":
            patch.title = item.title;
            break;
          case "plan":
            if (rec.session.intent === undefined && patch.intent === undefined) patch.intent = oneLine(item.heading);
            break;
          case "permission_mode":
            this.host.noteMode(rec, item.mode, now);
            break;
          case "queue":
            if (record && item.operation === "enqueue" && item.content && !this.host.isOwnText(rec, item.content)) {
              this.host.event(rec, "notification", { type: "queued", text: capText(item.content, 1000) }, rawIfSmall(row), item.at);
            }
            break;
        }
      }
    }
    state.onUsage = undefined;
    // Its sub-agents after its own lines: the launches those name are known by then.
    this.tailSubagents(state, path, now);
    if (state.statsChanged) {
      state.statsChanged = false;
      patch.stats = countOn(rec.statsBase, statsFor(state, this.price));
    }
    if (Object.keys(patch).length > 0) this.host.patch(rec, patch, now);
    this.commitSpend(rec, state, now);
    if (lines.length === 0) return;
    this.host.tailed(rec);
    if (state.continuedIn) this.continued(rec, state.continuedIn, now);
    // A turn taken here since: the conversation goes on in its window after all.
    else if (rec.continuing) delete rec.continuing;
  }

  /** The ledger's feed for a parser, made with the marks the ledger holds; none without a ledger. */
  private feedOf(state: ClaudeTranscriptState, path: string): SpendFeed | undefined {
    if (!this.ledger) return undefined;
    let feed = this.feeds.get(state);
    if (!feed) {
      const key = conversationKey("claude", basename(path, ".jsonl"));
      feed = { key, mark: this.ledger.marks([key]).get(key) ?? 0, calls: [], side: [], marks: new Map() };
      this.feeds.set(state, feed);
      this.ledger.claim(key);
    }
    return feed;
  }

  /** Before a line of a conversation's own transcript: whether what it counts goes to the ledger. */
  private feedLine(state: ClaudeTranscriptState, feed: SpendFeed, row: unknown, counts: boolean): void {
    const at = rowAt(row);
    if (at !== undefined) feed.lastAt = at;
    state.onUsage = counts ? (u) => feed.calls.push(u) : undefined;
  }

  /** After a pass: its own transcript's mark moves to where the tail is, then the pass is written. */
  private commitSpend(rec: SessionRecord, state: ClaudeTranscriptState, now: number, tail: Tail | undefined = rec.tail): void {
    state.onUsage = undefined;
    const feed = this.feeds.get(state);
    if (!feed || !this.ledger) return;
    if (tail && tail.consumed > feed.mark) {
      feed.mark = tail.consumed;
      feed.marks.set(feed.key, tail.consumed);
    }
    if (feed.calls.length === 0 && feed.side.length === 0 && feed.marks.size === 0) return;
    const s = rec.session;
    const title = s.name ?? s.title;
    const at = feed.lastAt ?? now;
    try {
      this.ledger.commit({
        conversation: { conversation: feed.key, harness: "claude", session: s.id, profile: s.profile, cwd: s.cwd, ...(title ? { title } : {}), firstAt: at, lastAt: at },
        calls: feed.calls,
        side: feed.side,
        marks: feed.marks,
      });
    } catch (e) {
      this.log.warn("spend ledger write failed", { session: s.id, error: e instanceof Error ? e.message : String(e) });
    }
    feed.calls = [];
    feed.side = [];
    feed.marks = new Map();
  }

  /**
   * Reads the session's sub-agents' transcripts into its usage: at once for a parser that has
   * not read them, then every `SUBAGENT_READ_MS`, the folders looked in again each time for a
   * sub-agent started since.
   */
  private tailSubagents(state: ClaudeTranscriptState, path: string, now: number, force = false): void {
    let subs = this.subagents.get(state);
    if (!subs) {
      subs = { tails: new Map(), readAt: -Infinity, info: new Map() };
      this.subagents.set(state, subs);
    }
    if (!force && now - subs.readAt < SUBAGENT_READ_MS) return;
    subs.readAt = now;
    const feed = this.feeds.get(state);
    const files = subagentTranscripts(path);
    const fresh = files.filter((f) => !subs.tails.has(f));
    if (fresh.length > 0) {
      const infos = fresh.map((f) => subagentInfo(path, f));
      const marks = feed && this.ledger ? this.ledger.marks(infos.map((i) => `${feed.key}/${i.key}`)) : new Map<string, number>();
      fresh.forEach((f, i) => {
        subs.tails.set(f, new Tail(f));
        const info = infos[i]!;
        subs.info.set(f, { ...info, mark: feed ? (marks.get(`${feed.key}/${info.key}`) ?? 0) : 0, trigger: state.trigger });
      });
    }
    // A line of the conversation's own may be counting for the ledger: kept for it after.
    const keep = state.onUsage;
    for (const file of files) {
      const tail = subs.tails.get(file)!;
      const info = subs.info.get(file)!;
      for (const line of tail.read()) {
        state.onUsage = feed && line.offset >= info.mark ? (u) => feed.calls.push(u) : undefined;
        try {
          applyClaudeUsage(state, JSON.parse(line.text), { agent: info.agent, trigger: state.agentTriggers.get(info.id) ?? info.trigger });
        } catch {
          // a line that is not JSON counts nothing
        }
      }
      if (feed && tail.consumed > info.mark) {
        info.mark = tail.consumed;
        feed.marks.set(`${feed.key}/${info.key}`, tail.consumed);
      }
    }
    state.onUsage = keep;
  }

  /**
   * Claude's cost record, met in a transcript: its sub-agents' transcripts are read up to now
   * first, so the record is set against all the usage it covers, then what it holds beyond
   * that counts as the session's (`applyClaudeCostRecord`).
   */
  private settleCost(state: ClaudeTranscriptState, path: string, row: unknown, now: number): void {
    if (!this.price) return;
    const counts = state.onUsage !== undefined;
    this.tailSubagents(state, path, now, true);
    const was = state.unrecorded ?? { cost: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    if (!applyClaudeCostRecord(state, row, this.price)) return;
    const feed = this.feeds.get(state);
    const u = state.unrecorded;
    if (!counts || !feed || !u) return;
    feed.side.push({
      at: feed.lastAt ?? now,
      model: state.model ?? "unknown",
      cost: Math.max(0, u.cost - was.cost),
      tokens: { in: u.in - was.in, out: u.out - was.out, cacheRead: u.cacheRead - was.cacheRead, cacheWrite: u.cacheWrite - was.cacheWrite },
    });
  }

  /**
   * A transcript its record has just left, read on a while if Claude's cost record for it has
   * not been read: `tail` given, the record has moved on to another transcript (cleared, or
   * resumed another conversation); none, it ended, its own tail read on.
   */
  private closeLater(rec: SessionRecord, tail: Tail | undefined, state: ClaudeTranscriptState | undefined, now: number): void {
    if (!this.price || !state?.stats || state.settled) return;
    this.closing.push({ rec, state, until: now + CLOSING_READ_MS, ...(tail ? { tail, counted: statsFor(state, this.price) } : {}) });
  }

  /** The transcripts left behind, read on for a cost record, until one turns up or their time is up. */
  private readClosing(now: number): void {
    if (this.closing.length === 0) return;
    this.closing = this.closing.filter((c) => {
      if (!c.tail) {
        // Ended: read on through its own tail, unless it came back and reads on by itself.
        if (c.rec.session.status !== "ended" || c.rec.parser !== c.state) return false;
        this.tailTranscript(c.rec, now);
        return !c.state.settled && now < c.until;
      }
      const feed = this.feeds.get(c.state);
      for (const line of c.tail.read()) {
        let row: unknown;
        try {
          row = JSON.parse(line.text);
        } catch {
          continue;
        }
        if (feed) this.feedLine(c.state, feed, row, line.offset >= feed.mark);
        if (isCostRecord(row)) this.settleCost(c.state, c.tail.path, row, now);
        else applyClaudeUsage(c.state, row, { agent: "main", trigger: c.state.trigger });
      }
      this.commitSpend(c.rec, c.state, now, c.tail);
      if (c.state.statsChanged && c.counted) {
        c.state.statsChanged = false;
        const after = statsFor(c.state, this.price);
        const more = statsDelta(after, c.counted);
        c.counted = after;
        // What the old transcript turned out to have spent is part of the base the new one counts on from.
        c.rec.statsBase = plusStats(c.rec.statsBase, more);
        this.host.patch(c.rec, { stats: plusStats(c.rec.session.stats, more) }, now);
      }
      return !c.state.settled && now < c.until;
    });
  }

  drain(rec: SessionRecord, now: number): void {
    this.tailTranscript(rec, now);
    this.closeLater(rec, undefined, rec.parser as ClaudeTranscriptState | undefined, now);
  }

  /** The old transcript's last lines, Claude's cost record for it among them when written yet; read on a while when not. */
  leave(rec: SessionRecord, now: number): void {
    this.tailTranscript(rec, now);
    if (rec.tail) this.closeLater(rec, rec.tail, rec.parser as ClaudeTranscriptState | undefined, now);
  }

  readNow(rec: SessionRecord, now: number): void {
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

  /** Whether the session's settings let any session's message in at once (`crossSessionInbound: "accept"`), which a bypass session otherwise holds. */
  acceptsInbound(rec: SessionRecord): boolean {
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
    this.checkAccount(found, hook, meta);
    return found;
  }

  /**
   * Whose a session is by its transcript, which Claude keeps at
   * `<configDir>/projects/<project>/<session>.jsonl`: the profile whose directory holds it, or,
   * when none does, the Claude directory it is in. `undefined` with no transcript path, or one
   * of no such shape.
   */
  private accountOf(transcriptPath: string | undefined): Account | undefined {
    if (!transcriptPath) return undefined;
    const profile = this.profiles.find((p) => isWithin(transcriptPath, p.configDir));
    if (profile) return { profile };
    const dir = claudeConfigDirOf(transcriptPath);
    return dir ? { dir } : undefined;
  }

  /**
   * What a hook's transcript says against what its hooks name, logged once each: a session in a
   * directory no profile has, which is listed under another profile until config names it; and
   * a session in one profile's directory running another's hooks, launched with that profile's
   * settings (`--settings`), which the directory decides.
   */
  private checkAccount(rec: SessionRecord, hook: NormalisedHook, meta: HookMeta): void {
    const account = this.accountOf(hook.transcriptPath);
    if (account?.dir !== undefined) {
      const key = `dir:${pathKey(account.dir)}`;
      if (this.logged.has(key)) return;
      this.logged.add(key);
      this.log.warn("a claude session runs under a directory no profile has; [[profiles]] in config.toml can name it", { dir: account.dir, hooks: meta.profile, session: rec.session.id, profile: rec.session.profile });
    } else if (account && meta.profile !== undefined && meta.profile !== account.profile.id) {
      const key = `hooks:${account.profile.id}:${meta.profile}`;
      if (this.logged.has(key)) return;
      this.logged.add(key);
      this.log.info("a claude session runs another profile's hooks; its directory decides whose it is", { dir: account.profile.configDir, profile: account.profile.id, hooks: meta.profile, session: rec.session.id });
    }
  }

  /** The session's timeline says it is listed under a profile not its own, and how to list it under its own. */
  private unknownAccount(rec: SessionRecord, dir: string, profile: HarnessProfile, hinted: boolean): void {
    this.host.event(rec, "notification", {
      type: "unknown_account",
      configDir: dir,
      profile: profile.id,
      message: `This session runs under ${dir}, a Claude folder that is none of Cophyla's profiles, so it is listed under "${profile.name}", ${hinted ? "whose hooks it runs" : "the usual one"}. Add the folder to [[profiles]] in config.toml and restart Cophyla to list it under its own.`,
    });
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
    // The transcript path names the directory the profile owns. One in a Claude directory no
    // profile has is an account cophylad was not told of: the session is still listed, under
    // the profile its hooks name (else the usual one), so the user sees it and is told why it
    // is there; it keeps its own directory for what is read from it, and moves to its own
    // profile once the registry there lists it (`meet`).
    const account = this.accountOf(hook.transcriptPath);
    const hinted = this.profiles.find((p) => p.id === meta.profile);
    const profile = account?.profile ?? hinted ?? this.profiles.find((p) => p.default) ?? this.profiles[0];
    if (!profile || !hook.cwd) return undefined;
    this.log.info("claude session known only from its hook", { session: hook.sessionId, profile: profile.id, ...(account?.dir !== undefined ? { dir: account.dir } : {}) });
    const rec = this.host.ensure({
      harness: "claude",
      nativeId: hook.sessionId,
      profile: profile.id,
      cwd: hook.cwd,
      transport: "pipe",
      status: "busy",
      ...(hook.transcriptPath ? { transcriptPath: hook.transcriptPath } : {}),
      handles: { configDir: account?.dir ?? profile.configDir },
    });
    if (account?.dir !== undefined && rec.session.status !== "ended") this.unknownAccount(rec, account.dir, profile, profile === hinted);
    return rec;
  }
}

/**
 * A session's stats counted on from what it spent before its context was cleared: turns and
 * tokens add up, the context window is the new transcript's own. The new transcript's tokens
 * at no cost (a model with no price) leave the cost at 0 for the price table to fill from the
 * summed tokens; a new transcript with no tokens yet keeps the cost spent before.
 */
export function countOn(base: SessionStats | undefined, now: SessionStats): SessionStats {
  if (!base) return now;
  const sum = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  const cacheRead = sum(base.tokens.cacheRead, now.tokens.cacheRead);
  const cacheWrite = sum(base.tokens.cacheWrite, now.tokens.cacheWrite);
  const model = now.model ?? base.model;
  const unpriced = now.cost === 0 && now.tokens.in + now.tokens.out + (now.tokens.cacheRead ?? 0) + (now.tokens.cacheWrite ?? 0) > 0;
  return {
    turns: base.turns + now.turns,
    cost: unpriced ? 0 : base.cost + now.cost,
    tokens: { in: base.tokens.in + now.tokens.in, out: base.tokens.out + now.tokens.out, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) },
    ...(now.context ? { context: now.context } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/** What `after` holds beyond `before`: cost and tokens, none of them below 0. */
function statsDelta(after: SessionStats, before: SessionStats): { cost: number; in: number; out: number; cacheRead: number; cacheWrite: number } {
  const d = (a = 0, b = 0) => Math.max(0, a - b);
  return { cost: d(after.cost, before.cost), in: d(after.tokens.in, before.tokens.in), out: d(after.tokens.out, before.tokens.out), cacheRead: d(after.tokens.cacheRead, before.tokens.cacheRead), cacheWrite: d(after.tokens.cacheWrite, before.tokens.cacheWrite) };
}

/** Stats with more spent added: turns, window and model as they were. */
function plusStats(stats: SessionStats | undefined, more: ReturnType<typeof statsDelta>): SessionStats {
  const s = stats ?? { turns: 0, cost: 0, tokens: { in: 0, out: 0 } };
  const cacheRead = (s.tokens.cacheRead ?? 0) + more.cacheRead;
  const cacheWrite = (s.tokens.cacheWrite ?? 0) + more.cacheWrite;
  return {
    ...s,
    cost: Math.round((s.cost + more.cost) * 1e6) / 1e6,
    tokens: { in: s.tokens.in + more.in, out: s.tokens.out + more.out, ...(cacheRead ? { cacheRead } : {}), ...(cacheWrite ? { cacheWrite } : {}) },
  };
}
