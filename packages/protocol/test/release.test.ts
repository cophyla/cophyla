// The release helpers: canonical JSON gives the same bytes whatever the key order, at every
// depth, with unicode intact and `undefined` dropped; the signed payload leaves out `url`
// and `signature` and nothing else; feed paths and file names follow the layout.

import { describe, expect, test } from "bun:test";
import { canonicalJson, feedPath, releaseFileName, releasePayload } from "../src/index.ts";

describe("canonicalJson", () => {
  test("sorts keys at every depth and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });

  test("two key orders give the same bytes", () => {
    const one = { version: "0.1.2", component: "brain", protocol: { max: 1, min: 1 }, size: 5 };
    const two = { size: 5, protocol: { min: 1, max: 1 }, component: "brain", version: "0.1.2" };
    expect(canonicalJson(one)).toBe(canonicalJson(two));
  });

  test("keeps unicode and escapes as JSON does; drops undefined fields, keeps null", () => {
    expect(canonicalJson({ name: "Ördek — ✓", gone: undefined, kept: null })).toBe('{"kept":null,"name":"Ördek — ✓"}');
  });

  test("arrays keep their order", () => {
    expect(canonicalJson([{ b: 1, a: 2 }, "x", 3])).toBe('[{"a":2,"b":1},"x",3]');
  });
});

describe("releasePayload", () => {
  const entry = {
    component: "brain",
    version: "0.1.2",
    channel: "stable",
    os: "windows",
    arch: "x64",
    protocol: { min: 1, max: 1 },
    url: "https://a.example/brain.exe",
    size: 10,
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    signature: "ed25519:abc",
    publishedAt: 1,
    future: { field: true },
  };

  test("leaves out url and signature, keeps everything else including unknown fields", () => {
    const payload = releasePayload(entry);
    expect(payload).not.toContain("a.example");
    expect(payload).not.toContain("ed25519:abc");
    expect(payload).toContain('"future":{"field":true}');
    expect(payload).toContain('"sha256":"e3b0c442');
  });

  test("a moved artifact has the same payload", () => {
    expect(releasePayload({ ...entry, url: "http://192.168.1.2:8790/artifacts/brain.exe" })).toBe(releasePayload(entry));
  });

  test("a changed field changes the payload", () => {
    expect(releasePayload({ ...entry, size: 11 })).not.toBe(releasePayload(entry));
  });
});

describe("layout", () => {
  test("feedPath", () => {
    expect(feedPath("stable", "windows", "x64")).toBe("stable/windows-x64.json");
  });

  test("releaseFileName derives from component, version and target unless the entry names one", () => {
    expect(releaseFileName({ component: "platform", version: "0.1.1", os: "windows", arch: "x64" })).toBe("platform-0.1.1-windows-x64.tar.gz");
    expect(releaseFileName({ component: "brain", version: "0.1.2", os: "windows", arch: "x64" })).toBe("brain-0.1.2-windows-x64.exe");
    expect(releaseFileName({ component: "brain", version: "0.1.2", os: "linux", arch: "x64" })).toBe("brain-0.1.2-linux-x64");
    expect(releaseFileName({ component: "model", version: "1.0.0", name: "tts-kokoro-en" })).toBe("model-tts-kokoro-en-1.0.0.tar.gz");
  });
});
