// The tracker's judge: two short questions put to a small model through the user's own Claude
// Code, signed in as they are (`claude -p`), so judging costs their subscription and no key.
// `extract` reads a message the user gave an agent and says what in it is worth following: new
// asks, each in a line, or a change to one already followed, or nothing (a "yes", a go-ahead
// to go on). `grade` reads the agent's new messages against the asks still open and says which
// of them answer which, in part or whole.
//
// A run is as bare as Claude Code allows while it is still the user's login: no user settings
// (so none of the user's hooks, which would report it as a session), no MCP servers, no tools,
// nothing saved, and a system prompt of its own in place of the coding one, which keeps a call
// near a thousand tokens. It runs in a folder of cophylad's own (`tracker/work` in the data
// directory), which the session registry passes over (`privateRun`): Claude Code lists even a
// print run among its live sessions. The question goes on stdin, since a turn's messages can be
// longer than a Windows command line.

import { mkdirSync } from "node:fs";
import type { HarnessProfile } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import { claudeEnv } from "../sessions/claude/start.ts";
import { scrub } from "../sessions/env.ts";

/** An ask as the judge is shown it: its number in this question, its line and the user's words. */
export interface JudgeAsk {
  n: number;
  title: string;
  /** The start of what the user wrote, for what the line leaves out. */
  words?: string;
}

export interface ExtractInput {
  /** The user's message to the agent. */
  text: string;
  /** The agent's last message before it, which a short reply answers. */
  before?: string;
  /** The asks already followed in the session, open or not. */
  asks: JudgeAsk[];
}

export interface ExtractResult {
  asks: { title: string }[];
  amend: { ask: number; title: string }[];
}

export interface GradeInput {
  asks: JudgeAsk[];
  /** The agent's messages, numbered from 1 in the order they came. */
  messages: { n: number; text: string }[];
}

export interface GradeResult {
  results: { ask: number; status: "open" | "partial" | "answered"; messages: number[] }[];
}

export interface Judge {
  extract(input: ExtractInput): Promise<ExtractResult>;
  grade(input: GradeInput): Promise<GradeResult>;
}

/** The account it judges with is at a usage limit: try again after `retryAt` when it says. */
export class JudgeLimited extends Error {
  readonly retryAt?: number;
  constructor(message: string, retryAt?: number) {
    super(message);
    this.name = "JudgeLimited";
    if (retryAt !== undefined) this.retryAt = retryAt;
  }
}

/** No judge can run: no signed-in Claude account, no `claude`, or it fails. */
export class JudgeUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeUnavailable";
  }
}

// --- the questions --------------------------------------------------------------------------

/** The longest piece of a user's message the judge reads. */
export const PROMPT_CHARS = 6000;
/** The longest piece of the agent's message before it that the judge reads. */
export const BEFORE_CHARS = 1500;
/** The user's words shown beside an ask's line when grading. */
export const WORDS_CHARS = 400;
/** The longest piece of one agent message the judge reads: its start and its end, which is where an answer is. */
export const MESSAGE_CHARS = 6000;
/** The most text one grading question carries; a longer turn is judged in more than one. */
export const GRADE_CHARS = 24000;
/** The longest line the judge may give an ask. */
export const TITLE_CHARS = 80;

export const EXTRACT_SYSTEM = `You keep a list of what a user asked an AI coding agent, so that later they can see whether each thing was answered.

You are given the user's new message to the agent, the agent's message just before it, and the asks already on the list, numbered.

Decide what the new message asks the agent to do or to answer:
- A new request or question: add an ask. Its title is one line of at most ${TITLE_CHARS} characters, in the user's own terms, a question or an instruction, with no full stop at the end.
- Several separate requests: one ask each, at most three. Do not split one request into its steps.
- A go-ahead to do something the agent proposed: an ask naming what was proposed, when the agent's message makes it clear.
- A change to an ask already listed (a correction, an addition, a narrower scope): amend that ask with a title that covers both.
- Nothing to follow: no ask. This is a reply to the agent's question, a "yes" or "continue" to go on with what it was doing, thanks, an acknowledgement, or a slash command.

Reply with JSON only, nothing before or after it:
{"asks": [{"title": "..."}], "amend": [{"ask": 1, "title": "..."}]}
Use empty lists when there is nothing to add or amend.`;

export const GRADE_SYSTEM = `You check whether an AI coding agent's messages answer what the user asked it.

You are given the user's open asks, numbered, each with its title and the start of the user's own words, and the agent's new messages, numbered.

For each ask, decide from these messages alone:
- "answered": the messages give the user what the ask wanted: the answer to the question, or a report that the work asked for is done, or a definite statement that it cannot be done and why.
- "partial": the messages answer part of it: part of the question, some of the work reported done, or a finding that settles only some of it.
- "open": nothing in these messages answers it. A plan, a promise, "let me check", a question back to the user, or progress notes without a result are not answers.

For "partial" and "answered", list the numbers of the messages that carry the answer.

Reply with JSON only, nothing before or after it:
{"results": [{"ask": 1, "status": "answered", "messages": [2]}]}
Give one result for every ask.`;

