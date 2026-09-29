// Whether a reply is read out, and where: config.toml's `[speech]` rules (`speech-rules.ts`)
// over where the user is (`presence.ts`), decided on the primary before the brain writes the
// reply, since what is read out is written for the ear.
//
// Every user message leaves an origin in the store (`voice.origins`, one key per message): the
// device it came from, and whether the user hushed what it brings back. The answer's verdict
// rides the `user.message` event (`speak`); a listener that serves the message (`asked`) is a
// candidate for a spoken result, and each of its wake and notify fires gets its own verdict
// (`listener.fired {speak}`), kept by the fire until its `voice.speak` comes. When that comes,
// naming the message and the fire, the speech goes to the device the verdict chose, checked
// again first: not hushed since, the device still heard, and the session not in front of the
// user now. A `voice.speak` that names neither is an older brain's, spoken where it always
// was. Candidates are keyed by what they stand for (`{kind: "listener", id}`), so other kinds
// of pending result can be added beside them.
//
// What the speaker button shows (`voice.next`) is worked out again whenever anything it rests
// on may have moved: the user acting or reporting in the app, a tab or a terminal opened, a
// listener added, fired or gone, a message or its reply, a hush; at the moment a device's last
// action falls out of a rule's window; and, while a result could be read out, every two seconds,
// for the window in front, which nothing announces. An answer is pending from its message until
// its speech, or a moment after the reply or the end of the brain's turn with none, so the
// button is lit while the brain thinks.
//
// `hush` stops what is being read out and marks every pending candidate's origin hushed: kept in
// the store, it silences that request's later results too, until `hush` off clears it. A
// hushed listener still fires, told not to speak, so the brain writes its result for the eye.

import type { Client, Listener, Session, Task, VoiceNext } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { ClientRegistry } from "../api/clients.ts";
import type { SpeechRule } from "../config/schema.ts";
import { VOICE_ORIGINS_NS } from "../grants/namespaces.ts";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";
import { REPLY_GRACE_MS } from "./conversation.ts";
import { deviceOf } from "./presence.ts";
import type { Presence, PresenceReport } from "./presence.ts";
import { decide } from "./speech-rules.ts";
import type { SpeechFacts, SpeechVerdict, SpeechWorld } from "./speech-rules.ts";

export { VOICE_ORIGINS_NS };

/** How long an origin is kept: a listener rarely outlives a request by more. */
export const ORIGIN_DAYS = 30;
/** How often the old origins are pruned. */
export const PRUNE_MS = 24 * 60 * 60_000;
/** How often the window in front is asked while a result could be read out. */
export const POLL_MS = 2000;
/** How long a fire's verdict waits for its `voice.speak`. */
export const FIRE_KEEP_MS = 10 * 60_000;
/** How long an answer is pending at most, when no reply ever comes. */
export const ANSWER_MAX_MS = 10 * 60_000;
/** Changes that come together are worked out once. */
const SETTLE_MS = 30;

/**
 * The user's actions in the app, as the requests and signals that carry them: what the user
 * does, not what an app polls or streams on its own.
 */
export const USER_ACTIONS: ReadonlySet<string> = new Set([
  "chat.send",
  "chat.typing",
  "voice.ptt",
  "voice.wake",
  "voice.hush",
  "ask.answer",
  "session.send",
  "session.focus",
  "session.stop",
  "terminal.open",
  "terminal.spawn",
  "terminal.input",
  "task.create",
  "task.update",
  "remote.open",
]);
/** Requests that change what is shown where, though they are no action of the user's. */
const SHOWN = new Set(["session.watch", "terminal.close"]);

/** Where a request was made, and whether the user hushed what it brings back. */
export interface Origin {
  device: string;
  at: number;
  hushed?: true;
}

/** What a pending result stands for. */
export type CandidateKey = { kind: "listener"; id: string };

