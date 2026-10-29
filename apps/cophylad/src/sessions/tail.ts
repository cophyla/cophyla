// Reads a JSONL file from where the last read stopped. A partial trailing line waits for the
// next read, and a file that shrank (rotated, truncated) is read from the start again. A
// fresh tail reads the whole file, so a parser's state is whole, but says from which offset
// its lines are new to the record: the end of what an earlier tail recorded, or the last
// `replayBytes` of a file no tail has recorded, so history is recorded once.

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

/** Only this much of a transcript that predates the attach is recorded as events; the rest feeds stats and intent. */
export const REPLAY_BYTES = 256 * 1024;

/** When a file last changed; undefined when it cannot be read. */
export function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

export interface TailLine {
  text: string;
  /** Byte offset of the line's start, for callers that replay only the recent end of a file. */
  offset: number;
}

const NL = 0x0a;

/** How far back `lastLineWhere` reads by default, and how much at a time. */
const LAST_LINE_BYTES = 32 * 1024 * 1024;
const LAST_LINE_CHUNK = 1024 * 1024;

/**
 * The last complete line of a JSONL file that `match` takes, read back from the file's end a
 * chunk at a time, no further than `maxBytes` from it; `undefined` when none is, or the file
 * cannot be read. A line cut by the start of that window is not looked at.
 */
export function lastLineWhere(path: string, match: (text: string) => boolean, maxBytes = LAST_LINE_BYTES): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    const floor = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(Math.min(LAST_LINE_CHUNK, size - floor));
    // The start of a line whose beginning is further back than what has been read.
    let carry: Buffer = Buffer.alloc(0);
    let end = size;
    const take = (bytes: Buffer): string | undefined => {
      let to = bytes.length;
      if (to > 0 && bytes[to - 1] === 0x0d) to--;
      if (to === 0) return undefined;
      const text = bytes.subarray(0, to).toString("utf8");
      return match(text) ? text : undefined;
    };
    while (end > floor) {
      const start = Math.max(floor, end - buf.length);
      const want = end - start;
      for (let got = 0; got < want; ) {
        const n = readSync(fd, buf, got, want - got, start + got);
        if (n <= 0) return undefined;
        got += n;
      }
      const data = carry.length > 0 ? Buffer.concat([buf.subarray(0, want), carry]) : buf.subarray(0, want);
      let lineEnd = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== NL) continue;
        const hit = take(data.subarray(i + 1, lineEnd));
        if (hit !== undefined) return hit;
        lineEnd = i;
      }
      carry = Buffer.from(data.subarray(0, lineEnd));
      end = start;
    }
    // Read to the file's start, what is left is its first line.
    return end === 0 ? take(carry) : undefined;
  } finally {
    closeSync(fd);
  }
}

export class Tail {
  readonly path: string;
  private offset = 0;
  private partial: Buffer = Buffer.alloc(0);
  private partialStart = 0;
  /** The file's size when the tail was opened, so a first read can tell history from the recent end. */
  readonly initialSize: number;
  /** Lines starting here or later are recorded; earlier ones only feed the parser. */
  readonly recordFrom: number;

  /**
   * `recordedTo` is where an earlier tail of the same file stopped recording; one past the
   * file's size means the file shrank, and only the replay rule applies.
   */
  constructor(path: string, opts: { replayBytes?: number; recordedTo?: number } = {}) {
    this.path = path;
    this.initialSize = Tail.sizeOf(path);
    const replay = opts.replayBytes !== undefined && this.initialSize > opts.replayBytes ? this.initialSize - opts.replayBytes : 0;
    this.recordFrom = opts.recordedTo !== undefined && opts.recordedTo <= this.initialSize ? Math.max(replay, opts.recordedTo) : replay;
  }

  /** Where the next complete line starts: every line before it has been handed out. */
  get consumed(): number {
    return this.partial.length > 0 ? this.partialStart : this.offset;
  }

  /**
   * Whether the file holds a complete line past `offset`, or shrank below it: something wrote
   * to it after a tail stopped there. A partial line alone is not enough.
   */
  static lineAfter(path: string, offset: number): boolean {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return false;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < offset) return true;
      const buf = Buffer.alloc(64 * 1024);
      for (let at = offset; at < size; ) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - at), at);
        if (n <= 0) break;
        if (buf.subarray(0, n).includes(NL)) return true;
        at += n;
      }
      return false;
    } finally {
      closeSync(fd);
    }
  }

  static sizeOf(path: string): number {
    try {
      const fd = openSync(path, "r");
      try {
        return fstatSync(fd).size;
      } finally {
        closeSync(fd);
      }
    } catch {
      return 0;
    }
  }

  /** Everything appended since the last call, as complete lines. */
  read(): TailLine[] {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return [];
    }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        this.offset = 0;
        this.partial = Buffer.alloc(0);
        this.partialStart = 0;
      }
      if (size === this.offset) return [];
      const buf = Buffer.alloc(size - this.offset);
      let read = 0;
      while (read < buf.length) {
        const n = readSync(fd, buf, read, buf.length - read, this.offset + read);
        if (n <= 0) break;
        read += n;
      }
      const chunk = read === buf.length ? buf : buf.subarray(0, read);
      const startOffset = this.partial.length > 0 ? this.partialStart : this.offset;
      const data = this.partial.length > 0 ? Buffer.concat([this.partial, chunk]) : chunk;
      this.offset += read;

      const lines: TailLine[] = [];
      let lineStart = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== NL) continue;
        let end = i;
        if (end > lineStart && data[end - 1] === 0x0d) end--;
        if (end > lineStart) lines.push({ text: data.subarray(lineStart, end).toString("utf8"), offset: startOffset + lineStart });
        lineStart = i + 1;
      }
      if (lineStart < data.length) {
        this.partial = Buffer.from(data.subarray(lineStart));
        this.partialStart = startOffset + lineStart;
      } else {
        this.partial = Buffer.alloc(0);
        this.partialStart = 0;
      }
      return lines;
    } finally {
      closeSync(fd);
    }
  }
}
