// The kit the daemon hands its sign-in door, built from a home on disk: the membership with
// its key, the primary and backups alone of the registry, the host's credentials (the
// configured pair over the kept one), the paired machines once each, and the flags that open
// no door. And the small rules beside it: why a kit opens no door, whom a door lets in, the
// primary's protocol read from its refusal, the release a door moves to, the words for an
// administrator's prompt that went wrong, and Windows' quoting of an argument.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { NodeRecord, Release } from "@cophyla/protocol";
import { Config } from "../src/config/schema.ts";
import { KIT_TTL_MS } from "../src/door/constants.ts";
import { elevationError, quoteArg } from "../src/door/elevate.ts";
import { buildKit, hostCredentials, kitRefusal, sameKit } from "../src/door/kit.ts";
import type { Kit, KitSources } from "../src/door/kit.ts";
import { doorAllows, refusedProtocol } from "../src/door/link.ts";
import { pickRelease } from "../src/door/program.ts";
import { removeHome, tempHome } from "./helpers.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) removeHome(h);
});

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const PRIMARY = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER = "node_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const KEY = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

function row(id: string, role: "primary" | "secondary", extra: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id,
    name: id.slice(-4),
    role,
    status: "online",
    via: "direct",
    platform: "windows",
    scope: { kind: "machine" },
    capabilities: { harnesses: [], voice: { wake: false, stt: false, tts: false }, remote: true, brain: role === "primary" },
    versions: { platform: "0.22.0", protocol: 1 },
    lastSeen: 1,
    endpoints: ["192.168.1.44:4818"],
    ...extra,
  };
}

function home(opts: { hostJson?: boolean } = {}): { dir: string; sources: KitSources } {
  const dir = tempHome();
  homes.push(dir);
  const data = join(dir, "data");
  mkdirSync(join(data, "remote"), { recursive: true });
  writeFileSync(join(data, "link.json"), JSON.stringify({ v: 1, grant: "grt_01ARZ3NDEKTSV4RRFFQ69G5FD1", key: KEY, cluster: "9f86d081884c7d65", role: "full", via: "join", primary: { id: PRIMARY, name: "desk" }, endpoints: ["192.168.1.44:4818"], relay: { url: "https://orc.example", token: "rly_x" } }));
  if (opts.hostJson !== false) writeFileSync(join(data, "remote", "host.json"), JSON.stringify({ username: "cophyla", password: "kept-pw" }));
  const config = Config.parse({});
  const sources: KitSources = {
    node: () => ({ id: NODE, name: "laptop" }),
    linkFile: join(data, "link.json"),
    remoteDir: join(data, "remote"),
    config,
    role: () => "secondary",
    hands: () => false,
    confined: () => false,
    registry: () => [row(PRIMARY, "primary"), row(NODE, "secondary"), row(OTHER, "secondary", { backup: true, rank: 1 })],
    epoch: () => 3,
    lastPrimary: () => ({ id: PRIMARY, epoch: 3, endpoints: ["192.168.1.44:4818"] }),
    hostKind: () => "none",
    display: () => ({ width: 1920, height: 1080 }),
    sharing: () => true,
    directEnabled: () => true,
    machines: () => [PRIMARY, PRIMARY, OTHER],
    platform: { version: "0.22.0", protocol: 1 },
    now: () => 5000,
  };
  return { dir, sources };
}

describe("buildKit", () => {
  test("the membership with its key, the primary and backups alone, the kept credentials, the machines once each", () => {
    const { sources } = home();
    const kit = buildKit(sources)!;
    expect(kit.link.key).toBe(KEY);
    expect(kit.registry.map((r) => r.id)).toEqual([PRIMARY, OTHER]);
    // the host's kind is Apollo while the desktop module has not said it yet
    expect(kit.host).toEqual({ kind: "apollo", username: "cophyla", password: "kept-pw" });
    expect(kit.machines).toEqual([PRIMARY, OTHER]);
    expect(kit.display).toEqual({ width: 1920, height: 1080 });
    expect(kit.attachedAt).toBe(5000);
    expect(kit.direct.enabled).toBe(true);
    expect(kitRefusal(kit, 5000)).toBeUndefined();
  });

  test("no membership, no kit; no credentials, a kit that says so", () => {
    const { dir, sources } = home({ hostJson: false });
    expect(buildKit(sources)!.host).toBeUndefined();
    expect(kitRefusal(buildKit(sources), 5000)).toBe("the desktop host's credentials are not known");
    expect(buildKit({ ...sources, linkFile: join(dir, "data", "missing.json") })).toBeUndefined();
    expect(kitRefusal(undefined, 0)).toMatch(/not been handed/);
  });

  test("the configured pair wins over the kept one", () => {
    const { sources } = home();
    expect(hostCredentials({ host_user: "me", host_password: "mine" }, sources.remoteDir)).toEqual({ username: "me", password: "mine" });
  });

  test("what opens no door: confined, the primary, sharing off, a grant ended, a month without Cophyla; a hands node's does", () => {
    const { sources } = home();
    const kit = buildKit(sources)!;
    const refused = (k: Partial<Kit>, now = 5000) => kitRefusal({ ...kit, ...k }, now);
    expect(refused({ hands: true })).toBeUndefined();
    expect(refused({ confined: true })).toMatch(/folders alone/);
    expect(refused({ primary: true })).toMatch(/the primary/);
    expect(refused({ sharing: false })).toMatch(/sharing is off/);
    expect(refused({ link: { ...kit.link, expiresAt: 4000 } })).toMatch(/grant has ended/);
    expect(refused({}, 5000 + KIT_TTL_MS + 1)).toMatch(/30 days/);
  });

  test("two kits made at different times are the same kit", () => {
    const { sources } = home();
    const a = buildKit(sources)!;
    const b = buildKit({ ...sources, now: () => 9999 })!;
    expect(sameKit(a, b)).toBe(true);
    expect(sameKit(a, { ...b, sharing: false })).toBe(false);
  });
});

