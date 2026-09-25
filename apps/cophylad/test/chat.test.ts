// The chat stream: threads opened lazily and closed by `thread.start`, user messages stored
// and raised as `user.message`, the brain's replies stored under a given id, `chat.load`
// paging backwards, `ui.ask` as a choice Ask, and `chat.typing` and speaking edges as
// `user.activity`.

import { describe, expect, test } from "bun:test";
import { newId } from "@cophyla/protocol";
import type { Ask, Message, Thread } from "@cophyla/protocol";
import { Bus } from "../src/bus.ts";
import type { UserActivityEvent, UserMessageEvent } from "../src/bus.ts";
import { Activity } from "../src/chat/activity.ts";
import { Chat } from "../src/chat/index.ts";
import { Asks } from "../src/gate/asks.ts";
import { Store } from "../src/store/index.ts";
import { sleep } from "./helpers.ts";

function setup() {
  const store = new Store(":memory:");
  store.migrate();
  const bus = new Bus();
  const asks = new Asks(store, newId("node"), bus);
  let now = 1_000_000;
  const chat = new Chat({ store, bus, asks, now: () => now++ });
  return { store, bus, asks, chat, tick: (ms: number) => (now += ms) };
}

describe("chat", () => {
  test("the first user message opens a thread, stores the message and raises user.message", () => {
    const { bus, chat, store } = setup();
    const messages: Message[] = [];
    const events: UserMessageEvent[] = [];
    const threads: Thread[] = [];
    bus.on("chat.message", (m) => messages.push(m));
    bus.on("user.message", (e) => events.push(e));
    bus.on("thread.state", (t) => threads.push(t));
    expect(chat.peek()).toBeUndefined();
    const m = chat.userMessage({ text: "hi", source: "ui", mode: "quick" });
    expect(threads).toHaveLength(1);
    expect(m.thread).toBe(threads[0]!.id);
    expect(m.role).toBe("user");
    expect(messages).toEqual([m]);
    expect(events).toEqual([{ at: m.at, text: "hi", source: "ui", mode: "quick", message: m.id, thread: m.thread }]);
    expect(store.messages.byThread(m.thread)).toEqual([m]);
    expect(chat.current().id).toBe(m.thread);
    // A second message lands in the same thread; no mode when none was given.
    const m2 = chat.userMessage({ text: "again", source: "controller" });
    expect(m2.thread).toBe(m.thread);
    expect(Object.keys(events[1]!)).not.toContain("mode");
  });

  test("say stores the reply under the streamed id; thread.start closes the thread; an empty thread is reused", () => {
    const { bus, chat, store } = setup();
    const threads: Thread[] = [];
    bus.on("thread.state", (t) => threads.push(t));
    const first = chat.startThread({ topic: "a" });
    expect(first.topic).toBe("a");
    // Empty: the next start renames it instead of closing it.
    const same = chat.startThread({ topic: "b", workspace: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB0" });
    expect(same.id).toBe(first.id);
    expect(same.topic).toBe("b");
    expect(same.workspace).toBe("ws_01ARZ3NDEKTSV4RRFFQ69G5FB0");
    chat.userMessage({ text: "q", source: "ui" });
    const id = newId("message");
    const reply = chat.say([{ type: "text", text: "a" }, { type: "quote", text: "x", source: { kind: "memory", name: "n" } }], { message: id });
    expect(reply.id).toBe(id);
    expect(reply.role).toBe("orchestrator");
    expect(reply.source).toBe("brain");
    expect(store.messages.get(id)?.content).toHaveLength(2);
    const next = chat.startThread({ topic: "c" });
    expect(next.id).not.toBe(first.id);
    const closed = store.threads.get(first.id)!;
    expect(closed.endedAt).toBeDefined();
    expect(threads.filter((t) => t.id === first.id && t.endedAt !== undefined)).toHaveLength(1);
    expect(chat.current().id).toBe(next.id);
    expect(chat.listThreads({ open: true }).map((t) => t.id)).toEqual([next.id]);
    chat.annotateThread(next.id, { summary: "s", tags: ["t"] });
    expect(store.threads.get(next.id)).toMatchObject({ summary: "s", tags: ["t"] });
    chat.touchSession(next.id, "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1");
    chat.touchSession(next.id, "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1");
    expect(store.threads.get(next.id)?.sessions).toEqual(["sess_01ARZ3NDEKTSV4RRFFQ69G5FB1"]);
    expect(() => chat.annotateThread("thr_01ARZ3NDEKTSV4RRFFQ69G5FB9", {})).toThrow(/no thread/);
  });

  test("load pages threads backwards with their messages; history windows by at", () => {
    const { chat } = setup();
    chat.userMessage({ text: "one", source: "ui" });
    const t1 = chat.current();
    chat.say([{ type: "text", text: "r1" }]);
    chat.startThread({ topic: "two" });
    chat.userMessage({ text: "two", source: "ui" });
    const t2 = chat.current();
    chat.startThread({ topic: "three" });
    chat.userMessage({ text: "three", source: "ui" });
    const t3 = chat.current();
    const newest = chat.load({});
    expect(newest.threads.map((t) => t.id)).toEqual([t3.id]);
    expect(newest.messages.map((m) => m.thread)).toEqual([t3.id]);
    const earlier = chat.load({ before: t3.id, limit: 1 });
    expect(earlier.threads.map((t) => t.id)).toEqual([t2.id]);
    const rest = chat.load({ before: t2.id, limit: 5 });
    expect(rest.threads.map((t) => t.id)).toEqual([t1.id]);
    expect(rest.messages).toHaveLength(2);
    expect(chat.load({ before: t1.id })).toEqual({ threads: [], messages: [] });
    const h = chat.history(t1.id, { limit: 1 });
    expect(h.map((m) => m.role)).toEqual(["orchestrator"]);
    expect(chat.history(t1.id, { before: h[0]!.at }).map((m) => m.role)).toEqual(["user"]);
    expect(() => chat.history("thr_01ARZ3NDEKTSV4RRFFQ69G5FB9")).toThrow(/no thread/);
  });

  test("ask opens a choice Ask answerable by the user and resolves with the answer; abort cancels; brain asks can be swept", async () => {
    const { bus, chat, asks } = setup();
    const opened: Ask[] = [];
    bus.on("ask.state", (a) => opened.push(a));
    let pending: Ask | undefined;
    const p = chat.ask({ question: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], task: "task_01ARZ3NDEKTSV4RRFFQ69G5FB1" }, { onPending: (a) => (pending = a) });
    expect(pending).toBeDefined();
    expect(pending!.type).toBe("choice");
    expect(pending!.source).toEqual({ kind: "brain", task: "task_01ARZ3NDEKTSV4RRFFQ69G5FB1" });
    expect(pending!.answerableBy).toEqual(["user"]);
    expect(opened[0]!.status).toBe("open");
    asks.answer(pending!.id, { option: "b" }, { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" });
    const r = await p;
    expect(r.answer.option).toBe("b");
    expect(r.answer.by.kind).toBe("user");

    const ac = new AbortController();
    const p2 = chat.ask({ question: "Again?", options: [{ id: "y", label: "Y" }] }, { signal: ac.signal });
    ac.abort();
    const e = await p2.catch((x) => x);
    expect((e as { code: string }).code).toBe("cancelled");

    const p3 = chat.ask({ question: "Third?", options: [{ id: "y", label: "Y" }] });
    expect(asks.listOpen()).toHaveLength(1);
    expect(chat.cancelBrainAsks()).toBe(1);
    expect(((await p3.catch((x) => x)) as { code: string }).code).toBe("cancelled");
    expect(asks.listOpen()).toHaveLength(0);
  });
});

describe("activity", () => {
  test("typing is edge-triggered per client, idles on false or after silence, controllers are named", async () => {
    const bus = new Bus();
    const events: UserActivityEvent[] = [];
    bus.on("user.activity", (e) => events.push(e));
    const activity = new Activity({ bus, idleAfterMs: 60 });
    const ui = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind: "ui" as const };
    const phone = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB8", kind: "controller" as const };
    activity.typingSignal(ui, true);
    activity.typingSignal(ui, true);
    activity.typingSignal(ui, true);
    expect(events.map((e) => [e.state, e.source])).toEqual([["typing", "ui"]]);
    activity.typingSignal(ui, false);
    activity.typingSignal(ui, false);
    expect(events.map((e) => e.state)).toEqual(["typing", "idle"]);
    activity.typingSignal(phone, true);
    expect(events[2]).toMatchObject({ state: "typing", source: "controller" });
    await sleep(120);
    expect(events[3]).toMatchObject({ state: "idle", source: "controller" });
    // A client that disconnects mid-word is forgotten without an idle event.
    activity.typingSignal(ui, true);
    activity.forget(ui.id);
    await sleep(100);
    expect(events).toHaveLength(5);
    activity.dispose();
  });

  test("speaking is the same edge pair, always named voice, and never crosses with typing", async () => {
    const bus = new Bus();
    const events: UserActivityEvent[] = [];
    bus.on("user.activity", (e) => events.push(e));
    const activity = new Activity({ bus, idleAfterMs: 60, speakingSafetyMs: 80 });
    const phone = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB8", kind: "controller" as const };
    // Wake and every frame after it say the same thing; only the first is an edge.
    activity.speaking(phone, true);
    activity.speaking(phone, true);
    activity.speaking(phone, true);
    // Speaking is the user's mouth, not the client's kind: a controller's is still `voice`.
    expect(events.map((e) => [e.state, e.source])).toEqual([["speaking", "voice"]]);
    activity.speaking(phone, false);
    activity.speaking(phone, false);
    expect(events.map((e) => [e.state, e.source])).toEqual([["speaking", "voice"], ["idle", "voice"]]);

    // The two signals are tracked apart: typing on the same client while it speaks is its own pair.
    activity.speaking(phone, true);
    activity.typingSignal(phone, true);
    expect(events.slice(2).map((e) => [e.state, e.source])).toEqual([["speaking", "voice"], ["typing", "controller"]]);
    activity.typingSignal(phone, false);
    expect(events[4]).toMatchObject({ state: "idle", source: "controller" });
    // The falling edge is still owed: the safety timer closes an utterance nobody ended.
    await sleep(120);
    expect(events[5]).toMatchObject({ state: "idle", source: "voice" });
    expect(events).toHaveLength(6);

    // A phone that vanishes mid-word closes the utterance: unlike typing, silence is not idle
    // by itself, so nothing else would tell the brain the user stopped.
    activity.speaking(phone, true);
    activity.forget(phone.id);
    expect(events.slice(6).map((e) => e.state)).toEqual(["speaking", "idle"]);
    // Forgotten twice is once.
    activity.forget(phone.id);
    expect(events).toHaveLength(8);
    activity.dispose();
  });
});
