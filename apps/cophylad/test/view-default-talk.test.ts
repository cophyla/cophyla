// The default view's Messages pane, pure: every session's count as the node says it, a page, an
// earlier page and a message as it lands (and one past a gap, which leaves the page behind),
// the line dropping, what the pane shows and when Messages offers itself, the count a badge
// shows, the parties a session talked with, and how a row reads: to or from whom, the message
// it answers, where it stands, a leader's words, a report, the first new one.

import { describe, expect, test } from "bun:test";
import { ACCESS_PRESETS } from "@cophyla/protocol";
import type { Client, TalkMessage } from "@cophyla/protocol";
import { apply, chatDraw, initialState, paneMode } from "../views/default/model.ts";
import type { HostReady, ViewState } from "../views/default/model.ts";
import { badge, partyKey, selfName, statusWords, talkParties, talkReadUpTo, talkRows, talkUnread } from "../views/default/talkmodel.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const A = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB3";
const B = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB4";
const C = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB5";
const TM = "tm_01ARZ3NDEKTSV4RRFFQ69G5TM1";

function connected(): ViewState {
  const scopes = [...ACCESS_PRESETS.full.scopes];
  const client: Client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind: "ui", node: DESK, scopes, via: "direct", audio: { in: false, out: false }, connectedAt: 1 } as Client;
  const ready: HostReady = { client, node: DESK, protocolVersion: 1, platformVersion: "0.20.0", view: { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin" }, scopes };
  const state = initialState();
  apply(state, { type: "host.ready", params: ready });
  apply(state, { type: "host.state", params: { connected: true } });
  return state;
}

const msg = (n: number, over: Partial<TalkMessage> = {}): TalkMessage => ({ session: A, n, id: `pmsg_${String(n).padStart(26, "0")}`, dir: "in", with: { session: B, name: "api-codex", harness: "codex", machine: "Desk", folder: "api" }, text: `message ${n}`, at: 1_000 + n, ...over });

describe("the conversations as the node says them", () => {
  test("talk.list turns Messages on, and its refusal off; a count comes and goes with talk.state", () => {
    const s = connected();
    expect(s.talkOn).toBeUndefined();
    apply(s, { type: "talks", talks: [{ session: A, n: 5, readTo: 2, unread: 3 }] });
    expect(s.talkOn).toBe(true);
    expect(talkUnread(s, A)).toBe(3);
    expect(talkUnread(s, B)).toBe(0);
    apply(s, { type: "talk.state", params: { session: A, n: 6, readTo: 6, unread: 0 } });
    expect(talkUnread(s, A)).toBe(0);
    apply(s, { type: "talks" });
    expect(s.talkOn).toBe(false);
    expect(s.talks.size).toBe(0);
    for (const type of ["talks", "talk.state", "talk.said", "talk.page", "talk.page.loading", "talk.page.failed"] as const) expect(chatDraw({ type } as never)).toBe("none");
  });

  test("a page, an earlier one before it, and the next message as it lands", () => {
    const s = connected();
    apply(s, { type: "talk.page.loading", session: A });
    expect(s.talkPages.get(A)).toMatchObject({ loaded: false, loading: true });
    apply(s, { type: "talk.page", session: A, messages: [msg(3), msg(4)], more: true });
    apply(s, { type: "talk.page", session: A, messages: [msg(1), msg(2)], more: false, before: 3 });
    expect(s.talkPages.get(A)!.messages.map((m) => m.n)).toEqual([1, 2, 3, 4]);
    expect(s.talkPages.get(A)!.more).toBe(false);
    apply(s, { type: "talk.said", params: { message: msg(5) } });
    apply(s, { type: "talk.state", params: { session: A, n: 5, readTo: 0, unread: 5 } });
    expect(s.talkPages.get(A)!.messages.map((m) => m.n)).toEqual([1, 2, 3, 4, 5]);
    expect(s.talkPages.get(A)!.stale).toBeUndefined();
    // a change to one shown takes its place
    apply(s, { type: "talk.said", params: { message: msg(5, { status: "failed", why: "the user did not allow it" }) } });
    expect(s.talkPages.get(A)!.messages.at(-1)).toMatchObject({ n: 5, status: "failed" });
    // a session never opened keeps no page
    apply(s, { type: "talk.said", params: { message: msg(1, { session: C }) } });
    expect(s.talkPages.has(C)).toBe(false);
  });

  test("a message past a gap, or a count past the last loaded, leaves the page behind; the line dropping too", () => {
    const s = connected();
    apply(s, { type: "talk.page", session: A, messages: [msg(1)], more: false });
    apply(s, { type: "talk.said", params: { message: msg(3) } });
    expect(s.talkPages.get(A)!.stale).toBe(true);
    expect(s.talkPages.get(A)!.messages.map((m) => m.n)).toEqual([1]);
    // the latest page again: what it brings, and nothing lost
    apply(s, { type: "talk.page", session: A, messages: [msg(1), msg(2), msg(3)], more: false });
    expect(s.talkPages.get(A)!.stale).toBeUndefined();
    apply(s, { type: "talk.state", params: { session: A, n: 4, readTo: 3, unread: 1 } });
    expect(s.talkPages.get(A)!.stale).toBe(true);
    apply(s, { type: "talk.page", session: B, messages: [msg(1, { session: B })], more: false });
    apply(s, { type: "talk.page.loading", session: B });
    apply(s, { type: "host.state", params: { connected: false } });
    expect(s.talkPages.get(B)).toMatchObject({ stale: true, loading: false });
  });

  test("what came while the latest page was asked for stays beside it", () => {
    const s = connected();
    apply(s, { type: "talk.page.loading", session: A });
    apply(s, { type: "talk.said", params: { message: msg(9) } });
    apply(s, { type: "talk.page", session: A, messages: [msg(7), msg(8)], more: true });
    expect(s.talkPages.get(A)!.messages.map((m) => m.n)).toEqual([7, 8, 9]);
  });

  test("the user's read point is told only past what they read", () => {
    const s = connected();
    expect(talkReadUpTo(s, A)).toBeUndefined();
    apply(s, { type: "talks", talks: [{ session: A, n: 2, readTo: 1, unread: 1 }] });
    apply(s, { type: "talk.page", session: A, messages: [msg(1), msg(2)], more: false });
    expect(talkReadUpTo(s, A)).toBe(2);
    apply(s, { type: "talk.state", params: { session: A, n: 2, readTo: 2, unread: 0 } });
    expect(talkReadUpTo(s, A)).toBeUndefined();
  });
});

describe("the pane", () => {
  test("shows the terminal until the user chooses, Messages where the node keeps them, never without", () => {
    expect(paneMode(undefined, true, true)).toBe("terminal");
    expect(paneMode("messages", true, true)).toBe("messages");
    expect(paneMode("messages", false, true)).toBe("messages");
    expect(paneMode("messages", true, false)).toBe("terminal");
    expect(paneMode("messages", false, false)).toBe("timeline");
    expect(paneMode("timeline", true, true)).toBe("timeline");
    expect(paneMode("terminal", false, true)).toBe("timeline");
  });

  test("a badge counts to 99, then says 99+", () => {
    expect(badge(7)).toBe("7");
    expect(badge(99)).toBe("99");
    expect(badge(100)).toBe("99+");
  });

  test("a session goes by its own name, else its folder and harness", () => {
    expect(selfName({ name: "mulberry", cwd: "C:\\TTLM\\UnrealEngine", harness: "claude" })).toBe("mulberry");
    expect(selfName({ cwd: "C:\\TTLM\\UnrealEngine", harness: "claude" })).toBe("UnrealEngine-claude");
    expect(selfName({ cwd: "C:\\", harness: "codex" })).toBe("codex");
  });

  test("the parties are the ones it talked with, the latest first, another person's agent by how it is reached", () => {
    const bob = { name: "bob/web", harness: "claude" as const, user: "bob", teammate: TM };
    const page = { messages: [msg(1), msg(2, { with: bob }), msg(3), msg(4, { with: { session: C, name: "docs" } })] };
    expect(talkParties(page)).toEqual([
      { key: C, name: "docs", count: 1 },
      { key: B, name: "api-codex", harness: "codex", count: 2 },
      { key: `${TM}:bob/web`, name: "bob/web", harness: "claude", user: "bob", count: 1 },
    ]);
    expect(partyKey(bob)).toBe(`${TM}:bob/web`);
    expect(talkParties(undefined)).toEqual([]);
  });

  test("a row says who it is to or from, what it answers, where it stands, and marks the first new one", () => {
    const page = {
      messages: [
        msg(1, { dir: "out", text: "Rebase on main.\nThen run the tests.", status: "sent" }),
        msg(2, { replyTo: msg(1).id, text: "done" }),
        msg(3, { dir: "out", lead: true, status: "failed", why: "the user did not allow it" }),
        msg(4, { replyTo: "pmsg_gone", report: true }),
        msg(5, { with: { name: "bob/web", user: "bob", teammate: TM }, status: "held" }),
      ],
    };
    const rows = talkRows(page, { since: 2, self: "mulberry" });
    expect(rows.map((r) => [r.n, r.dir, r.name, r.first])).toEqual([
      [1, "out", "api-codex", false],
      [2, "in", "api-codex", false],
      [3, "out", "api-codex", true],
      [4, "in", "api-codex", false],
      [5, "in", "bob/web", false],
    ]);
    expect(rows[0]!.status).toBeUndefined();
    expect(rows[0]!.where).toBe("Desk, api");
    expect(rows[1]!.quote).toEqual({ name: "mulberry", excerpt: "Rebase on main." });
    expect(rows[2]).toMatchObject({ lead: true, status: { label: "not delivered", failed: true }, why: "the user did not allow it" });
    expect(rows[3]).toMatchObject({ report: true, quote: { excerpt: "an earlier message" } });
    expect(rows[4]).toMatchObject({ user: "bob", where: "bob's agent, a teammate's", status: { label: "held", failed: false } });
    // one party alone, and the first new one among those shown
    expect(talkRows(page, { party: `${TM}:bob/web`, since: 2 }).map((r) => [r.n, r.first])).toEqual([[5, true]]);
    expect(statusWords("pending")?.label).toBe("waiting on you");
    expect(statusWords("sent")).toBeUndefined();
  });
});
