// A data channel carries messages of 16 KiB at most: what cophylad's helper takes, and what every
// WebRTC stack sends without fragmenting a message across its own limits. A tunnel record
// (base64 of one sealed frame) can be far larger, a terminal's repaint or a replica page, so
// it goes as pieces: each message is one marker character and a slice of the record, `+`
// while more follow and `=` on the last. The record is sealed before it is cut, so the helper
// between the two ends handles ciphertext only, and a piece lost, reordered or forged makes
// the reassembled record fail to open, which closes the channel.
//
//   message = ("+" | "=") | slice          slice = up to CHUNK_MAX - 1 characters of the record

/** The largest message on a data channel, in characters (a record is base64, so bytes too). */
export const CHUNK_MAX = 16 * 1024;
/** The largest record a reassembler takes: a 16 MiB frame, sealed and base64'd. */
export const RECORD_MAX = 24 * 1024 * 1024;

export class ChunkError extends Error {}

/** Cuts a record into messages of at most `max` characters, in order. */
export function chunk(record: string, max = CHUNK_MAX): string[] {
  const slice = max - 1;
  if (slice < 1) throw new ChunkError("a message must hold at least one character");
  if (record.length <= slice) return ["=" + record];
  const out: string[] = [];
  for (let at = 0; at < record.length; at += slice) {
    const end = at + slice;
    out.push((end >= record.length ? "=" : "+") + record.slice(at, end));
  }
  return out;
}

/** Puts records back together from their messages, one channel's worth, in order. */
export class Reassembler {
  private parts: string[] = [];
  private size = 0;
  private readonly maxRecord: number;

  constructor(maxRecord = RECORD_MAX) {
    this.maxRecord = maxRecord;
  }

  /** One message; a whole record once its last piece is in, `undefined` before. Throws on a malformed message or an oversized record. */
  push(message: string): string | undefined {
    const marker = message[0];
    if (marker !== "+" && marker !== "=") throw new ChunkError("a message without its marker");
    const slice = message.slice(1);
    this.size += slice.length;
    if (this.size > this.maxRecord) {
      this.parts = [];
      this.size = 0;
      throw new ChunkError(`a record over ${this.maxRecord} characters`);
    }
    if (marker === "+") {
      this.parts.push(slice);
      return undefined;
    }
    const record = this.parts.length === 0 ? slice : this.parts.join("") + slice;
    this.parts = [];
    this.size = 0;
    return record;
  }

  /** Characters held for a record not yet whole. */
  get pending(): number {
    return this.size;
  }
}
