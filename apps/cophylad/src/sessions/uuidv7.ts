// UUIDv7: the ids Muse takes for its sessions and commands, and Codex gives its threads. The
// first 48 bits are the time the id was made, which tells when a thread was started.

/** A new UUIDv7. */
export function uuidv7(now: number = Date.now()): string {
  const r = crypto.getRandomValues(new Uint8Array(10));
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  const t = Math.max(0, Math.floor(now)).toString(16).padStart(12, "0").slice(-12);
  r[0] = (r[0]! & 0x0f) | 0x70;
  r[2] = (r[2]! & 0x3f) | 0x80;
  const rand = hex(r);
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-${rand.slice(0, 4)}-${rand.slice(4, 8)}-${rand.slice(8, 20)}`;
}

/** The time a UUIDv7 carries, in milliseconds; `undefined` for any other id (a Muse child's is a v4). */
export function uuidv7Time(id: string): number | undefined {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(id);
  if (!m) return undefined;
  return parseInt(m[1]! + m[2]!, 16);
}
