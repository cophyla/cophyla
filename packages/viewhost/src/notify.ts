// Asks on OS notifications. Every open `ask.state` a person may answer is toasted once, with
// its options as buttons; a button click comes back as `ask:activated` and is answered on
// the host's own connection. An answer refused because the ask was settled elsewhere just
// shows the window. An ask that takes several options at once (`multiple`) is toasted
// without buttons, since one button is one answer: its body opens the window. Elicitation
// asks (`answerableBy: []`) are display-only and never toasted. A toasted ask that settles
// takes its toast down, and so does one missing from cophylad's replay after a reconnect: it
// settled while the link was down. DOM-free.
//
// An ask is toasted only on a machine someone is at, so a cluster's asks pop up where the
// user is rather than on every desktop that hears them: input on this machine within
// `AWAY_MS`, and its desktop not streamed to another (whose own input would count here). An
// ask that opens with no one here is held, and toasted once someone is, if it is still open
// then; the machine is looked at every `RETURN_POLL_MS` while any is held. A host that cannot
// tell (`idleMs` absent, or answering undefined) toasts at once.

import type { Ask, RemoteState, RpcNotification } from "@cophyla/protocol";

/** No input on this machine for this long: no one is at it, and its asks wait to be toasted. */
export const AWAY_MS = 60_000;
/** How often a machine holding asks is looked at for someone come back. */
export const RETURN_POLL_MS = 2_000;

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
  /** How long since the last keyboard or mouse input on this machine; undefined when it cannot tell. */
  idleMs?: () => Promise<number | undefined>;
  /** This machine's node, whose `remote.state` says whether its desktop is streamed elsewhere. */
  node?: () => string | undefined;
  /** Runs `fn` after `ms`; the returned function cancels it. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export class AskNotifier {
  private deps: AskNotifierDeps;
  /** The asks toasted and not yet settled. */
  private seen = new Set<string>();
  /** After a reconnect, until cophylad's replay of the open asks is over: the ones it named. */
  private replayed?: Set<string>;
  /** Open asks waiting for someone to be at this machine, in the order they opened. */
  private held = new Map<string, NotifyAsk>();
  /** This machine's desktop is streamed to another: its input is that viewer's. */
  private streamed = false;
  private looking = false;
  private cancelLook?: () => void;

  constructor(deps: AskNotifierDeps) {
    this.deps = deps;
  }

  onNotification(n: RpcNotification): void {
    if (n.method !== "ask.state") {
      if (n.method === "remote.state") this.onRemote(n.params as RemoteState);
      this.replayOver();
      return;
    }
    const ask = n.params as Ask;
    if (ask.status !== "open") {
      this.held.delete(ask.id);
      if (this.seen.delete(ask.id)) this.dismiss(ask.id);
      return;
    }
    this.replayed?.add(ask.id);
    if (!ask.answerableBy.includes("user") || this.seen.has(ask.id) || this.held.has(ask.id)) return;
    const toast: NotifyAsk = { id: ask.id, title: ask.title, options: ask.options.map((o) => ({ id: o.id, label: o.label })) };
    if (ask.detail !== undefined) toast.detail = ask.detail;
    if (ask.multiple === true) toast.multiple = true;
    if (!this.deps.idleMs) {
      this.show(toast);
      return;
    }
    this.held.set(ask.id, toast);
    void this.look();
  }

  /** Toasts the held asks if someone is at this machine; else looks again in a while. */
  private async look(): Promise<void> {
    if (this.looking) return;
    this.looking = true;
    this.cancelLook?.();
    this.cancelLook = undefined;
    try {
      const here = await this.someoneHere();
      if (here) {
        // what settled while this looked is gone from `held` already
        const toasts = [...this.held.values()];
        this.held.clear();
        for (const t of toasts) this.show(t);
      } else if (this.held.size > 0) {
        const schedule = this.deps.schedule ?? ((fn, ms) => {
          const t = setTimeout(fn, ms);
          return () => clearTimeout(t);
        });
        this.cancelLook = schedule(() => {
          this.cancelLook = undefined;
          void this.look();
        }, RETURN_POLL_MS);
      }
    } finally {
      this.looking = false;
    }
  }

  private async someoneHere(): Promise<boolean> {
    if (this.streamed) return false;
    let idle: number | undefined;
    try {
      idle = await this.deps.idleMs?.();
    } catch (e) {
      this.deps.onError?.(`idle time: ${messageOf(e)}`);
    }
    return idle === undefined || idle < AWAY_MS;
  }

  private onRemote(state: RemoteState): void {
    const node = this.deps.node?.();
    if (node === undefined || state.node !== node) return;
    const was = this.streamed;
    this.streamed = state.streaming === true;
    // the viewer gone, whoever is at this machine is its own user again
    if (was && !this.streamed && this.held.size > 0) void this.look();
  }

  private show(toast: NotifyAsk): void {
    this.seen.add(toast.id);
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
    this.held.delete(id);
  }

  private replayOver(): void {
    const replayed = this.replayed;
    if (replayed === undefined) return;
    this.replayed = undefined;
    for (const id of this.held.keys()) if (!replayed.has(id)) this.held.delete(id);
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