/** A fire told to speak, waiting for its `voice.speak`. */
interface Fired {
  asked: string;
  device: string;
  sessions: string[];
  at: number;
}

/** An answer being thought about, to be read on `device`: dropped at `ANSWER_MAX_MS` whatever happens, or a moment after the turn ends (`closing`). */
interface Answer {
  device: string;
  opened: number;
  timer?: ReturnType<typeof setTimeout>;
  closing?: ReturnType<typeof setTimeout>;
}

export interface DeliveryDeps {
  rules: readonly SpeechRule[];
  store: Store;
  bus: Bus;
  clients: ClientRegistry;
  presence: Presence;
  /** Stops whatever is being read out. */
  hushVoice?: () => void;
  /** The brain's listeners. */
  listeners: () => Listener[];
  session: (id: string) => Session | undefined;
  task: (id: string) => Task | undefined;
  /**
   * Where the window in front is asked of the system: reads the chains of the processes whose
   * windows would show these sessions, for the checks that follow. Absent elsewhere, and then
   * nothing is polled.
   */
  front?: (sessions: string[]) => Promise<void>;
  log: Logger;
  now?: () => number;
  /** For the tests. */
  pollMs?: number;
  replyGraceMs?: number;
}

export class Delivery {
  private deps: DeliveryDeps;
  private started = false;
  private answers = new Map<string, Answer>();
  private fires = new Map<string, Fired>();
  private next: VoiceNext = { speak: false };
  private told = JSON.stringify(this.next);
  private settle?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private prune?: ReturnType<typeof setInterval>;
  private unsubscribe: (() => void)[] = [];

