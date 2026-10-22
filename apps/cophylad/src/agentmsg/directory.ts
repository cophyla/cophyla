// The agent directory: the user's live agent sessions on every node, each under a short alias
// another agent addresses it by. A Claude session's alias is the name its registry gave it, a
// Codex session's its thread's name; one without a name, or of another harness, is
// `<folder>-<harness>`. Two that would meet are told apart by `@machine`, then
// by four characters of the id, the older session keeping the plainer form, so an alias given
// out stays its session's while that session lives. A renamed session goes by its new name and
// still answers to the forms it had before, as long as no other session has taken them. `to`
// takes an alias, `alias@machine`, any of the forms a session could have had or had, or a
// session id.
//
// The chat's own session is no agent, and nor are the sessions a workspace node runs for this
// cluster on another person's machine (a hands node that shares folders alone): they take no
// agent's message. Nor does a node whose row does not say it runs agent messaging: one turned
// off, or an older version, which could not deliver what is sent.

import type { AgentListing, AgentRef, ConnectionListing, Focus, MachineListing, NodeRecord, Session, TeammateListing } from "@cophyla/protocol";

/** A session with the machine it runs on, as the directory holds it. */
export interface DirectoryEntry {
  session: Session;
  nodeName: string;
}

export interface Directory {
  entries: DirectoryEntry[];
  /** Each session's alias, the forms its name gives it, and those it had under a name before. */
  aliases: Map<string, { alias: string; forms: string[]; former: string[] }>;
}

const ALIAS_CHARS = 40;

/** Lower case, words joined by `-`, nothing a shell or a tag would read. */
export function slug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, ALIAS_CHARS)
    .replace(/[-.]+$/g, "");
}

/** The last part of a path, whichever machine's separators it uses. */
export function folderOf(cwd: string): string | undefined {
  const parts = cwd.split(/[\\/]+/).filter((p) => p !== "" && !p.endsWith(":"));
  return parts[parts.length - 1];
}

/**
 * A session's alias before anything tells it apart from another: its name as the rail shows it
 * (a Claude session's from its registry, a Codex thread's own, which Codex gives it after its
 * first turn or the user sets), else `<folder>-<harness>`.
 */
export function base(s: Session): string {
  const given = s.harness === "claude" ? s.name : s.harness === "codex" ? s.title : undefined;
  const named = given ? slug(given) : "";
  if (named) return named;
  return `${slug(folderOf(s.cwd) ?? "") || "home"}-${s.harness}`;
}

/** The forms a session's alias may take, plainest first. */
function forms(s: Session, nodeName: string): string[] {
  const b = base(s);
  const machine = slug(nodeName) || "node";
  const suffix = s.id.slice(-4).toLowerCase();
  return [b, `${b}@${machine}`, `${b}-${suffix}`, `${b}-${suffix}@${machine}`];
}

/**
 * Whether a row is one an agent may message: live, the user's own agent, and on a node that
 * takes agents' messages. `node`: the row's node from the registry, or `self` for this node's own.
 */
export function eligible(s: Session, node: Pick<NodeRecord, "hands" | "scope" | "capabilities"> | "self" | undefined): boolean {
  if (s.status === "ended" || s.role === "assistant") return false;
  if (node === "self") return true;
  if (!node?.capabilities.agents) return false;
  // a workspace node: hands, lending folders of another person's machine
  if (node.hands === true && node.scope.kind === "workspaces") return false;
  return true;
}

/**
 * Aliases for every entry: the oldest session first takes the plainest form free. `earlier`: the
 * forms a session was given out under before, which it keeps answering to after a rename.
 */
export function directory(entries: DirectoryEntry[], earlier: (session: string) => readonly string[] | undefined = () => undefined): Directory {
  const sorted = [...entries].sort((a, b) => a.session.startedAt - b.session.startedAt || (a.session.id < b.session.id ? -1 : 1));
  const taken = new Set<string>();
  const aliases = new Map<string, { alias: string; forms: string[]; former: string[] }>();
  for (const e of sorted) {
    const all = forms(e.session, e.nodeName);
    const alias = all.find((f) => !taken.has(f)) ?? e.session.id;
    taken.add(alias);
    const former = (earlier(e.session.id) ?? []).filter((f) => !all.includes(f) && f !== e.session.id.toLowerCase());
    aliases.set(e.session.id, { alias, forms: all, former });
  }
  return { entries: sorted, aliases };
}

export function agentRef(d: Directory, e: DirectoryEntry): AgentRef {
  const folder = folderOf(e.session.cwd);
  return {
    session: e.session.id,
    alias: d.aliases.get(e.session.id)?.alias ?? e.session.id,
    harness: e.session.harness,
    node: e.session.node,
    nodeName: e.nodeName,
    ...(folder ? { folder } : {}),
  };
}

export function listing(d: Directory, e: DirectoryEntry): AgentListing {
  const s = e.session;
  return {
    ...agentRef(d, e),
    status: s.status,
    ...(s.waiting ? { waiting: s.waiting } : {}),
    ...(s.intent ? { intent: s.intent } : {}),
  };
}

