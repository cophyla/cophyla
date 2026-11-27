// The last microphone frames, numbered, with when each was captured. The worker scores a frame
// a moment after it was captured, so by the time it says it heard the word the page has
// captured more; those are the first of what the user says next, and go up right after
// `voice.wake`. A press handled late (a busy page, a talk key that took its time) begins where
// the user pressed: the frames captured since then go up first, so the ring keeps ten seconds,
// and marks the ones that already went up, which are not sent twice.

export interface NumberedFrame {
  seq: number;
  pcm: Int16Array;
  /** When its last sample was captured, epoch ms; 0 when unknown. */
  at: number;
  /** It went up to the node. */
  sent?: boolean;
}

/** One frame's length, in milliseconds. */
export const FRAME_MS = 40;
/** How far back a press may begin: ten seconds of 40 ms frames. */
export const RING_FRAMES = 250;

export class FrameRing {
  private frames: NumberedFrame[] = [];
  private size: number;

  constructor(size = RING_FRAMES) {
    this.size = size;
  }

  push(seq: number, pcm: Int16Array, at = 0): NumberedFrame {
    const frame: NumberedFrame = { seq, pcm, at };
    this.frames.push(frame);
    if (this.frames.length > this.size) this.frames.shift();
    return frame;
  }

  /** The frames captured after `seq`, oldest first. */
  after(seq: number): NumberedFrame[] {
    return this.frames.filter((f) => f.seq > seq);
  }

  /** The frames with any audio captured after `at`, epoch ms, oldest first. */
  since(at: number): NumberedFrame[] {
    return this.frames.filter((f) => f.at > at);
  }

  /** The newest frame. */
  get last(): NumberedFrame | undefined {
    return this.frames.at(-1);
  }

  /** The newest frame that began before `at` and went up. */
  lastSentBefore(at: number): NumberedFrame | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (f.sent && f.at - FRAME_MS < at) return f;
    }
    return undefined;
  }

  clear(): void {
    this.frames = [];
  }
}
