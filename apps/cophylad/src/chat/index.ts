// The chat stream: threads and their messages. A user message is stored and raised as
// `user.message` for the brain, with whether its answer is read out when a delivery decides
// that (`speech`); the brain's `ui.say` is stored through `say`; `thread.start`
// closes the current thread and opens the next. `chat.load` pages threads backwards, one at a
// time, with all their messages. A `ui.ask` opens a choice Ask whose answer is the request's
// result.

import { newId, RpcError } from "@cophyla/protocol";
import type { Ask, ContentBlock, Message, MessageSource, Thread, TurnStep } from "@cophyla/protocol";
import type { Bus, UserMessageEvent } from "../bus.ts";
import type { Asks } from "../gate/asks.ts";
import type { Store } from "../store/index.ts";
import type { ThreadListFilter } from "../store/index.ts";

export interface ChatDeps {
  store: Store;
  bus: Bus;
  asks: Asks;
  now?: () => number;
}

export interface UserMessageInput {
  text: string;
  source: "ui" | "controller" | "voice";
  mode?: "quick";
  /** The client it came through, for the log. */
  client?: string;
}

export interface AskInput {
  question: string;
  options: { id: string; label: string }[];
  allowsText?: boolean;
  task?: string;
}

export interface AskOptions {
  signal?: AbortSignal;
  onPending?: (ask: Ask) => void;
}

/** Decides, as a user message is stored, whether its answer is read out; undefined where nothing decides. */
export type SpeechHook = (message: string, input: UserMessageInput) => boolean | undefined;

/** How long a brain question stays open before it expires; 0 keeps it open. */
export const BRAIN_ASK_TIMEOUT_MS = 0;

export class Chat {
  private deps: ChatDeps;
  private currentId?: string;
  /** Set once the delivery of speech is up. */
  speech?: SpeechHook;