/** A piece of text cut to `max` characters: its start, or its start and end with the middle left out. */
export function cut(text: string, max: number, keepEnd = false): string {
  if (text.length <= max) return text;
  if (!keepEnd) return `${text.slice(0, max - 1)}…`;
  const head = Math.floor(max * 0.4);
  const tail = max - head - 7;
  return `${text.slice(0, head)}\n[…]\n${text.slice(text.length - tail)}`;
}

/** What the user typed, without the wrappers Claude Code puts around a pasted or multi-line message. */
export function plainPrompt(text: string): string {
  return text
    .replace(/<\/?pasted_content[^>]*>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
}

export function extractQuestion(input: ExtractInput): string {
  const lines: string[] = [];
  lines.push("Asks already on the list:");
  if (input.asks.length === 0) lines.push("(none)");
  for (const a of input.asks) lines.push(`${a.n}. ${a.title}`);
  lines.push("");
  lines.push("The agent's message just before:");
  lines.push(input.before ? cut(input.before, BEFORE_CHARS, true) : "(none)");
  lines.push("");
  lines.push("The user's new message:");
  lines.push(cut(input.text, PROMPT_CHARS, true));
  return lines.join("\n");
}

export function gradeQuestion(input: GradeInput): string {
  const lines: string[] = [];
  lines.push("Open asks:");
  for (const a of input.asks) {
    lines.push(`${a.n}. ${a.title}`);
    if (a.words) lines.push(`   The user wrote: "${cut(a.words.replace(/\s+/g, " "), WORDS_CHARS)}"`);
  }
  lines.push("");
  lines.push("The agent's new messages:");
  for (const m of input.messages) {
    lines.push("");
    lines.push(`[${m.n}]`);
    lines.push(cut(m.text, MESSAGE_CHARS, true));
  }
  return lines.join("\n");
}

// --- reading the answers --------------------------------------------------------------------

/** The first JSON object in a model's reply, fenced or bare; undefined when there is none. */
export function firstObject(reply: string): unknown {
  const text = reply.replace(/```(?:json)?/g, "");
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1)) as unknown;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** A title as the tracker keeps it: one line, trimmed, no full stop, at most `TITLE_CHARS` and a bit. */
export function cleanTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const one = raw.replace(/\s+/g, " ").trim().replace(/[.。]+$/, "");
  if (one === "") return undefined;
  return cut(one, TITLE_CHARS + 20);
}

export function readExtract(reply: string, asks: number): ExtractResult {
  const o = firstObject(reply) as { asks?: unknown; amend?: unknown } | undefined;
  if (!o || typeof o !== "object") throw new Error(`the judge's answer was not JSON: ${cut(reply, 200)}`);
  const out: ExtractResult = { asks: [], amend: [] };
  if (Array.isArray(o.asks)) {
    for (const a of o.asks.slice(0, 3)) {
      const title = cleanTitle((a as { title?: unknown } | null)?.title);
      if (title) out.asks.push({ title });
    }
  }
  if (Array.isArray(o.amend)) {
    for (const a of o.amend) {
      const n = (a as { ask?: unknown } | null)?.ask;
      const title = cleanTitle((a as { title?: unknown } | null)?.title);
      if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= asks && title) out.amend.push({ ask: n, title });
    }
  }
  return out;
}

export function readGrade(reply: string, asks: number, messages: number): GradeResult {
  const o = firstObject(reply) as { results?: unknown } | undefined;
  if (!o || typeof o !== "object" || !Array.isArray(o.results)) throw new Error(`the judge's answer was not JSON: ${cut(reply, 200)}`);
  const out: GradeResult = { results: [] };
  for (const r of o.results) {
    const x = r as { ask?: unknown; status?: unknown; messages?: unknown } | null;
    if (!x || typeof x.ask !== "number" || !Number.isInteger(x.ask) || x.ask < 1 || x.ask > asks) continue;
    if (x.status !== "open" && x.status !== "partial" && x.status !== "answered") continue;
    const ms = Array.isArray(x.messages) ? [...new Set(x.messages.filter((m): m is number => typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= messages))].sort((a, b) => a - b) : [];
    out.results.push({ ask: x.ask, status: x.status, messages: x.status === "open" ? [] : ms });
  }
  return out;
}

// --- the runner -----------------------------------------------------------------------------

/** What one run gives back: the model's reply, or why there is none. */
export interface RunOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (argv: string[], opts: { cwd: string; env: Record<string, string>; stdin: string; timeoutMs: number }) => Promise<RunOutput>;

/** `Bun.spawn` with a timeout, the question written to stdin, nothing shown. */
export const spawnRunner: Runner = async (argv, opts) => {
  const p = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const timer = setTimeout(() => p.kill(), opts.timeoutMs);
  try {
    p.stdin.write(opts.stdin);
    await p.stdin.end();
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

export interface ClaudeJudgeDeps {
  /** The signed-in Claude account to judge with, now; undefined when there is none. */
  profile: () => HarnessProfile | undefined;
  /** The folder it runs in: cophylad's own, one the registry passes over. */
  cwd: string;
  model: string;
  effort: string;
  timeoutMs: number;
  /** A program in place of `claude`, and its first arguments: a test's or a kit's. */
  command?: readonly string[];
  /** The daemon's environment, scrubbed here of harness markers. */
  env: Record<string, string | undefined>;
  log: Logger;
  run?: Runner;
  now?: () => number;
}

/** Words of Claude Code's that mean the account is at a usage limit. */
const LIMITED = /usage limit|rate limit|rate_limit|limit reached|429|overloaded|too many requests|out of (extra )?usage/i;
/** Words that mean nobody is signed in there. */
const SIGNED_OUT = /not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|oauth/i;

export class ClaudeJudge implements Judge {
  private d: ClaudeJudgeDeps;
  private run: Runner;

  constructor(deps: ClaudeJudgeDeps) {
    this.d = deps;
    this.run = deps.run ?? spawnRunner;
  }

  async extract(input: ExtractInput): Promise<ExtractResult> {
    return readExtract(await this.ask(EXTRACT_SYSTEM, extractQuestion(input)), input.asks.length);
  }

  async grade(input: GradeInput): Promise<GradeResult> {
    return readGrade(await this.ask(GRADE_SYSTEM, gradeQuestion(input)), input.asks.length, input.messages.length);
  }

  /** The command line of one question, after the program. */
  args(system: string): string[] {
    return ["-p", "--model", this.d.model, "--effort", this.d.effort, "--setting-sources", "project,local", "--strict-mcp-config", "--tools", "", "--no-session-persistence", "--output-format", "json", "--system-prompt", system];
  }

  private async ask(system: string, question: string): Promise<string> {
    const profile = this.d.profile();
    if (!profile) throw new JudgeUnavailable("no Claude account is signed in on this machine to judge with");
    const program = this.d.command ? [...this.d.command] : [profile.exec?.command ?? Bun.which("claude") ?? "claude"];
    const dir = claudeEnv(profile.configDir);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(scrub(this.d.env))) if (v !== undefined && !dir.unset.includes(k)) env[k] = v;
    Object.assign(env, dir.set, profile.env as Record<string, string> | undefined);
    mkdirSync(this.d.cwd, { recursive: true });
    const started = (this.d.now ?? Date.now)();
    let out: RunOutput;
    try {
      out = await this.run([...program, ...this.args(system)], { cwd: this.d.cwd, env, stdin: question, timeoutMs: this.d.timeoutMs });
    } catch (e) {
      throw new JudgeUnavailable(`claude would not start: ${e instanceof Error ? e.message : String(e)}`);
    }
    const ms = (this.d.now ?? Date.now)() - started;
    let doc: { result?: unknown; is_error?: unknown; api_error_status?: unknown; subtype?: unknown; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined;
    try {
      doc = JSON.parse(out.stdout.trim()) as typeof doc;
    } catch {
      doc = undefined;
    }
    const reply = typeof doc?.result === "string" ? doc.result : "";
    const failed = out.code !== 0 || !doc || doc.is_error === true || typeof doc.result !== "string";
    if (failed) {
      const why = cut(`${reply} ${out.stderr} ${doc ? "" : out.stdout}`.replace(/\s+/g, " ").trim() || `claude exited with ${out.code}`, 300);
      this.d.log.warn("the tracker's judge failed", { code: out.code, ms, why });
      if (doc?.api_error_status === 429 || LIMITED.test(why)) throw new JudgeLimited(why, retryAtOf(why, (this.d.now ?? Date.now)()));
      if (SIGNED_OUT.test(why)) throw new JudgeUnavailable(`the Claude account it judges with is not signed in: ${why}`);
      throw new Error(why);
    }
    const u = doc!.usage ?? {};
    this.d.log.debug("the tracker's judge answered", { ms, in: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), out: u.output_tokens ?? 0 });
    return reply;
  }
}

/** When a limit's words say it lifts ("resets 3pm", "try again in 20 minutes"), else in a quarter of an hour. */
export function retryAtOf(why: string, now: number): number {
  const mins = /in (\d+) ?(?:min|minute)/i.exec(why);
  if (mins) return now + Number(mins[1]) * 60_000;
  const secs = /in (\d+) ?(?:s|sec|second)/i.exec(why);
  if (secs) return now + Number(secs[1]) * 1000;
  return now + 15 * 60_000;
}
