// `chat.typing` per client, turned into `user.activity` for the brain on the edges only: the
// first `active: true` says typing, an `active: false` or three seconds of silence says idle.
// A controller says so as `controller`, everything else as `ui`. Speaking is the same shape
// from the voice module: the utterance's edges, with a safety timer in case the falling one
// never comes.

import type { Bus, UserActivityEvent } from "../bus.ts";

export const IDLE_AFTER_MS = 3000;
/** A speaking edge that is never closed (a controller that vanished mid-word) goes idle here. */
export const SPEAKING_SAFETY_MS = 30000;

export interface ActivityDeps {
  bus: Bus;
  now?: () => number;
  idleAfterMs?: number;
  speakingSafetyMs?: number;
}

export class Activity {
  private deps: ActivityDeps;
  private typing = new Map<string, ReturnType<typeof setTimeout>>();
  private speakers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: ActivityDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** A `chat.typing` signal from a client. */
  typingSignal(client: { id: string; kind: "ui" | "controller" }, active: boolean): void {
    const source: UserActivityEvent["source"] = client.kind === "controller" ? "controller" : "ui";
    const pending = this.typing.get(client.id);
    if (active) {
      if (pending) clearTimeout(pending);
      const timer = setTimeout(() => this.idle(client.id, source), this.deps.idleAfterMs ?? IDLE_AFTER_MS);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      this.typing.set(client.id, timer);
      if (!pending) this.deps.bus.emit("user.activity", { at: this.now(), state: "typing", source });
      return;
    }
    if (pending) this.idle(client.id, source);
  }

  /** The edges of an utterance, from the voice module: `user.activity {speaking}` and then `idle`. */
  speaking(client: { id: string; kind: "ui" | "controller" }, active: boolean): void {
    const source: UserActivityEvent["source"] = "voice";
    const pending = this.speakers.get(client.id);
    if (active) {
      if (pending) clearTimeout(pending);
      const timer = setTimeout(() => this.stopSpeaking(client.id), this.deps.speakingSafetyMs ?? SPEAKING_SAFETY_MS);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      this.speakers.set(client.id, timer);
      if (!pending) this.deps.bus.emit("user.activity", { at: this.now(), state: "speaking", source });
      return;
    }
    if (pending) this.stopSpeaking(client.id);
  }

  private stopSpeaking(client: string): void {
    const pending = this.speakers.get(client);
    if (!pending) return;
    clearTimeout(pending);
    this.speakers.delete(client);
    this.deps.bus.emit("user.activity", { at: this.now(), state: "idle", source: "voice" });
  }

  private idle(client: string, source: UserActivityEvent["source"]): void {
    const pending = this.typing.get(client);
    if (!pending) return;
    clearTimeout(pending);
    this.typing.delete(client);
    this.deps.bus.emit("user.activity", { at: this.now(), state: "idle", source });
  }

  /** A client went away mid-word. */
  forget(client: string): void {
    const pending = this.typing.get(client);
    if (pending) {
      clearTimeout(pending);
      this.typing.delete(client);
    }
    const speaking = this.speakers.get(client);
    if (speaking) this.stopSpeaking(client);
  }

  dispose(): void {
    for (const t of this.typing.values()) clearTimeout(t);
    this.typing.clear();
    for (const t of this.speakers.values()) clearTimeout(t);
    this.speakers.clear();
  }
}
