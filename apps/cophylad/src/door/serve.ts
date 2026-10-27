// When the sign-in door serves: the one rule, kept pure so the tests can walk it. The door
// holds the machine's desktop only while its kit opens a door (kitRefusal), no daemon has been
// attached for GONE_DEBOUNCE_MS (a restart or an update of the daemon is not a sign-out), and
// the console is at the sign-in screen or locked. Someone who signs in or unlocks while the
// door holds a stream keeps it for GRACE_MS, long enough for Cophyla to start there and take
// the desktop over; with no stream the door stands down at once. Locked with the daemon
// running is the daemon's: it asks as it always has, answered from the viewing app.

import type { ConsoleState } from "./constants.ts";
import { GONE_DEBOUNCE_MS, GRACE_MS } from "./constants.ts";

export interface ServeInputs {
  now: number;
  /** Why the kit opens no door, when it does not. */
  refusal: string | undefined;
  /** A daemon is attached now. */
  attached: boolean;
  /** When the last daemon went, or when this door started (none had come yet). */
  goneSince: number;
  console: ConsoleState;
  /** When the console last became active, while it is. */
  activeSince?: number;
  /** The door serves now. */
  serving: boolean;
  /** A stream it holds is live. */
  streaming: boolean;
  /** GONE_DEBOUNCE_MS and GRACE_MS, shorter in the tests. */
  goneMs?: number;
  graceMs?: number;
}

export type ServeVerdict = { serve: true; why: string } | { serve: false; why: string; after?: number };

/** Whether the door should serve now, why, and, when it should not yet, when to look again. */
export function serveVerdict(i: ServeInputs): ServeVerdict {
  if (i.refusal) return { serve: false, why: i.refusal };
  if (i.attached) return { serve: false, why: "Cophyla runs here" };
  const settled = i.goneSince + (i.goneMs ?? GONE_DEBOUNCE_MS);
  if (i.now < settled) return { serve: false, why: "Cophyla went moments ago", after: settled };
  if (i.console === "signin") return { serve: true, why: "no one is signed in" };
  if (i.console === "locked") return { serve: true, why: "the screen is locked and Cophyla is not running" };
  // someone signed in or unlocked: a stream the door holds lasts the grace, for Cophyla to take it
  if (i.serving && i.streaming && i.activeSince !== undefined) {
    const end = i.activeSince + (i.graceMs ?? GRACE_MS);
    if (i.now < end) return { serve: true, why: "someone signed in through the stream; Cophyla takes it when it starts" };
  }
  return { serve: false, why: "someone is signed in" };
}

/** Whether the machine is held awake: while the door is ready at the sign-in or lock screen on mains power, and during a stream. The shim applies it; this is its mirror for the tests. */
export function holdAwake(i: { ready: boolean; streaming: boolean; console: ConsoleState; ac: boolean }): boolean {
  return i.streaming || (i.ready && i.console !== "active" && i.ac);
}
