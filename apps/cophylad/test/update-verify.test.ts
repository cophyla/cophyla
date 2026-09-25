// The update module's pure parts: a signed entry verifies and any tampered field fails;
// another key fails; a moved `url` still verifies; `selectReleases` drops with reasons;
// `newest` picks the highest semver above the current, skipping broken and invalid versions;
// `urlAllowed`; `download` rejects a size or hash mismatch and leaves no `.partial`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Release } from "@cophyla/protocol";
import { download } from "../src/update/download.ts";
import { feedUrl, newest, selectReleases, urlAllowed } from "../src/update/feed.ts";
import { sha256File, signRelease, verifyRelease } from "../src/update/verify.ts";

function keyPair(): { pem: string; pub: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }) as string, pub: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

const KEY = keyPair();
const OTHER = keyPair();

const base = (over: Partial<Release> = {}): Omit<Release, "signature"> => ({
  component: "brain",
  name: "brain-0.1.2-windows-x64.exe",
  version: "0.1.2",
  channel: "stable",
  os: "windows",
  arch: "x64",
  protocol: { min: 1, max: 1 },
  url: "https://releases.example/brain-0.1.2-windows-x64.exe",
  size: 5,
  sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  publishedAt: 1758196800000,
  ...over,
});

const signed = (over: Partial<Release> = {}, pem = KEY.pem): Release => signRelease(base(over), pem);

describe("sign and verify", () => {
  test("roundtrip", () => {
    const r = signed();
    expect(r.signature).toMatch(/^ed25519:[A-Za-z0-9+/=]+$/);
    expect(verifyRelease(r, [KEY.pub])).toBe(true);
  });

  test("any tampered field fails", () => {
    const r = signed();
    const tampered: Record<string, unknown>[] = [
      { ...r, version: "0.1.3" },
      { ...r, protocol: { min: 1, max: 2 } },
      { ...r, sha256: "f".repeat(64) },
      { ...r, size: 6 },
      { ...r, channel: "beta" },
      { ...r, component: "platform" },
      { ...r, os: "linux" },
      { ...r, extra: true },
    ];
    for (const t of tampered) expect(verifyRelease(t, [KEY.pub])).toBe(false);
  });

  test("the wrong key fails; a rotation set with the right key passes", () => {
    const r = signed();
    expect(verifyRelease(r, [OTHER.pub])).toBe(false);
    expect(verifyRelease(r, [OTHER.pub, KEY.pub])).toBe(true);
    expect(verifyRelease(r, [])).toBe(false);
    expect(verifyRelease(r, ["not a key"])).toBe(false);
  });

  test("a changed url still verifies; a missing or malformed signature does not", () => {
    const r = signed();
    expect(verifyRelease({ ...r, url: "http://192.168.0.2:8790/artifacts/brain.exe" }, [KEY.pub])).toBe(true);
    expect(verifyRelease({ ...r, signature: "ed25519:AAAA" }, [KEY.pub])).toBe(false);
    expect(verifyRelease({ ...r, signature: "rsa:" + r.signature.slice(8) }, [KEY.pub])).toBe(false);
    const { signature: _s, ...unsigned } = r;
    expect(verifyRelease(unsigned, [KEY.pub])).toBe(false);
  });

  test("an unknown field is covered by the signature", () => {
    const r = signRelease({ ...base(), future: "yes" }, KEY.pem);
    expect(verifyRelease(r, [KEY.pub])).toBe(true);
    expect(verifyRelease({ ...r, future: "no" }, [KEY.pub])).toBe(false);
  });
});

