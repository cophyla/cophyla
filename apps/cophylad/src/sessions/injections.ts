// Pending sends with their receipts and timeouts, shared by the adapters. A message is
// `queued` when sent, `delivered` when the harness shows it (the UserPromptSubmit hook or a
// transcript row on Claude, the rollout UserMessage carrying cophylad's client_id on Codex, the
// UserPromptSubmit hook or the view's user message on Muse),
// `withdrawn` when Codex never picked it up and cophylad took it back, and `unconfirmed` when
// Claude or Muse gave no sign in time. The clock and timers are injected so tests can drive them.

export type SendState = "queued" | "delivered" | "withdrawn" | "unconfirmed";

export interface PendingSend {
  ref: string;
  session: string;
  harness: "claude" | "codex" | "muse";
  /** What the user asked to send. */
  text: string;
  /** What went over the wire: the text behind cophylad's one-line prefix, or, typed, the text itself. */
  body: string;
  /** Typed into the session's terminal as the user's own words. */
  typed?: boolean;
  /** Claude: the prompt it landed as, so the transcript's copy of that prompt is known for it. */
  promptId?: string;
  at: number;
  state: SendState;
  /** Codex: the queue entry to delete on withdrawal. */
  queuedSubmissionId?: string;
  /** The timer fired while the session was busy; re-armed when it goes idle. */
  waitingForIdle?: boolean;
  timer?: unknown;
}

export interface InjectionsOptions {
  timeoutMs: number;
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (timer: unknown) => void;
  /** The window passed with no receipt. The caller withdraws, marks unconfirmed, or asks for a re-arm. */
  onTimeout: (p: PendingSend) => void;
}

/** A prompt as typed and as the harness records it: line breaks alike, ends trimmed. */
function normal(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

function typedMatch(p: PendingSend, text: string, promptId: string | undefined): boolean {
  if (normal(text) !== normal(p.body)) return false;
  return p.state === "queued" || p.state === "unconfirmed" || (promptId !== undefined && p.promptId === promptId);
}

/** How long a settled send stays known, so a late receipt still matches and is not recorded as a user turn. */
const RETAIN_MS = 6 * 60 * 60 * 1000;

export class Injections {
  private opts: InjectionsOptions;
  private byRef = new Map<string, PendingSend>();

  constructor(opts: InjectionsOptions) {
    this.opts = opts;
  }

  add(input: Omit<PendingSend, "state" | "timer">): PendingSend {
    const p: PendingSend = { ...input, state: "queued" };
    this.byRef.set(p.ref, p);
    this.arm(p);
    this.prune();
    return p;
  }

  get(ref: string): PendingSend | undefined {
    return this.byRef.get(ref);
  }

  /** Sends still waiting for a receipt in one session. */
  pending(session: string): PendingSend[] {
    return [...this.byRef.values()].filter((p) => p.session === session && p.state === "queued");
  }

  /**
   * The send a delivered prompt carries; queued ones first, then recently settled. A send over
   * the pipe matches by its body, prefix and all, never the bare text, which a short message
   * would find in prompts that merely contain it. A typed send has no prefix: it matches the
   * whole prompt, and once delivered only the prompt it landed as, so the user typing the same
   * words later is the user's own turn.
   */
  matchText(session: string, text: string, promptId?: string): PendingSend | undefined {
    const candidates = [...this.byRef.values()].filter((p) => p.session === session && (p.typed ? typedMatch(p, text, promptId) : text.includes(p.body)));
    return candidates.find((p) => p.state === "queued") ?? candidates.find((p) => p.state === "unconfirmed") ?? candidates[0];
  }

  /** Marks a send settled and clears its timer. Returns the send when it changed state. */
  settle(ref: string, state: Exclude<SendState, "queued">): PendingSend | undefined {
    const p = this.byRef.get(ref);
    if (!p) return undefined;
    if (p.state === state) return undefined;
    if (p.state !== "queued" && !(p.state === "unconfirmed" && state === "delivered")) return undefined;
    this.disarm(p);
    p.state = state;
    delete p.waitingForIdle;
    return p;
  }

  /** The timer fired while the session was busy: wait for it to go idle. */
  hold(p: PendingSend): void {
    p.waitingForIdle = true;
    this.disarm(p);
  }

  /** The session went idle: every held send gets the full window again. */
  rearm(session: string): void {
    for (const p of this.byRef.values()) {
      if (p.session !== session || p.state !== "queued" || !p.waitingForIdle) continue;
      delete p.waitingForIdle;
      this.arm(p);
    }
  }

  private arm(p: PendingSend): void {
    this.disarm(p);
    p.timer = this.opts.schedule(() => {
      p.timer = undefined;
      if (p.state === "queued") this.opts.onTimeout(p);
    }, this.opts.timeoutMs);
  }

  private disarm(p: PendingSend): void {
    if (p.timer !== undefined) {
      this.opts.cancel(p.timer);
      p.timer = undefined;
    }
  }

  private prune(): void {
    const cutoff = this.opts.now() - RETAIN_MS;
    for (const [ref, p] of this.byRef) if (p.state !== "queued" && p.at < cutoff) this.byRef.delete(ref);
  }

  dispose(): void {
    for (const p of this.byRef.values()) this.disarm(p);
  }
}
