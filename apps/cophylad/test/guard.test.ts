// The LAN listener's guard as pure functions: which peers are served (loopback, a private
// subnet this machine is on, a configured range, IPv4 inside an IPv6 socket), which `Host`
// names are this machine's, which `Origin` a socket may come from, the headers the app's files
// go out with, and the limiter of pairing misses per address.

import { describe, expect, test } from "bun:test";
import { appHeaders, attachedSubnets, badNetwork, formatAddress, Guard, hostName, inCidr, isLoopback, isPrivate, judge, loopbackName, nameAllowed, originKind, PairLimiter, parseAddress, parseCidr, parseNetworks, peerAllowed, rangeFor } from "../src/api/guard.ts";
import type { GuardRequest, GuardRules } from "../src/api/guard.ts";

type Interfaces = NonNullable<Parameters<typeof attachedSubnets>[0]>;

const adapter = (address: string, netmask: string, extra: Partial<{ internal: boolean; cidr: string | null; family: "IPv4" | "IPv6" }> = {}) =>
  ({ address, netmask, family: extra.family ?? (address.includes(":") ? "IPv6" : "IPv4"), mac: "00:00:00:00:00:00", internal: extra.internal ?? false, cidr: extra.cidr === undefined ? null : extra.cidr }) as never;

/** A desk on a home network, with a Hyper-V switch, a public address on a second card, and loopback. */
const DESK: Interfaces = {
  Ethernet: [adapter("192.168.1.44", "255.255.255.0", { cidr: "192.168.1.44/24" }), adapter("fe80::1c2d:3e4f:5a6b:7c8d", "ffff:ffff:ffff:ffff::", { cidr: "fe80::1c2d:3e4f:5a6b:7c8d/64" })],
  "vEthernet (WSL)": [adapter("172.27.96.1", "255.255.240.0")],
  Wan: [adapter("203.0.113.9", "255.255.255.0", { cidr: "203.0.113.9/24" })],
  Loopback: [adapter("127.0.0.1", "255.0.0.0", { internal: true, cidr: "127.0.0.1/8" })],
};

const subnets = () => attachedSubnets(DESK);
const LOCAL = parseNetworks(["local"]);

describe("addresses", () => {
  test("an IPv4 address inside an IPv6 socket is the IPv4 address", () => {
    expect(parseAddress("::ffff:192.168.1.7")).toEqual({ family: 4, bytes: Uint8Array.of(192, 168, 1, 7) });
    expect(parseAddress("::FFFF:c0a8:0107")).toEqual({ family: 4, bytes: Uint8Array.of(192, 168, 1, 7) });
    expect(formatAddress(parseAddress("[::ffff:10.0.0.1]")!)).toBe("10.0.0.1");
  });

  test("brackets and a zone are dropped; what is not an address is nothing", () => {
    expect(formatAddress(parseAddress("[fe80::1%eth0]")!)).toBe("fe80:0:0:0:0:0:0:1");
    expect(parseAddress("fe80::1%12")?.family).toBe(6);
    for (const bad of ["", "?", "256.1.1.1", "1.2.3", "1::2::3", "12345::", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "g::1", "example.com"]) expect(parseAddress(bad)).toBeUndefined();
  });

  test("loopback and the private ranges", () => {
    const a = (t: string) => parseAddress(t)!;
    for (const t of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(a(t))).toBe(true);
    for (const t of ["10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.0.9", "169.254.3.4", "fd12:3456::1", "fe80::1"]) expect(isPrivate(a(t))).toBe(true);
    // a tailnet's range, a neighbour of 172.16/12, the public internet
    for (const t of ["100.101.102.103", "172.32.0.1", "172.15.9.9", "8.8.8.8", "2a02:1810::1"]) expect(isPrivate(a(t))).toBe(false);
  });

  test("a range holds its own addresses and no neighbour's", () => {
    const lan = parseCidr("192.168.1.44/24")!;
    expect(lan.text).toBe("192.168.1.0/24");
    expect(inCidr(parseAddress("192.168.1.200")!, lan)).toBe(true);
    expect(inCidr(parseAddress("192.168.2.1")!, lan)).toBe(false);
    expect(inCidr(parseAddress("fe80::9")!, lan)).toBe(false);
    const odd = parseCidr("172.27.96.1/20")!;
    expect(odd.text).toBe("172.27.96.0/20");
    expect(inCidr(parseAddress("172.27.111.255")!, odd)).toBe(true);
    expect(inCidr(parseAddress("172.27.112.0")!, odd)).toBe(false);
    expect(parseCidr("10.0.0.1")!.bits).toBe(32);
    expect(inCidr(parseAddress("8.8.8.8")!, parseCidr("0.0.0.0/0")!)).toBe(true);
    for (const bad of ["10.0.0.0/33", "10.0.0.0/x", "fd00::/129", "10.0.0.0/8/8", "lan"]) expect(parseCidr(bad)).toBeUndefined();
  });
});

