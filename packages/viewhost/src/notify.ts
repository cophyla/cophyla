// Asks on OS notifications. Every open `ask.state` a person may answer is toasted once, with
// its options as buttons; a button click comes back as `ask:activated` and is answered on
// the host's own connection. An answer refused because the ask was settled elsewhere just
// shows the window. An ask that takes several options at once (`multiple`) is toasted
// without buttons, since one button is one answer: its body opens the window. Elicitation
// asks (`answerableBy: []`) are display-only and never toasted. A toasted ask that settles
// takes its toast down, and so does one missing from cophylad's replay after a reconnect: it
// settled while the link was down. DOM-free.

import type { Ask, RpcNotification } from "@cophyla/protocol";

export interface NotifyAsk {
  id: string;
  title: string;
  detail?: string;
  options: { id: string; label: string }[];
  /** Several options may be chosen: no button stands for an answer. */
  multiple?: boolean;
}

export interface Activated {
  ask: string;
  option: string;
}

export interface AskNotifierDeps {
  notify: (ask: NotifyAsk) => Promise<void>;
  /** Takes an ask's toast down; none up is not an error. */
  dismiss: (id: string) => Promise<void>;
  answer: (id: string, option: string) => Promise<unknown>;
  showWindow: () => void;
  onError?: (message: string) => void;
}

export class AskNotifier {
  private deps: AskNotifierDeps;
  /** The asks toasted and not yet settled. */
  private seen = new Set<string>();
  /** After a reconnect, until cophylad's replay of the open asks is over: the ones it named. */
  private replayed?: Set<string>;

  constructor(deps: AskNotifierDeps) {
    this.deps = deps;
  }

  onNotification(n: RpcNotification): void {
    if (n.method !== "ask.state") {
      this.replayOver();
      return;
    }
    const ask = n.params as Ask;
    if (ask.status !== "open") {
      if (this.seen.delete(ask.id)) this.dismiss(ask.id);
      return;
    }
    this.replayed?.add(ask.id);
    if (!ask.answerableBy.includes("user") || this.seen.has(ask.id)) return;
    this.seen.add(ask.id);
    const toast: NotifyAsk = { id: ask.id, title: ask.title, options: ask.options.map((o) => ({ id: o.id, label: o.label })) };
    if (ask.detail !== undefined) toast.detail = ask.detail;
    if (ask.multiple === true) toast.multiple = true;
    this.deps.notify(toast).catch((e) => this.deps.onError?.(`notification: ${messageOf(e)}`));
  }

  async onActivated(a: Activated): Promise<void> {
    try {
      await this.deps.answer(a.ask, a.option);
    } catch (e) {
      // Already answered in the terminal, or expired: nothing to do but show where it went.
      this.deps.showWindow();
      this.deps.onError?.(`answer ${a.ask}: ${messageOf(e)}`);
    }
  }

  /** The link is up again: cophylad replays every open ask before anything else, so the first other notification ends the replay. */
  onConnected(): void {
    this.replayed = new Set();
  }

  forget(id: string): void {
    this.seen.delete(id);
  }

  private replayOver(): void {
    const replayed = this.replayed;
    if (replayed === undefined) return;
    this.replayed = undefined;
    for (const id of this.seen) {
      if (replayed.has(id)) continue;
      this.seen.delete(id);
      this.dismiss(id);
    }
  }

  private dismiss(id: string): void {
    this.deps.dismiss(id).catch((e) => this.deps.onError?.(`dismiss ${id}: ${messageOf(e)}`));
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
