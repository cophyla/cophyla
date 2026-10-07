// What keeps agents' messages from running away, in memory on the router: a message to an idle
// session starts a turn and spends the user's tokens, and two agents that answer each other
// would go on forever. A sender may send so many a minute in all and so many to one session;
// the same text to the same session again within a window is dropped; and a conversation, a
// message and the replies that follow it, ends at a number of hops. A reply is a message whose
// `reply_to` names one this sender was sent: any other `reply_to` starts a new conversation.

/** The limits, as `[agent_messages]` sets them. */
export interface LimitsConfig {
  max_chars: number;
  per_minute: number;
  per_target_per_minute: number;
  duplicate_window_s: number;
  max_hops: number;
}

const MINUTE_MS = 60_000;
/** How long, and how many, messages are remembered for their conversation. */
const CONVERSATION_MS = 24 * 60 * 60 * 1000;
const CONVERSATIONS = 2000;

interface Sent {
  from: string;
  to: string;
  text: string;
  at: number;
}

interface Hop {
  from: string;
  to: string;
  hops: number;
  at: number;
}

export class Limits {
  private recent: Sent[] = [];
  private conversations = new Map<string, Hop>();
  private config: () => LimitsConfig;
  private now: () => number;

  constructor(config: () => LimitsConfig, now: () => number = Date.now) {
    this.config = config;
    this.now = now;
  }

  /** Where a message from `from` would stand: its hop count, and whether it answers one sent to `from`. */
  hops(from: string, replyTo: string | undefined): { hops: number; reply: boolean } {
    const prior = replyTo !== undefined ? this.conversations.get(replyTo) : undefined;
    if (prior && prior.to === from && this.now() - prior.at <= CONVERSATION_MS) return { hops: prior.hops + 1, reply: true };
    return { hops: 1, reply: false };
  }

  /** Why a message may not go, or undefined when it may. */
  check(from: string, to: string, toName: string, text: string, hops: number): string | undefined {
    const c = this.config();
    const now = this.now();
    if (text.length > c.max_chars) return `the message is ${text.length} characters, over the ${c.max_chars} a message may have: send less, or say where the rest is`;
    if (hops > c.max_hops) return `this conversation has gone back and forth ${c.max_hops} times: stop here and tell the user, rather than answer again`;
    this.recent = this.recent.filter((s) => now - s.at < Math.max(MINUTE_MS, c.duplicate_window_s * 1000));
    const mine = this.recent.filter((s) => s.from === from && now - s.at < MINUTE_MS);
    if (mine.length >= c.per_minute) return `you have sent ${mine.length} messages in the last minute, the most you may: wait before sending more`;
    if (mine.filter((s) => s.to === to).length >= c.per_target_per_minute) return `you have sent ${toName} ${c.per_target_per_minute} messages in the last minute, the most you may: wait for its answer`;
    const same = this.recent.find((s) => s.from === from && s.to === to && s.text === text && now - s.at < c.duplicate_window_s * 1000);
    if (same) return `you sent ${toName} this same message ${Math.max(1, Math.round((now - same.at) / 1000))}s ago: it was not sent again`;
    return undefined;
  }

  /** A message went (or is held for approval): it counts against its sender, and its conversation is remembered. */
  record(id: string, from: string, to: string, text: string, hops: number): void {
    const now = this.now();
    this.recent.push({ from, to, text, at: now });
    this.conversations.set(id, { from, to, hops, at: now });
    if (this.conversations.size > CONVERSATIONS) {
      for (const [key, hop] of this.conversations) {
        if (this.conversations.size <= CONVERSATIONS && now - hop.at <= CONVERSATION_MS) break;
        this.conversations.delete(key);
      }
    }
  }
}