describe("peers", () => {
  test("the subnets are the adapters' private ones: by the cidr, or by the netmask where there is none", () => {
    expect(subnets().map((c) => c.text).sort()).toEqual(["172.27.96.0/20", "192.168.1.0/24", "fe80:0:0:0:0:0:0:0/64"]);
  });

  test("loopback and the attached private subnets are served by default, and nothing else", () => {
    const ok = (address: string) => peerAllowed(address, LOCAL, subnets);
    for (const a of ["127.0.0.1", "::1", "192.168.1.7", "::ffff:192.168.1.7", "172.27.100.2", "fe80::abcd"]) expect(ok(a)).toBe(true);
    // another private network, the public card's neighbours, a tailnet, the internet, an address that is none
    for (const a of ["192.168.2.7", "10.0.0.5", "203.0.113.10", "100.101.102.103", "8.8.8.8", "2a02:1810::1", "?"]) expect(ok(a)).toBe(false);
  });

  test("a configured range is served beside them; `any` serves everyone; without `local` only loopback and the ranges", () => {
    const tailnet = parseNetworks(["local", "100.64.0.0/10"]);
    expect(peerAllowed("100.101.102.103", tailnet, subnets)).toBe(true);
    expect(peerAllowed("8.8.8.8", tailnet, subnets)).toBe(false);
    expect(peerAllowed("8.8.8.8", parseNetworks(["any"]), subnets)).toBe(true);
    expect(peerAllowed("?", parseNetworks(["any"]), subnets)).toBe(true);
    const ranges = parseNetworks(["10.9.0.0/16"]);
    expect(peerAllowed("10.9.3.3", ranges, subnets)).toBe(true);
    expect(peerAllowed("192.168.1.7", ranges, subnets)).toBe(false);
    expect(peerAllowed("127.0.0.1", parseNetworks([]), subnets)).toBe(true);
  });

  test("a bad entry is said, not skipped", () => {
    expect(badNetwork("local")).toBeUndefined();
    expect(badNetwork("192.168.0.0/16")).toBeUndefined();
    expect(badNetwork("lan")).toContain('"lan"');
    expect(() => parseNetworks(["local", "10.0.0.0/40"])).toThrow(/networks/);
  });

  test("the range a refusal suggests is the peer's /24, or its /64", () => {
    expect(rangeFor("::ffff:100.101.102.103")).toBe("100.101.102.0/24");
    expect(rangeFor("2a02:1810:4f2a:1::9")).toBe("2a02:1810:4f2a:1:0:0:0:0/64");
    expect(rangeFor("?")).toBeUndefined();
  });
});

