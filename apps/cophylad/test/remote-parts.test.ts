// The remote module's small parts: where the host and the viewer are looked for and how a
// missing one is installed on each platform; a JPEG's size read from its header; the host
// address moonlight is given; the Windows service's state read from `sc query`; the capture
// script's refusal of a display that is not there.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteConfig } from "../src/config/schema.ts";
import { silentLogger } from "../src/log.ts";
import { hostCandidates, install, installCommand, kindOf, locateHost, locateMoonlight } from "../src/remote/install.ts";
import { hostOfEndpoint, randomPin } from "../src/remote/moonlight.ts";
import { jpegSize, screenshotter } from "../src/remote/screenshot.ts";
import { windowsServiceState, windowsServiceStart } from "../src/remote/service.ts";
import { remoteSeams, TINY_JPEG } from "./fakes/remote.ts";

const config = (over: Record<string, unknown> = {}) => RemoteConfig.parse(over);

describe("remote parts", () => {
  test("the host is found where its installer puts it, Apollo first; Apollo's tree names it whatever the file is called", () => {
    const env = { ProgramFiles: "C:\\PF" };
    const all = hostCandidates("windows", env).map((c) => `${c.kind} ${c.path}`);
    expect(all[0]).toBe("apollo C:\\PF\\Apollo\\sunshine.exe");
    expect(all.at(-1)).toBe("sunshine C:\\PF\\Sunshine\\sunshine.exe");
    const has = (paths: string[]) => (p: string) => paths.includes(p);
    expect(locateHost(config(), "windows", env, has(["C:\\PF\\Sunshine\\sunshine.exe", "C:\\PF\\Apollo\\sunshine.exe"]))).toEqual({ kind: "apollo", path: "C:\\PF\\Apollo\\sunshine.exe" });
    expect(locateHost(config({ host: "sunshine" }), "windows", env, has(["C:\\PF\\Sunshine\\sunshine.exe", "C:\\PF\\Apollo\\sunshine.exe"]))).toEqual({ kind: "sunshine", path: "C:\\PF\\Sunshine\\sunshine.exe" });
    expect(locateHost(config(), "windows", env, has([]))).toBeUndefined();
    expect(locateHost(config({ host_command: "D:\\apps\\Apollo\\sunshine.exe" }), "windows", env, has([]))).toEqual({ kind: "apollo", path: "D:\\apps\\Apollo\\sunshine.exe" });
    expect(kindOf("/usr/bin/sunshine")).toBe("sunshine");
    expect(locateMoonlight(config(), "windows", env, has(["C:\\PF\\Moonlight Game Streaming\\Moonlight.exe"]))).toBe("C:\\PF\\Moonlight Game Streaming\\Moonlight.exe");
    expect(locateMoonlight(config(), "macos", env, has(["/Applications/Moonlight.app/Contents/MacOS/Moonlight"]))).toBe("/Applications/Moonlight.app/Contents/MacOS/Moonlight");
  });

  test("a missing host or viewer is installed through the platform's package manager; a failure names its last words", async () => {
    expect(installCommand("apollo", "windows")).toEqual(["winget", "install", "-e", "--id", "ClassicOldSong.Apollo", "--accept-package-agreements", "--accept-source-agreements"]);
    expect(installCommand("moonlight", "windows")!.slice(0, 5)).toEqual(["winget", "install", "-e", "--id", "MoonlightGameStreamingProject.Moonlight"]);
    expect(installCommand("sunshine", "macos")).toEqual(["brew", "install", "--cask", "sunshine"]);
    expect(installCommand("moonlight", "linux")).toEqual(["flatpak", "install", "-y", "flathub", "com.moonlight_stream.Moonlight"]);
    expect(installCommand("apollo", "linux")).toBeUndefined();
    const ok = remoteSeams();
    const lines: string[] = [];
    await install("apollo", { exec: ok.exec, os: "windows", onLine: (l) => lines.push(l) });
    expect(lines).toContain("Successfully installed");
    const bad = remoteSeams({ installOk: false });
    await expect(install("apollo", { exec: bad.exec, os: "windows" })).rejects.toThrow(/winget exited 1/);
    await expect(install("apollo", { exec: ok.exec, os: "linux" })).rejects.toThrow(/no package manager install/);
  });

  test("the Windows service's state comes from sc query; starting it is reported, not retried", async () => {
    const running = remoteSeams({ service: "RUNNING" });
    expect((await windowsServiceState("apollo", running.exec)).state).toBe("running");
    const stopped = remoteSeams({ service: "STOPPED" });
    expect(await windowsServiceState("apollo", stopped.exec)).toEqual({ state: "stopped", detail: "service ApolloService is stopped" });
    expect((await windowsServiceStart("apollo", stopped.exec)).ok).toBe(true);
    const absent = remoteSeams({ service: "absent" });
    expect(await windowsServiceState("sunshine", absent.exec)).toEqual({ state: "absent", detail: "service SunshineService is not installed" });
  });

  test("a JPEG's size is read from its frame header; anything else has none", () => {
    expect(jpegSize(TINY_JPEG)).toEqual({ width: 1, height: 1 });
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
    expect(jpegSize(new Uint8Array([]))).toBeUndefined();
  });

  test("moonlight is given the host without the port; a pin is four digits", () => {
    expect(hostOfEndpoint("192.168.1.44:4818")).toBe("192.168.1.44");
    expect(hostOfEndpoint("[fe80::1%eth0]:4818")).toBe("fe80::1%eth0");
    expect(hostOfEndpoint("desk.local")).toBe("desk.local");
    expect(hostOfEndpoint("fe80::1")).toBe("fe80::1");
    for (let i = 0; i < 50; i++) expect(randomPin()).toMatch(/^[1-9]\d{3}$/);
  });

  test("the capture reads the file its command wrote and reports a missing display as not found", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cophyla-shot-"));
    try {
      const calls: string[][] = [];
      const capture = screenshotter({
        dir,
        os: "windows",
        log: silentLogger,
        exec: async (file, args) => {
          calls.push([file, ...args]);
          const display = args[args.indexOf("-Display") + 1];
          if (display === "5") return { code: 1, out: "", err: "no display 5 (this node has 2)" };
          await Bun.write(args[args.indexOf("-Out") + 1]!, TINY_JPEG);
          return { code: 0, out: "1x1", err: "" };
        },
      });
      const shot = await capture(1, 640);
      expect(shot).toEqual({ mime: "image/jpeg", base64: TINY_JPEG.toString("base64"), width: 1, height: 1, display: 1 });
      expect(calls[0]!.slice(0, 7)).toEqual(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(dir, "screenshot.ps1")]);
      expect(calls[0]).toContain("640");
      await expect(capture(5, 640)).rejects.toMatchObject({ code: "not_found" });
      const linux = screenshotter({ dir, os: "linux", log: silentLogger, env: {}, exec: async () => ({ code: 0, out: "", err: "" }) });
      await expect(linux(undefined, 640)).rejects.toMatchObject({ code: "unsupported" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
