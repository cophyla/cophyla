// A held permission as an ask. A tool's call shows its redacted input the way the terminal's
// dialog does, not as the JSON it arrives in: the command, the file and the lines an edit
// takes out and puts in, the address, the query, and any other field as `name: value`. It is
// read by shape rather than by tool name, so a tool cophylad has never met, or a spawned
// session's raw input, reads the same way. `ExitPlanMode` is the one cophylad holds as more than
// a call. Its input is the plan itself, in markdown, and a wall of quoted newlines is no way
// to ask whether to build it: the plan becomes the ask's detail, and the options are the rows
// the terminal offers, each carrying the mode the session goes on in, because allowing the
// tool alone would release a session that is still planning, and the call it answers, without
// which the CLI drops the allow and keeps its own dialog up. Which "Yes, and …" row the
// terminal shows depends on what the session was started with (bypass when it may, auto mode
// when it runs in it, accepting edits otherwise), so the caller says which. "Yes, clear
// context" is offered whenever the plan can go on that way: a hook cannot clear a context, so
// the caller either presses the CLI's own row in the session's terminal (a session in tether
// whose dialog shows it), or builds the plan in a fresh session and ends the old one's turn.
// Pure: no host, no store.

import type { AskAnswer, AskOption } from "@cophyla/protocol";
import { redact } from "../gate/audit.ts";
import type { ClaudeLaunch } from "./claude/launch.ts";

/** Claude Code's tool for leaving plan mode; its input is `{ plan }`, in markdown. */
export const EXIT_PLAN_TOOL = "ExitPlanMode";

export const ALLOW = "allow";
export const DENY = "deny";
/** Build the plan with a clear context: in the same terminal, or in a fresh session. */
export const CLEAR = "clear";
/** Allow, and go on in the mode the "Yes, and …" row names. */
export const BYPASS = "bypass";
export const AUTO = "auto";
export const ACCEPT_EDITS = "accept_edits";

/** A plan is prose meant to be read whole: it gets more room than a tool's input. */
export const PLAN_CHARS = 8000;

const TOOL_OPTIONS: AskOption[] = [
  { id: ALLOW, label: "Allow", style: "primary" },
  { id: DENY, label: "Deny", style: "danger" },
];

/** The modes a session can leave plan mode in beyond asking before each edit. */
export type GoOnMode = "bypassPermissions" | "auto" | "acceptEdits";

const GO_ON: Record<GoOnMode, { id: string; label: string; clear: string; description: string }> = {
  bypassPermissions: { id: BYPASS, label: "Yes, and bypass permissions", clear: "bypass permissions", description: "Build it with no further prompts" },
  auto: { id: AUTO, label: "Yes, and use auto mode", clear: "use auto mode", description: "Build it, with a reviewer model screening its actions" },
  acceptEdits: { id: ACCEPT_EDITS, label: "Yes, auto-accept edits", clear: "auto-accept edits", description: "Build it, applying edits without asking" },
};

/** The mode each allowing option leaves plan mode in. */
const MODE_OF: Record<string, string> = { [BYPASS]: "bypassPermissions", [AUTO]: "auto", [ACCEPT_EDITS]: "acceptEdits", [ALLOW]: "default" };

/**
 * The mode the "Yes, and …" row goes on in, as the CLI picks it: bypass when the session may
 * bypass, auto mode when it started in it or has been seen in it, accepting edits otherwise.
 */
export function goOnMode(launch: ClaudeLaunch | undefined, seen: ReadonlySet<string> = new Set()): GoOnMode {
  if (launch?.bypass || seen.has("bypassPermissions")) return "bypassPermissions";
  if (launch?.mode === "auto" || seen.has("auto")) return "auto";
  return "acceptEdits";
}

/** What a plan's ask offers. */
export interface PlanOffer {
  goOn: GoOnMode;
  /** The plan can go on with a clear context. */
  clear: boolean;
  /** In the session's own terminal, by the CLI's row; in a fresh session otherwise. */
  inPlace?: boolean;
  /** How full the session's context is, in percent, when known. */
  used?: number;
}

/** The terminal's rows for a plan, in its order. */
export function planOptions(offer: PlanOffer): AskOption[] {
  const go = GO_ON[offer.goOn];
  const used = offer.used !== undefined ? ` (${offer.used}% used)` : "";
  const options: AskOption[] = [];
  if (offer.clear) options.push({ id: CLEAR, label: `Yes, clear context${used} and ${go.clear}`, description: offer.inPlace ? "Build it in this terminal, starting from the plan alone" : "Build it in a new session that starts from the plan alone", style: "primary" });
  options.push({ id: go.id, label: go.label, description: go.description, style: "primary" });
  options.push({ id: ALLOW, label: "Yes, manually approve edits", description: "Build it, asking before each edit", style: "primary" });
  options.push({ id: DENY, label: "No, keep planning", description: "Stay in plan mode; a note says what to change", style: "danger" });
  return options;
}

