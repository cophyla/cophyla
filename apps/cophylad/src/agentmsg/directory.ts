// The agent directory: the user's live agent sessions on every node, each under a short alias
// another agent addresses it by. A Claude session's alias is the name its registry gave it;
// any other's is `<folder>-<harness>`. Two that would meet are told apart by `@machine`, then
// by four characters of the id, the older session keeping the plainer form, so an alias given
// out stays its session's while that session lives. `to` takes an alias, `alias@machine`, any
// of the forms a session could have had, or a session id.
//
// The chat's own session is no agent, and nor are the sessions a workspace node runs for this
// cluster on another person's machine (a hands node that shares folders alone): they take no
// agent's message. Nor does a node whose row does not say it runs agent messaging: one turned
// off, or an older version, which could not deliver what is sent.

import type { AgentListing, AgentRef, NodeRecord, Session } from "@cophyla/protocol";

/** A session with the machine it runs on, as the directory holds it. */
export interface DirectoryEntry {
  session: Session;
  nodeName: string;
}

export interface Directory {
  entries: DirectoryEntry[];
  /** Each session's alias and every form it answers to, by session id. */
  aliases: Map<string, { alias: string; forms: string[] }>;
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

function base(s: Session): string {
  const named = s.harness === "claude" && s.name ? slug(s.name) : "";
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

/** Aliases for every entry: the oldest session first takes the plainest form free. */
export function directory(entries: DirectoryEntry[]): Directory {
  const sorted = [...entries].sort((a, b) => a.session.startedAt - b.session.startedAt || (a.session.id < b.session.id ? -1 : 1));
  const taken = new Set<string>();
  const aliases = new Map<string, { alias: string; forms: string[] }>();
  for (const e of sorted) {
    const all = forms(e.session, e.nodeName);
    const alias = all.find((f) => !taken.has(f)) ?? e.session.id;
    taken.add(alias);
    aliases.set(e.session.id, { alias, forms: all });
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
  // a form the session could have had: one given out before another session came or went
  const any = d.entries.filter((e) => d.aliases.get(e.session.id)?.forms.includes(key));
  if (any.length === 1) return any[0]!;
  if (any.length > 1) return { error: `"${want}" names more than one session: use the name list_agents gives, or the session's sess_ id` };
  return { error: `no agent session is called "${want}": list_agents shows who you can message` };
}

/** The directory as the model reads it: one line a session. */
export function listingText(rows: AgentListing[]): string {
  if (rows.length === 0) return "No other agent session is running that you can message.";
  const words: Record<string, string> = { claude: "Claude Code", codex: "Codex", muse: "Muse", acp: "an ACP agent" };
  const lines = rows.map((r) => {
    const state = r.status === "idle" && r.waiting ? `idle, waiting on ${r.waiting.on === "shell" ? "its shells" : "its user"}` : r.status.replace("_", " ");
    return `- ${r.alias}: ${words[r.harness] ?? r.harness} on ${r.nodeName}${r.folder ? `, in ${r.folder}` : ""}, ${state}${r.intent ? `. ${r.intent}` : ""}`;
  });
  return `${rows.length === 1 ? "One agent session" : `${rows.length} agent sessions`} you can message (send_message with to set to the name):\n${lines.join("\n")}`;
}
