// The group chats as a side keeps them: one `kv` row per group under `groups`, its posts under
// `groups.posts` one key each (`<group>/<number>`, the number this side gave it as it arrived),
// and, once teammates are in a group, the log of what this side's own people and agents did,
// under `groups.log` (`<group>/<seq>`), which the teammates catch up from. All of them
// replicate to the backups and stay out of the cloud backup and the brain
// (`grants/namespaces.ts`).

import type { Focus, GroupEntry, GroupEntryPost, GroupFile, GroupMention, GroupNotify, GroupPhoto, HarnessKind, TeammatePlace } from "@cophyla/protocol";
import { GROUP_LOG_KV_NS, GROUP_POSTS_KV_NS, GROUPS_KV_NS } from "../grants/namespaces.ts";
import type { Store } from "../store/index.ts";

/** A member as a side keeps it. */
export interface MemberRow {
  /** `agent:<sess_…>`, or `person:<account>` (`person:me` for this side's user while signed out). */
  key: string;
  kind: "agent" | "person";
  session?: string;
  /** The owner's account (`me` for this side's user while signed out), and their login. */
  owner: string;
  user: string;
  /** An agent's name on its owner's side, as it was when added or last told. */
  name?: string;
  harness?: HarnessKind;
  /** The name of the workspace an agent works in. */
  workspace?: string;
  notify?: GroupNotify;
  /** The number of the last post it read, on this side. */
  readTo: number;
  /** An agent of this side's: the post its last notice was for, while that notice waits unread, and when it was sent. */
  noticeAt?: number;
  noticeTime?: number;
  /** It was reminded once of the tag its notice was for. */
  reminded?: boolean;
  /** An agent of this side's: the last post a line of what is unread, beside a prompt or a tool's answer, told it of. */
  nudgedTo?: number;
  /** Its session ended; kept, with its read point. */
  gone?: boolean;
  /** Another side's agent's focus, as its side said. */
  focus?: Focus;
  addedBy: string;
  addedAt: number;
  /** When its row last changed, by its writer's clock: of two changes, the later one stands. */
  at: number;
}

/** A group as a side keeps it. */
export interface GroupRow {
  id: string;
  name: string;
  purpose?: string;
  /** Who made it: their login, or `you` while signed out; and their account. */
  by: string;
  byOwner: string;
  notify: GroupNotify;
  createdAt: number;
  /** When its name, purpose or setting last changed, by the changer's clock. */
  updatedAt: number;
  ended?: { at: number; by: string };
  members: MemberRow[];
  /** This side's: the folder of the first of this side's agents added, which the rail puts it under. */
  home?: TeammatePlace;
  /** The number of the last post this side took. */
  n: number;
  /** The last entry of this side's own log. */
  seq: number;
  /**
   * The other sides in it, by account: the teammate they are reached through, the last entry of
   * theirs taken, and, for a side that came in after the group was made here, the number of the
   * last post before it came, whose files it is not served.
   */
  sides: Record<string, { teammate: string; user: string; taken: number; since?: number }>;
  lastAt?: number;
}

/**
 * A file of a post as a side keeps it. On the side that wrote the post, `src` is where it is:
 * the machine and path it was posted from, or where an app's upload was kept on the primary;
 * no other side is told.
 */
export interface FileRow extends Omit<GroupFile, "machine"> {
  src?: { node: string; path: string };
}

/** A post as a side keeps it: its text holds each tag as `@[<member key>]`. */
export interface PostRow {
  id: string;
  group: string;
  n: number;
  from: GroupEntryPost["from"];
  text: string;
  mentions: GroupMention[];
  replyTo?: string;
  expectsReply?: boolean;
  answered?: boolean;
  /** The member keys that gave it a thumbs up. */
  acks: string[];
  /** Its photos, whose bytes every side keeps (`media.ts`), and its files. */
  photos?: GroupPhoto[];
  files?: FileRow[];
  at: number;
}

const pad = (n: number) => String(n).padStart(9, "0");

export class GroupStore {
  private store: Store;
  /** Where each post id lives, as far as this process has met it. */
  private index = new Map<string, { group: string; n: number }>();

  constructor(store: Store) {
    this.store = store;
  }

  get(id: string): GroupRow | undefined {
    const v = this.store.kv.get(GROUPS_KV_NS, id) as GroupRow | undefined;
    return v ? { ...v, members: v.members ?? [], sides: v.sides ?? {} } : undefined;
  }

  list(): GroupRow[] {
    const out: GroupRow[] = [];
    for (const k of this.store.kv.list(GROUPS_KV_NS)) {
      const g = this.get(k);
      if (g) out.push(g);
    }
    return out;
  }

