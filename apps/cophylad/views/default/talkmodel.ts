// An agent's conversation with other agents, as the view keeps and draws it: each session's
// count from `talk.list` and `talk.state`, the pages of the ones opened from `talk.messages`,
// a message as it comes from `talk.said`, and what a row of the Messages pane says. Kept apart
// from model.ts, which folds these in through `applyTalk`.

import type { TalkMessage, TalkParty, TalkStatus, TalkSummary } from "@cophyla/protocol";
import type { Action, ViewState } from "./model.ts";
import { postExcerpt } from "./model.ts";

/** A session's messages loaded so far, as a group's posts are. */
export interface TalkPage {
  messages: TalkMessage[];
  more: boolean;
  loaded: boolean;
  loading?: boolean;
  /** The line dropped, or messages came that this view was not watching for, since it loaded: the latest page is asked for again as the pane shows. */
  stale?: boolean;
}

const byNumber = (a: TalkMessage, b: TalkMessage) => a.n - b.n;

function merge(...lists: TalkMessage[][]): TalkMessage[] {
  const out = new Map<number, TalkMessage>();
  for (const list of lists) for (const m of list) out.set(m.n, m);
  return [...out.values()].sort(byNumber);
}

/** Folds a conversation action in; false when the action is none of them. */
export function applyTalk(state: ViewState, action: Action): boolean {
  switch (action.type) {
    case "talks":
      // refused (an older node or app): no Messages shows
      state.talkOn = action.talks !== undefined;
      state.talks = new Map((action.talks ?? []).map((t) => [t.session, t]));
      return true;
    case "talk.state": {
      const s = action.params;
      state.talks.set(s.session, s);
      // more came than this view was told of: what is loaded is behind
      const page = state.talkPages.get(s.session);
      if (page?.loaded && s.n > (page.messages.at(-1)?.n ?? 0)) page.stale = true;
      return true;
    }
    case "talk.said": {
      const m = action.params.message;
      const page = state.talkPages.get(m.session);
      if (!page) return true;
      const last = page.messages.at(-1)?.n ?? 0;
      // a change to one shown, or the next one: kept; one past a gap leaves the page behind
      if (!page.loaded || m.n === last + 1 || page.messages.some((x) => x.n === m.n)) page.messages = merge(page.messages, [m]);
      else if (m.n > last) page.stale = true;
      return true;
    }
    case "talk.page.loading": {
      const page = state.talkPages.get(action.session) ?? { messages: [], more: false, loaded: false };
      page.loading = true;
      state.talkPages.set(action.session, page);
      return true;
    }
    case "talk.page.failed": {
      const page = state.talkPages.get(action.session);
      if (page) page.loading = false;
      return true;
    }
    case "talk.page": {
      const page = state.talkPages.get(action.session);
      if (action.before !== undefined && page?.loaded && !page.stale) {
        page.messages = merge(action.messages, page.messages);
        page.more = action.more;
        page.loading = false;
        return true;
      }
      // the latest page: what came while it was asked for, newer than any in it, stays too
      const last = action.messages.at(-1)?.n ?? 0;
      const since = page ? page.messages.filter((m) => m.n > last) : [];
      state.talkPages.set(action.session, { messages: merge(action.messages, since), more: action.more, loaded: true });
      return true;
    }
    default:
      return false;
  }
}

/** What the user has not read of a session's conversation. */
export function talkUnread(state: Pick<ViewState, "talks">, session: string): number {
  return state.talks.get(session)?.unread ?? 0;
}

/** A count as a badge shows it. */
export function badge(n: number): string {
  return n > 99 ? "99+" : String(n);
}

/** The number of the last message loaded, when the user has not read up to it. */
export function talkReadUpTo(state: Pick<ViewState, "talks" | "talkPages">, session: string): number | undefined {
  const last = state.talkPages.get(session)?.messages.at(-1)?.n;
  if (last === undefined) return undefined;
  const read = state.talks.get(session)?.readTo ?? 0;
  return read < last ? last : undefined;
}

/** What a session goes by in its own conversation: its own name, else its folder and harness, as other agents name it. */
export function selfName(s: { name?: string; cwd: string; harness: string }): string {
  if (s.name) return s.name;
  const folder = s.cwd.split(/[\\/]+/).filter((p) => p !== "" && !p.endsWith(":")).at(-1);
  return folder ? `${folder}-${s.harness}` : s.harness;
}

/** The other end, as a key the filter keeps: its session, or the person's agent by how it is reached. */
export function partyKey(p: TalkParty): string {
  return p.session ?? `${p.teammate ?? p.connection ?? "peer"}:${p.name}`;
}

