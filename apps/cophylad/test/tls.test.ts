// The controller listener's certificate: a self-signed pair the node makes for itself, with
// every LAN address in it, which Bun will serve TLS with and `node:crypto` will parse; kept
// on disk and made again only when it no longer covers the node.

import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CERT_FILE, certificateNames, certificateStale, ensureCertificate, generateSelfSigned, KEY_FILE, lanAddress, lanEndpoints, spkiHash } from "../src/api/tls.ts";

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
  });
});
