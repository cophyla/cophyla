// One Ask for every prompt source: a harness, the gate or the brain. Opening one persists
// it and streams `ask.state`; answering it does the same and wakes whoever is waiting.

import { ASK_TEXT_OPTION, newId, RpcError } from "@cophyla/protocol";
import type { Ask, AskAnswer, NodeId, Principal, Remember } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { Store } from "../store/index.ts";

export type AskInput = Omit<Ask, "id" | "node" | "status" | "answer" | "createdAt" | "remember"> & {
  expiresAt?: number;
};

export interface AnswerInput {
  /** A declared option id, or `"text"` for a free-text answer on an ask that `allowsText`. */
  option: string;
  /** Every chosen id on a `multiple` ask, `option` first. */
  options?: string[];
  text?: string;
  remember?: Remember;
}

interface Waiter {
  resolve: (ask: Ask) => void;
}

export class Asks {
  private waiters = new Map<string, Waiter[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private store: Store;
  private nodeId: NodeId;
  private bus: Bus;

  constructor(store: Store, nodeId: NodeId, bus: Bus) {
    this.store = store;
    this.nodeId = nodeId;
    this.bus = bus;
  }

  /** Asks left open by a previous run cannot be answered: the request that waited is gone. */
  closeStale(now = Date.now()): number {
    let n = 0;
    for (const ask of this.store.asks.listOpen()) {
      ask.status = "cancelled";
      this.store.asks.update(ask);
      n++;
      void now;
    }
    return n;
  }

  open(input: AskInput, now = Date.now()): Ask {
    const ask: Ask = { ...input, id: newId("ask", now), node: this.nodeId, status: "open", createdAt: now };
    this.store.asks.insert(ask);
    if (ask.expiresAt !== undefined) {
      const delay = Math.max(0, ask.expiresAt - now);
      const timer = setTimeout(() => this.expire(ask.id), delay);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      this.timers.set(ask.id, timer);
    }
    this.bus.emit("ask.state", ask);
    return ask;
  }

  get(id: string): Ask | undefined {
    return this.store.asks.get(id);
  }

  listOpen(): Ask[] {
    return this.store.asks.listOpen();
  }

  /** Resolves when the ask leaves `open`, with its final state. */
  wait(id: string): Promise<Ask> {
    const current = this.store.asks.get(id);
    if (!current) return Promise.reject(new RpcError("not_found", `no ask ${id}`));
    if (current.status !== "open") return Promise.resolve(current);
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push({ resolve });
      this.waiters.set(id, list);
    });
  }

  answer(id: string, input: AnswerInput, by: Principal, now = Date.now()): Ask {
    const ask = this.store.asks.get(id);
    if (!ask) throw new RpcError("not_found", `no ask ${id}`);
    if (ask.status !== "open") throw new RpcError("conflict", `ask ${id} is ${ask.status}`);
    if ((by.kind === "user" || by.kind === "brain") && !ask.answerableBy.includes(by.kind)) {
      throw new RpcError("denied", `ask ${id} is not answerable by the ${by.kind}`);
    }
    const chosen = validChoice(ask, input);
    if (chosen === undefined) throw new RpcError("invalid", `ask ${id} has no option ${input.options?.join(", ") ?? input.option}`);
    const answer: AskAnswer = { option: input.option, by, at: now };
    if (chosen) answer.options = chosen;
    if (input.text !== undefined) answer.text = input.text;
    ask.answer = answer;
    ask.status = "answered";
    if (input.remember !== undefined) ask.remember = input.remember;
    return this.settle(ask);
  }

  cancel(id: string): Ask | undefined {
    const ask = this.store.asks.get(id);
    if (!ask || ask.status !== "open") return ask;
    ask.status = "cancelled";
    return this.settle(ask);
  }

  expire(id: string): Ask | undefined {
    const ask = this.store.asks.get(id);
    if (!ask || ask.status !== "open") return ask;
    ask.status = "expired";
    return this.settle(ask);
  }

  private settle(ask: Ask): Ask {
    this.store.asks.update(ask);
    const timer = this.timers.get(ask.id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(ask.id);
    }
    this.bus.emit("ask.state", ask);
    const waiters = this.waiters.get(ask.id);
    this.waiters.delete(ask.id);
    for (const w of waiters ?? []) w.resolve(ask);
    return ask;
  }

  /** Clears timers so a stopping daemon does not keep the process alive. */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

/**
 * The ids an answer may carry: every one a declared option, or the reserved `"text"` alone
 * with text on an ask that `allowsText`. Returns the list to store on a `multiple` ask,
 * `null` for a single ask, `undefined` when the answer is not valid.
 */
function validChoice(ask: Ask, input: AnswerInput): string[] | null | undefined {
  const declared = (id: string) => ask.options.some((o) => o.id === id);
  const textOnly = (ids: string[]) => ids.length === 1 && ids[0] === ASK_TEXT_OPTION && !declared(ASK_TEXT_OPTION);
  const textOk = ask.allowsText === true && input.text !== undefined;
  if (ask.multiple) {
    const ids = input.options ?? [input.option];
    if (ids.length === 0 || ids[0] !== input.option) return undefined;
    if (new Set(ids).size !== ids.length) return undefined;
    if (textOnly(ids)) return textOk ? ids : undefined;
    return ids.every(declared) ? ids : undefined;
  }
  if (input.options && !(input.options.length === 1 && input.options[0] === input.option)) return undefined;
  if (declared(input.option)) return null;
  return input.option === ASK_TEXT_OPTION && textOk ? null : undefined;
}
