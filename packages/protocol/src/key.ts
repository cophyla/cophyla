// A browser's key: what a person reads off one screen and types into a browser on another
// computer to pair it. Ten random bytes as sixteen characters of Crockford's base32, shown in
// fours (`7KQ2-M9XF-3ZTA-B6WD`): no letter that reads as a digit, no case to get wrong. It is
// read back forgivingly: case, spaces and dashes are dropped, and the letters the alphabet
// leaves out are taken for the digits they look like. Good once, for a few minutes; the node
// keeps only its hash. Zod-free on purpose: the page uses it too.

/** Crockford's base32: the digits, then the letters without I, L, O and U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const KEY_BYTES = 10;
export const KEY_CHARS = 16;

/** Ten bytes as the sixteen characters, with no dashes: the form a key is hashed and compared in. */
export function encodeKey(bytes: Uint8Array): string {
  if (bytes.length !== KEY_BYTES) throw new Error(`a key is ${KEY_BYTES} bytes`);
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

/** A fresh key, from the platform's random source. */
export function newKey(random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  return encodeKey(random(new Uint8Array(KEY_BYTES)));
}

/** A key as it is shown: in fours. */
export function formatKey(key: string): string {
  return key.replace(/(.{4})(?=.)/g, "$1-");
}

/**
 * What was typed, as the sixteen characters, or nothing when it is no key: case, spaces and
 * dashes dropped, `O` read as `0`, `I` and `L` as `1`.
 */
export function parseKey(text: string): string | undefined {
  const typed = text.toUpperCase().replace(/[\s\-_.]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (typed.length !== KEY_CHARS) return undefined;
  for (const c of typed) if (!ALPHABET.includes(c)) return undefined;
  return typed;
}

/** The fragment a link carries a key in (`https://192.168.1.44:4818/#k=7KQ2-M9XF-3ZTA-B6WD`): never sent to a server, and cleared by the page that reads it. */
export const KEY_FRAGMENT = "k";

/** The link that carries `key` to the page at `address`. */
export function keyLink(address: string, key: string): string {
  return `${address.replace(/\/+$/, "")}/#${KEY_FRAGMENT}=${formatKey(key)}`;
}

/** The key a page's fragment carries (`location.hash`), as the sixteen characters; nothing when there is none. */
export function keyFromFragment(hash: string): string | undefined {
  const m = new RegExp(`^#?(?:.*&)?${KEY_FRAGMENT}=([^&]*)`).exec(hash);
  if (!m) return undefined;
  let value = m[1]!;
  try {
    value = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  return parseKey(value);
}
