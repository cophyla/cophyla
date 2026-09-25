// Checking an entitlement token here, on the node: the JWT the server signs (EdDSA over
// `header.payload`), its claims the protocol's `Entitlement`, against the key list the
// platform ships. The daemon verifies so `account.state` shows the free plan for a forged or
// long-expired row; the brain verifies again on its own, since the token is what it acts on.
// The rule is the server's: valid before `expiresAt`, in grace for `graceSeconds` after,
// free past that or when anything does not check.

import { createPublicKey, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { Entitlement, FREE_ENTITLEMENT } from "@cophyla/protocol";
import type { EntitlementKey } from "./keys.ts";

export type EntitlementStatus = "valid" | "grace" | "expired" | "invalid";

export interface VerifiedEntitlement {
  claims: Entitlement;
  status: EntitlementStatus;
  kid?: string;
}

function publicKey(spki: string): KeyObject | undefined {
  try {
    return createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
  } catch {
    return undefined;
  }
}

/** The token's claims when it checks against one of `keys`, judged at `now`; the free entitlement otherwise. */
export function verifyEntitlement(token: string, keys: EntitlementKey[], now: number): VerifiedEntitlement {
  const invalid: VerifiedEntitlement = { claims: FREE_ENTITLEMENT, status: "invalid" };
  const parts = token.split(".");
  if (parts.length !== 3) return invalid;
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: unknown; kid?: unknown };
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: unknown; kid?: unknown };
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return invalid;
  }
  if (header.alg !== "EdDSA") return invalid;
  const sig = Buffer.from(s, "base64url");
  if (sig.length !== 64) return invalid;
  const data = Buffer.from(`${h}.${p}`, "utf8");
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const ordered = [...keys.filter((k) => k.kid === kid), ...keys.filter((k) => k.kid !== kid)];
  let matched: EntitlementKey | undefined;
  for (const k of ordered) {
    const key = publicKey(k.key);
    if (!key) continue;
    try {
      if (verify(null, data, key, sig)) {
        matched = k;
        break;
      }
    } catch {
      // a malformed key is a failed check, not an error
    }
  }
  if (!matched) return invalid;
  const claims = Entitlement.safeParse(payload);
  if (!claims.success) return invalid;
  const c = claims.data;
  if (now < c.expiresAt) return { claims: c, status: "valid", kid: matched.kid };
  if (now < c.expiresAt + c.graceSeconds * 1000) return { claims: c, status: "grace", kid: matched.kid };
  return { claims: FREE_ENTITLEMENT, status: "expired", kid: matched.kid };
}
