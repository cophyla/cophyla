// Opus on the wire: a `voice.audio` frame with `codec: "opus"` carries several 20 ms
// packets at once, each behind its length as a little-endian u16, and the lot as base64.
// Both ends pack and unpack with these two, so the framing is written once; the file has
// no schema in it, so the phone can take it without the rest of the package.

/** One Opus packet's length is at most this; anything longer is not a packet. */
export const MAX_PACKET_BYTES = 4000;

/** Packets as one buffer: `[u16 LE length][bytes]` each, in order. */
export function packPackets(packets: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of packets) {
    if (p.length > MAX_PACKET_BYTES) throw new Error(`an Opus packet of ${p.length} bytes`);
    total += 2 + p.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of packets) {
    out[off] = p.length & 0xff;
    out[off + 1] = p.length >> 8;
    out.set(p, off + 2);
    off += 2 + p.length;
  }
  return out;
}

/** The packets back out; a buffer cut short or naming an impossible length throws. */
export function unpackPackets(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let off = 0;
  while (off < bytes.length) {
    if (off + 2 > bytes.length) throw new Error("an Opus frame cut short");
    const len = bytes[off]! | (bytes[off + 1]! << 8);
    off += 2;
    if (len === 0 || len > MAX_PACKET_BYTES || off + len > bytes.length) throw new Error("an Opus frame cut short");
    out.push(bytes.subarray(off, off + len));
    off += len;
  }
  return out;
}
