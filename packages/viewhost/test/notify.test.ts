// Asks on OS notifications: one toast per open ask a person may answer, `multiple` passed
// along, a button's activation answered on the connection, a refused answer showing the
// window instead, and a toast taken down when its ask settles, live or while the link was
// down. On a machine that can tell, an ask is toasted only while someone is at it: held
// otherwise, and toasted when someone comes back if it is still open.

import { describe, expect, test } from "bun:test";
import type { Ask, RpcNotification } from "@cophyla/protocol";
import { AskNotifier, AWAY_MS } from "../src/notify.ts";
import type { NotifyAsk } from "../src/notify.ts";

const n = (method: string, params: unknown): RpcNotification => ({ jsonrpc: "2.0", method, params });

function ask(id: string, extra: Partial<Ask> = {}): Ask {
  return {
    id,
    node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    type: "permission",
    source: { kind: "harness", session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1" },
    title: "Write x.txt",
    options: [
      { id: "allow", label: "Allow", style: "primary" },
      { id: "deny", label: "Deny", style: "danger" },
    ],
    answerableBy: ["user", "brain"],
    status: "open",
    createdAt: 1,
    ...extra,
  };
}

function harness() {
  const toasts: NotifyAsk[] = [];
  const dismissed: string[] = [];
  const answers: [string, string][] = [];
  const errors: string[] = [];
  let shown = 0;
  let refuse = false;
  const notifier = new AskNotifier({
    notify: async (t) => {
      toasts.push(t);
    },
    dismiss: async (id) => {
      dismissed.push(id);
    },
    answer: async (id, option) => {
      if (refuse) throw new Error("ask is answered");
      answers.push([id, option]);
      return {};
    },
    showWindow: () => {
      shown += 1;
    },
    onError: (m) => errors.push(m),
  });
  return { notifier, toasts, dismissed, answers, errors, shown: () => shown, refuse: () => (refuse = true) };
}

describe("ask notifier", () => {
  test("toasts each open user-answerable ask once, with title, detail, options and multiple", () => {
    const h = harness();
    h.notifier.onNotification(n("ask.state", ask("ask_1", { detail: "Create x.txt" })));
    h.notifier.onNotification(n("ask.state", ask("ask_1", { detail: "Create x.txt" })));
    h.notifier.onNotification(n("ask.state", ask("ask_2", { type: "choice", title: "Which tools?", options: [{ id: "ESLint", label: "ESLint", description: "the linter" }], multiple: true, allowsText: true })));
    expect(h.toasts).toEqual([
      { id: "ask_1", title: "Write x.txt", detail: "Create x.txt", options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }] },
      { id: "ask_2", title: "Which tools?", options: [{ id: "ESLint", label: "ESLint" }], multiple: true },
    ]);
    // Forgotten, it can be toasted again.
    h.notifier.forget("ask_1");
    h.notifier.onNotification(n("ask.state", ask("ask_1")));
    expect(h.toasts).toHaveLength(3);
  });

  test("skips display-only asks, settled ones and other methods", () => {
    const h = harness();
    h.notifier.onNotification(n("ask.state", ask("ask_e", { type: "input", answerableBy: [] })));
    h.notifier.onNotification(n("ask.state", ask("ask_b", { answerableBy: ["brain"] })));
    h.notifier.onNotification(n("ask.state", ask("ask_a", { status: "answered" })));
    h.notifier.onNotification(n("ask.state", ask("ask_c", { status: "cancelled" })));
    h.notifier.onNotification(n("session.state", { id: "sess_1" }));
    expect(h.toasts).toEqual([]);
  });

  test("a toasted ask that settles takes its toast down once; one never toasted takes nothing down", () => {
    const h = harness();
    h.notifier.onNotification(n("ask.state", ask("ask_1")));
    h.notifier.onNotification(n("ask.state", ask("ask_2")));
    h.notifier.onNotification(n("ask.state", ask("ask_1", { status: "answered" })));
    h.notifier.onNotification(n("ask.state", ask("ask_1", { status: "answered" })));
    h.notifier.onNotification(n("ask.state", ask("ask_2", { status: "expired" })));
    h.notifier.onNotification(n("ask.state", ask("ask_b", { answerableBy: ["brain"] })));
    h.notifier.onNotification(n("ask.state", ask("ask_b", { answerableBy: ["brain"], status: "answered" })));
    h.notifier.onNotification(n("ask.state", ask("ask_x", { status: "cancelled" })));
    expect(h.dismissed).toEqual(["ask_1", "ask_2"]);
  });

  test("after a reconnect, a toasted ask the replay leaves out is taken down when the replay is over", () => {
    const h = harness();
    h.notifier.onNotification(n("ask.state", ask("ask_1")));
    h.notifier.onNotification(n("ask.state", ask("ask_2")));
    h.notifier.onNotification(n("session.state", { id: "sess_1" }));
    expect(h.dismissed).toEqual([]);
    h.notifier.onConnected();
    h.notifier.onNotification(n("ask.state", ask("ask_2")));
    h.notifier.onNotification(n("ask.state", ask("ask_3")));
    expect(h.dismissed).toEqual([]);
    h.notifier.onNotification(n("session.state", { id: "sess_1" }));
    expect(h.dismissed).toEqual(["ask_1"]);
    // Still open asks are not toasted twice, and the replay is over for good.
    expect(h.toasts.map((t) => t.id)).toEqual(["ask_1", "ask_2", "ask_3"]);
    h.notifier.onNotification(n("node.state", { id: "node_1" }));
    expect(h.dismissed).toEqual(["ask_1"]);
    h.notifier.onNotification(n("ask.state", ask("ask_2", { status: "answered" })));
    expect(h.dismissed).toEqual(["ask_1", "ask_2"]);
  });

  test("a button's activation answers the ask; a refused answer shows the window", async () => {
    const h = harness();
    await h.notifier.onActivated({ ask: "ask_1", option: "allow" });
    expect(h.answers).toEqual([["ask_1", "allow"]]);
    expect(h.shown()).toBe(0);
    h.refuse();
    await h.notifier.onActivated({ ask: "ask_1", option: "deny" });
    expect(h.answers).toHaveLength(1);
    expect(h.shown()).toBe(1);
    expect(h.errors[0]).toContain("ask_1");
  });
});