describe("Host", () => {
  test("the name is the header without its port, lowercased", () => {
    expect(hostName("192.168.1.44:4818")).toBe("192.168.1.44");
    expect(hostName("Desk.Local:8443")).toBe("desk.local");
    expect(hostName("desk.local.")).toBe("desk.local");
    expect(hostName("[::1]:4818")).toBe("::1");
    expect(hostName("desk")).toBe("desk");
    for (const bad of [null, undefined, "", "a b", "desk/evil", "desk:port", "user@desk", "[::1"]) expect(hostName(bad)).toBeUndefined();
  });

  test("a name is this machine's by the list, a wildcard standing for one label", () => {
    const names = ["192.168.1.44", "Desk", "localhost", "*.home.example"];
    expect(nameAllowed("192.168.1.44", names)).toBe(true);
    expect(nameAllowed("desk", names)).toBe(true);
    expect(nameAllowed("nas.home.example", names)).toBe(true);
    expect(nameAllowed("a.nas.home.example", names)).toBe(false);
    expect(nameAllowed("home.example", names)).toBe(false);
    expect(nameAllowed("evil.example", names)).toBe(false);
    expect(nameAllowed("192.168.1.45", names)).toBe(false);
    // an address is the address it is, however it was written
    expect(nameAllowed("fe80:0:0:0:0:0:0:1", ["fe80::1"])).toBe(true);
    expect(nameAllowed("::ffff:192.168.1.44", names)).toBe(true);
    expect(nameAllowed("fe80::2", ["fe80::1"])).toBe(false);
  });

  test("loopback names", () => {
    for (const n of ["127.0.0.1", "localhost", "::1", "127.9.9.9"]) expect(loopbackName(n)).toBe(true);
    for (const n of ["192.168.1.44", "localhost.evil.example", undefined]) expect(loopbackName(n)).toBe(false);
  });
});

describe("Origin", () => {
  test("no Origin is an app's socket; the listener's own is a browser; anything else is refused", () => {
    expect(originKind(null, "192.168.1.44:4818", "https")).toBe("none");
    expect(originKind("https://192.168.1.44:4818", "192.168.1.44:4818", "https")).toBe("own");
    expect(originKind("https://Desk.local", "desk.local", "https")).toBe("own");
    for (const o of ["https://evil.example", "http://192.168.1.44:4818", "https://192.168.1.44", "https://192.168.1.44:4820", "null", "https://192.168.1.44:4818.evil.example"]) {
      expect(originKind(o, "192.168.1.44:4818", "https")).toBe("refused");
    }
  });

  test("a stream page behind a loopback Host may come over plain HTTP, and only there", () => {
    expect(originKind("http://127.0.0.1:51234", "127.0.0.1:51234", "https", { remote: true })).toBe("forwarder");
    expect(originKind("http://127.0.0.1:51234", "127.0.0.1:51234", "https")).toBe("refused");
    expect(originKind("http://192.168.1.44:4818", "192.168.1.44:4818", "https", { remote: true })).toBe("refused");
    expect(originKind("http://127.0.0.1:9", "127.0.0.1:51234", "https", { remote: true })).toBe("refused");
  });
});