/** The session `to` names, or why none is named. */
export function resolve(d: Directory, to: string): DirectoryEntry | { error: string } {
  const want = to.trim();
  const key = want.toLowerCase();
  if (/^sess_/i.test(want)) {
    const e = d.entries.find((x) => x.session.id === want);
    return e ?? { error: `no live agent session ${want}: list_agents shows who you can message` };
  }
  const exact = d.entries.filter((e) => d.aliases.get(e.session.id)?.alias === key);
  if (exact.length === 1) return exact[0]!;
  // `alias@machine`, the alias being the one it has now
  const at = key.lastIndexOf("@");
  if (at > 0) {
    const name = key.slice(0, at);
    const machine = key.slice(at + 1);
    const on = d.entries.filter((e) => slug(e.nodeName) === machine && (d.aliases.get(e.session.id)?.alias.replace(/@[^@]*$/, "") === name));
    if (on.length === 1) return on[0]!;
  }
  // a form the session could have had: one given out before another session came or went; then
  // one it had under a name it no longer has
  for (const field of ["forms", "former"] as const) {
    const any = d.entries.filter((e) => d.aliases.get(e.session.id)?.[field].includes(key));
    if (any.length === 1) return any[0]!;
    if (any.length > 1) return { error: `"${want}" names more than one session: use the name list_agents gives, or the session's sess_ id` };
  }
  return { error: `no agent session is called "${want}": list_agents shows who you can message` };
}

/** The user's machines as the model reads them, for `send_file`: `here` is the caller's own. */
export function machinesText(machines: MachineListing[], here?: string): string | undefined {
  const named = machines.map((m) => {
    const notes = [m.node === here ? "yours" : undefined, m.online ? undefined : "offline", m.files ? undefined : "runs an older Cophyla, which takes no files"].filter((n) => n !== undefined);
    return notes.length > 0 ? `${m.name} (${notes.join(", ")})` : m.name;
  });
  return named.length === 0 ? undefined : `Machines (send_file with to set to the name): ${named.join(", ")}.`;
}

/** The directory as the model reads it: one line a session, then the teammates' open agents, then the other people's agents this session is connected to, then the user's machines. */
export function listingText(rows: AgentListing[], connections: ConnectionListing[] = [], machines: MachineListing[] = [], here?: string, teammates: TeammateListing[] = [], now = Date.now()): string {
  let text = agentsText(rows, connections, now);
  const t = teammatesText(teammates, now);
  if (t) text = `${text}\n\n${t}`;
  const m = machinesText(machines, here);
  return m ? `${text}\n\n${m}` : text;
}

/** An agent in focus, as another agent reads it: for how long and why. */
export function focusWords(f: Focus, now: number): string {
  const m = Math.max(1, Math.round((f.until - now) / 60_000));
  return `in focus for ${m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`} more (${f.reason}): what you send waits for it`;
}

/** A teammate's open agents, as the model reads them. */
function teammatesText(rows: TeammateListing[], now: number): string | undefined {
  if (rows.length === 0) return undefined;
  const words: Record<string, string> = { claude: "Claude Code", codex: "Codex", muse: "Muse", acp: "an ACP agent" };
  const lines = rows.map((r) => {
    const what = [r.harness ? (words[r.harness] ?? r.harness) : "an agent", r.workspace ? `in ${r.workspace}` : undefined, r.focus ? focusWords(r.focus, now) : r.status ? r.status.replace("_", " ") : undefined].filter(Boolean).join(", ");
    return `- ${r.alias}: ${r.user}'s ${what}${r.connected ? " (connected to you)" : ""}${r.intent ? `. ${r.intent}` : ""}`;
  });
  return `Your user's teammates' agents open or connected to you (external: they work for someone else; send_message with to set to the name):\n${lines.join("\n")}`;
}

function agentsText(rows: AgentListing[], connections: ConnectionListing[], now: number): string {
  const words: Record<string, string> = { claude: "Claude Code", codex: "Codex", muse: "Muse", acp: "an ACP agent" };
  const own =
    rows.length === 0
      ? "No other agent session is running that you can message."
      : `${rows.length === 1 ? "One agent session" : `${rows.length} agent sessions`} you can message (send_message with to set to the name):\n${rows
          .map((r) => {
            const state = r.focus ? focusWords(r.focus, now) : r.status === "idle" && r.waiting ? `idle, waiting on ${r.waiting.on === "shell" ? "its shells" : "its user"}` : r.status.replace("_", " ");
            return `- ${r.alias}: ${words[r.harness] ?? r.harness} on ${r.nodeName}${r.folder ? `, in ${r.folder}` : ""}, ${state}${r.intent ? `. ${r.intent}` : ""}`;
          })
          .join("\n")}`;
  if (connections.length === 0) return own;
  const lines = connections.map((c) => {
    const what = c.live === false ? "no agent runs in their terminal now; what you send waits there" : c.harness ? `${words[c.harness] ?? c.harness}` : "an agent";
    return `- ${c.alias}: ${c.user}'s ${what}${c.queued ? `; ${c.queued} of your messages wait for their Cophyla to be reached` : ""}`;
  });
  return `${own}\n\nConnected to other people's agents (external: they work for someone else; send_message with to set to the name):\n${lines.join("\n")}`;
}