describe("selectReleases", () => {
  const target = { os: "windows", arch: "x64", channel: "stable", protocolVersion: 1 };

  test("keeps good entries and drops the rest with reasons", () => {
    const good = signed();
    const platform = signed({ component: "platform", name: "platform-0.1.1-windows-x64.tar.gz", version: "0.1.1" });
    const bad = { ...signed({ version: "0.1.9" }), version: "0.2.0" };
    const linux = signed({ os: "linux" });
    const arm = signed({ arch: "arm64" });
    const beta = signed({ channel: "beta" });
    const proto = signed({ protocol: { min: 2, max: 2 } });
    const noOs = signRelease({ ...base(), os: undefined, arch: undefined }, KEY.pem);
    const notSemver = signed({ version: "v1" });
    const otherKey = signed({}, OTHER.pem);
    const { accepted, dropped } = selectReleases({ generatedAt: 1, releases: [good, platform, bad, linux, arm, beta, proto, noOs, notSemver, otherKey] }, target, [KEY.pub]);
    expect(accepted.map((r) => `${r.component}@${r.version}`)).toEqual(["brain@0.1.2", "platform@0.1.1"]);
    expect(dropped.map((d) => d.reason)).toEqual([
      "bad signature",
      "os linux",
      "arch arm64",
      "channel beta",
      "protocol range 2-2 excludes 1",
      "no os or arch",
      "version v1 is not semver",
      "bad signature",
    ]);
  });

  test("a body that is not a feed drops everything", () => {
    expect(selectReleases({ nope: true }, target, [KEY.pub]).dropped).toEqual([{ release: {}, reason: "feed invalid" }]);
    expect(selectReleases("text", target, [KEY.pub]).dropped[0]!.reason).toBe("feed invalid");
    const { accepted, dropped } = selectReleases({ releases: [{ component: "brain" }] }, target, [KEY.pub]);
    expect(accepted).toEqual([]);
    expect(dropped[0]!.reason).toBe("entry invalid");
  });

  test("a protocol range that contains ours passes; a model entry needs no os", () => {
    const wide = signed({ protocol: { min: 1, max: 3 } });
    const model = signRelease({ ...base({ component: "model", name: "wake-word-1.onnx", version: "1.0.0" }), os: undefined, arch: undefined, protocol: undefined }, KEY.pem);
    const { accepted, dropped } = selectReleases({ releases: [wide, model] }, target, [KEY.pub]);
    expect(dropped).toEqual([]);
    expect(accepted).toHaveLength(2);
  });
});

describe("newest", () => {
  const rel = (component: Release["component"], version: string): Release => signed({ component, version });

  test("picks the highest semver above the current, per component", () => {
    const list = [rel("brain", "0.1.2"), rel("brain", "0.1.10"), rel("brain", "0.1.3"), rel("platform", "0.2.0"), rel("brain", "0.1.0")];
    expect(newest(list, "brain", "0.1.1")?.version).toBe("0.1.10");
    expect(newest(list, "platform", "0.1.0")?.version).toBe("0.2.0");
    expect(newest(list, "brain", "0.1.10")).toBeUndefined();
    expect(newest(list, "brain", "1.0.0")).toBeUndefined();
  });

  test("skips broken versions and never updates an invalid current", () => {
    const list = [rel("platform", "0.1.1"), rel("platform", "0.1.2")];
    expect(newest(list, "platform", "0.1.0", ["0.1.2"])?.version).toBe("0.1.1");
    expect(newest(list, "platform", "0.1.0", ["0.1.1", "0.1.2"])).toBeUndefined();
    expect(newest(list, "platform", "fake-0.1")).toBeUndefined();
    expect(newest(list, "platform", undefined)).toBeUndefined();
  });
});

describe("urls", () => {
  test("https anywhere, http on loopback, http on the LAN only with the flag", () => {
    expect(urlAllowed("https://feed.example.com/stable/windows-x64.json")).toBe(true);
    expect(urlAllowed("http://127.0.0.1:8790/stable/windows-x64.json")).toBe(true);
    expect(urlAllowed("http://localhost:8790/x")).toBe(true);
    expect(urlAllowed("http://[::1]:8790/x")).toBe(true);
    expect(urlAllowed("http://172.28.192.1:8790/x")).toBe(false);
    expect(urlAllowed("http://172.28.192.1:8790/x", true)).toBe(true);
    expect(urlAllowed("ftp://example.com/x", true)).toBe(false);
    expect(urlAllowed("not a url", true)).toBe(false);
  });

  test("feedUrl", () => {
    expect(feedUrl("https://feed.getcophyla.com/", "stable", "windows", "x64")).toBe("https://feed.getcophyla.com/stable/windows-x64.json");
    expect(feedUrl("http://127.0.0.1:8790", "beta", "linux", "arm64")).toBe("http://127.0.0.1:8790/beta/linux-arm64.json");
  });
});