describe("the verdict", () => {
  const rules: GuardRules = { networks: LOCAL, subnets, names: () => ["192.168.1.44", "127.0.0.1", "localhost", "desk"], scheme: "https", forwarder: true };
  const req = (over: Partial<GuardRequest>): GuardRequest => ({ address: "192.168.1.7", host: "192.168.1.44:4818", origin: null, upgrade: false, path: "/", ...over });

  test("a page and an app's socket from the network pass", () => {
    expect(judge(req({}), rules)).toEqual({ ok: true, origin: "none" });
    expect(judge(req({ upgrade: true, path: "/ws/client" }), rules)).toEqual({ ok: true, origin: "none" });
    expect(judge(req({ upgrade: true, path: "/ws/client", origin: "https://192.168.1.44:4818" }), rules)).toEqual({ ok: true, origin: "own" });
  });

  test("a peer off the network is refused first, with the range that would serve it", () => {
    const v = judge(req({ address: "::ffff:100.101.102.103", host: "evil.example" }), rules);
    expect(v).toMatchObject({ ok: false, status: 403, why: "peer" });
    expect((v as { detail: string }).detail).toContain('"100.101.102.0/24"');
    expect((v as { detail: string }).detail).toContain("[controller] networks");
  });

  test("another name that resolves here is misdirected, a socket and a page alike", () => {
    for (const host of ["evil.example", "evil.example:4818", "192.168.1.45:4818", null, "a b"]) {
      expect(judge(req({ host }), rules)).toMatchObject({ ok: false, status: 421, why: "host" });
      expect(judge(req({ host, upgrade: true, path: "/ws/node" }), rules)).toMatchObject({ ok: false, status: 421, why: "host" });
    }
    // the port is not part of the name: a port mapping still works
    expect(judge(req({ host: "192.168.1.44:9443" }), rules)).toMatchObject({ ok: true });
  });

  test("a foreign page's socket is refused; a page's GET carries no judgement of its Origin", () => {
    expect(judge(req({ upgrade: true, path: "/ws/client", origin: "https://evil.example" }), rules)).toMatchObject({ ok: false, status: 403, why: "origin" });
    expect(judge(req({ origin: "null", path: "/view/abcdef0123456789/view.js" }), rules)).toEqual({ ok: true, origin: "none" });
  });

  test("the forwarder's page: a loopback Host under /remote, over plain HTTP, on the listener that serves it", () => {
    const forwarded = req({ host: "[::1]:51234", origin: "http://[::1]:51234", upgrade: true, path: "/remote/api/host/stream" });
    expect(judge(forwarded, rules)).toEqual({ ok: true, origin: "forwarder" });
    // `[::1]` is no name of this machine's: only /remote takes it, and only where the forwarder is served
    expect(judge({ ...forwarded, path: "/ws/client" }, rules)).toMatchObject({ ok: false, why: "host" });
    expect(judge(forwarded, { ...rules, forwarder: false })).toMatchObject({ ok: false, why: "host" });
    expect(judge(req({ host: "127.0.0.1:51234", origin: "http://127.0.0.1:51234", upgrade: true, path: "/ws/client" }), rules)).toMatchObject({ ok: false, why: "origin" });
  });

  test("the guard reads the adapters again before it turns a peer away, and keeps the last refusal", () => {
    let now = 1000;
    let cards: Interfaces = { Ethernet: DESK["Ethernet"]! };
    const warned: unknown[] = [];
    const log = { warn: (_m: string, f: unknown) => void warned.push(f) } as never;
    const guard = new Guard({ networks: LOCAL, names: () => ["192.168.1.44"], scheme: "https", interfaces: () => cards, now: () => now, log });
    expect(guard.check(req({})).ok).toBe(true);
    expect(guard.last).toBeUndefined();
    // a new adapter, inside the few seconds the last read is believed
    cards = DESK;
    now += 100;
    expect(guard.check(req({ address: "172.27.100.2" })).ok).toBe(true);
    expect(guard.check(req({ address: "10.0.0.5" })).ok).toBe(false);
    expect(guard.last).toMatchObject({ at: 1100, address: "10.0.0.5", why: "peer" });
    // said once a minute per address and reason, not once a request
    guard.check(req({ address: "10.0.0.5" }));
    expect(warned.length).toBe(1);
    now += 61_000;
    guard.check(req({ address: "10.0.0.5" }));
    expect(warned.length).toBe(2);
  });
});

describe("headers", () => {
  test("the page carries the policy and the opener rule; a script neither; everything says its type is its type", () => {
    const page = appHeaders("text/html; charset=utf-8", "default-src 'none'");
    expect(page["content-security-policy"]).toBe("default-src 'none'");
    expect(page["cross-origin-opener-policy"]).toBe("same-origin");
    expect(page["x-content-type-options"]).toBe("nosniff");
    expect(page["referrer-policy"]).toBe("no-referrer");
    const script = appHeaders("text/javascript", "default-src 'none'");
    expect(script["content-security-policy"]).toBeUndefined();
    expect(script["cross-origin-opener-policy"]).toBeUndefined();
    expect(script["x-content-type-options"]).toBe("nosniff");
    expect(Object.keys(page).some((k) => k.toLowerCase() === "strict-transport-security")).toBe(false);
  });
});

