// Where this phone's wake word is detected, and whether it has just heard it, as a value.
// Pure, so the answers and the timer that move it are testable without a browser: the page
// dispatches what happened and reads `mode` and `pending` into what the chrome derives.

import type { VoiceState } from "@cophyla/protocol";

export type WakeMode = "phone" | "node" | "off";

export interface WakeBook {
  /** The node's last answer to `voice.wakeword`, kept across reconnects; `node` before the first. */
  mode: WakeMode;
  /** The phone heard the word and the node has not yet said `listening`: audio goes up meanwhile. */
  pending: boolean;
  /** When it heard it, for the timeout. */
  heardAt?: number;
}

/** How long the phone streams on its own word before it gives up on the node saying `listening`. */
export const PENDING_MS = 3000;

export type WakeEvent =
  /** `voice.wakeword` answered; a node that does not know the request is `node`. */
  | { type: "answer"; mode: WakeMode }
  /** The detector or its worker failed: the node detects from now on. */
  | { type: "failed" }
  | { type: "heard"; at: number }
  /** This phone's voice state from the node. */
  | { type: "voice"; state: VoiceState }
  /** `voice.wake` was refused, with the error's code. */
  | { type: "refused"; code?: string }
  | { type: "tick"; at: number }
  | { type: "disconnected" }
  | { type: "background" };

export function initialWake(): WakeBook {
  return { mode: "node", pending: false };
}

export function reduceWake(book: WakeBook, event: WakeEvent): WakeBook {
  switch (event.type) {
    case "answer":
      return { ...book, mode: event.mode };
    case "failed":
      return settle({ ...book, mode: "node" });
    case "heard":
      return book.mode === "phone" ? { ...book, pending: true, heardAt: event.at } : book;
    case "voice":
      return event.state === "listening" ? settle(book) : book;
    case "refused":
      // An older node has no `voice.wake`: it can only detect the word itself.
      return settle(event.code === "unsupported" ? { ...book, mode: "node" } : book);
    case "tick":
      return book.pending && book.heardAt !== undefined && event.at - book.heardAt >= PENDING_MS ? settle(book) : book;
    case "disconnected":
    case "background":
      return settle(book);
  }
}

function settle(book: WakeBook): WakeBook {
  const { heardAt: _, ...rest } = book;
  return { ...rest, pending: false };
}
