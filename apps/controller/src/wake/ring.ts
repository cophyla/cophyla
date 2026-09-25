// The last few microphone frames, numbered. The worker scores a frame a moment after it was
// captured, so by the time it says it heard the word the page has captured more; those are
// the first of what the user says next, and go up right after `voice.wake`.

export interface NumberedFrame {
  seq: number;
  pcm: Int16Array;
}

/** Eight 40 ms frames: the worker's lag on a slow phone, with room to spare. */
export const RING_FRAMES = 8;

export class FrameRing {
  private frames: NumberedFrame[] = [];
  private size: number;

  constructor(size = RING_FRAMES) {
    this.size = size;
  }

  push(seq: number, pcm: Int16Array): void {
    this.frames.push({ seq, pcm });
    if (this.frames.length > this.size) this.frames.shift();
  }

  /** The frames captured after `seq`, oldest first. */
  after(seq: number): NumberedFrame[] {
    return this.frames.filter((f) => f.seq > seq);
  }

  clear(): void {
    this.frames = [];
  }
}
