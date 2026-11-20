// The presses of the Listen buttons, kept apart from their drawing (listen.ts) so they need no
// page: what this device reads out now, the words each button reads, and the control that asks
// the node to read one out or stop, and follows what the node says this device hears.

import { READ_MAX } from "./listenmodel.ts";
import type { ViewState } from "./model.ts";

/** The host's line, as far as the presses use it. */
export interface ListenRpc {
  request(method: string, params?: unknown): Promise<unknown>;
}

/** What this device reads out now. */
export interface ListenUi {
  /** The message, by its button's key. */
  key?: string;
  /** Asked for and not heard yet, or heard. */
  phase?: "starting" | "playing";
  /** The last message the voice could not read: its key and why, until `FAILED_MS` has passed or another is pressed. */
  failed?: { key: string; words: string; at: number };
}

/** How long why a message was not read out stays beside its button. */
export const FAILED_MS = 12_000;

export function newListenUi(): ListenUi {
  return {};
}

/** How many messages' words are kept for their buttons. */
const KEPT = 400;

// The words each button reads, by its key, kept as the buttons are drawn: the newest last.
const texts = new Map<string, string>();

/** The words a button reads, as last drawn. */
export function textFor(key: string): string | undefined {
  return texts.get(key);
}

/** The words a button reads, kept under its key as it is drawn (and by the tests). */
export function remember(key: string, text: string): void {
  texts.delete(key);
  texts.set(key, text);
  if (texts.size > KEPT) texts.delete(texts.keys().next().value!);
}

export interface ListenDeps {
  rpc: ListenRpc;
  state: Pick<ViewState, "client">;
  ui: { listen: ListenUi };
  draw: () => void;
  fail: (what: string, e: unknown) => void;
}

export class ListenControl {
  private d: ListenDeps;
  private failedTimer?: ReturnType<typeof setTimeout>;

  constructor(deps: ListenDeps) {
    this.d = deps;
  }

  /** A press on a Listen button; false for any other. */
  click(target: { dataset: { [name: string]: string | undefined } }): boolean {
    if (target.dataset["action"] !== "listen") return false;
    const key = target.dataset["key"];
    if (!key) return true;
    const l = this.d.ui.listen;
    if (l.key === key && l.phase !== undefined) void this.stop();
    else void this.play(key);
    return true;
  }

  /**
   * What this device hears changed: the first audio of what it asked for has left, so it plays;
   * or what it was reading is over, its button Listen again, with why when the voice failed it.
   * A plain `speaking` comes as the line begins, before the voice has made any of it.
   */
  voiceState(p: { state: string; client?: string; sounding?: boolean; failed?: string }): void {
    const l = this.d.ui.listen;
    if (l.key === undefined) return;
    if (p.client !== undefined && p.client !== this.d.state.client?.id) return;
    if (p.state === "speaking") {
      if (p.sounding !== true || l.phase === "playing") return;
      l.phase = "playing";
    } else if (p.state === "idle") {
      if (p.failed !== undefined) this.failed(l.key, p.failed);
      this.done();
    } else return;
    this.d.draw();
  }

  /** The line went: whatever was playing on it is over. */
  disconnected(): void {
    this.done();
  }

  private async play(key: string): Promise<void> {
    const text = textFor(key);
    if (!text) return;
    const l = this.d.ui.listen;
    l.key = key;
    l.phase = "starting";
    delete l.failed;
    this.d.draw();
    try {
      // Asked: it is getting ready until its first audio leaves, in place of what played before.
      await this.d.rpc.request("voice.preview", { text: text.slice(0, READ_MAX), read: true });
    } catch (e) {
      if (l.key === key) this.done();
      // refused at once (no voice, nothing in it to say): why, beside the button
      this.failed(key, `Not read out: ${e instanceof Error ? e.message : String(e)}.`.replace(/\.\.$/, "."));
      this.d.draw();
    }
  }

  /** Why `key` was not read out, beside its button for `FAILED_MS`. */
  private failed(key: string, words: string): void {
    const at = Date.now();
    this.d.ui.listen.failed = { key, words, at };
    if (this.failedTimer) clearTimeout(this.failedTimer);
    this.failedTimer = setTimeout(() => {
      if (this.d.ui.listen.failed?.at !== at) return;
      delete this.d.ui.listen.failed;
      this.d.draw();
    }, FAILED_MS);
  }

  private async stop(): Promise<void> {
    this.done();
    this.d.draw();
    try {
      await this.d.rpc.request("voice.preview", { stop: true });
    } catch (e) {
      this.d.fail("stop", e);
    }
  }

  private done(): void {
    const l = this.d.ui.listen;
    delete l.key;
    delete l.phase;
  }
}
