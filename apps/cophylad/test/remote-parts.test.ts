// The remote module's small parts: where the host and the viewer are looked for and how a
// missing one is installed on each platform; a JPEG's size read from its header; the host
// address moonlight is given; the Windows service's state read from `sc query`; the capture
// script's refusal of a display that is not there; the stream's size and bitrate picked from a
// screen; moonlight's window sized only while the user saved no settings of its own, read where
// each platform keeps them; its own window opened bare.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteConfig } from "../src/config/schema.ts";
import { silentLogger } from "../src/log.ts";
import { brewPath, hostCandidates, install, installCommand, kindOf, locateHost, locateMoonlight } from "../src/remote/install.ts";
import { hostOfEndpoint, Moonlight, moonlightSaved, randomPin } from "../src/remote/moonlight.ts";
import { streamVideo } from "../src/remote/quality.ts";
import { jpegSize, SCREEN_RECORDING_REFUSED, screenshotter } from "../src/remote/screenshot.ts";
import { windowsServiceState, windowsServiceStart } from "../src/remote/service.ts";
import { MoonlightWeb } from "../src/remote/web.ts";
import type { SidecarSpec, Sidecars } from "../src/sidecars/index.ts";
import { remoteSeams, TINY_JPEG } from "./fakes/remote.ts";

const config = (over: Record<string, unknown> = {}) => RemoteConfig.parse(over);

