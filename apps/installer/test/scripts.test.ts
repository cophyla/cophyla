// The pure parts of the release scripts: the per-OS names, the Mach-O sniff, the bundle
// overlay, the publish plan. What each script does with a real bundler is the per-OS build's
// job (the PM/PL runbooks in the README).

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Release } from "@cophyla/protocol";
import { BUN_NAMES, NET_PATHS, SHELL_PATHS } from "../../cophylad/src/update/platform.ts";
import { BUN_NAME, bundleArch, findMachO, installerNames, isMachO, isMachOHeader, MODEL_NAME, NET, NET_LICENCES, NET_LICENCES_REL, NET_REL, OS, parseSignArgs, parseTarget, releaseTag, SHELL_REL, sherpaBinaryPackage, TARGETS } from "../scripts/lib.ts";
import { feedFilesFor, mergeInto, releaseKey } from "../scripts/feed.ts";
import { LAUNCHER_IDENTIFIER, overlayFor } from "../scripts/overlay.ts";
import { installerAssets, mergePlan } from "../scripts/publish.ts";

describe("names", () => {
  test("the shell and runtime names are this host's entries of the cophylad tables", () => {
    expect(SHELL_REL).toBe(SHELL_PATHS[OS]);
    expect(BUN_NAME).toBe(BUN_NAMES[OS]);
    expect(SHELL_PATHS.windows).toBe("cophyla-ui.exe");
    expect(SHELL_PATHS.macos).toBe("Cophyla.app/Contents/MacOS/cophyla-ui");
    expect(SHELL_PATHS.linux).toBe("cophyla-ui");
  });

  test("cophyla-net sits in the version folder's bin/, its crates' licences beside it, generated in its workspace", () => {
    expect(NET_REL).toBe(NET_PATHS[OS]);
    expect(NET_PATHS).toEqual({ windows: "bin/cophyla-net.exe", macos: "bin/cophyla-net", linux: "bin/cophyla-net" });
    expect(NET_LICENCES_REL).toBe("bin/cophyla-net-THIRD-PARTY-LICENSES.html");
    const licences = readFileSync(join(NET, NET_LICENCES), "utf8");
    expect(licences).toContain("cophyla-net: third-party licences");
    expect(licences).toContain(">rtc 0.21.0<");
    expect(licences).toContain(">portmapper 0.19.3<");
  });

  test("sign.ts takes its flags anywhere, and the entitlements file is never the file to sign", () => {
    expect(parseSignArgs(["--staged", "a.exe"])).toEqual({ staged: true, tree: false, file: "a.exe" });
    expect(parseSignArgs(["--staged", "--entitlements", "net.plist", "bin/cophyla-net"])).toEqual({ staged: true, tree: false, entitlements: "net.plist", file: "bin/cophyla-net" });
    expect(parseSignArgs(["--tree", "dir", "--entitlements", "x.plist"])).toEqual({ staged: false, tree: true, entitlements: "x.plist", file: "dir" });
    expect(parseSignArgs([])).toEqual({ staged: false, tree: false });
  });

  test("installer names follow the bundler's per target", () => {
    expect(installerNames("windows", "x64", "0.1.2")).toEqual({ installer: "Cophyla_0.1.2_x64-setup.exe", bundleDir: "nsis" });
    expect(installerNames("macos", "arm64", "0.1.2")).toEqual({ installer: "Cophyla_0.1.2_aarch64.dmg", bundleDir: "dmg" });
    expect(installerNames("macos", "x64", "0.1.2").installer).toBe("Cophyla_0.1.2_x64.dmg");
    expect(installerNames("linux", "x64", "0.1.2")).toEqual({ installer: "Cophyla_0.1.2_amd64.deb", bundleDir: "deb", appimage: "Cophyla_0.1.2_amd64.AppImage" });
    expect(installerNames("linux", "arm64", "0.1.2").installer).toBe("Cophyla_0.1.2_arm64.deb");
    expect(bundleArch("windows", "arm64")).toBe("aarch64");
  });

  test("a release's tag is its component's, and a model's carries its name", () => {
    expect(releaseTag("platform", "0.2.0")).toBe("platform-v0.2.0");
    expect(releaseTag("brain", "0.4.0")).toBe("brain-v0.4.0");
    expect(releaseTag("model", "1.0.0", "tts-kokoro-en")).toBe("model-tts-kokoro-en-v1.0.0");
  });

  test("a model name is lowercase with dots and dashes, and not empty", () => {
    for (const ok of ["tts-kokoro-en", "wake-openwakeword", "stt-nemotron-3.5-streaming-int8", "vad-silero"]) expect(MODEL_NAME.test(ok)).toBe(true);
    for (const bad of ["", "a", "Tts-Kokoro", "tts_kokoro", "-leading", "tts kokoro", "../escape", "x".repeat(65)]) expect(MODEL_NAME.test(bad)).toBe(false);
  });

  test("sherpa's native package is named from node's own words, with win32 spelled win", () => {
    expect(sherpaBinaryPackage("win32", "x64")).toBe("sherpa-onnx-win-x64");
    expect(sherpaBinaryPackage("darwin", "arm64")).toBe("sherpa-onnx-darwin-arm64");
    expect(sherpaBinaryPackage("linux", "x64")).toBe("sherpa-onnx-linux-x64");
  });

  test("targets parse as the feed names them", () => {
    expect(parseTarget("macos-arm64")).toEqual({ os: "macos", arch: "arm64" });
    expect(parseTarget("linux-x64")).toEqual({ os: "linux", arch: "x64" });
    expect(parseTarget("windows-x64")).toEqual({ os: "windows", arch: "x64" });
    expect(parseTarget("darwin-arm64")).toBeUndefined();
    expect(parseTarget("macos")).toBeUndefined();
  });
});