describe("download", () => {
  const body = Buffer.from("the brain, allegedly");
  const sha = createHash("sha256").update(body).digest("hex");
  let server: ReturnType<typeof Bun.serve>;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cophyla-dl-"));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/ok") return new Response(body);
        if (path === "/short") return new Response(body.subarray(0, 10), { headers: { "content-length": String(body.length) } });
        if (path === "/nolength") {
          // Chunked with a pause, so no content-length is known up front and the short body is caught at the end.
          return new Response(
            new ReadableStream({
              async start(c) {
                c.enqueue(body.subarray(0, 5));
                await Bun.sleep(20);
                c.enqueue(body.subarray(5, 10));
                c.close();
              },
            }),
          );
        }
        if (path === "/missing") return new Response("no", { status: 404 });
        return new Response("?", { status: 400 });
      },
    });
  });

  afterAll(async () => {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
  const leftovers = () => readdirSync(dir).filter((f) => f.endsWith(".partial"));

  test("a good download lands at dest with progress reported and no partial left", async () => {
    const dest = join(dir, "good.bin");
    const progress: number[] = [];
    await download(url("/ok"), dest, { size: body.length, sha256: sha, onProgress: (f) => progress.push(f) });
    expect(readFileSync(dest)).toEqual(body);
    expect(progress[progress.length - 1]).toBe(1);
    expect(leftovers()).toEqual([]);
    expect(await sha256File(dest)).toBe(sha);
  });

  test("a hash mismatch is rejected and leaves nothing", async () => {
    const dest = join(dir, "hash.bin");
    await expect(download(url("/ok"), dest, { size: body.length, sha256: "0".repeat(64) })).rejects.toThrow(/sha256/);
    expect(existsSync(dest)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  test("a size mismatch is rejected: declared, short body, and over-long", async () => {
    const dest = join(dir, "size.bin");
    await expect(download(url("/ok"), dest, { size: 3, sha256: sha })).rejects.toThrow(/content-length|more than|expected/);
    await expect(download(url("/nolength"), dest, { size: body.length, sha256: sha })).rejects.toThrow(/bytes, expected/);
    expect(existsSync(dest)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  test("an HTTP error is a DownloadError", async () => {
    await expect(download(url("/missing"), join(dir, "missing.bin"), { size: 1, sha256: sha })).rejects.toThrow(/HTTP 404/);
    expect(leftovers()).toEqual([]);
  });
});

describe("brain store", () => {
  const release = (name: string): Release =>
    ({ component: "brain", name, version: "0.2.0", channel: "stable", os: "linux", arch: "x64", protocol: { min: 1, max: 1 }, url: `https://example.invalid/${name}`, size: 1, sha256: "0".repeat(64), publishedAt: 1, signature: "ed25519:x" }) as Release;

  test("a staged binary gets the executable bit on Unix; a script is left alone", async () => {
    const { BrainStore } = await import("../src/update/brain.ts");
    const { chmodSync, statSync, writeFileSync } = await import("node:fs");
    const data = mkdtempSync(join(tmpdir(), "cophyla-brain-"));
    const store = new BrainStore(data);
    const download = join(data, "brain-0.2.0-linux-x64");
    writeFileSync(download, "#!/bin/sh\necho hello\n");
    if (process.platform !== "win32") chmodSync(download, 0o600);
    const dir = store.stage(download, release("brain-0.2.0-linux-x64"));
    const binary = join(dir, process.platform === "win32" ? "brain.exe" : "brain");
    expect(existsSync(binary)).toBe(true);
    if (process.platform !== "win32") expect(statSync(binary).mode & 0o111).toBe(0o111);
    const script = join(data, "brain-0.2.0.ts");
    writeFileSync(script, "// brain\n");
    if (process.platform !== "win32") chmodSync(script, 0o600);
    const sdir = store.stage(script, release("brain-0.2.0-linux-x64.ts"));
    expect(existsSync(join(sdir, "brain.ts"))).toBe(true);
    if (process.platform !== "win32") expect(statSync(join(sdir, "brain.ts")).mode & 0o111).toBe(0);
    rmSync(data, { recursive: true, force: true });
  });
});
