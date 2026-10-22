// A tag of the user in a group chat, on an OS notification: a new post that names the user's
// person (or `@users`, `@everyone`) and is not their own is toasted once, one toast per group
// (a later tag in the same group takes the earlier one's place), and taken down once the user
// has read the group that far, leaves it, or it ends. Like asks, a tag is toasted only where
// someone is at the machine, so a cluster's desktops do not all chime; the phone has its own
// push for it. The window in front shows no toast (the shell's own rule for every toast). The
// toast has no buttons: a click shows the window. DOM-free.

import type { Group, GroupPost, RpcNotification } from "@cophyla/protocol";
import { AWAY_MS } from "./notify.ts";
import type { NotifyAsk } from "./notify.ts";

/** A post this much older than now, met first after a start or a reconnect, is not new. */
export const MENTION_FRESH_MS = 2 * 60_000;
const DETAIL_CHARS = 200;

export interface MentionNotifierDeps {
  notify: (toast: NotifyAsk) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  onError?: (message: string) => void;
  /** How long since the last keyboard or mouse input on this machine; undefined when it cannot tell. */
  idleMs?: () => Promise<number | undefined>;
  now?: () => number;
}

interface Known {
  name: string;
  /** The user's own person in the group, and how far they have read. */
  me?: { key: string; readTo: number };
  ended: boolean;
}

/** The toast's id for a group: one per group. */
export function mentionToastId(group: string): string {
  return `mention:${group}`;
}

export class MentionNotifier {
  private deps: MentionNotifierDeps;
  private now: () => number;
  private groups = new Map<string, Known>();
  /** The highest post number met per group, so a post that changed (a thumbs up) is not new. */
  private lastN = new Map<string, number>();
  /** The post each group's toast is up for. */
  private up = new Map<string, number>();
  /** A new post of a group this host has not heard of yet, until its state comes. */
  private waiting = new Map<string, GroupPost>();
  /** The user's own latest posts per group: a reply to one tags them, as the daemon counts it. */
  private mineIds = new Map<string, string[]>();

  constructor(deps: MentionNotifierDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  onNotification(n: RpcNotification): void {
    if (n.method === "group.state") this.onGroup(n.params as Group & { left?: boolean });
    else if (n.method === "group.posted") void this.onPost(n.params as { group: string; post: GroupPost });
  }

  private onGroup(g: Group & { left?: boolean }): void {
    if (g.left) {
      this.groups.delete(g.id);
      this.lastN.delete(g.id);
      this.waiting.delete(g.id);
      this.mineIds.delete(g.id);
      this.takeDown(g.id);
      return;
    }
    const me = g.members.find((m) => m.kind === "person" && m.me === true);
    this.groups.set(g.id, { name: g.name, ...(me ? { me: { key: me.key, readTo: me.readTo } } : {}), ended: g.ended !== undefined });
    const up = this.up.get(g.id);
    if (up !== undefined && ((me && me.readTo >= up) || g.ended)) this.takeDown(g.id);
    // a post that came before this host knew its group: the group's state follows its post
    const waiting = this.waiting.get(g.id);
    if (waiting) {
      this.waiting.delete(g.id);
      void this.consider(g.id, waiting);
    }
  }

  private async onPost(p: { group: string; post: GroupPost }): Promise<void> {
    const post = p.post;
    const last = this.lastN.get(p.group);
    this.lastN.set(p.group, Math.max(last ?? 0, post.n));
    // a post already met, changed since (a thumbs up, an answer), or an old one first met now
    if (last !== undefined ? post.n <= last : this.now() - post.at > MENTION_FRESH_MS) return;
    if (!this.groups.has(p.group)) {
      this.waiting.set(p.group, post);
      return;
    }
    await this.consider(p.group, post);
  }

  private async consider(group: string, post: GroupPost): Promise<void> {
    const p = { group, post };
    const g = this.groups.get(p.group);
    if (!g?.me || g.ended) return;
    const mine = this.mineIds.get(group) ?? [];
    if (post.from.kind !== "cophyla" && post.from.key === g.me.key) {
      this.mineIds.set(group, [...mine, post.id].slice(-50));
      return;
    }
    const answersMe = post.replyTo !== undefined && mine.includes(post.replyTo);
    if ((!tagsMe(post, g.me.key) && !answersMe) || post.n <= g.me.readTo) return;
    if (!(await this.someoneHere())) return;
    const toast: NotifyAsk = { id: mentionToastId(p.group), title: `${writerOf(post)} tagged you in #${g.name}`, detail: cut(post.text), options: [], multiple: true };
    // the group's earlier toast gives way
    if (this.up.has(p.group)) await this.deps.dismiss(toast.id).catch(() => undefined);
    this.up.set(p.group, post.n);
    this.deps.notify(toast).catch((e: unknown) => this.deps.onError?.(`notification: ${messageOf(e)}`));
  }

  private takeDown(group: string): void {
    if (!this.up.delete(group)) return;
    this.deps.dismiss(mentionToastId(group)).catch((e: unknown) => this.deps.onError?.(`dismiss ${group}: ${messageOf(e)}`));
  }

  private async someoneHere(): Promise<boolean> {
    if (!this.deps.idleMs) return true;
    try {
      const idle = await this.deps.idleMs();
      return idle === undefined || idle < AWAY_MS;
    } catch (e) {
      this.deps.onError?.(`idle time: ${messageOf(e)}`);
      return true;
    }
  }
}

/** Whether a post tags the user's person: by its key, or as one of `@users` and `@everyone`, never their own. */
export function tagsMe(post: Pick<GroupPost, "from" | "mentions">, me: string): boolean {
  if (post.from.kind !== "cophyla" && post.from.key === me) return false;
  return post.mentions.some((m) => ("member" in m ? m.member === me : m.all === "users" || m.all === "everyone"));
}

function writerOf(post: GroupPost): string {
  if (post.from.kind === "cophyla") return "Cophyla";
  if (post.from.kind === "person") return post.from.user;
  // another person's agent's handle carries their login already
  return post.from.handle;
}

function cut(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DETAIL_CHARS ? `${flat.slice(0, DETAIL_CHARS - 1)}…` : flat;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