describe("the limiter", () => {
  const at = { now: 0 };
  const limiter = (over = {}) => new PairLimiter({ now: () => at.now, ...over });

  test("ten misses in ten minutes block an address's pairing for a minute, then two, up to fifteen", () => {
    at.now = 0;
    const l = limiter();
    for (let i = 0; i < 9; i++) l.miss("192.168.1.7");
    expect(l.blocked("192.168.1.7")).toBeUndefined();
    l.miss("192.168.1.7");
    expect(l.blocked("192.168.1.7")).toBe(60_000);
    expect(l.blocked("192.168.1.8")).toBeUndefined();
    at.now += 60_000;
    expect(l.blocked("192.168.1.7")).toBeUndefined();
    for (let i = 0; i < 10; i++) l.miss("192.168.1.7");
    expect(l.blocked("192.168.1.7")).toBe(120_000);
    for (let round = 0; round < 6; round++) {
      at.now += 15 * 60_000;
      for (let i = 0; i < 10; i++) l.miss("::ffff:192.168.1.7");
    }
    expect(l.blocked("192.168.1.7")).toBe(15 * 60_000);
  });

  test("misses spread over more than the window never add up", () => {
    at.now = 0;
    const l = limiter();
    for (let i = 0; i < 30; i++) {
      l.miss("192.168.1.7");
      at.now += 70_000;
    }
    expect(l.blocked("192.168.1.7")).toBeUndefined();
  });

  test("a long quiet after a block starts the next one short again", () => {
    at.now = 0;
    const l = limiter();
    for (let i = 0; i < 20; i++) l.miss("192.168.1.7");
    expect(l.blocked("192.168.1.7")).toBe(120_000);
    at.now += 60 * 60_000;
    for (let i = 0; i < 10; i++) l.miss("192.168.1.7");
    expect(l.blocked("192.168.1.7")).toBe(60_000);
  });

  test("IPv6 is counted by its /64; this machine is never counted", () => {
    at.now = 0;
    const l = limiter();
    for (let i = 0; i < 10; i++) l.miss(`2a02:1810:4f2a:1::${i + 1}`);
    expect(l.blocked("2a02:1810:4f2a:1::ffff")).toBe(60_000);
    expect(l.blocked("2a02:1810:4f2a:2::1")).toBeUndefined();
    for (let i = 0; i < 50; i++) l.miss("127.0.0.1");
    for (let i = 0; i < 50; i++) l.miss("::1");
    expect(l.blocked("127.0.0.1")).toBeUndefined();
    expect(l.key("::ffff:127.0.0.1")).toBeUndefined();
  });

  test("sixteen sockets that have not said hello per address; one that says it, or closes, makes room", () => {
    at.now = 0;
    const l = limiter();
    for (let i = 0; i < 16; i++) expect(l.open("192.168.1.7")).toBe(true);
    expect(l.open("192.168.1.7")).toBe(false);
    expect(l.open("192.168.1.8")).toBe(true);
    l.done("192.168.1.7");
    expect(l.open("192.168.1.7")).toBe(true);
    for (let i = 0; i < 100; i++) expect(l.open("127.0.0.1")).toBe(true);
  });

  test("the table is bounded, and an address with nothing against it is forgotten", () => {
    at.now = 0;
    const l = limiter({ entries: 8 });
    for (let i = 0; i < 50; i++) l.miss(`10.0.0.${i}`);
    expect(l.size).toBe(8);
    const quiet = limiter();
    expect(quiet.open("192.168.1.7")).toBe(true);
    quiet.done("192.168.1.7");
    expect(quiet.size).toBe(0);
  });
});
