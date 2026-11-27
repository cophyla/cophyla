// When a microphone frame was captured, on the wall clock. The worklet stamps each frame with
// the audio clock (the capture context's time as the frame ended); the page turns that into
// epoch milliseconds as the frame arrives. A frame never arrives before it was captured, so the
// least gap seen between arrival and capture is the offset between the two clocks, and a page
// too busy to take its frames as they come still knows when each was captured. The two clocks
// drift apart a little, so the least gap is let rise slowly; a capture started again, or a
// context resumed after it was suspended, starts the count over (`reset`). DOM-free.

/** How fast the offset may rise, in milliseconds per second: well past any two clocks' drift. */
export const DRIFT_MS_PER_S = 1;

export class CaptureClock {
  /** Wall milliseconds less audio milliseconds, as far as the frames so far say. */
  private offset?: number;
  private lastArrival = 0;

  /** The wall time of a frame that ended at `audioS` on the audio clock and arrived at `arrived`. */
  wall(audioS: number, arrived: number): number {
    const gap = arrived - audioS * 1000;
    if (this.offset === undefined || gap <= this.offset) this.offset = gap;
    else this.offset = Math.min(gap, this.offset + (Math.max(0, arrived - this.lastArrival) / 1000) * DRIFT_MS_PER_S);
    this.lastArrival = arrived;
    return audioS * 1000 + this.offset;
  }

  /** The wall time of a moment on the audio clock, once a frame has set the offset. */
  at(audioS: number): number | undefined {
    return this.offset === undefined ? undefined : audioS * 1000 + this.offset;
  }

  reset(): void {
    this.offset = undefined;
    this.lastArrival = 0;
  }
}