describe("doorAllows", () => {
  test("the user's own phones and browsers, never a shared computer's session", () => {
    expect(doorAllows({ kind: "phone", grant: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC8" }, []).decision).toBe("allow");
    expect(doorAllows({ kind: "phone", browser: true }, []).why).toMatch(/browsers/);
    expect(doorAllows({ kind: "phone", session: true }, []).decision).toBe("deny");
  });
  test("a machine that paired a viewer with this desktop, and no other", () => {
    expect(doorAllows({ kind: "machine", node: PRIMARY }, [PRIMARY]).decision).toBe("allow");
    const other = doorAllows({ kind: "machine", node: OTHER }, [PRIMARY]);
    expect(other.decision).toBe("deny");
    expect(other.why).toMatch(/pair it while someone is signed in/);
  });
  test("no one unknown", () => {
    expect(doorAllows(undefined, [PRIMARY]).decision).toBe("deny");
  });
});

describe("the door's updates", () => {
  const rel = (version: string, protocol?: { min: number; max: number }): Release => ({ component: "platform", version, channel: "stable", os: "windows", arch: "x64", url: "https://x/p.tar.gz", size: 1, sha256: "0".repeat(64), signature: "ed25519:x", ...(protocol ? { protocol } : {}) }) as Release;
  const feed = [rel("0.21.0"), rel("0.22.0", { min: 1, max: 1 }), rel("0.23.0", { min: 2, max: 2 }), rel("0.24.0", { min: 2, max: 3 })];
  test("the daemon's version, never an older one nor a broken one", () => {
    expect(pickRelease(feed, "0.21.0", { version: "0.22.0" }, () => false)?.version).toBe("0.22.0");
    expect(pickRelease(feed, "0.22.0", { version: "0.21.0" }, () => false)).toBeUndefined();
    expect(pickRelease(feed, "0.21.0", { version: "0.22.0" }, (v) => v === "0.22.0")).toBeUndefined();
  });
  test("the newest that speaks the primary's protocol", () => {
    expect(pickRelease(feed, "0.21.0", { protocol: 2 }, () => false)?.version).toBe("0.24.0");
    expect(pickRelease(feed, "0.21.0", { protocol: 1 }, () => false)?.version).toBe("0.22.0");
    expect(pickRelease(feed, "0.21.0", { protocol: 9 }, () => false)).toBeUndefined();
  });
  test("the primary's protocol, from its refusal of ours", () => {
    expect(refusedProtocol(new RpcError("unsupported", "protocol 1 is not 2"))).toBe(2);
    expect(refusedProtocol(new RpcError("unsupported", "the primary is older than the sign-in door: update it"))).toBeUndefined();
    expect(refusedProtocol(new Error("protocol 1 is not 2"))).toBeUndefined();
  });
});

describe("the administrator's prompt", () => {
  test("declined, failed with words, failed without", () => {
    expect(elevationError({ code: 1223 })).toBe("the administrator prompt was declined");
    expect(elevationError({ code: 0, result: { ok: true } })).toBeUndefined();
    expect(elevationError({ code: 0 })).toBeUndefined();
    expect(elevationError({ code: 1, result: { ok: false, error: "ProgramData\\Cophyla Door is owned by someone else" } })).toMatch(/owned by someone else/);
    expect(elevationError({ code: 5 })).toBe("it needs an administrator");
    expect(elevationError({ code: 7 })).toBe("the door's installer failed (exit 7)");
  });
  test("Windows' quoting of one argument", () => {
    expect(quoteArg("install")).toBe("install");
    expect(quoteArg("C:\\Users\\me\\AppData\\Local\\Cophyla\\versions\\0.22.0")).toBe("C:\\Users\\me\\AppData\\Local\\Cophyla\\versions\\0.22.0");
    expect(quoteArg("C:\\Program Files\\x")).toBe('"C:\\Program Files\\x"');
    expect(quoteArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
    expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteArg("")).toBe('""');
  });
});
