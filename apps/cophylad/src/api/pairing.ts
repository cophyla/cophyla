// The pairing window: `pair.start` on the desktop opens one six-digit code, good for five
// minutes and one use, and the phone spends it with `pair.claim` for a token of its own.
// One code is live at a time, so a second `pair.start` replaces the first; a code burns
// after a handful of wrong guesses, so the window cannot be walked through. Nothing here
// reaches disk: a code that outlives the daemon would be a code nobody is watching.

import type { Controller } from "@cophyla/protocol";
import type { Grants } from "../grants/store.ts";

export const DEFAULT_TTL_MS = 300_000;
/** Wrong guesses a live code survives, across every socket. */
export const MAX_ATTEMPTS = 5;

export interface PairingOffer {
  code: string;
  url: string;
  expiresAt: number;
}

export interface PairingDeps {
  grants: Pick<Grants, "createController">;
  now?: () => number;
  ttlMs?: number;
  maxAttempts?: number;
}

interface Live extends PairingOffer {
  attempts: number;
  timer?: ReturnType<typeof setTimeout>;
}

function sixDigits(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0]! % 1_000_000).padStart(6, "0");
}

export class Pairing {
  private deps: PairingDeps;
  private live?: Live;

  constructor(deps: PairingDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The offer live now, if the window is still open. */
  current(): PairingOffer | undefined {
    if (!this.live) return undefined;
    if (this.live.expiresAt <= this.now()) return undefined;
    const { code, url, expiresAt } = this.live;
    return { code, url, expiresAt };
  }

  /** Opens a window. `url` is what the phone opens; the code is appended by the caller. */
  start(url: (code: string) => string): PairingOffer {
    this.clear();
    const code = sixDigits();
    const expiresAt = this.now() + (this.deps.ttlMs ?? DEFAULT_TTL_MS);
    const live: Live = { code, url: url(code), expiresAt, attempts: 0 };
    const timer = setTimeout(() => {
      if (this.live === live) this.live = undefined;
    }, (this.deps.ttlMs ?? DEFAULT_TTL_MS) + 1);
    timer.unref?.();
    live.timer = timer;
    this.live = live;
    return { code, url: live.url, expiresAt };
  }

  /**
   * Spends a code. A hit pairs a controller and closes the window; a miss counts against
   * the code and burns it after `maxAttempts`. Undefined either way, so the caller cannot
   * tell a wrong code from an expired one and neither can the phone.
   */
  claim(code: string, name: string): { controller: Controller; token: string } | undefined {
    const live = this.live;
    if (!live || live.expiresAt <= this.now()) {
      this.clear();
      return undefined;
    }
    if (code !== live.code) {
      live.attempts++;
      if (live.attempts >= (this.deps.maxAttempts ?? MAX_ATTEMPTS)) this.clear();
      return undefined;
    }
    this.clear();
    return this.deps.grants.createController(name);
  }

  /** Closes the window by hand: the desktop's Done button, or a daemon stopping. */
  clear(): void {
    if (this.live?.timer) clearTimeout(this.live.timer);
    this.live = undefined;
  }

  dispose(): void {
    this.clear();
  }
}