  constructor(deps: DeliveryDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // --- lifecycle -----------------------------------------------------------------------------

  /** Whether this node decides: it is the primary. */
  get running(): boolean {
    return this.started;
  }

  /** On the primary, beside the listeners. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.pruneOrigins();
    this.prune = setInterval(() => this.pruneOrigins(), PRUNE_MS);
    this.prune.unref?.();
    this.unsubscribe.push(
      // The reply came: its answer is pending a moment longer, for the speech that follows it.
      this.deps.bus.on("chat.message", (m) => {
        if (m.role === "orchestrator") this.replied();
      }),
      // A turn that ended with no reply leaves nothing to read; one that runs is still thinking.
      this.deps.bus.on("chat.progress", (p) => {
        if (p.turn === undefined) this.replied();
        else this.thinking();
      }),
    );
    this.recompute();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    for (const a of this.answers.values()) for (const t of [a.timer, a.closing]) if (t) clearTimeout(t);
    this.answers.clear();
    this.fires.clear();
    for (const t of [this.settle, this.expiry]) if (t) clearTimeout(t);
    for (const t of [this.poll, this.prune]) if (t) clearInterval(t);
    this.settle = this.expiry = this.poll = this.prune = undefined;
    this.next = { speak: false };
    this.told = JSON.stringify(this.next);
  }

  // --- origins ------------------------------------------------------------------------------

  private origin(message: string): Origin | undefined {
    return this.deps.store.kv.get(VOICE_ORIGINS_NS, message) as Origin | undefined;
  }

  private putOrigin(message: string, o: Origin): void {
    this.deps.store.kv.put(VOICE_ORIGINS_NS, message, o, this.now());
  }

  private pruneOrigins(): void {
    const before = this.now() - ORIGIN_DAYS * 24 * 60 * 60_000;
    let n = 0;
    for (const key of this.deps.store.kv.list(VOICE_ORIGINS_NS)) {
      const o = this.origin(key);
      if (!o || o.at < before) {
        this.deps.store.kv.delete(VOICE_ORIGINS_NS, key);
        n++;
      }
    }
    if (n > 0) this.deps.log.debug("old origins pruned", { n });
  }

  /** Whether a message was spoken or typed. */
  private asked(message: string): "voice" | "typed" {
    return this.deps.store.messages.get(message)?.source === "voice" ? "voice" : "typed";
  }

  // --- the rules ------------------------------------------------------------------------------

  private readonly world: SpeechWorld = {
    recent: () => this.deps.presence.recent(),
    lastAction: (device) => this.deps.presence.lastAction(device),
    heard: (device) => this.deps.presence.speakable(device) !== undefined,
    now: () => this.now(),
  };

  private decide(facts: SpeechFacts): SpeechVerdict {
    return decide(this.deps.rules, facts, this.world);
  }

  /** The sessions a listener's result is about: the event's, else the listener's own, its `until`, or its task's. */
  sessionsOf(l: Listener, event?: { params: Record<string, unknown> }): string[] {
    const s = event?.params["session"];
    const id = typeof s === "string" ? s : s !== null && typeof s === "object" && typeof (s as { id?: unknown }).id === "string" ? (s as { id: string }).id : undefined;
    if (id !== undefined) return [id];
    if (l.session !== undefined) return [l.session];
    if (l.until?.startsWith("sess_")) return [l.until];
    const task = l.task ?? (l.until?.startsWith("task_") ? l.until : undefined);
    return task !== undefined ? [...(this.deps.task(task)?.sessions ?? [])] : [];
  }

  /** A listener's result's verdict now, hushed or not. */
  private resultVerdict(l: Listener & { asked: string }, origin: Origin, sessions: string[]): SpeechVerdict {
    return this.decide({ reply: "result", asked: this.asked(l.asked), asker: origin.device, watching: () => this.deps.presence.watched(sessions) });
  }

  /** The listeners that would bring a result back for a request: waking or notifying, with an origin. */
  private candidates(): (Listener & { asked: string })[] {
    return this.deps.listeners().filter((l): l is Listener & { asked: string } => l.asked !== undefined && l.deliver !== "note" && this.origin(l.asked) !== undefined);
  }

  // --- the hooks --------------------------------------------------------------------------------

  /**
   * A user message was stored: its origin is kept, and whether its answer is read out is decided
   * now. Undefined while this is not the primary: the brain then goes by how it was asked.
   */
  onUserMessage(message: string, input: { source: "ui" | "controller" | "voice"; client?: string }): boolean | undefined {
    if (!this.started) return undefined;
    const client = input.client !== undefined ? this.deps.clients.get(input.client)?.client : undefined;
    if (!client) return false;
    const device = deviceOf(client);
    // Saying something is acting in the app, however it was said.
    this.deps.presence.acted(client);
    this.putOrigin(message, { device, at: this.now() });
    const verdict = this.decide({ reply: "answer", asked: input.source === "voice" ? "voice" : "typed", asker: device, watching: () => false });
    if (verdict.speak) this.openAnswer(message, verdict.device);
    this.changed();
    return verdict.speak;
  }

  private openAnswer(message: string, device: string): void {
    const a: Answer = { device, opened: this.now() };
    a.timer = setTimeout(() => this.closeAnswer(message), ANSWER_MAX_MS);
    a.timer.unref?.();
    this.answers.set(message, a);
  }

  private closeAnswer(message: string): void {
    const a = this.answers.get(message);
    if (!a) return;
    for (const t of [a.timer, a.closing]) if (t) clearTimeout(t);
    this.answers.delete(message);
    this.changed();
  }

  /** A reply reached the chat, or the turn ended: an answer still pending gives way a moment later unless its speech comes first. */
  private replied(): void {
    for (const [message, a] of this.answers) {
      if (a.closing) clearTimeout(a.closing);
      a.closing = setTimeout(() => this.closeAnswer(message), this.deps.replyGraceMs ?? REPLY_GRACE_MS);
      a.closing.unref?.();
    }
  }

  /** A turn runs: the answers pending are being thought about, whatever turn ended before it. */
  private thinking(): void {
    for (const a of this.answers.values()) {
      if (a.closing) clearTimeout(a.closing);
      a.closing = undefined;
    }
  }

  /**
   * A listener fired, waking or notifying the brain: whether its result is read out, for one
   * that serves a request; undefined for one that serves none, or a note.
   */
  onFire(l: Listener, event: { name: string; params: Record<string, unknown> }): boolean | undefined {
    if (!this.started || l.asked === undefined || l.deliver === "note") return undefined;
    const origin = this.origin(l.asked);
    if (!origin) return undefined;
    const sessions = this.sessionsOf(l, event);
    const verdict: SpeechVerdict = origin.hushed ? { speak: false } : this.resultVerdict(l as Listener & { asked: string }, origin, sessions);
    const at = this.now();
    for (const [key, f] of this.fires) if (at - f.at > FIRE_KEEP_MS) this.fires.delete(key);
    if (verdict.speak) this.fires.set(`${l.id}:${l.fired}`, { asked: l.asked, device: verdict.device, sessions, at });
    this.deps.log.info("result", { listener: l.id, fire: l.fired, speak: verdict.speak, ...(verdict.speak ? { device: verdict.device } : {}), ...(verdict.rule !== undefined ? { rule: verdict.rule } : {}), ...(origin.hushed ? { hushed: true } : {}) });
    this.changed();
    return verdict.speak;
  }

  /**
   * Where the brain's `voice.speak` goes: a client of the device its verdict chose, checked again
   * now; none when it was hushed, the device went or muted, or the session came into view since;
   * `legacy` for a brain that names neither the message nor the fire.
   */
  target(p: { asked?: string; fire?: { listener: string; n: number } }): { client: string } | "legacy" | undefined {
    if (p.asked === undefined && p.fire === undefined) return "legacy";
    if (!this.started) return undefined;
    if (p.fire) {
      const fired = this.fires.get(`${p.fire.listener}:${p.fire.n}`);
      const origin = this.origin(p.asked ?? fired?.asked ?? "");
      if (!fired || !origin || origin.hushed) return undefined;
      const entry = this.deps.presence.speakable(fired.device);
      if (!entry || this.deps.presence.watched(fired.sessions)) return undefined;
      return { client: entry.client.id };
    }
    const asked = p.asked!;
    const origin = this.origin(asked);
    const open = this.answers.get(asked);
    if (open) this.closeAnswer(asked);
    if (!origin || origin.hushed) return undefined;
    // An answer long after its message (a turn resumed) is decided again now.
    let device = open?.device;
    if (device === undefined) {
      const verdict = this.decide({ reply: "answer", asked: this.asked(asked), asker: origin.device, watching: () => false });
      if (verdict.speak) device = verdict.device;
    }
    const entry = device !== undefined ? this.deps.presence.speakable(device) : undefined;
    return entry ? { client: entry.client.id } : undefined;
  }

  /**
   * The speaker button: `on` stops what is being read out and silences every pending answer and
   * result, and every later result of the same requests; `off` reads them out again.
   */
  hush(on: boolean): VoiceNext {
    const messages = new Set<string>([...this.answers.keys(), ...this.candidates().map((l) => l.asked), ...[...this.fires.values()].map((f) => f.asked)]);
    if (on) this.deps.hushVoice?.();
    for (const message of messages) {
      const o = this.origin(message);
      if (!o) continue;
      if (on && !o.hushed) this.putOrigin(message, { ...o, hushed: true });
      if (!on && o.hushed) {
        const { hushed: _hushed, ...rest } = o;
        this.putOrigin(message, rest);
      }
    }
    this.deps.log.info(on ? "hushed" : "hush undone", { requests: messages.size });
    this.recompute();
    return this.current();
  }

  /** `voice.presence`: what a client says of its window. */
  presence(client: Client, report: PresenceReport): void {
    if (this.deps.presence.report(client, report)) this.changed();
  }

  /** A request or signal came from a client: an action of the user's, or a change of what it shows. */
  request(client: Client, method: string): void {
    if (USER_ACTIONS.has(method)) {
      this.deps.presence.acted(client);
      this.changed();
    } else if (SHOWN.has(method)) this.changed();
  }

  /** What a client shows changed. */
  shown(): void {
    this.changed();
  }

  /** A client went away. */
  disconnected(clientId: string): void {
    this.deps.presence.forget(clientId);
    this.changed();
  }

  /** The listeners changed: one added, fired or gone. */
  listenersChanged(): void {
    this.changed();
  }

  // --- the button ------------------------------------------------------------------------------

  /** What the speaker button shows now. */
  current(): VoiceNext {
    return this.next;
  }

  /** Something the button rests on may have moved: worked out once things settle. */
  private changed(): void {
    if (!this.started || this.settle) return;
    this.settle = setTimeout(() => {
      this.settle = undefined;
      this.recompute();
    }, SETTLE_MS);
    this.settle.unref?.();
  }

  private recompute(): void {
    if (!this.started) return;
    if (this.settle) clearTimeout(this.settle);
    this.settle = undefined;
    const candidates = this.candidates();
    const next = this.compute(candidates);
    const line = JSON.stringify(next);
    this.next = next;
    if (line !== this.told) {
      this.told = line;
      this.deps.bus.emit("voice.next", next);
    }
    this.arm(candidates);
  }

  private compute(candidates: (Listener & { asked: string })[]): VoiceNext {
    let hushed = false;
    const on = (device: string): VoiceNext | undefined => {
      const entry = this.deps.presence.speakable(device);
      if (!entry) return undefined;
      const name = this.deps.presence.nameOf(device, entry.client);
      return { speak: true, target: entry.client.id, ...(name !== undefined ? { name } : {}) };
    };
    // The answer the user waits for first, then a result.
    for (const [message, a] of [...this.answers].reverse()) {
      const next = on(a.device);
      if (!next) continue;
      if (this.origin(message)?.hushed) hushed = true;
      else return next;
    }
    for (const l of candidates) {
      const origin = this.origin(l.asked)!;
      const verdict = this.resultVerdict(l, origin, this.sessionsOf(l));
      if (!verdict.speak) continue;
      if (origin.hushed) hushed = true;
      else {
        const next = on(verdict.device);
        if (next) return next;
      }
    }
    return { speak: false, ...(hushed ? { hushed: true } : {}) };
  }

  /**
   * The timers the button needs while results are pending: when a device's last action next
   * falls out of a rule's window, and the poll of the window in front while one could be read.
   */
  private arm(candidates: (Listener & { asked: string })[]): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    const open = candidates.filter((l) => !this.origin(l.asked)?.hushed);
    if (open.length === 0) {
      if (this.poll) clearInterval(this.poll);
      this.poll = undefined;
      return;
    }
    const at = this.now();
    let soonest = Infinity;
    const windows = this.deps.rules.flatMap((r) => (r.used_within_min !== undefined ? [r.used_within_min * 60_000] : []));
    const devices = new Set(open.map((l) => this.origin(l.asked)!.device));
    const recent = this.deps.presence.recent();
    if (recent !== undefined) devices.add(recent);
    for (const device of devices) {
      const last = this.deps.presence.lastAction(device);
      if (last === undefined) continue;
      for (const w of windows) if (last + w > at) soonest = Math.min(soonest, last + w);
    }
    if (soonest < Infinity) {
      this.expiry = setTimeout(() => this.recompute(), soonest - at + 5);
      this.expiry.unref?.();
    }
    const front = this.deps.front;
    if (!front) return;
    void front([...new Set(open.flatMap((l) => this.sessionsOf(l)))]);
    if (!this.poll) {
      this.poll = setInterval(() => this.recompute(), this.deps.pollMs ?? POLL_MS);
      this.poll.unref?.();
    }
  }
}