  put(g: GroupRow): void {
    this.store.kv.put(GROUPS_KV_NS, g.id, g);
  }

  /** Drops a group with its posts and its log. */
  delete(id: string): void {
    this.store.kv.delete(GROUPS_KV_NS, id);
    for (const k of this.store.kv.list(GROUP_POSTS_KV_NS, `${id}/`)) this.store.kv.delete(GROUP_POSTS_KV_NS, k);
    for (const k of this.store.kv.list(GROUP_LOG_KV_NS, `${id}/`)) this.store.kv.delete(GROUP_LOG_KV_NS, k);
    for (const [pid, at] of [...this.index]) if (at.group === id) this.index.delete(pid);
  }

  // --- posts ---------------------------------------------------------------------------------------

  putPost(p: PostRow): void {
    this.store.kv.put(GROUP_POSTS_KV_NS, `${p.group}/${pad(p.n)}`, p);
    this.index.set(p.id, { group: p.group, n: p.n });
  }

  post(group: string, n: number): PostRow | undefined {
    const p = this.store.kv.get(GROUP_POSTS_KV_NS, `${group}/${pad(n)}`) as PostRow | undefined;
    if (p) this.index.set(p.id, { group, n });
    return p;
  }

  /** The numbers of a group's posts, oldest first. */
  numbers(group: string): number[] {
    return this.store.kv.list(GROUP_POSTS_KV_NS, `${group}/`).map((k) => Number(k.slice(group.length + 1)));
  }

  /** A post by its id, looked for from the newest back. */
  byId(group: string, id: string): PostRow | undefined {
    const at = this.index.get(id);
    if (at && at.group === group) {
      const p = this.post(group, at.n);
      if (p?.id === id) return p;
    }
    const ns = this.numbers(group);
    for (let i = ns.length - 1; i >= 0; i--) {
      const p = this.post(group, ns[i]!);
      if (p?.id === id) return p;
    }
    return undefined;
  }

  /** The posts after number `after`, oldest first, at most `limit`. */
  after(group: string, after: number, limit = Infinity): PostRow[] {
    const out: PostRow[] = [];
    for (const n of this.numbers(group)) {
      if (n <= after) continue;
      const p = this.post(group, n);
      if (p) out.push(p);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** The `limit` posts before number `before` (the latest without it), oldest first, and whether there are more. */
  page(group: string, limit: number, before?: number): { posts: PostRow[]; more: boolean } {
    const ns = this.numbers(group).filter((n) => before === undefined || n < before);
    const take = ns.slice(Math.max(0, ns.length - limit));
    const posts = take.flatMap((n) => {
      const p = this.post(group, n);
      return p ? [p] : [];
    });
    return { posts, more: ns.length > take.length };
  }

  /** Keeps a group to its last `max` posts: the ones dropped, for what is kept beside them. */
  trim(group: string, max: number): PostRow[] {
    const ns = this.numbers(group);
    const dropped: PostRow[] = [];
    for (const n of ns.slice(0, Math.max(0, ns.length - max))) {
      const p = this.post(group, n);
      this.store.kv.delete(GROUP_POSTS_KV_NS, `${group}/${pad(n)}`);
      if (p) {
        this.index.delete(p.id);
        dropped.push(p);
      }
    }
    return dropped;
  }

  // --- this side's log, for teammates ---------------------------------------------------------------

  /** A group this side left while other sides were in it: its leave, kept for a side that was away (`<group>/left`). */
  putLeft(group: string, left: { seq: number; at: number; person: string; owners: string[] }): void {
    this.store.kv.put(GROUP_LOG_KV_NS, `${group}/left`, left);
  }

  left(group: string): { seq: number; at: number; person: string; owners: string[] } | undefined {
    return this.store.kv.get(GROUP_LOG_KV_NS, `${group}/left`) as { seq: number; at: number; person: string; owners: string[] } | undefined;
  }

  putEntry(group: string, seq: number, entry: GroupEntry, at: number): void {
    this.store.kv.put(GROUP_LOG_KV_NS, `${group}/${pad(seq)}`, { seq, entry, at });
  }

  /** This side's entries after `after`, oldest first, at most `limit`. */
  entries(group: string, after: number, limit: number): { entries: { seq: number; entry: GroupEntry; at: number }[]; more: boolean } {
    const keys = this.store.kv.list(GROUP_LOG_KV_NS, `${group}/`).filter((k) => Number(k.slice(group.length + 1)) > after);
    const entries = keys.slice(0, limit).flatMap((k) => {
      const v = this.store.kv.get(GROUP_LOG_KV_NS, k) as { seq: number; entry: GroupEntry; at: number } | undefined;
      return v ? [v] : [];
    });
    return { entries, more: keys.length > limit };
  }
}
