// The controller listener's certificate: a self-signed pair the node makes for itself, with
// every LAN address in it, which Bun will serve TLS with and `node:crypto` will parse; kept
// on disk and made again only when it no longer names the address the node is reached at,
// whatever its other adapters do. And a certificate the user brings: checked before it is
// served, served by name beside the node's own, and put in service again when its files change.

import { afterEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import type { LanState } from "@cophyla/protocol";
import { CERT_FILE, certificateNames, certificateNamesFor, certificateStale, ensureCertificate, generateSelfSigned, KEY_FILE, lanAddress, lanEndpoints, loadOwnCertificate, PAST_ADDRESSES, pickAddress, reachableAddresses, spkiHash, virtualAdapter } from "../src/api/tls.ts";
import type { Daemon } from "../src/daemon.ts";
import { stopDaemon, testDaemon, TestClient } from "./helpers.ts";

const spec = { dnsNames: ["localhost", "desk"], ips: ["127.0.0.1", "192.168.1.44"] };

describe("self-signed certificate", () => {
  test("parses, verifies against itself, and carries every name and address", () => {
    const pair = generateSelfSigned(spec);
    const x = new X509Certificate(pair.certPem);
    expect(x.subject).toBe("CN=cophylad");
    expect(x.issuer).toBe("CN=cophylad");
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.ca).toBe(false);
    const names = certificateNames(pair.certPem)!;
    expect(names.dns).toEqual(["localhost", "desk"]);
    expect(names.ips).toEqual(["127.0.0.1", "192.168.1.44"]);
    expect(names.validTo).toBeGreaterThan(Date.now());
    // Backdated, so a phone whose clock runs ahead still accepts it.
    expect(new Date(x.validFrom).getTime()).toBeLessThan(Date.now());
  });

  test("Bun serves TLS with it and a client that accepts the warning gets through", async () => {
    const pair = generateSelfSigned(spec);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: pair.keyPem, cert: pair.certPem }, fetch: () => new Response("ok") });
    try {
      const res = await fetch(`https://127.0.0.1:${server.port}/`, { tls: { rejectUnauthorized: false } } as never);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    } finally {
      await server.stop(true);
    }
  });

  test("an unknown address, a short life or an unreadable file makes it stale", () => {
    const pair = generateSelfSigned(spec);
    expect(certificateStale(pair.certPem, spec)).toBeUndefined();
    expect(certificateStale(pair.certPem, { ...spec, ips: [...spec.ips, "10.0.0.2"] })).toContain("10.0.0.2");
    expect(certificateStale(pair.certPem, { ...spec, dnsNames: ["other"] })).toContain("other");
    expect(certificateStale("not a certificate", spec)).toBe("unreadable");
    const short = generateSelfSigned({ ...spec, days: 10 });
    expect(certificateStale(short.certPem, spec)).toBe("expiring");
  });
});

