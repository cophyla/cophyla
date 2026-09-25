import { describe, expect, test } from "bun:test";
import { FREE_ENTITLEMENT } from "@cophyla/protocol";
import { verifyEntitlement } from "../src/cloud/entitlement.ts";
import { ENTITLEMENT_KEYS } from "../src/cloud/keys.ts";
import { period, UsageCounters } from "../src/cloud/usage.ts";
import { Store } from "../src/store/index.ts";
import { PRO, serverKey, signEntitlement } from "./fakes/server.ts";
import type { Entitlement } from "@cophyla/protocol";

const NOW = Date.UTC(2026, 8, 21, 12);
const k = serverKey();
const keys = [{ kid: "fake-1", key: k.spki }];
const claims = (over: Partial<Entitlement> = {}): Entitlement => ({ subject: "usr_1", plan: "pro", issuedAt: NOW, expiresAt: NOW + 86400_000, graceSeconds: 604800, ...PRO, ...over });

describe("verifyEntitlement", () => {
  test("a token by the server's key is valid, then in grace, then free", () => {
    const token = signEntitlement(claims(), k.key, "fake-1");
    expect(verifyEntitlement(token, keys, NOW)).toEqual({ claims: claims(), status: "valid", kid: "fake-1" });
    expect(verifyEntitlement(token, keys, NOW + 86400_000 + 1).status).toBe("grace");
    expect(verifyEntitlement(token, keys, NOW + 86400_000 + 1).claims.plan).toBe("pro");
    const past = verifyEntitlement(token, keys, NOW + 86400_000 + 604800_000 + 1);
    expect(past.status).toBe("expired");
    expect(past.claims).toEqual(FREE_ENTITLEMENT);
  });

  test("a forged, tampered, wrongly signed or garbled token is the free plan", () => {
    const other = serverKey();
    expect(verifyEntitlement(signEntitlement(claims(), other.key, "fake-1"), keys, NOW)).toEqual({ claims: FREE_ENTITLEMENT, status: "invalid" });
    const token = signEntitlement(claims(), k.key, "fake-1");
    const [h, p, s] = token.split(".") as [string, string, string];
    const tampered = Buffer.from(JSON.stringify(claims({ limits: { ...PRO.limits, sessions: 99 } }))).toString("base64url");
    expect(verifyEntitlement(`${h}.${tampered}.${s}`, keys, NOW).status).toBe("invalid");
    expect(verifyEntitlement(`${h}.${p}.${s.slice(1)}`, keys, NOW).status).toBe("invalid");
    const hs = Buffer.from(JSON.stringify({ alg: "HS256", kid: "fake-1" })).toString("base64url");
    expect(verifyEntitlement(`${hs}.${p}.${s}`, keys, NOW).status).toBe("invalid");
    expect(verifyEntitlement("", keys, NOW).status).toBe("invalid");
    expect(verifyEntitlement("a.b", keys, NOW).status).toBe("invalid");
    expect(verifyEntitlement("not.a.jwt", keys, NOW).status).toBe("invalid");
    expect(verifyEntitlement(token, [], NOW).status).toBe("invalid");
    expect(verifyEntitlement(token, [{ kid: "fake-1", key: "garbage" }], NOW).status).toBe("invalid");
  });

  test("the kid is a hint: another entry in the list still verifies; a rotation ships both", () => {
    const next = serverKey();
    const token = signEntitlement(claims(), next.key, "fake-2");
    expect(verifyEntitlement(token, keys, NOW).status).toBe("invalid");
    const v = verifyEntitlement(token, [...keys, { kid: "fake-2", key: next.spki }], NOW);
    expect(v.status).toBe("valid");
    expect(v.kid).toBe("fake-2");
    const mislabelled = signEntitlement(claims(), k.key, "fake-9");
    expect(verifyEntitlement(mislabelled, keys, NOW).kid).toBe("fake-1");
  });

  test("the shipped key list names the production key", () => {
    expect(ENTITLEMENT_KEYS.length).toBeGreaterThanOrEqual(1);
    expect(ENTITLEMENT_KEYS[0]!.kid).toBe("ent-1");
    expect(Buffer.from(ENTITLEMENT_KEYS[0]!.key, "base64").length).toBe(44);
  });
});

describe("usage counters", () => {
  test("count locally per UTC month, take the server's report, and snapshot with cap 0 when unknown", () => {
    const store = new Store(":memory:");
    store.migrate();
    let now = NOW;
    const u = new UsageCounters(store, () => now);
    expect(period(NOW)).toBe("2026-09");
    u.add("llm_tokens_in", 100);
    u.add("llm_tokens_in", 50);
    u.add("stt_seconds", 0);
    expect(u.snapshot()).toEqual({ period: "2026-09", metrics: { llm_tokens_in: { used: 150, cap: 0 } } });
    u.reported({ period: "2026-09", metrics: { llm_tokens_in: { used: 1000, cap: 2_000_000 }, tts_chars: { used: 0, cap: 200_000 } } });
    expect(u.snapshot().metrics).toEqual({ llm_tokens_in: { used: 1000, cap: 2_000_000 }, tts_chars: { used: 0, cap: 200_000 } });
    u.add("llm_tokens_in", 7);
    expect(u.snapshot().metrics["llm_tokens_in"]).toEqual({ used: 1007, cap: 2_000_000 });
    now = Date.UTC(2026, 9, 2);
    expect(u.snapshot()).toEqual({ period: "2026-10", metrics: {} });
    u.clear();
    now = NOW;
    expect(u.snapshot().metrics).toEqual({});
    store.close();
  });
});
