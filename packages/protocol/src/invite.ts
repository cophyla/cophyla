// An invite: how a new phone or node gets a grant of its own without any account. The primary
// mints it as text to paste or a link to open (the same bytes behind a QR code), good until
// `expiresAt` and for one redemption. It names the grant it redeems and carries the one-use
// secret that proves the bearer holds the invite, and the ways to reach the node that minted
// it: its LAN listener pinned by the key's hash, and the server relay, through a throwaway
// peer of its own so the real credential is minted fresh at redemption.
//
//   text = "cophyla-invite:" base64url(json)          link = "cophyla://invite?i=" base64url(json)

import { z } from "zod";
import { GrantKind } from "./entities.ts";
import { GrantRef, NodeId, Timestamp } from "./ids.ts";

export const INVITE_TEXT_PREFIX = "cophyla-invite:";
export const INVITE_LINK_PREFIX = "cophyla://invite?i=";
/** The name a node invite carries when the user gave the machine none: never taken for its name. */
export const UNNAMED_NODE = "new node";

/** 32 bytes as hex. */
export const Secret = z.string().regex(/^[0-9a-f]{64}$/, { message: "expected 32 bytes as hex" });

export const InviteBody = z.object({
  v: z.literal(1),
  kind: GrantKind,
  /** The pending grant the invite redeems: a phone's controller id, a node's `grt_` id. */
  grant: GrantRef,
  /** The one-use secret, 32 bytes as hex: the enrollment's key, and never stored where it was minted. */
  secret: Secret,
  expiresAt: Timestamp,
  /** The node that minted it, so the one redeeming can say where it is going. */
  node: z.object({ id: NodeId, name: z.string() }),
  /** Its LAN listener: the addresses to try, the port, and the SHA-256 of its key (SPKI, base64). */
  lan: z.object({ hosts: z.array(z.string().min(1)).min(1), port: z.number().int().min(1).max(65535), spki: z.string().min(1) }).optional(),
  /** The server relay: its origin, the invite's own throwaway peer and that peer's relay token. */
  relay: z.object({ url: z.string().min(1), peer: GrantRef, token: z.string().min(1) }).optional(),
});
export type InviteBody = z.infer<typeof InviteBody>;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

function toBase64Url(text: string): string {
  const bytes = utf8.encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new InviteError("an invite is base64url");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const s = atob(padded);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return fromUtf8.decode(bytes);
}

export class InviteError extends Error {}

/** The invite as text to paste. */
export function inviteText(body: InviteBody): string {
  return INVITE_TEXT_PREFIX + toBase64Url(JSON.stringify(body));
}

/** The invite as a link the phone app opens: what the QR code holds. */
export function inviteLink(body: InviteBody): string {
  return INVITE_LINK_PREFIX + toBase64Url(JSON.stringify(body));
}

/**
 * An invite read back from its text or its link, with whatever whitespace or line breaks a
 * paste brought along; throws `InviteError` on anything else. Expiry is the redeemer's to
 * check against its own clock, and the minter's against its own.
 */
export function parseInvite(input: string): InviteBody {
  const compact = input.replace(/\s+/g, "");
  let payload: string | undefined;
  if (compact.startsWith(INVITE_TEXT_PREFIX)) payload = compact.slice(INVITE_TEXT_PREFIX.length);
  else if (compact.startsWith(INVITE_LINK_PREFIX)) payload = compact.slice(INVITE_LINK_PREFIX.length);
  else {
    const i = compact.match(/^cophyla:\/\/invite\?(?:.*&)?i=([^&#]*)/);
    if (i) payload = i[1];
  }
  if (payload === undefined || payload.length === 0) throw new InviteError("not a Cophyla invite");
  let json: unknown;
  try {
    json = JSON.parse(fromBase64Url(payload));
  } catch (e) {
    throw e instanceof InviteError ? e : new InviteError("the invite is damaged");
  }
  const parsed = InviteBody.safeParse(json);
  if (!parsed.success) throw new InviteError("the invite is damaged or from another version");
  return parsed.data;
}
