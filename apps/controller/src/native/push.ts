// Push on the phone's side: the device token registered with the node (`push.register`,
// sent on every connect until the node took it), and the deep links a notification's
// buttons open (`cophyla://ask/<id>/<option>`), answered as `ask.answer` once the link is up
// and dropped after a minute — an answer the user gave from the lock screen should not land
// on a stale ask an hour later. The notification itself is built by the messaging service
// on the native side from the push's data; a push received while the app is in front is
// ignored, since the ask is already on the socket.

export interface AskLink {
  ask: string;
  option?: string;
}

/** `cophyla://ask/<id>` or `cophyla://ask/<id>/<option>`, the parts percent-decoded. */
export function parseAskLink(url: string): AskLink | undefined {
  const m = /^cophyla:\/\/ask\/([^/?#]+)(?:\/([^/?#]+))?\/?(?:[?#].*)?$/.exec(url.trim());
  if (!m) return undefined;
  try {
    const ask = decodeURIComponent(m[1]!);
    if (!ask) return undefined;
    return m[2] !== undefined ? { ask, option: decodeURIComponent(m[2]) } : { ask };
  } catch {
    return undefined;
  }
}

/** How long a queued answer waits for the link. */
export const ANSWER_TTL_MS = 60_000;

export interface PushBridgeDeps {
  /** A request on the link; rejects while it is down. */
  request: (method: string, params: unknown) => Promise<unknown>;
  connected: () => boolean;
  platform: "android" | "ios";
  now?: () => number;
  log?: (message: string) => void;
}

interface Queued {
  ask: string;
  option: string;
  at: number;
}

export class PushBridge {
  private deps: PushBridgeDeps;
  private token?: string;
  private acked?: string;
  private queue: Queued[] = [];
  private sending = false;

  constructor(deps: PushBridgeDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The platform handed out a device token: registered at the next chance. */
  onToken(token: string): void {
    if (this.token === token) return;
    this.token = token;
    this.acked = undefined;
    void this.flush();
  }

  /** The link came up: the registration goes again unless acknowledged, and the queued answers land. */
  onConnected(): void {
    void this.flush();
  }

  /** A notification's button, or its body, was tapped. */
  onLink(url: string): AskLink | undefined {
    const link = parseAskLink(url);
    if (!link) return undefined;
    if (link.option !== undefined) {
      this.queue = this.queue.filter((q) => q.ask !== link.ask);
      this.queue.push({ ask: link.ask, option: link.option, at: this.now() });
      void this.flush();
    }
    return link;
  }

  /** For the tests and the status line. */
  get registered(): boolean {
    return this.token !== undefined && this.acked === this.token;
  }

  get pending(): number {
    return this.queue.length;
  }

  private async flush(): Promise<void> {
    if (this.sending || !this.deps.connected()) return;
    this.sending = true;
    try {
      if (this.token && this.acked !== this.token) {
        const token = this.token;
        try {
          await this.deps.request("push.register", { platform: this.deps.platform, token });
          this.acked = token;
        } catch (e) {
          this.deps.log?.(`push.register: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const now = this.now();
      const due = this.queue;
      this.queue = [];
      for (const q of due) {
        if (now - q.at > ANSWER_TTL_MS) {
          this.deps.log?.(`answer to ${q.ask} dropped: older than a minute`);
          continue;
        }
        try {
          await this.deps.request("ask.answer", { id: q.ask, option: q.option });
        } catch (e) {
          this.deps.log?.(`ask.answer ${q.ask}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      this.sending = false;
    }
  }
}
