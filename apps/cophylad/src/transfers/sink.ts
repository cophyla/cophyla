// The receiving end of a file's pipe: the bytes appended to the partial file, from where it
// stopped (`at`), or the file begun again from nothing. The pipe is held back while the disk
// is behind (the write stream past its high-water mark), so a slow disk slows the sender all
// the way back. How many bytes the pipe is to bring is known once the sending machine
// answered (`expect`); once they all came the end is complete, and a pipe that closed before
// is short, its partial kept for the next try.

import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import type { End } from "../remote/pipes.ts";

/** What the disk may be behind by before the pipe is held: twice a file pipe's window, so a window in flight never waits on it. */
const BEHIND = 2 * 1024 * 1024;

/** How a pipe into a sink ended: all its bytes came, it closed before, or the file could not be written. */
export type SinkOutcome = { kind: "complete" } | { kind: "short"; reason: string } | { kind: "error"; reason: string };

export class FileSinkEnd implements End {
  onRoom?: () => void;
  private out: WriteStream;
  /** Bytes this pipe brought. */
  received = 0;
  private want?: number;
  private settled = false;
  private resolve!: (o: SinkOutcome) => void;
  /** How the pipe ended; settles once. */
  readonly outcome: Promise<SinkOutcome>;
  private finished: Promise<void>;
  private onBytes: (n: number) => void;

  constructor(path: string, at: number, onBytes: (n: number) => void = () => undefined) {
    this.onBytes = onBytes;
    this.outcome = new Promise((r) => (this.resolve = r));
    // from nothing, the file is made or emptied; from `at`, the partial already holds that much
    this.out = createWriteStream(path, { flags: at > 0 ? "a" : "w", highWaterMark: BEHIND });
    this.finished = new Promise((r) => {
      this.out.once("close", () => r());
    });
    this.out.on("drain", () => this.onRoom?.());
    this.out.on("error", (e: Error) => this.settle({ kind: "error", reason: `the file could not be written: ${e.message}` }));
  }

  get room(): boolean {
    return !this.settled && !this.out.writableNeedDrain;
  }

  /** How many bytes the pipe is to bring, once the sending machine said: done at once when they came already. */
  expect(bytes: number): void {
    this.want = bytes;
    if (this.received >= bytes) this.settle({ kind: "complete" });
  }

  write(data: Uint8Array): void {
    if (this.settled) return;
    let piece = data;
    // never past what was asked for
    if (this.want !== undefined && this.received + piece.length > this.want) piece = piece.subarray(0, Math.max(0, this.want - this.received));
    if (piece.length === 0) return;
    this.received += piece.length;
    this.out.write(piece);
    this.onBytes(piece.length);
    if (this.want !== undefined && this.received >= this.want) this.settle({ kind: "complete" });
  }

  /** The pipe closed, from either side: short unless every byte came. */
  close(reason: string): void {
    if (this.want !== undefined && this.received >= this.want) this.settle({ kind: "complete" });
    else this.settle({ kind: "short", reason });
  }

  /** What was written reaches the disk and the file is closed; resolves once it is. */
  async finish(): Promise<void> {
    if (!this.settled) this.settle({ kind: "short", reason: "stopped" });
    if (!this.out.closed && !this.out.destroyed) this.out.end();
    await this.finished;
  }

  private settle(o: SinkOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(o);
  }
}