/** A notifier on a machine whose idle time the test sets, with the looks it schedules run by hand. */
function attended(idle: number | undefined) {
  const toasts: string[] = [];
  const dismissed: string[] = [];
  const state = { idle, looks: [] as (() => void)[], cancelled: 0 };
  const node = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const notifier = new AskNotifier({
    notify: async (t) => {
      toasts.push(t.id);
    },
    dismiss: async (id) => {
      dismissed.push(id);
    },
    answer: async () => ({}),
    showWindow: () => {},
    idleMs: async () => state.idle,
    node: () => node,
    schedule: (fn) => {
      state.looks.push(fn);
      return () => (state.cancelled += 1);
    },
  });
  /** Runs the look scheduled last, as its timer would, and lets it finish. */
  const look = async () => {
    state.looks.pop()?.();
    await settle();
  };
  const remote = (streaming: boolean) => n("remote.state", { node, host: { kind: "apollo", status: "ready" }, viewers: [], streaming });
  return { notifier, toasts, dismissed, state, look, remote };
}

const settle = () => new Promise((ok) => setTimeout(ok, 0));

describe("toasts where someone is", () => {
  test("someone at the machine: toasted at once", async () => {
    const h = attended(5_000);
    h.notifier.onNotification(n("ask.state", ask("ask_1")));
    await settle();
    expect(h.toasts).toEqual(["ask_1"]);
    expect(h.state.looks).toHaveLength(0);
  });

  test("a machine that cannot tell its idle time toasts at once", async () => {
    const h = attended(undefined);
    h.notifier.onNotification(n("ask.state", ask("ask_1")));
    await settle();
    expect(h.toasts).toEqual(["ask_1"]);
  });

  test("no one at the machine: held, and toasted when someone comes back, in the order they opened", async () => {
    const h = attended(AWAY_MS + 1);
    h.notifier.onNotification(n("ask.state", ask("ask_1")));
    await settle();
    h.notifier.onNotification(n("ask.state", ask("ask_2")));
    await settle();
    // a held ask heard again is not held twice
    h.notifier.onNotification(n("ask.state", ask("ask_1")));
    await settle();
    expect(h.toasts).toEqual([]);
    await h.look();
    expect(h.toasts).toEqual([]);
    expect(h.state.looks.length).toBeGreaterThan(0);
    h.state.idle = 800;
    await h.look();
    expect(h.toasts).toEqual(["ask_1", "ask_2"]);
    // nothing held: no more looking, and an ask heard again is not toasted twice
    await h.look();
    expect(h.state.looks).toHaveLength(0);
    h.notifier.onNotification(n("ask.state", ask("ask_2")));
    await settle();
    expect(h.toasts).toEqual(["ask_1", "ask_2"]);
  });

  test("an ask that settles while held is never toasted, nor dismissed; one missing from a replay neither", async () => {
    const h = attended(AWAY_MS * 10);
    h.notifier.onNotification(n("ask.state", ask("ask_1")));
    h.notifier.onNotification(n("ask.state", ask("ask_2")));
    await settle();
    h.notifier.onNotification(n("ask.state", ask("ask_1", { status: "answered" })));
    h.notifier.onConnected();
    h.notifier.onNotification(n("session.state", { id: "sess_1" }));
    h.state.idle = 0;
    await h.look();
    expect(h.toasts).toEqual([]);
    expect(h.dismissed).toEqual([]);
  });

  test("a desktop streamed to another machine holds its asks, whatever its input says, until the viewer leaves", async () => {
    const h = attended(0);
    h.notifier.onNotification(h.remote(true));
    h.notifier.onNotification(n("ask.state", ask("ask_1")));
    await settle();
    expect(h.toasts).toEqual([]);
    // another node's desktop streamed is not this one's
    h.notifier.onNotification(n("remote.state", { node: "node_01ARZ3NDEKTSV4RRFFQ69G5FB0", host: { kind: "apollo", status: "ready" }, viewers: [], streaming: false }));
    await settle();
    expect(h.toasts).toEqual([]);
    h.notifier.onNotification(h.remote(false));
    await settle();
    expect(h.toasts).toEqual(["ask_1"]);
  });
});
