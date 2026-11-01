// The chat composer's slash commands, pure: which commands exist, what each does, how a line
// that starts with `/` is read, and which commands the palette offers for what is typed after
// it. A command either opens a picker in the view (`/resume`, `/usage`, `/model`, `/help`), or
// goes to the session as the user's own words, where the harness runs it as it would in its
// terminal (`/compact`, `/clear`). Rewind is not here: no platform call backs it yet.

export type SlashKind = "picker" | "send";

export interface SlashCommand {
  /** The name typed after the slash, lower case. */
  name: string;
  /** One line for the palette. */
  summary: string;
  /** `picker`: the view opens its own panel; `send`: the line goes to the session as typed. */
  kind: SlashKind;
  /** A command that discards the session's context asks first. */
  destructive?: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "model", summary: "Change the model the session uses", kind: "picker" },
  { name: "resume", summary: "Pick an ended session to start again", kind: "picker" },
  { name: "usage", summary: "What each login has spent, and its plan limit", kind: "picker" },
  { name: "compact", summary: "Summarise the conversation to free context", kind: "send" },
  { name: "clear", summary: "Start a fresh conversation in this session", kind: "send", destructive: true },
  { name: "help", summary: "List the slash commands", kind: "picker" },
];

/** A line the composer reads as a command: its name and what follows it, when it starts with `/`. */
export function parseSlash(text: string): { name: string; args: string } | undefined {
  const m = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return undefined;
  return { name: m[1]!.toLowerCase(), args: (m[2] ?? "").trim() };
}

/** The commands the palette lists for what is typed after the slash: prefix matches first, then words that contain it. */
export function matchSlash(typed: string, commands: readonly SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const q = typed.replace(/^\//, "").trim().toLowerCase();
  if (q === "") return [...commands];
  const prefix = commands.filter((c) => c.name.startsWith(q));
  const within = commands.filter((c) => !c.name.startsWith(q) && (c.name.includes(q) || c.summary.toLowerCase().includes(q)));
  return [...prefix, ...within];
}

/** Whether the composer shows the palette: a line that is a slash and a partial name, with nothing after the name yet. */
export function paletteOpen(text: string): boolean {
  return /^\/[A-Za-z-]*$/.test(text.trimStart());
}

/** The line sent to the session when a `send` command runs or a model is picked: the command as the user would type it. */
export function sendLine(name: string, args = ""): string {
  return args === "" ? `/${name}` : `/${name} ${args}`;
}