  constructor(deps: ChatDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The latest open thread, opened when there is none. */
  current(): Thread {
    if (this.currentId) {
      const t = this.deps.store.threads.get(this.currentId);
      if (t && t.endedAt === undefined) return t;
      this.currentId = undefined;
    }
    const open = this.deps.store.threads.latestOpen();
    if (open) {
      this.currentId = open.id;
      return open;
    }
    return this.open({});
  }

  /** The current thread if one is open, without opening one. */
  peek(): Thread | undefined {
    if (this.currentId) {
      const t = this.deps.store.threads.get(this.currentId);
      if (t && t.endedAt === undefined) return t;
    }
    return this.deps.store.threads.latestOpen();
  }

  private open(input: { topic?: string; workspace?: string }): Thread {
    const now = this.now();
    const t: Thread = { id: newId("thread", now), startedAt: now, tags: [], sessions: [] };
    if (input.topic !== undefined) t.topic = input.topic;
    if (input.workspace !== undefined) t.workspace = input.workspace;
    this.deps.store.threads.insert(t);
    this.currentId = t.id;
    this.deps.bus.emit("thread.state", t);
    return t;
  }

  /** Closes the current thread and opens the next; the brain calls it when the topic changes. */
  startThread(input: { topic?: string; workspace?: string } = {}): Thread {
    const current = this.peek();
    if (current) {
      // A thread with nothing in it is reused rather than closed empty.
      if (this.deps.store.messages.count(current.id) === 0) {
        let changed = false;
        if (input.topic !== undefined && current.topic !== input.topic) {
          current.topic = input.topic;
          changed = true;
        }
        if (input.workspace !== undefined && current.workspace !== input.workspace) {
          current.workspace = input.workspace;
          changed = true;
        }
        this.currentId = current.id;
        if (changed) {
          this.deps.store.threads.update(current);
          this.deps.bus.emit("thread.state", current);
        }
        return current;
      }
      current.endedAt = this.now();
      this.deps.store.threads.update(current);
      this.deps.bus.emit("thread.state", current);
    }
    return this.open(input);
  }

  get(id: string): Thread | undefined {
    return this.deps.store.threads.get(id);
  }

  listThreads(filter: ThreadListFilter = {}): Thread[] {
    return this.deps.store.threads.list(filter);
  }

  history(id: string, window: { before?: number; around?: number; limit?: number } = {}): Message[] {
    if (!this.deps.store.threads.get(id)) throw new RpcError("not_found", `no thread ${id}`);
    return this.deps.store.messages.history(id, window);
  }

  annotateThread(id: string, patch: { topic?: string; workspace?: string; summary?: string; tags?: string[] }): Thread {
    const t = this.deps.store.threads.get(id);
    if (!t) throw new RpcError("not_found", `no thread ${id}`);
    if (patch.topic !== undefined) t.topic = patch.topic;
    if (patch.workspace !== undefined) t.workspace = patch.workspace;
    if (patch.summary !== undefined) t.summary = patch.summary;
    if (patch.tags !== undefined) t.tags = patch.tags;
    this.deps.store.threads.update(t);
    this.deps.bus.emit("thread.state", t);
    return t;
  }

  /** Records that a harness session was touched in the thread. */
  touchSession(threadId: string, session: string): void {
    const t = this.deps.store.threads.get(threadId);
    if (!t || t.sessions.includes(session)) return;
    t.sessions.push(session);
    this.deps.store.threads.update(t);
    this.deps.bus.emit("thread.state", t);
  }

  /** The `limit` threads before `before` (or the newest), oldest first, with all their messages. */
  load(input: { before?: string; limit?: number } = {}): { threads: Thread[]; messages: Message[] } {
    const threads = this.deps.store.threads.before(input.before, input.limit ?? 1);
    const messages: Message[] = [];
    for (const t of threads) messages.push(...this.deps.store.messages.byThread(t.id));
    return { threads, messages };
  }

  /** Stores the user's message in the current thread and wakes the brain with it. */
  userMessage(input: UserMessageInput): Message {
    const thread = this.current();
    const now = this.now();
    const m: Message = {
      id: newId("message", now),
      thread: thread.id,
      at: now,
      role: "user",
      source: input.source,
      content: [{ type: "text", text: input.text }],
    };
    this.deps.store.messages.insert(m);
    this.deps.bus.emit("chat.message", m);
    const event: UserMessageEvent = { at: now, text: input.text, source: input.source, message: m.id, thread: thread.id };
    if (input.mode) event.mode = input.mode;
    const speak = this.speech?.(m.id, input);
    if (speak !== undefined) event.speak = speak;
    this.deps.bus.emit("user.message", event);
    return m;
  }

  /** Stores the brain's reply, blocks already expanded, under `message` when a stream allocated it, with the steps its turn took. */
  say(blocks: ContentBlock[], opts: { message?: string; source?: MessageSource; steps?: TurnStep[] } = {}): Message {
    const thread = this.current();
    const now = this.now();
    const m: Message = {
      id: opts.message ?? newId("message", now),
      thread: thread.id,
      at: now,
      role: "orchestrator",
      source: opts.source ?? "brain",
      content: blocks,
      ...(opts.steps?.length ? { steps: opts.steps } : {}),
    };
    this.deps.store.messages.insert(m);
    this.deps.bus.emit("chat.message", m);
    return m;
  }

  /**
   * A question from the brain: a choice Ask the user answers. Resolves with the answer;
   * `cancelled` on abort, `timeout` when it expires.
   */
  async ask(input: AskInput, opts: AskOptions = {}): Promise<{ answer: NonNullable<Ask["answer"]> }> {
    const now = this.now();
    const source: Ask["source"] = input.task !== undefined ? { kind: "brain", task: input.task } : { kind: "brain" };
    const ask = this.deps.asks.open(
      {
        type: "choice",
        source,
        title: input.question,
        options: input.options.map((o) => ({ id: o.id, label: o.label })),
        ...(input.allowsText ? { allowsText: true } : {}),
        answerableBy: ["user"],
        ...(BRAIN_ASK_TIMEOUT_MS > 0 ? { expiresAt: now + BRAIN_ASK_TIMEOUT_MS } : {}),
      },
      now,
    );
    opts.onPending?.(ask);
    const onAbort = () => this.deps.asks.cancel(ask.id);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    let settled: Ask;
    try {
      settled = await this.deps.asks.wait(ask.id);
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
    if (settled.status === "answered" && settled.answer) return { answer: settled.answer };
    if (settled.status === "expired") throw new RpcError("timeout", `ask ${ask.id} expired unanswered`);
    throw new RpcError("cancelled", `ask ${ask.id} was cancelled`);
  }

  /** Cancels every open ask the brain raised: on a brain restart, its questions are moot. */
  cancelBrainAsks(): number {
    let n = 0;
    for (const ask of this.deps.asks.listOpen()) {
      if (ask.source.kind !== "brain") continue;
      this.deps.asks.cancel(ask.id);
      n++;
    }
    return n;
  }
}