export interface PermissionAsk {
  title: string;
  detail: string;
  options: AskOption[];
  /** A plan's answer also moves the session's permission mode, and may carry a note. */
  plan: boolean;
}

function cap(text: string, chars: number): string {
  return text.length > chars ? text.slice(0, chars - 1) + "…" : text;
}

/** What a call runs or reaches, one to a line at the top: the terminal leads with these. */
const LEAD_FIELDS = ["command", "pattern", "url", "query", "file_path", "notebook_path", "path"];
/** Prose or a file's text, each set apart: what a call writes, then why, then what it asks. */
const BODY_FIELDS = ["content", "new_source", "description", "prompt"];

/**
 * A tool's input in words, redacted: the fields that say what the call runs or reaches, an
 * edit as its lines (the ones it keeps as context, `- ` the ones it takes out, `+ ` the ones
 * it puts in), a file's content, the call's description and prompt, and every other field as
 * `name: value`, nested ones indented under their name.
 */
export function inputText(toolInput: unknown): string {
  const input = redact(toolInput ?? {});
  if (typeof input === "string") return input;
  if (input === null || typeof input !== "object") return String(input);
  if (Array.isArray(input)) return input.flatMap((v, i) => fieldLines(String(i + 1), v)).join("\n");
  const rest = new Map(Object.entries(input as Record<string, unknown>));
  const text = (key: string): string | undefined => {
    const value = rest.get(key);
    if (typeof value !== "string" || !value.trim()) return undefined;
    rest.delete(key);
    return value;
  };
  const lead: string[] = [];
  // Codex's command is its argv.
  const argv = rest.get("command");
  if (Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === "string")) {
    lead.push(argv.join(" "));
    rest.delete("command");
  }
  for (const key of LEAD_FIELDS) {
    const value = text(key);
    if (value !== undefined) lead.push(value);
  }
  const blocks = lead.length > 0 ? [lead.join("\n")] : [];
  const edit = editLines(rest.get("old_string"), rest.get("new_string"));
  if (edit !== undefined) {
    blocks.push(edit);
    rest.delete("old_string");
    rest.delete("new_string");
  }
  const edits = rest.get("edits");
  const each = Array.isArray(edits) ? edits.map((e) => (e !== null && typeof e === "object" ? editLines((e as Record<string, unknown>)["old_string"], (e as Record<string, unknown>)["new_string"]) : undefined)) : [];
  if (each.length > 0 && each.every((e): e is string => e !== undefined)) {
    blocks.push(...each);
    rest.delete("edits");
  }
  for (const key of BODY_FIELDS) {
    const value = text(key);
    if (value !== undefined) blocks.push(value);
  }
  const fields = [...rest].filter(([, v]) => v !== undefined).flatMap(([k, v]) => fieldLines(k, v));
  if (fields.length > 0) blocks.push(fields.join("\n"));
  return blocks.join("\n\n");
}

