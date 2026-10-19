// Checking another user's identity here: the token their server link got from the server
// (`identity.attest`), a JWT signed EdDSA with the entitlement key, whose claims say
// `typ: cophyla-identity`, the account, its GitHub login and the audience it is bound to.
// A connection's redemption trades two of them, each bound to the invite and to which end
// speaks, so one says nothing in any other exchange. Checked against the same key list the
// platform ships for entitlements; an entitlement never parses as one, nor one as it.

import { createPublicKey, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { IdentityClaims, RpcError } from "@cophyla/protocol";
import type { EntitlementKey } from "./keys.ts";

export interface VerifiedIdentity {
  subject: string;
  login: string;
}

function publicKey(spki: string): KeyObject | undefined {
  try {
    return createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
  } catch {
    return undefined;
  }
}

/** Who the token says, when it checks against one of `keys`, names `aud` and has not run out at `now`; throws `denied` otherwise. */
export function verifyIdentity(token: string, keys: EntitlementKey[], aud: string, now: number): VerifiedIdentity {
  const refuse = (why: string) => new RpcError("denied", `the other side's identity ${why}`);
  const parts = token.split(".");
  if (parts.length !== 3) throw refuse("is not a token");
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: unknown; kid?: unknown };
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: unknown; kid?: unknown };
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    throw refuse("is not a token");
  }
  if (header.alg !== "EdDSA") throw refuse("is not signed as the server signs");
  const sig = Buffer.from(s, "base64url");
  if (sig.length !== 64) throw refuse("is not signed as the server signs");
  const data = Buffer.from(`${h}.${p}`, "utf8");
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const ordered = [...keys.filter((k) => k.kid === kid), ...keys.filter((k) => k.kid !== kid)];
  let matched = false;
  for (const k of ordered) {
    const key = publicKey(k.key);
    if (!key) continue;
    try {
      if (verify(null, data, key, sig)) {
        matched = true;
        break;
      }
    } catch {
      // a malformed key is a failed check, not an error
    }
  }
  if (!matched) throw refuse("is not the server's");
  const claims = IdentityClaims.safeParse(payload);
  if (!claims.success) throw refuse("is not an identity");
  const c = claims.data;
  if (c.aud !== aud) throw refuse("was made for another exchange");
  if (now >= c.exp) throw refuse("has run out");
  return { subject: c.sub, login: c.login };
}
