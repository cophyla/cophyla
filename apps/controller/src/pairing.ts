// The controller's credential: the token it got for a pairing code (or for signing in with
// the account, or for an invite from the desktop), the node's addresses, the relay access
// when the node minted one, and, in the native app, the node's pinned key.
// In the browser it lives in the page's own storage — the one place in the system where a
// client-protocol credential lives in web content, and deliberate: a browser has no native
// side to hold it, the token is this controller's alone, and the desktop can revoke it. The
// native app keeps the same shape in its preferences, behind the same store interface.

import { InviteError, parseInvite } from "@cophyla/protocol";
import type { InviteBody, PairedLan, RelayAccess } from "@cophyla/protocol";

export const STORAGE_KEY = "cophyla.controller";

/** The node as the native app reaches it on the LAN: the host and port typed at pairing, and the SPKI hash of the key it pinned then. */
export interface NodeAddress {
  host: string;
  port: number;
  spki?: string;
}

export interface Credential {
  token: string;
  /** The controller id the node gave it, so `controller.revoke` can name itself. */
  controller: string;
  name: string;
  /** The LAN socket URLs the node answered on, tried first. */
  lan?: string[];
  /** What the server relay needs, when the node could mint it: tried when the LAN is out of reach. */
  relay?: RelayAccess;
  node?: NodeAddress;
}

export interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Where the credential lives: sync in the browser, async in the native app; the link core waits on either. */
export interface CredentialStore {
  read(): Promise<Credential | undefined>;
  write(credential: Credential): Promise<void>;
  forget(): Promise<void>;
}

function parse(raw: string | null): Credential | undefined {
  try {
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<Credential>;
    if (typeof value.token !== "string" || typeof value.controller !== "string") return undefined;
    const out: Credential = { token: value.token, controller: value.controller, name: typeof value.name === "string" ? value.name : "this phone" };
    if (Array.isArray(value.lan)) out.lan = value.lan.filter((u): u is string => typeof u === "string");
    if (value.relay && typeof value.relay === "object" && typeof value.relay.url === "string" && typeof value.relay.token === "string" && typeof value.relay.key === "string" && typeof value.relay.peer === "string") {
      out.relay = { url: value.relay.url, peer: value.relay.peer, token: value.relay.token, key: value.relay.key };
    }
    if (value.node && typeof value.node === "object" && typeof value.node.host === "string" && typeof value.node.port === "number") {
      out.node = { host: value.node.host, port: value.node.port, ...(typeof value.node.spki === "string" ? { spki: value.node.spki } : {}) };
    }
    return out;
  } catch {
    return undefined;
  }
}

export function readCredential(storage: Storage): Credential | undefined {
  return parse(storage.getItem(STORAGE_KEY));
}

export function writeCredential(storage: Storage, credential: Credential): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(credential));
}

export function forgetCredential(storage: Storage): void {
  storage.removeItem(STORAGE_KEY);
}

/** A store over the browser's synchronous storage. */
export function syncStore(storage: Storage): CredentialStore {
  return {
    read: async () => readCredential(storage),
    write: async (c) => writeCredential(storage, c),
    forget: async () => forgetCredential(storage),
  };
}

/** A store over an async key-value seam: the native app's preferences. */
export function asyncStore(kv: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> }): CredentialStore {
  return {
    read: async () => parse(await kv.get(STORAGE_KEY)),
    write: (c) => kv.set(STORAGE_KEY, JSON.stringify(c)),
    forget: () => kv.remove(STORAGE_KEY),
  };
}

// --- one preference beside it: the listen switch -------------------------------------------------

/** Where the page remembers that the user turned listening off; nothing is stored while it is on. */
export const LISTEN_KEY = "cophyla.controller.listen";

/** Listening for the wake word while the app is open: on, unless the user turned it off in the menu. */
export function readListen(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(LISTEN_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeListen(storage: Pick<Storage, "setItem" | "removeItem"> | undefined, on: boolean): void {
  try {
    if (on) storage?.removeItem(LISTEN_KEY);
    else storage?.setItem(LISTEN_KEY, "off");
  } catch {
    // a page that cannot store it still listens as asked until it is closed
  }
}

/** Six digits from what the user typed, or from `?code=`; spaces and dashes are theirs to type. */
export function parseCode(input: string): string | undefined {
  const digits = input.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : undefined;
}

/** The code in the page's own URL, when the phone opened the link rather than typing. */
export function codeFromUrl(search: string): string | undefined {
  try {
    const value = new URLSearchParams(search).get("code");
    return value ? parseCode(value) : undefined;
  } catch {
    return undefined;
  }
}

/** `host:port` as typed in the native app's pairing form; the port defaults to the controller listener's. */
export function parseAddress(input: string, defaultPort = 4818): NodeAddress | undefined {
  const text = input.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!text) return undefined;
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(text);
  if (!m) return undefined;
  const host = m[1]!;
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!(port > 0 && port < 65536)) return undefined;
  return { host, port };
}