/** An edit as lines: the unchanged ones at either end as context, then the ones taken out and put in. */
function editLines(before: unknown, after: unknown): string | undefined {
  if (typeof before !== "string" || typeof after !== "string") return undefined;
  const a = before === "" ? [] : before.split(/\r?\n/);
  const b = after === "" ? [] : after.split(/\r?\n/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return [
    ...a.slice(0, head).map((l) => `  ${l}`),
    ...a.slice(head, a.length - tail).map((l) => `- ${l}`),
    ...b.slice(head, b.length - tail).map((l) => `+ ${l}`),
    ...a.slice(a.length - tail).map((l) => `  ${l}`),
  ].join("\n");
}

/** One field as `name: value`; a many-line value, an object or a list of objects indented under its name. */
function fieldLines(key: string, value: unknown): string[] {
  const indent = (lines: string[]) => lines.map((l) => `  ${l}`);
  if (value === null || typeof value !== "object") {
    const lines = String(value).split(/\r?\n/);
    return lines.length > 1 ? [`${key}:`, ...indent(lines)] : [`${key}: ${lines[0]}`];
  }
  if (Array.isArray(value) && value.every((v) => v === null || (typeof v !== "object" && !String(v).includes("\n")))) {
    return [`${key}: ${value.length > 0 ? value.map(String).join(", ") : "none"}`];
  }
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((v, i) => [String(i + 1), v]) : Object.entries(value);
  if (entries.length === 0) return [`${key}: none`];
  return [`${key}:`, ...indent(entries.flatMap(([k, v]) => fieldLines(k, v)))];
}

/** A tool's name as the terminal writes it: an MCP tool as its server and its own name. */
function toolLabel(toolName: string | undefined): string {
  const mcp = toolName?.match(/^mcp__(.+?)__(.+)$/);
  return mcp ? `${mcp[1]} - ${mcp[2]} (MCP)` : (toolName ?? "tool");
}

/** The plan an `ExitPlanMode` input carries; `undefined` for any other tool, or an input without one. */
export function planOf(toolName: string | undefined, toolInput: unknown): string | undefined {
  if (toolName !== EXIT_PLAN_TOOL || toolInput === null || typeof toolInput !== "object") return undefined;
  const plan = (toolInput as Record<string, unknown>)["plan"];
  return typeof plan === "string" && plan.trim() ? plan.trim() : undefined;
}

/** What a permission ask shows: the plan of an `ExitPlanMode`, the tool's own input in words otherwise. */
export function permissionDetail(toolName: string | undefined, toolInput: unknown, chars: number): string {
  const plan = planOf(toolName, toolInput);
  return plan !== undefined ? cap(plan, PLAN_CHARS) : cap(inputText(toolInput), chars);
}

/** The ask a held tool call opens; `where` names the session, as the title of a tool's ask does. */
export function permissionAsk(toolName: string | undefined, toolInput: unknown, where: string, chars: number, offer: PlanOffer = { goOn: "acceptEdits", clear: false }): PermissionAsk {
  const plan = planOf(toolName, toolInput);
  if (plan !== undefined) return { title: `Ready to code in ${where}?`, detail: cap(plan, PLAN_CHARS), options: planOptions(offer), plan: true };
  return { title: `${toolLabel(toolName)} in ${where}`, detail: cap(inputText(toolInput), chars), options: TOOL_OPTIONS, plan: false };
}

/** The allowing option that goes on in `mode`: what a clear-context answer falls back to. */
export function goOnOption(mode: GoOnMode): string {
  return GO_ON[mode].id;
}

/** The terminal's label for the row that goes on in `mode`. */
export function goOnLabel(mode: GoOnMode): string {
  return GO_ON[mode].label;
}

/**
 * The call a plan's allow hands back. Claude Code takes a hook's allow for a tool that must
 * ask the user (`ExitPlanMode`, as `AskUserQuestion`) only with the input it answers for:
 * without one the allow is dropped and the terminal's dialog stays up. The hook is shown the
 * call with the plan and its file read in from disk (`plan`, `planFilePath`), and a `plan`
 * handed back reads to the CLI as the user's edit of it, so those two go and the call is the
 * model's own, as the terminal's own "Yes" gives it. A plan with no file is the model's own
 * argument, and stays.
 */
export function planCallInput(toolInput: unknown): Record<string, unknown> {
  if (toolInput === null || typeof toolInput !== "object" || Array.isArray(toolInput)) return {};
  const { plan, planFilePath, ...own } = toolInput as Record<string, unknown>;
  return typeof planFilePath === "string" || plan === undefined ? own : { ...own, plan };
}

/**
 * The `PermissionRequest` decision an answered ask releases. Anything but an allow is a deny
 * carrying the text as its message, which is how a note on a plan ("use the other library")
 * reaches the agent that is to keep planning. A plan's allow carries its call and the mode it
 * goes on in. `clear` is not decided here: the caller starts the fresh session first.
 */
export function permissionDecision(answer: AskAnswer | undefined, plan?: { input: unknown }): Record<string, unknown> {
  const option = answer?.option;
  const mode = plan && option !== undefined ? MODE_OF[option] : undefined;
  if (option !== ALLOW && mode === undefined) {
    return { behavior: "deny", message: answer?.text ?? (plan ? "Keep planning" : "Denied through cophylad") };
  }
  // Leaving plan mode is the mode change, not the tool call: the harness makes it for us.
  if (plan && mode !== undefined) return { behavior: "allow", updatedInput: planCallInput(plan.input), updatedPermissions: [{ type: "setMode", mode, destination: "session" }] };
  return { behavior: "allow" };
}

/** The old session's decision once its plan went on in a fresh one: a deny that ends its turn. */
export function handedOffDecision(): Record<string, unknown> {
  return { behavior: "deny", message: "Approved. The plan is being built in a new session with a clear context, so this one stops here.", interrupt: true };
}

/**
 * The first message of the session a plan is built in: the plan, where the planning session's
 * transcript is for details left behind (as the CLI's own clear-context message says), and
 * the note that came with the answer.
 */
export function freshPlanPrompt(plan: string, transcript?: string, note?: string): string {
  let text = `Implement this plan:\n\n${plan}`;
  if (transcript) text += `\n\nIf you need specific details from before exiting plan mode (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcript}`;
  if (note) text += `\n\nUser feedback on this plan: ${note}`;
  return text;
}
