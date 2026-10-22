// A post's tags and its words. A tag is `@` and a member's handle as this side names it (an
// agent's alias, a teammate's agent's `<login>/<name>`, a person's login), or `@agents`,
// `@users`, `@everyone`. A post keeps each member's tag as `@[<member key>]`, since two sides
// name one agent differently, and each side writes it back as it names the member. Code spans
// and blocks are left alone: `@Injectable` in backticks tags no one.

import type { GroupMention } from "@cophyla/protocol";

/** The special tags, and who they reach. */
export const ALL_TAGS = ["everyone", "agents", "users"] as const;
export type AllTag = (typeof ALL_TAGS)[number];

/** Where in a text a tag may start: not after a letter, a digit or the parts of a handle, so an e-mail address tags no one. */
const TAG = /(^|[^\p{L}\p{N}_@./\\-])@([\p{L}\p{N}][\p{L}\p{N}_.-]*(?:\/[\p{L}\p{N}_.-]+)?(?:@[\p{L}\p{N}_.-]+)?)/gu;
const MARKER = /@\[((?:agent|person):[^\]\s]{1,120})\]/g;
/** Where a typed text holds what would read as a marker. */
const TYPED_MARKER = /@\[(?=(?:agent|person):)/g;

/** A marker typed by hand, or one that tags no one: broken with a zero-width space, so it never shows as a tag. */
const BREAK = "@\u200b[";

/** The text with every marker but those of `keep` broken, so a post cannot show a tag it did not make. */
export function keepMarkers(text: string, keep: ReadonlySet<string>): string {
  return text.replace(MARKER, (whole, key: string) => (keep.has(key) ? whole : BREAK + whole.slice(2)));
}

/** The text with its code (fenced blocks and backtick spans) blanked to spaces, so its positions hold. */
export function blankCode(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return text.replace(/```[\s\S]*?(```|$)/g, blank).replace(/`[^`\n]*`/g, blank);
}

/** What a tag's handle may resolve to: the member keys it names, by its lower-case form. */
export type HandleTable = Map<string, string[]>;

/** The tags read out of a post as it is posted: its text with the members' tags as markers, and whom it tags; or why it is refused. */
export function readTags(text: string, table: HandleTable, opts: { person: boolean }): { text: string; mentions: GroupMention[]; tagged: string[] } | { error: string; unknown: string[] } {
  const blanked = blankCode(text);
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  const mentions: GroupMention[] = [];
  const seen = new Set<string>();
  const tagged: string[] = [];
  let out = "";
  let last = 0;
  let refusal: string | undefined;
  for (const m of blanked.matchAll(TAG)) {
    const lead = m[1]!;
    let handle = m[2]!;
    // a sentence's full stop or a dash after the handle is not part of it
    handle = handle.replace(/[.-]+$/, "");
    if (!handle) continue;
    const start = m.index! + lead.length;
    const end = start + 1 + handle.length;
    const lower = handle.toLowerCase();
    if ((ALL_TAGS as readonly string[]).includes(lower)) {
      if (lower === "everyone" && !opts.person) refusal = "only a person tags @everyone: tag @agents for every agent, @users for every person";
      if (!seen.has(`all:${lower}`)) {
        seen.add(`all:${lower}`);
        mentions.push({ all: lower as AllTag });
      }
      continue;
    }
    const keys = table.get(lower);
    if (!keys || keys.length === 0) {
      unknown.push(`@${handle}`);
      continue;
    }
    if (keys.length > 1) {
      ambiguous.push(`@${handle}`);
      continue;
    }
    const key = keys[0]!;
    out += text.slice(last, start).replace(TYPED_MARKER, BREAK) + `@[${key}]`;
    last = end;
    if (!seen.has(key)) {
      seen.add(key);
      mentions.push({ member: key });
      tagged.push(key);
    }
  }
  if (refusal) return { error: refusal, unknown: [] };
  if (unknown.length > 0 || ambiguous.length > 0) {
    const bits: string[] = [];
    if (unknown.length > 0) bits.push(`${[...new Set(unknown)].join(", ")} ${unknown.length === 1 ? "names" : "name"} no member`);
    if (ambiguous.length > 0) bits.push(`${[...new Set(ambiguous)].join(", ")} ${ambiguous.length === 1 ? "names" : "name"} more than one member`);
    return { error: bits.join("; "), unknown: [...new Set([...unknown, ...ambiguous])] };
  }
  out += text.slice(last).replace(TYPED_MARKER, BREAK);
  return { text: out, mentions, tagged };
}

/** A kept text written back with each tag as this side names its member. */
export function writeTags(text: string, handleOf: (key: string) => string | undefined): string {
  return text.replace(MARKER, (whole, key: string) => {
    const h = handleOf(key);
    return h ? `@${h}` : whole === `@[${key}]` ? "@someone" : whole;
  });
}

/** The first words of a text for a notice: one line, cut at a word. */
export function preview(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Whether a post's mentions reach a member: by its key, or by a tag of everyone of its kind. */
export function reaches(mentions: readonly GroupMention[], key: string, kind: "agent" | "person"): boolean {
  for (const m of mentions) {
    if ("member" in m && m.member === key) return true;
    if ("all" in m && (m.all === "everyone" || (m.all === "agents" && kind === "agent") || (m.all === "users" && kind === "person"))) return true;
  }
  return false;
}

/** A clock time of the post for an agent's words. */
export function postTime(at: number, now: number): string {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return now - at > 20 * 3600_000 ? `${d.toISOString().slice(0, 10)} ${hm}` : hm;
}