/** The native app's LAN address and pin from what `pair.account` answered: the node's listener as the node itself named it. */
export function nodeFromLan(lan: PairedLan): NodeAddress {
  return { host: lan.host, port: lan.port, spki: lan.spki };
}

// --- the sign-in with the account (12.1) -------------------------------------------------------

/** Where the app's sign-in comes back: the page on the server opens this with `?grant=`. */
export const PAIR_LINK = "cophyla://pair";

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** PKCE (S256): the verifier the phone keeps and the challenge the sign-in URL carries. */
export async function pkcePair(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(random(32));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64url(digest) };
}

/** The server's sign-in page for a challenge. */
export function signInUrl(server: string, challenge: string): string {
  return `${server.replace(/\/$/, "")}/pair?challenge=${encodeURIComponent(challenge)}`;
}

/** The grant in `cophyla://pair?grant=…`, or undefined for any other link. */
export function parsePairLink(url: string): string | undefined {
  const m = /^cophyla:\/\/pair\/?\?([^#]*)/.exec(url.trim());
  if (!m) return undefined;
  const grant = new URLSearchParams(m[1]).get("grant");
  return grant && /^[A-Za-z0-9_-]{8,}$/.test(grant) ? grant : undefined;
}

// --- an invite from the desktop (grants) --------------------------------------------------------

/** How far the phone's clock may run ahead of the node's before an invite is called run out here. */
export const INVITE_CLOCK_SLACK_MS = 5 * 60_000;

/**
 * A phone's invite from what was pasted or the link that opened the app (`cophyla-invite:…`,
 * `cophyla://invite?i=…`). Throws a word for the user on anything else: not an invite, a
 * damaged one, a computer's, one that ran out, one that names no way to its node. The node
 * checks it again; this only spares the user a trip.
 */
export function parseInviteLink(input: string, now = Date.now()): InviteBody {
  let body: InviteBody;
  try {
    body = parseInvite(input);
  } catch (e) {
    throw new Error(e instanceof InviteError ? `${e.message}: copy it again from the desktop` : "not a Cophyla invite");
  }
  if (body.kind !== "controller") throw new Error("that invite is for a computer: run `cophylad join` on the machine it is for");
  if (body.expiresAt + INVITE_CLOCK_SLACK_MS <= now) throw new Error("that invite has run out: ask the desktop for a new one");
  if (!body.lan && !body.relay) throw new Error("that invite names no way to its node");
  return body;
}

/**
 * The node's LAN listener as an invite names it, one address per host the phone could reach:
 * each pinned to the invite's key, the node's own loopback left out (on the phone it is the
 * phone), an IPv6 host in brackets.
 */
export function inviteLanNodes(invite: Pick<InviteBody, "lan">): NodeAddress[] {
  const lan = invite.lan;
  if (!lan) return [];
  return lan.hosts
    .filter((h) => h !== "127.0.0.1" && h !== "localhost" && h !== "::1")
    .map((h) => ({ host: h.includes(":") && !h.startsWith("[") ? `[${h}]` : h, port: lan.port, spki: lan.spki }));
}

/** Whether a link that opened the app is an invite, whole or not. */
export function isInviteLink(url: string): boolean {
  return /^cophyla:\/\/invite(?:[/?#]|$)/.test(url.trim());
}

/** A sign-in the app started: the verifier, kept until the grant comes back, and when. */
export interface PendingSignIn {
  verifier: string;
  startedAt: number;
}

/** How long a started sign-in waits for its grant: the server's own window for the browser. */
export const SIGN_IN_TTL_MS = 10 * 60_000;

/** A name the user will recognise in the desktop's list, guessed from the browser. */
export function guessName(userAgent: string): string {
  const ua = userAgent || "";
  const model = /Android[^;)]*;\s*([^;)]+?)\s*(?:Build|\))/.exec(ua)?.[1]?.trim();
  if (model && model.toLowerCase() !== "k") return model;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux";
  return "a browser";
}
