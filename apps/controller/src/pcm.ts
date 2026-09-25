// Audio on the wire: base64 of little-endian int16 samples, which is what `voice.audio`
// carries in both directions. Browsers have no Buffer, so this is done by hand; a decoded
// frame is copied rather than viewed, because a base64 decode gives no alignment guarantee
// and an Int16Array over an odd offset throws.

/** Little-endian int16 samples as base64. */
export function encodeChunk(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true);
  let binary = "";
  // In chunks: `String.fromCharCode(...bytes)` blows the argument limit on a long frame.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Base64 back to samples; an odd length loses its last byte rather than throwing. */
export function decodeChunk(chunk: string): Int16Array {
  const binary = atob(chunk);
  const usable = binary.length - (binary.length % 2);
  const pcm = new Int16Array(usable / 2);
  for (let i = 0; i < pcm.length; i++) {
    const lo = binary.charCodeAt(i * 2) & 0xff;
    const hi = binary.charCodeAt(i * 2 + 1) & 0xff;
    pcm[i] = ((hi << 8) | lo) << 16 >> 16;
  }
  return pcm;
}

/** Samples as the floats an AudioBuffer holds. */
export function toFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768;
  return out;
}