/** What a message's standing says beside it, when it is anything but delivered. */
export function statusWords(status: TalkStatus | undefined): { label: string; title: string } | undefined {
  switch (status) {
    case "held":
      return { label: "held", title: "Held in its terminal until that agent lets messages in" };
    case "pending":
      return { label: "waiting on you", title: "Waiting for your approval before it goes" };
    case "queued":
      return { label: "queued", title: "Kept until the other person's Cophyla is reached" };
    case "waiting":
      return { label: "waiting", title: "Kept until an agent runs in the connection's terminal" };
    case "focus":
      return { label: "held for focus", title: "Held until the receiving agent comes out of focus" };
    case "failed":
      return { label: "not delivered", title: "It never arrived" };
    default:
      return undefined;
  }
}

/** One of the parties a session talked with, for the filter over the Messages pane. */
export interface TalkPartyChip {
  key: string;
  name: string;
  harness?: string;
  /** Another person's agent: their login. */
  user?: string;
  count: number;
}

/** The parties in the messages loaded, the most recent first. */
export function talkParties(page: Pick<TalkPage, "messages"> | undefined): TalkPartyChip[] {
  const out = new Map<string, TalkPartyChip & { last: number }>();
  for (const m of page?.messages ?? []) {
    const key = partyKey(m.with);
    const had = out.get(key);
    if (had) {
      had.count++;
      had.last = m.n;
      had.name = m.with.name;
    } else out.set(key, { key, name: m.with.name, ...(m.with.harness ? { harness: m.with.harness } : {}), ...(m.with.user ? { user: m.with.user } : {}), count: 1, last: m.n });
  }
  return [...out.values()].sort((a, b) => b.last - a.last).map(({ last: _last, ...c }) => c);
}

/** A row of the Messages pane: who it is from or to, when, where it stands, what it answers, and its words. */
export interface TalkRow {
  key: string;
  n: number;
  id: string;
  dir: "in" | "out";
  /** The other end's name, and what its mark is drawn as. */
  name: string;
  harness?: string;
  /** The other end is another person's agent: their login. */
  user?: string;
  /** Where the other end works, for its title. */
  where: string;
  at: number;
  text: string;
  lead: boolean;
  report: boolean;
  status?: { label: string; title: string; failed: boolean };
  why?: string;
  quote?: { name?: string; excerpt: string };
  /** The first message the user had not read when the pane opened. */
  first: boolean;
}

/**
 * The rows of a session's Messages pane: the messages loaded, those with one party alone when
 * the filter says, each with the message it answers quoted when that is loaded. `since` is the
 * read point as the pane opened: the first message past it is marked.
 */
export function talkRows(page: Pick<TalkPage, "messages"> | undefined, opts: { party?: string; since?: number; self?: string } = {}): TalkRow[] {
  const messages = page?.messages ?? [];
  const byId = new Map(messages.map((m) => [m.id, m]));
  const shown = opts.party === undefined ? messages : messages.filter((m) => partyKey(m.with) === opts.party);
  const firstNew = opts.since === undefined ? undefined : shown.find((m) => m.n > opts.since!)?.n;
  return shown.map((m) => {
    let quote: TalkRow["quote"];
    if (m.replyTo !== undefined) {
      const answered = byId.get(m.replyTo);
      const name = answered?.dir === "out" ? opts.self : answered?.with.name;
      quote = answered ? { ...(name !== undefined ? { name } : {}), excerpt: postExcerpt(answered.text, 90) } : { excerpt: "an earlier message" };
    }
    const status = statusWords(m.status);
    const place = [m.with.machine, m.with.folder].filter((w) => w !== undefined && w !== "").join(", ");
    return {
      key: `${m.n}`,
      n: m.n,
      id: m.id,
      dir: m.dir,
      name: m.with.name,
      ...(m.with.harness ? { harness: m.with.harness } : {}),
      ...(m.with.user ? { user: m.with.user } : {}),
      where: m.with.user ? `${m.with.user}'s agent, ${m.with.teammate ? "a teammate's" : "on a connection"}` : place,
      at: m.at,
      text: m.text,
      lead: m.lead === true,
      report: m.report === true,
      ...(status ? { status: { ...status, failed: m.status === "failed" } } : {}),
      ...(m.why ? { why: m.why } : {}),
      ...(quote ? { quote } : {}),
      first: firstNew !== undefined && m.n === firstNew,
    };
  });
}
