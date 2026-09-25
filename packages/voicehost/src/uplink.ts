// The microphone's frames on their way up: each numbered, so the node can count the ones
// that never came, and dropped here instead of queued when the link already holds more
// than it has sent. Late audio is worth less than the next frame: a frame queued behind a
// backlog arrives after the moment it belongs to, and delays every frame after it.

import type { AudioCodec } from "@cophyla/protocol";

/** Bytes the link may hold unsent before a frame is dropped rather than queued behind them. */
export const SHED_BYTES = 32 * 1024;

export interface UplinkDeps {
  /** Bytes the link has not yet put on the wire. */
  backlog: () => number;
  send: (params: { chunk: string; codec: AudioCodec; seq: number }) => void;
  shedBytes?: number;
}

export class Uplink {
  private deps: UplinkDeps;
  private seq = 0;
  readonly counts = { sent: 0, shed: 0, opus: 0, pcm: 0 };

  constructor(deps: UplinkDeps) {
    this.deps = deps;
  }

  /** One frame up; false when it was shed. A shed frame still takes its number, so the node sees the gap. */
  frame(chunk: string, codec: AudioCodec): boolean {
    const seq = this.seq++;
    if (this.deps.backlog() > (this.deps.shedBytes ?? SHED_BYTES)) {
      this.counts.shed++;
      return false;
    }
    this.counts.sent++;
    this.counts[codec]++;
    this.deps.send({ chunk, codec, seq });
    return true;
  }
}