describe("mach-o", () => {
  const dir = mkdtempSync(join(tmpdir(), "cophyla-macho-"));
  const write = (rel: string, bytes: number[] | string) => {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof bytes === "string" ? bytes : Buffer.from(bytes));
    return path;
  };

  test("sniffs thin and fat headers in either byte order, and nothing else", () => {
    expect(isMachOHeader(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))).toBe(true); // arm64/x86_64 thin, little-endian
    expect(isMachOHeader(Buffer.from([0xfe, 0xed, 0xfa, 0xcf]))).toBe(true);
    expect(isMachOHeader(Buffer.from([0xce, 0xfa, 0xed, 0xfe]))).toBe(true);
    expect(isMachOHeader(Buffer.from([0xca, 0xfe, 0xba, 0xbe]))).toBe(true); // fat
    expect(isMachOHeader(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toBe(false); // PE
    expect(isMachOHeader(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBe(false); // ELF
    expect(isMachOHeader(Buffer.from([0xcf]))).toBe(false);
    const binary = write("node_modules/pty/build/pty.node", [0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
    const script = write("node_modules/pty/index.js", "module.exports = 1;\n");
    const short = write("node_modules/pty/empty", []);
    expect(isMachO(binary)).toBe(true);
    expect(isMachO(script)).toBe(false);
    expect(isMachO(short)).toBe(false);
    expect(isMachO(join(dir, "missing"))).toBe(false);
  });

  test("findMachO walks a tree and skips bundles", () => {
    write("node_modules/other/lib.dylib", [0xcf, 0xfa, 0xed, 0xfe]);
    write("node_modules/Some.app/Contents/MacOS/some", [0xcf, 0xfa, 0xed, 0xfe]);
    const found = findMachO(join(dir, "node_modules")).map((p) => p.slice(dir.length + 1).replace(/\\/g, "/"));
    expect(found).toEqual(["node_modules/other/lib.dylib", "node_modules/pty/build/pty.node"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("overlay", () => {
  const env = { bun: "C:\\bun.exe", signScript: "C:\\repo\\apps\\installer\\scripts\\sign.ts" };

  test("windows keeps the shell's identifier, writes the root straight and signs through sign.ts", () => {
    const o = overlayFor("windows", "0.1.2", env) as { version: string; identifier?: string; bundle: { targets?: string[]; resources: Record<string, string>; windows: { signCommand: { cmd: string; args: string[] } } } };
    expect(o.version).toBe("0.1.2");
    expect(o.identifier).toBeUndefined();
    expect(o.bundle.targets).toBeUndefined();
    expect(o.bundle.resources).toEqual({ "../stage/versions/0.1.2": "versions/0.1.2", "../stage/current": "current", "../stage/brain": "brain" });
    expect(o.bundle.windows.signCommand).toEqual({ cmd: "C:\\bun.exe", args: ["run", "C:\\repo\\apps\\installer\\scripts\\sign.ts", "%1"] });
  });

  test("macos and linux take the launcher's identifier and map the root under seed/", () => {
    const mac = overlayFor("macos", "0.1.2", { ...env, appleSigningIdentity: "Developer ID Application: X (TEAM)" }) as { identifier: string; bundle: { targets: string[]; resources: Record<string, string>; macOS: { signingIdentity: string; minimumSystemVersion: string } } };
    expect(mac.identifier).toBe(LAUNCHER_IDENTIFIER);
    expect(mac.bundle.targets).toEqual(["app", "dmg"]);
    expect(mac.bundle.resources).toEqual({ "../stage/versions/0.1.2": "seed/versions/0.1.2", "../stage/current": "seed/current", "../stage/brain": "seed/brain" });
    expect(mac.bundle.macOS).toEqual({ signingIdentity: "Developer ID Application: X (TEAM)", minimumSystemVersion: "11.0" });
    const adhoc = overlayFor("macos", "0.1.2", env) as { bundle: { macOS: { signingIdentity: string } } };
    expect(adhoc.bundle.macOS.signingIdentity).toBe("-");
    const deb = overlayFor("linux", "0.1.2", env) as { identifier: string; bundle: { targets: string[]; resources: Record<string, string> } };
    expect(deb.identifier).toBe(LAUNCHER_IDENTIFIER);
    expect(deb.bundle.targets).toEqual(["deb"]);
    expect(deb.bundle.resources["../stage/current"]).toBe("seed/current");
    expect((overlayFor("linux", "0.1.2", env, { appimage: true }) as { bundle: { targets: string[] } }).bundle.targets).toEqual(["appimage"]);
    expect(JSON.stringify(deb)).not.toContain("sign");
  });
});

describe("publish plan", () => {
  const repo = "cophyla/cophyla";
  const url = (tag: string, name: string) => `https://github.com/${repo}/releases/download/${tag}/${name}`;
  const entry = (component: "platform" | "brain", version: string, os: string, arch: string, name: string, over: Partial<Release> = {}): Release =>
    ({ component, name, version, channel: "stable", os, arch, protocol: { min: 1, max: 1 }, url: url(`${component}-v${version}`, name), size: 1, sha256: "0".repeat(64), publishedAt: 1, signature: "ed25519:x", ...over }) as Release;

  test("takes every target of a version with a matching entry beside it, and reports the rest", () => {
    const out = "/out";
    const entries: Record<string, Release> = {
      [join(out, "platform-0.1.2-windows-x64.tar.gz.release.json")]: entry("platform", "0.1.2", "windows", "x64", "platform-0.1.2-windows-x64.tar.gz"),
      [join(out, "platform-0.1.2-macos-arm64.tar.gz.release.json")]: entry("platform", "0.1.2", "macos", "arm64", "platform-0.1.2-macos-arm64.tar.gz"),
      [join(out, "platform-0.1.2-linux-x64.tar.gz.release.json")]: entry("platform", "0.1.2", "linux", "x64", "platform-0.1.2-linux-x64.tar.gz", { url: "http://192.168.1.2:8790/x" }),
      [join(out, "platform-0.1.2-linux-arm64.tar.gz.release.json")]: entry("platform", "0.1.2", "linux", "arm64", "platform-0.1.2-linux-arm64.tgz"),
      [join(out, "brain-0.1.3-windows-x64.exe.release.json")]: entry("brain", "0.1.3", "windows", "x64", "brain-0.1.3-windows-x64.exe"),
    };
    const files = [
      "platform-0.1.2-windows-x64.tar.gz",
      "platform-0.1.2-windows-x64.tar.gz.release.json",
      "platform-0.1.2-macos-arm64.tar.gz",
      "platform-0.1.2-macos-arm64.tar.gz.release.json",
      "platform-0.1.2-linux-x64.tar.gz",
      "platform-0.1.2-linux-x64.tar.gz.release.json",
      "platform-0.1.2-linux-arm64.tar.gz",
      "platform-0.1.2-linux-arm64.tar.gz.release.json",
      "platform-0.1.2-freebsd-x64.tar.gz",
      "platform-0.1.1-windows-x64.tar.gz",
      "brain-0.1.3-windows-x64.exe",
      "brain-0.1.3-windows-x64.exe.release.json",
      "Cophyla_0.1.2_x64-setup.exe",
      "Cophyla_0.1.2_aarch64.dmg",
      "Cophyla_0.1.1_amd64.deb",
    ];
    const plan = mergePlan("platform", "0.1.2", files, (p) => entries[p], repo, out);
    expect(plan.tag).toBe("platform-v0.1.2");
    expect(plan.assets.map((a) => a.target)).toEqual(["macos-arm64", "windows-x64"]);
    expect(plan.assets[0]).toEqual({ artifact: join(out, "platform-0.1.2-macos-arm64.tar.gz"), entry: join(out, "platform-0.1.2-macos-arm64.tar.gz.release.json"), target: "macos-arm64" });
    expect(plan.problems).toEqual([
      "platform-0.1.2-freebsd-x64.tar.gz has no .release.json beside it",
      "platform-0.1.2-linux-arm64.tar.gz is named for the feed as platform-0.1.2-linux-arm64.tgz",
      `platform-0.1.2-linux-x64.tar.gz's entry names http://192.168.1.2:8790/x, not ${url("platform-v0.1.2", "platform-0.1.2-linux-x64.tar.gz")}; sign-release without --url for the public feed`,
    ]);
    const brain = mergePlan("brain", "0.1.3", files, (p) => entries[p], repo, out);
    expect(brain.assets.map((a) => a.target)).toEqual(["windows-x64"]);
    expect(brain.problems).toEqual([]);
    expect(mergePlan("brain", "0.1.4", files, (p) => entries[p], repo, out).problems).toEqual(["nothing in /out for brain 0.1.4"]);
    expect(installerAssets("0.1.2", files)).toEqual(["Cophyla_0.1.2_aarch64.dmg", "Cophyla_0.1.2_x64-setup.exe"]);
  });
});

describe("model releases", () => {
  const repo = "cophyla/cophyla";
  const model = (name: string, version: string, channel = "stable"): Release =>
    ({
      component: "model",
      name,
      version,
      channel,
      url: `https://github.com/${repo}/releases/download/model-${name}-v${version}/model-${name}-${version}.tar.gz`,
      size: 2,
      sha256: "1".repeat(64),
      publishedAt: 2,
      signature: "ed25519:y",
    }) as Release;

  test("a model is keyed by its name as well, so two models of one version do not collide", () => {
    expect(releaseKey(model("tts-kokoro-en", "1.0.0"))).toBe("model/tts-kokoro-en@1.0.0");
    expect(releaseKey(model("vad-silero", "1.0.0"))).toBe("model/vad-silero@1.0.0");
    expect(releaseKey({ component: "platform", version: "0.2.0" })).toBe("platform@0.2.0");
    expect(releaseKey({ component: "brain", version: "0.2.0" })).toBe("brain@0.2.0");
  });

  test("a model goes into every target's file of its channel, and nothing else's", () => {
    expect(feedFilesFor(model("tts-kokoro-en", "1.0.0"))).toEqual([
      "stable/linux-arm64.json",
      "stable/linux-x64.json",
      "stable/macos-arm64.json",
      "stable/macos-x64.json",
      "stable/windows-x64.json",
    ]);
    expect(TARGETS).toHaveLength(5);
    // A file already in the feed is kept, even for a target TARGETS does not name yet…
    expect(feedFilesFor(model("vad-silero", "1.0.0"), ["stable/freebsd-x64.json", "beta/windows-x64.json"])).toContain("stable/freebsd-x64.json");
    // …but another channel's is left alone.
    expect(feedFilesFor(model("vad-silero", "1.0.0"), ["beta/windows-x64.json"])).not.toContain("beta/windows-x64.json");
    expect(feedFilesFor(model("vad-silero", "1.0.0", "beta"))[0]).toBe("beta/linux-arm64.json");
  });

  test("a platform or a brain goes into the one file for its target", () => {
    const platform = { component: "platform", version: "0.2.0", channel: "stable", os: "macos", arch: "arm64" } as Release;
    expect(feedFilesFor(platform, ["stable/windows-x64.json"])).toEqual(["stable/macos-arm64.json"]);
  });

  test("merging replaces the same release and leaves the others, newest of a component first", () => {
    const kokoro = model("tts-kokoro-en", "1.0.0");
    const silero = model("vad-silero", "1.0.0");
    const platform = { component: "platform", version: "0.1.9", channel: "stable", os: "windows", arch: "x64" } as Release;
    let releases = mergeInto(mergeInto(mergeInto([], platform), kokoro), silero);
    expect(releases.map(releaseKey)).toEqual(["model/tts-kokoro-en@1.0.0", "model/vad-silero@1.0.0", "platform@0.1.9"]);
    // The same model at the same version replaces its entry rather than doubling it.
    releases = mergeInto(releases, { ...kokoro, size: 99 } as Release);
    expect(releases).toHaveLength(3);
    expect(releases.find((r) => r.name === "tts-kokoro-en")?.size).toBe(99);
    // A newer version of the same model sits above the old one, which is kept for a rollback.
    releases = mergeInto(releases, model("tts-kokoro-en", "1.1.0"));
    expect(releases.map(releaseKey)).toEqual(["model/tts-kokoro-en@1.1.0", "model/tts-kokoro-en@1.0.0", "model/vad-silero@1.0.0", "platform@0.1.9"]);
  });

  test("one artifact, named for the model, published under the model's own tag", () => {
    const out = "/out";
    const entries: Record<string, Release> = {
      [join(out, "model-tts-kokoro-en-1.0.0.tar.gz.release.json")]: model("tts-kokoro-en", "1.0.0"),
      [join(out, "model-vad-silero-1.0.0.tar.gz.release.json")]: model("vad-silero", "1.0.0"),
    };
    const files = ["model-tts-kokoro-en-1.0.0.tar.gz", "model-tts-kokoro-en-1.0.0.tar.gz.release.json", "model-vad-silero-1.0.0.tar.gz", "model-vad-silero-1.0.0.tar.gz.release.json"];
    const plan = mergePlan("model", "1.0.0", files, (p) => entries[p], repo, out, "tts-kokoro-en");
    expect(plan.tag).toBe("model-tts-kokoro-en-v1.0.0");
    expect(plan.title).toBe("tts-kokoro-en 1.0.0");
    // A model runs anywhere the platform does, so the plan names no target.
    expect(plan.assets).toEqual([{ artifact: join(out, "model-tts-kokoro-en-1.0.0.tar.gz"), entry: join(out, "model-tts-kokoro-en-1.0.0.tar.gz.release.json"), target: "any" }]);
    expect(plan.problems).toEqual([]);
    // The other model in the same directory is not swept in by a version match.
    expect(mergePlan("model", "1.0.0", files, (p) => entries[p], repo, out, "stt-nemotron").problems).toEqual(["nothing in /out for stt-nemotron 1.0.0"]);
  });
});