describe("the node's pair", () => {
  test("is written once and reused, and made again when the node gains an address", () => {
    const dir = mkdtempSync(join(tmpdir(), "cophyla-tls-"));
    try {
      const first = ensureCertificate(dir, spec);
      expect(first.fresh).toBe(true);
      expect(existsSync(join(dir, KEY_FILE))).toBe(true);
      expect(existsSync(join(dir, CERT_FILE))).toBe(true);
      const again = ensureCertificate(dir, spec);
      expect(again.fresh).toBe(false);
      expect(again.certPem).toBe(first.certPem);
      const moved = ensureCertificate(dir, { ...spec, ips: [...spec.ips, "10.0.0.2"] });
      expect(moved.fresh).toBe(true);
      expect(moved.certPem).not.toBe(first.certPem);
      expect(certificateNames(moved.certPem)!.ips).toContain("10.0.0.2");
      // the key is kept across a certificate made again, so a phone's pin on it still holds
      expect(moved.keyPem).toBe(first.keyPem);
      expect(spkiHash(moved.certPem)).toBe(spkiHash(first.certPem));
      expect(spkiHash(first.certPem)).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      // A key that cannot be read is replaced rather than served.
      writeFileSync(join(dir, KEY_FILE), "rubbish", "utf8");
      expect(ensureCertificate(dir, spec).fresh).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the endpoints hold loopback and this machine's own names", () => {
    const ends = lanEndpoints();
    expect(ends.ips).toContain("127.0.0.1");
    expect(ends.dnsNames).toContain("localhost");
    // Either a private address or nothing, on a machine with no LAN.
    const lan = lanAddress(ends.ips);
    if (lan !== undefined) expect(ends.ips).toContain(lan);
    const picked = lanAddress();
    if (picked !== undefined) expect(ends.ips).toContain(picked);
  });

  test("it is kept while it names the address the node is reached at, whatever else moved", () => {
    const dir = mkdtempSync(join(tmpdir(), "cophyla-tls-"));
    try {
      const reached = { ips: ["192.168.1.44"] };
      const first = ensureCertificate(dir, { dnsNames: ["localhost", "desk"], ips: ["127.0.0.1", "192.168.1.44", "172.27.96.1"], required: reached });
      // a hypervisor's switch moved, a VPN came up: not a reason for a new certificate, and a new warning in every browser
      const moved = ensureCertificate(dir, { dnsNames: ["localhost", "desk"], ips: ["127.0.0.1", "192.168.1.44", "172.29.0.1", "100.101.102.103"], required: reached });
      expect(moved.fresh).toBe(false);
      expect(moved.certPem).toBe(first.certPem);
      // the address it is reached at changed: made again, on the same key
      const other = ensureCertificate(dir, { dnsNames: ["localhost", "desk"], ips: ["127.0.0.1", "10.0.0.5"], required: { ips: ["10.0.0.5"] } });
      expect(other.fresh).toBe(true);
      expect(spkiHash(other.certPem)).toBe(spkiHash(first.certPem));
      // and it still carries the addresses the last one had, so going back costs nothing
      const names = certificateNames(other.certPem)!;
      expect(names.ips).toEqual(["10.0.0.5", "127.0.0.1", "192.168.1.44", "172.27.96.1"]);
      expect(ensureCertificate(dir, { dnsNames: ["localhost", "desk"], ips: ["127.0.0.1", "192.168.1.44"], required: reached }).fresh).toBe(false);
      // a name it must carry works as an address does
      expect(certificateStale(other.certPem, { dnsNames: [], ips: [], required: { dnsNames: ["desk.home.example"] } })).toBe("missing desk.home.example");
      expect(certificateStale(other.certPem, { dnsNames: [], ips: [], required: { dnsNames: ["desk"] } })).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a certificate made again carries at most four addresses of the one before", () => {
    const before = generateSelfSigned({ dnsNames: ["localhost"], ips: ["192.168.1.44", "10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5", "10.0.0.6"] });
    const names = certificateNamesFor({ dnsNames: ["localhost"], ips: ["127.0.0.1", "192.168.7.7"], required: { ips: ["192.168.7.7"] } }, before.certPem);
    expect(PAST_ADDRESSES).toBe(4);
    expect(names.ips).toEqual(["192.168.7.7", "127.0.0.1", "192.168.1.44", "10.0.0.1", "10.0.0.2", "10.0.0.3"]);
    expect(certificateNamesFor({ dnsNames: ["a"], ips: ["1.2.3.4"] }).ips).toEqual(["1.2.3.4"]);
  });

  test("the address picked is the first private one on a real adapter, not a hypervisor's or a VPN's", () => {
    const card = (address: string, internal = false) => ({ address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: `${address}/24` }) as never;
    const v6 = { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: "fe80::1/64", scopeid: 3 } as never;
    expect(pickAddress({ "vEthernet (WSL (Hyper-V firewall))": [card("172.27.96.1")], "vEthernet (Default Switch)": [card("172.29.0.1")], Tailscale: [card("100.101.102.103")], "Wi-Fi": [v6, card("192.168.1.44")], "Loopback Pseudo-Interface 1": [card("127.0.0.1", true)] })).toBe("192.168.1.44");
    expect(pickAddress({ docker0: [card("172.17.0.1")], "br-3f2a": [card("172.18.0.1")], enp3s0: [card("10.0.0.5")], lo: [card("127.0.0.1", true)] })).toBe("10.0.0.5");
    expect(pickAddress({ utun3: [card("100.64.0.2")], bridge100: [card("192.168.64.1")], en0: [card("192.168.1.9")] })).toBe("192.168.1.9");
    // what is offered to type is the real adapters' private addresses alone, in the system's order
    expect(reachableAddresses({ "vEthernet (WSL (Hyper-V firewall))": [card("172.27.96.1")], Tailscale: [card("100.101.102.103")], Ethernet: [card("10.0.0.5"), v6], "Wi-Fi": [card("192.168.1.44")], "Loopback Pseudo-Interface 1": [card("127.0.0.1", true)], "Ethernet 2": [card("203.0.113.9")] })).toEqual(["10.0.0.5", "192.168.1.44"]);
    expect(reachableAddresses({ "vEthernet (Default Switch)": [card("172.29.0.1")] })).toEqual([]);
    // nothing but a virtual adapter: better than none, private before public
    expect(pickAddress({ "vEthernet (Default Switch)": [card("172.29.0.1")], Tailscale: [card("100.101.102.103")] })).toBe("172.29.0.1");
    expect(pickAddress({ eth0: [card("203.0.113.9")] })).toBe("203.0.113.9");
    expect(pickAddress({ lo: [card("127.0.0.1", true)] })).toBeUndefined();
    for (const name of ["vEthernet (WSL)", "VirtualBox Host-Only Network", "VMware Network Adapter VMnet8", "docker0", "veth1a2b", "virbr0", "tailscale0", "wg0", "utun4", "awdl0", "ZeroTier One [abc]", "Local Area Connection* 2"]) expect(virtualAdapter(name)).toBe(true);
    for (const name of ["Ethernet", "Wi-Fi", "eth0", "enp3s0", "wlan0", "en0", "wlp2s0"]) expect(virtualAdapter(name)).toBe(false);
  });
});

describe("a certificate of the user's own", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** A pair on disk, as a user would bring one: here self-signed, for a name. */
  function bring(names: string[], opts: { days?: number } = {}): { dir: string; cert: string; key: string; certPem: string; keyPem: string } {
    const dir = mkdtempSync(join(tmpdir(), "cophyla-own-"));
    dirs.push(dir);
    const pair = generateSelfSigned({ dnsNames: names, ips: [], cn: names[0] ?? "nobody", ...(opts.days !== undefined ? { days: opts.days } : {}) });
    const cert = join(dir, "fullchain.pem");
    const key = join(dir, "privkey.pem");
    writeFileSync(cert, pair.certPem);
    writeFileSync(key, pair.keyPem);
    return { dir, cert, key, certPem: pair.certPem, keyPem: pair.keyPem };
  }

  test("is read with the names it carries, when the key is its own and today is inside its dates", () => {
    const own = bring(["Desk.Home.Example", "*.home.example"]);
    const read = loadOwnCertificate(own.cert, own.key);
    expect(read.names).toEqual(["desk.home.example", "*.home.example"]);
    expect(read.certPem).toBe(own.certPem);
    expect(read.validTo).toBeGreaterThan(Date.now());
  });

  test("is refused, in words, before anything serves it: no file, no certificate, another key, out of date, not yet valid, no name", () => {
    const own = bring(["desk.home.example"]);
    const other = bring(["other.example"]);
    expect(() => loadOwnCertificate(join(own.dir, "none.pem"), own.key)).toThrow(/the certificate cannot be read/);
    expect(() => loadOwnCertificate(own.cert, join(own.dir, "none.pem"))).toThrow(/the key cannot be read/);
    expect(() => loadOwnCertificate(own.key, own.key)).toThrow(/holds no certificate/);
    expect(() => loadOwnCertificate(own.cert, own.cert)).toThrow(/holds no private key/);
    expect(() => loadOwnCertificate(own.cert, other.key)).toThrow("the key does not match the certificate");
    expect(() => loadOwnCertificate(own.cert, own.key, 0)).toThrow(/not valid before/);
    expect(() => loadOwnCertificate(own.cert, own.key, Date.now() + 11 * 365 * 86_400_000)).toThrow(/ran out on/);
    const spent = bring(["desk.home.example"], { days: 0 });
    expect(() => loadOwnCertificate(spent.cert, spent.key)).toThrow(/ran out on/);
    const nameless = bring([]);
    expect(() => loadOwnCertificate(nameless.cert, nameless.key)).toThrow(/names no host/);
  });

  /** The certificate a server shows a connection that names `servername`, or none: its SHA-256. */
  function shown(port: number, servername?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port, rejectUnauthorized: false, ...(servername !== undefined ? { servername } : {}) }, () => {
        const print = socket.getPeerCertificate().fingerprint256;
        socket.end();
        resolve(print);
      });
      socket.on("error", reject);
    });
  }
  const print = (certPem: string): string => new X509Certificate(certPem).fingerprint256;

  test("Bun serves the first certificate to a connection with no name or an unknown one, and a named one under its name", async () => {
    const own = bring(["desk.home.example"]);
    const node = generateSelfSigned(spec);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: [{ key: node.keyPem, cert: node.certPem }, { key: own.keyPem, cert: own.certPem, serverName: "desk.home.example" }] as never, fetch: () => new Response("ok") });
    try {
      expect(await shown(server.port!)).toBe(print(node.certPem));
      expect(await shown(server.port!, "elsewhere.example")).toBe(print(node.certPem));
      expect(await shown(server.port!, "desk.home.example")).toBe(print(own.certPem));
    } finally {
      await server.stop(true);
    }
  });

  let d: (Daemon & { home: string }) | undefined;
  afterEach(async () => {
    if (d) await stopDaemon(d);
    d = undefined;
  });
  const toml = (own: { cert: string; key: string }, extra = "") => `[controller]\nenabled = true\nport = 0\ncert_file = ${JSON.stringify(own.cert)}\nkey_file = ${JSON.stringify(own.key)}\n${extra}`;
  const info = async (dm: Daemon): Promise<LanState> => {
    const ui = await TestClient.connect(dm.api.url);
    try {
      await ui.hello(dm.token, { name: "desktop" });
      return await ui.request<LanState>("lan.info", {});
    } finally {
      ui.close();
    }
  };

  test("the listener serves it under its name and the node's own by address; the name is the address a browser is given, and a phone's stays an address", async () => {
    const own = bring(["desk.home.example"]);
    d = await testDaemon(toml(own), { lan: { ownCertificatePollMs: 0 } });
    const port = d.controller!.port;
    const state = await info(d);
    expect(state.certificate).toMatchObject({ names: ["desk.home.example"] });
    expect(state.certificate!.error).toBeUndefined();
    expect(state.addresses[0]).toBe(`https://desk.home.example:${port}`);
    // the fingerprints are the node's own, which is what an address shows and an app pins
    expect(await shown(port)).toBe(state.fingerprints!.certificate);
    expect(await shown(port, "desk.home.example")).toBe(print(own.certPem));
    const pin = d.lan.pin();
    if (pin) expect(pin.host).toMatch(/^[0-9.]+$/);
    // a request under the certificate's name is this machine's
    const res = await fetch(`https://127.0.0.1:${port}/`, { headers: { host: `desk.home.example:${port}` }, tls: { rejectUnauthorized: false } } as never);
    expect(res.status).not.toBe(421);
  });

  test("one that does not pass is never served, and lan.info says why; nothing else is held up", async () => {
    const own = bring(["desk.home.example"]);
    const other = bring(["other.example"]);
    d = await testDaemon(toml({ cert: own.cert, key: other.key }), { lan: { ownCertificatePollMs: 0 } });
    const port = d.controller!.port;
    const state = await info(d);
    expect(state.state).toBe("on");
    expect(state.certificate).toEqual({ names: [], error: "the key does not match the certificate" });
    expect(state.addresses.some((a) => a.includes("desk.home.example"))).toBe(false);
    expect(await shown(port, "desk.home.example")).toBe(state.fingerprints!.certificate);
    const res = await fetch(`https://127.0.0.1:${port}/`, { headers: { host: `desk.home.example:${port}` }, tls: { rejectUnauthorized: false } } as never);
    expect(res.status).toBe(421);
  });

  test("its files changing puts the new pair in service by starting the listener again; a bad one leaves the one before in service", async () => {
    const own = bring(["desk.home.example"]);
    d = await testDaemon(toml(own), { lan: { ownCertificatePollMs: 0 } });
    const port = d.controller!.port;
    const first = print(own.certPem);
    expect(await shown(port, "desk.home.example")).toBe(first);
    expect(await d.lan.checkOwn()).toBe(false);

    // renewed: a new certificate in the same files
    const renewed = generateSelfSigned({ dnsNames: ["desk.home.example", "nas.home.example"], ips: [], cn: "desk.home.example" });
    writeFileSync(own.cert, renewed.certPem);
    writeFileSync(own.key, renewed.keyPem);
    const later = new Date(Date.now() + 5000);
    utimesSync(own.cert, later, later);
    const phone = await TestClient.connect(`wss://127.0.0.1:${port}/ws/client`, { insecure: true });
    expect(await d.lan.checkOwn()).toBe(true);
    // the listener started again: what was connected reconnects
    await phone.closed;
    const again = d.controller!.port;
    expect(again).toBe(port);
    expect(await shown(again, "desk.home.example")).toBe(print(renewed.certPem));
    expect(await shown(again, "nas.home.example")).toBe(print(renewed.certPem));
    expect((await info(d)).certificate!.names).toEqual(["desk.home.example", "nas.home.example"]);

    // a key that is not its own is written over it: said, and not served
    const wrong = generateSelfSigned({ dnsNames: ["wrong.example"], ips: [] });
    writeFileSync(own.key, wrong.keyPem);
    const latest = new Date(Date.now() + 10_000);
    utimesSync(own.key, latest, latest);
    expect(await d.lan.checkOwn()).toBe(false);
    const state = await info(d);
    expect(state.certificate).toMatchObject({ names: ["desk.home.example", "nas.home.example"], error: "the key does not match the certificate" });
    expect(await shown(again, "desk.home.example")).toBe(print(renewed.certPem));
  });
});
