// Which session a call to `/mcp/agents` comes from. The shim reports what it can see: the
// harness, profile and spawn nonce it was started with, its parent's pid, its folder, and the
// variables a harness hands its MCP servers; a Codex call carries its thread in `_meta`. What
// is present must agree, or the call is refused: a process that read `hook.json` could claim
// to be any session, and cross-checking narrows what it can claim.
//
// The rules are scoped to the harness that started the shim, because the environment is
// inherited. A Codex thread may run in a shared app-server whose variables are those of
// whatever terminal started it, so a Codex call is known by its thread alone. A spawn cophylad
// made over ACP is known by its nonce. A Claude session is known by its messaging pipe,
// `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID` (aliases keep it valid after `/clear`) and the
// shim's parent, which is the session's process; these must agree, and the tether terminal
// is asked only when none of them is known. Muse and anything else: the parent, then the
// terminal.

import type { Session } from "@cophyla/protocol";

/** What the shim reports with every request. */
export interface Evidence {
  harness?: string;
  profile?: string;
  nonce?: string;
  pid?: number;
  ppid?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface CallerLookup {
  codexThread(threadId: string): Session | undefined;
  claudeSession(nativeId: string): Session | undefined;
  /** The live Claude session whose messaging pipe this is. */
  byPipe(pipe: string): Session | undefined;
  /** The live session whose root process this is. */
  byPid(pid: number): Session | undefined;
  /** The session a spawn over ACP was given this nonce for. */
  byNonce(nonce: string): Session | undefined;
  /** The live session in the tether terminal with this id, when one alone is. */
  byTerminal(id: string): Session | undefined;
}

export type Caller = { session: Session; how: string } | { error: string };

const UNKNOWN = "Cophyla can't tell which session you are, so nothing was sent";

/** A piece of evidence and what it names. */
interface Piece {
  how: string;
  session: Session | undefined;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || !/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** The one session the pieces that name one agree on; an error when they disagree; undefined when none names one. */
function agree(pieces: Piece[]): Caller | undefined {
  const named = pieces.filter((p): p is { how: string; session: Session } => p.session !== undefined);
  if (named.length === 0) return undefined;
  const ids = new Set(named.map((p) => p.session.id));
  if (ids.size > 1) return { error: `what this session reports names more than one session (${named.map((p) => p.how).join(", ")}), so nothing was sent` };
  return { session: named[0]!.session, how: named.map((p) => p.how).join(" + ") };
}

export function identify(evidence: Evidence, meta: Record<string, unknown> | undefined, lookup: CallerLookup): Caller {
  const env = evidence.env ?? {};
  const harness = evidence.harness;
  const threadId = typeof meta?.["threadId"] === "string" ? (meta["threadId"] as string) : undefined;
  const terminal = () => (env["TETHER_SESSION"] ? lookup.byTerminal(env["TETHER_SESSION"]) : undefined);
  let found: Caller | undefined;
  switch (harness) {
    case "codex":
      found = threadId ? agree([{ how: "codex thread", session: lookup.codexThread(threadId) }]) : undefined;
      break;
    case "acp":
      found = evidence.nonce ? agree([{ how: "spawn nonce", session: lookup.byNonce(evidence.nonce) }]) : undefined;
      break;
    case "claude": {
      const pieces: Piece[] = [];
      const pipe = env["CLAUDE_CODE_MESSAGING_SOCKET"];
      if (pipe) pieces.push({ how: "messaging pipe", session: lookup.byPipe(pipe) });
      const pid = num(env["CLAUDE_PID"]);
      if (pid !== undefined) pieces.push({ how: "CLAUDE_PID", session: lookup.byPid(pid) });
      const id = env["CLAUDE_CODE_SESSION_ID"];
      if (id) pieces.push({ how: "CLAUDE_CODE_SESSION_ID", session: lookup.claudeSession(id) });
      if (evidence.ppid !== undefined) pieces.push({ how: "parent process", session: lookup.byPid(evidence.ppid) });
      found = agree(pieces) ?? agree([{ how: "tether terminal", session: terminal() }]);
      break;
    }
    default: {
      const first: Piece[] = [];
      if (threadId) first.push({ how: "codex thread", session: lookup.codexThread(threadId) });
      if (evidence.nonce) first.push({ how: "spawn nonce", session: lookup.byNonce(evidence.nonce) });
      if (evidence.ppid !== undefined) first.push({ how: "parent process", session: lookup.byPid(evidence.ppid) });
      found = agree(first) ?? agree([{ how: "tether terminal", session: terminal() }]);
    }
  }
  if (!found) return { error: UNKNOWN };
  if ("error" in found) return found;
  // A shim a harness started speaks for that harness's sessions alone; an ACP spawn may run either.
  if (harness !== undefined && harness !== "acp" && ["claude", "codex", "muse"].includes(harness) && found.session.harness !== harness) {
    return { error: `this shim was started by ${harness}, and what it reports names a ${found.session.harness} session, so nothing was sent` };
  }
  if (found.session.status === "ended") return { error: "Cophyla has this session as ended, so nothing was sent" };
  if (found.session.role === "assistant") return { error: UNKNOWN };
  return found;
}

/**
 * The sender's permission class, for the parity rule: a Codex call's turn says its sandbox;
 * otherwise what the session's record says, and prompting when nothing does.
 */
export function senderBypasses(meta: Record<string, unknown> | undefined, recorded: boolean | undefined): boolean {
  const turn = turnMetadata(meta);
  const sandbox = turn?.["sandbox_mode"] ?? turn?.["sandbox"] ?? turn?.["sandboxMode"];
  if (typeof sandbox === "string") return sandbox === "danger-full-access";
  return recorded === true;
}

function turnMetadata(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const raw = meta?.["x-codex-turn-metadata"];
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