describe("remote parts", () => {
  test("the host is found where its installer puts it, Apollo first; Apollo's tree names it whatever the file is called", () => {
    const env = { ProgramFiles: "C:\\PF" };
    // joined as the code joins them, so the same paths on a test run off Windows
    const pf = (...parts: string[]) => join("C:\\PF", ...parts);
    const all = hostCandidates("windows", env).map((c) => `${c.kind} ${c.path}`);
    expect(all[0]).toBe(`apollo ${pf("Apollo", "sunshine.exe")}`);
    expect(all.at(-1)).toBe(`sunshine ${pf("Sunshine", "sunshine.exe")}`);
    const has = (paths: string[]) => (p: string) => paths.includes(p);
    expect(locateHost(config(), "windows", env, has([pf("Sunshine", "sunshine.exe"), pf("Apollo", "sunshine.exe")]))).toEqual({ kind: "apollo", path: pf("Apollo", "sunshine.exe") });
    expect(locateHost(config({ host: "sunshine" }), "windows", env, has([pf("Sunshine", "sunshine.exe"), pf("Apollo", "sunshine.exe")]))).toEqual({ kind: "sunshine", path: pf("Sunshine", "sunshine.exe") });
    expect(locateHost(config(), "windows", env, has([]))).toBeUndefined();
    expect(locateHost(config({ host_command: "D:\\apps\\Apollo\\sunshine.exe" }), "windows", env, has([]))).toEqual({ kind: "apollo", path: "D:\\apps\\Apollo\\sunshine.exe" });
    expect(kindOf("/usr/bin/sunshine")).toBe("sunshine");
    expect(locateMoonlight(config(), "windows", env, has([pf("Moonlight Game Streaming", "Moonlight.exe")]))).toBe(pf("Moonlight Game Streaming", "Moonlight.exe"));
    expect(locateMoonlight(config(), "macos", env, has(["/Applications/Moonlight.app/Contents/MacOS/Moonlight"]))).toBe("/Applications/Moonlight.app/Contents/MacOS/Moonlight");
  });

  test("a Mac runs Sunshine: Apollo is Windows-only, and Homebrew's formula lands in its prefix", () => {
    expect(hostCandidates("macos").every((c) => c.kind === "sunshine")).toBe(true);
    const has = (paths: string[]) => (p: string) => paths.includes(p);
    expect(locateHost(config(), "macos", {}, has(["/opt/homebrew/bin/sunshine"]))).toEqual({ kind: "sunshine", path: "/opt/homebrew/bin/sunshine" });
    expect(locateHost(config({ host: "apollo" }), "macos", {}, has(["/opt/homebrew/bin/sunshine"]))).toBeUndefined();
  });

  test("a missing host or viewer is installed through the platform's package manager; a failure names its last words", async () => {
    expect(installCommand("apollo", "windows")).toEqual(["winget", "install", "-e", "--id", "ClassicOldSong.Apollo", "--accept-package-agreements", "--accept-source-agreements"]);
    expect(installCommand("moonlight", "windows")!.slice(0, 5)).toEqual(["winget", "install", "-e", "--id", "MoonlightGameStreamingProject.Moonlight"]);
    expect(installCommand("sunshine", "macos")).toEqual(["brew", "install", "lizardbyte/homebrew/sunshine"]);
    expect(installCommand("moonlight", "macos")).toEqual(["brew", "install", "--cask", "moonlight"]);
    expect(installCommand("apollo", "macos")).toBeUndefined();
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

  test("brew is found off the PATH where Homebrew installs it, and its absence is said plainly", async () => {
    expect(brewPath({ PATH: "" }, (p) => p === "/usr/local/bin/brew")).toBe("/usr/local/bin/brew");
    expect(brewPath({ PATH: "" }, (p) => p === "/opt/homebrew/bin/brew" || p === "/usr/local/bin/brew")).toBe("/opt/homebrew/bin/brew");
    expect(brewPath({ PATH: "" }, () => false)).toBeUndefined();
    const commands: string[][] = [];
    const exec = async (command: string[]) => {
      commands.push(command);
      return { code: 0, stdout: "", stderr: "" };
    };
    await install("sunshine", { exec, os: "macos", brew: "/opt/homebrew/bin/brew" });
    expect(commands[0]).toEqual(["/opt/homebrew/bin/brew", "install", "lizardbyte/homebrew/sunshine"]);
    await expect(install("moonlight", { exec, os: "macos", brew: "" })).rejects.toThrow(/needs Homebrew/);
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

  test("a stream is asked for at its host's screen size, 60 fps and a quarter bit per pixel per frame, held to 10–150 Mbps; across the internet to 15", () => {
    expect(streamVideo({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080, fps: 60, bitrate: 31104 });
    expect(streamVideo({ width: 1920, height: 1200 })).toEqual({ width: 1920, height: 1200, fps: 60, bitrate: 34560 });
    expect(streamVideo({ width: 2560, height: 1440 }).bitrate).toBe(55296);
    expect(streamVideo({ width: 3840, height: 2160 }).bitrate).toBe(124416);
    // no screen to go by: 1080p
    expect(streamVideo(undefined)).toEqual({ width: 1920, height: 1080, fps: 60, bitrate: 31104 });
    // held to the bounds
    expect(streamVideo({ width: 1280, height: 720 }).bitrate).toBe(13824);
    expect(streamVideo({ width: 800, height: 600 }).bitrate).toBe(10000);
    expect(streamVideo({ width: 7680, height: 4320 }).bitrate).toBe(150000);
    // away from the LAN: the size kept, the bitrate held to 15 Mbps, a small one left as it is
    expect(streamVideo({ width: 1920, height: 1200 }, { away: true })).toEqual({ width: 1920, height: 1200, fps: 60, bitrate: 15000 });
    expect(streamVideo({ width: 800, height: 600 }, { away: true }).bitrate).toBe(10000);
  });

  test("moonlight's window is sized only when given a size; its settings window opens bare", async () => {
    const seams = remoteSeams();
    const moonlight = new Moonlight({ command: async () => seams.moonlight, exec: seams.exec, spawn: seams.spawn, log: silentLogger });
    await moonlight.stream("192.168.1.44", "Desktop", { width: 1920, height: 1200, fps: 60, bitrate: 34560 });
    await moonlight.stream("192.168.1.44");
    await moonlight.settings();
    expect(seams.children.map((c) => c.args.join(" "))).toEqual([
      "stream 192.168.1.44 Desktop --resolution 1920x1200 --fps 60 --bitrate 34560 --display-mode windowed --absolute-mouse --quit-after",
      "stream 192.168.1.44 Desktop --display-mode windowed --absolute-mouse --quit-after",
      "",
    ]);
    // the settings window is the user's: a new stream ends the last stream, never it
    expect(seams.children.map((c) => c.killed)).toEqual([true, false, false]);
  });

  test("the user's saved moonlight settings are read where each platform keeps them: the registry, the defaults, the INI file", async () => {
    const seams = remoteSeams();
    expect(await moonlightSaved("windows", seams.exec)).toBe(false);
    expect(await moonlightSaved("macos", seams.exec)).toBe(false);
    seams.moonlightSaved = true;
    expect(await moonlightSaved("windows", seams.exec)).toBe(true);
    expect(await moonlightSaved("macos", seams.exec)).toBe(true);
    expect(seams.commands).toContain("reg query HKCU\\Software\\Moonlight Game Streaming Project\\Moonlight /v width");
    expect(seams.commands).toContain("defaults read com.moonlight-stream.Moonlight width");
    // a runner that cannot run is no settings
    expect(await moonlightSaved("windows", async () => Promise.reject(new Error("no reg")))).toBe(false);
    // Linux: the native file under XDG_CONFIG_HOME, or the flatpak's own
    const files = new Map<string, string>();
    const read = (p: string) => {
      const text = files.get(p);
      if (text === undefined) throw new Error("ENOENT");
      return text;
    };
    const env = { HOME: "/home/u", XDG_CONFIG_HOME: "/home/u/.config" };
    const native = join("/home/u/.config", "Moonlight Game Streaming Project", "Moonlight.conf");
    const flatpak = join("/home/u", ".var", "app", "com.moonlight_stream.Moonlight", "config", "Moonlight Game Streaming Project", "Moonlight.conf");
    expect(await moonlightSaved("linux", seams.exec, env, read)).toBe(false);
    files.set(native, "[General]\ncertificate=@ByteArray(x)\n");
    expect(await moonlightSaved("linux", seams.exec, env, read)).toBe(false);
    files.set(flatpak, "[General]\nbitrate=20000\nwidth=2560\nheight=1440\n");
    expect(await moonlightSaved("linux", seams.exec, env, read)).toBe(true);
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

  test("a platform with no moonlight-web release runs the web-server [remote] web_server names, in its own folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cophyla-web-"));
    try {
      const specs: SidecarSpec[] = [];
      const sidecars = {
        spawn: (spec: SidecarSpec) => {
          specs.push(spec);
          return { start: async () => {}, state: () => ({ status: "ready" }), url: "http://127.0.0.1:1", port: 1 };
        },
        forget: () => {},
      } as unknown as Sidecars;
      const web = (over: Record<string, unknown>) =>
        new MoonlightWeb({ root: join(dir, "root"), sidecars, config: config(over), log: silentLogger, target: "macos-arm64", lanIps: () => [], pairOn: async () => {}, viewerName: "mac web" });
      await expect(web({}).ensure()).rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("[remote] web_server") });
      await expect(web({ web_server: join(dir, "nowhere", "web-server") }).ensure()).rejects.toMatchObject({ code: "unavailable" });
      const own = join(dir, "build", "web-server");
      await Bun.write(own, "");
      await web({ web_server: own }).ensure();
      expect(specs.map((s) => [s.command, s.cwd])).toEqual([[own, join(dir, "build")]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a Mac without Screen Recording is asked once and refused, not shown its wallpaper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cophyla-shot-"));
    try {
      let allowed = false;
      let asked = 0;
      const calls: string[] = [];
      const capture = screenshotter({
        dir,
        os: "macos",
        log: silentLogger,
        screenAccess: { allowed: () => allowed, ask: () => void asked++ },
        exec: async (file, args) => {
          calls.push(file);
          if (file === "screencapture") await Bun.write(args.at(-1)!, TINY_JPEG);
          return { code: 0, out: "", err: "" };
        },
      });
      await expect(capture(undefined, 640)).rejects.toMatchObject({ code: "unavailable", message: SCREEN_RECORDING_REFUSED });
      await expect(capture(undefined, 640)).rejects.toMatchObject({ code: "unavailable" });
      expect(asked).toBe(1);
      expect(calls).toEqual([]);
      allowed = true;
      expect((await capture(undefined, 640)).width).toBe(1);
      expect(calls).toEqual(["screencapture", "sips"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
