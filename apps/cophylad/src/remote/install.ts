// Finding and acquiring the host and the desktop viewer. Both are third-party GPL programs
// cophylad drives at arm's length: they are
// looked for at their installers' paths and, with `[remote] install`, fetched through the
// platform's package manager — winget on Windows, Homebrew on macOS, Flatpak on Linux — and
// never bundled. Apollo installs as `sunshine.exe` under `Apollo\`, so the kind is read off
// the path, not the file name. Apollo is Windows-only; on macOS Sunshine is a formula in
// LizardByte's tap, not a cask, and Homebrew's `brew` is often off a GUI start's PATH, so it
// is also looked for where its installer puts it.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RemoteConfig } from "../config/schema.ts";
import type { Exec } from "../sidecars/tts-py.ts";
import type { HostOs } from "../update/platform.ts";

export type HostKind = "apollo" | "sunshine";

export interface Located {
  kind: HostKind;
  path: string;
}

interface Env {
  [key: string]: string | undefined;
}

/** The host binaries where their installers put them, Apollo before Sunshine. */
export function hostCandidates(os: HostOs, env: Env = process.env): Located[] {
  switch (os) {
    case "windows": {
      const pf = env["ProgramFiles"] ?? "C:\\Program Files";
      return [
        { kind: "apollo", path: join(pf, "Apollo", "sunshine.exe") },
        { kind: "apollo", path: join(pf, "Apollo", "Apollo.exe") },
        { kind: "sunshine", path: join(pf, "Sunshine", "sunshine.exe") },
      ];
    }
    case "macos":
      return [
        { kind: "sunshine", path: "/opt/homebrew/bin/sunshine" },
        { kind: "sunshine", path: "/usr/local/bin/sunshine" },
        { kind: "sunshine", path: "/opt/local/bin/sunshine" },
        { kind: "sunshine", path: "/Applications/Sunshine.app/Contents/MacOS/sunshine" },
      ];
    default:
      return [
        { kind: "apollo", path: "/usr/bin/apollo" },
        { kind: "apollo", path: "/usr/local/bin/apollo" },
        { kind: "sunshine", path: "/usr/bin/sunshine" },
        { kind: "sunshine", path: "/usr/local/bin/sunshine" },
        { kind: "sunshine", path: "/var/lib/flatpak/exports/bin/dev.lizardbyte.app.Sunshine" },
      ];
  }
}

/** The moonlight-qt binary where its installers put it. */
export function moonlightCandidates(os: HostOs, env: Env = process.env): string[] {
  switch (os) {
    case "windows": {
      const pf = env["ProgramFiles"] ?? "C:\\Program Files";
      const pf86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
      return [
        join(pf, "Moonlight Game Streaming", "Moonlight.exe"),
        join(pf, "Moonlight Game Streaming Project", "Moonlight", "Moonlight.exe"),
        join(pf86, "Moonlight Game Streaming", "Moonlight.exe"),
      ];
    }
    case "macos":
      return ["/Applications/Moonlight.app/Contents/MacOS/Moonlight"];
    default:
      return ["/usr/bin/moonlight", "/usr/bin/moonlight-qt", "/usr/local/bin/moonlight", "/var/lib/flatpak/exports/bin/com.moonlight_stream.Moonlight"];
  }
}

/** The kind a path names: Apollo's tree, or a file called apollo, is Apollo. */
export function kindOf(path: string): HostKind {
  return /apollo/i.test(path) ? "apollo" : "sunshine";
}

/** The host to run: the configured command, else the first candidate on disk of the wanted kind. */
export function locateHost(config: RemoteConfig, os: HostOs, env: Env = process.env, exists: (p: string) => boolean = existsSync): Located | undefined {
  if (config.host_command) return { kind: kindOf(config.host_command), path: config.host_command };
  for (const c of hostCandidates(os, env)) {
    if (config.host !== "auto" && c.kind !== config.host) continue;
    if (exists(c.path)) return c;
  }
  return undefined;
}

export function locateMoonlight(config: RemoteConfig, os: HostOs, env: Env = process.env, exists: (p: string) => boolean = existsSync): string | undefined {
  if (config.moonlight) return config.moonlight;
  return moonlightCandidates(os, env).find((p) => exists(p));
}

/** The package manager command that installs a host of `kind`, or the viewer, on `os`. */
export function installCommand(what: HostKind | "moonlight", os: HostOs): string[] | undefined {
  const winget = (id: string) => ["winget", "install", "-e", "--id", id, "--accept-package-agreements", "--accept-source-agreements"];
  const brew = (...what: string[]) => ["brew", "install", ...what];
  const flatpak = (app: string) => ["flatpak", "install", "-y", "flathub", app];
  switch (what) {
    case "apollo":
      return os === "windows" ? winget("ClassicOldSong.Apollo") : undefined;
    case "sunshine":
      return os === "windows" ? winget("LizardByte.Sunshine") : os === "macos" ? brew("lizardbyte/homebrew/sunshine") : flatpak("dev.lizardbyte.app.Sunshine");
    case "moonlight":
      return os === "windows" ? winget("MoonlightGameStreamingProject.Moonlight") : os === "macos" ? brew("--cask", "moonlight") : flatpak("com.moonlight_stream.Moonlight");
  }
}

/** Homebrew's `brew`: on the PATH, else where its installer puts it (Apple Silicon, then Intel). */
export function brewPath(env: Env = process.env, exists: (p: string) => boolean = existsSync): string | undefined {
  const found = Bun.which("brew", { PATH: env["PATH"] ?? "" });
  if (found) return found;
  return ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find((p) => exists(p));
}

export interface InstallDeps {
  exec: Exec;
  os: HostOs;
  /** Where `brew` is: `brewPath()` when not given. */
  brew?: string;
  /** Each line the installer prints, for `remote.state.host.step`. */
  onLine?: (line: string) => void;
}

/** Runs the package manager; throws with its last words when it fails or when there is nothing to run. */
export async function install(what: HostKind | "moonlight", deps: InstallDeps): Promise<void> {
  const command = installCommand(what, deps.os);
  if (!command) throw new Error(`no package manager install for ${what} on ${deps.os}`);
  if (command[0] === "brew") {
    const brew = deps.brew ?? brewPath();
    if (!brew) throw new Error(`installing ${what} needs Homebrew (https://brew.sh), and it is not installed`);
    command[0] = brew;
  }
  const lines: string[] = [];
  const result = await deps.exec(command, {
    onLine: (line) => {
      const t = line.trim();
      if (!t) return;
      lines.push(t);
      deps.onLine?.(t);
    },
  });
  if (result.code !== 0) {
    const tail = lines.slice(-3).join(" | ") || result.stderr.trim().slice(-200) || `exit ${result.code}`;
    throw new Error(`${command[0]} exited ${result.code}: ${tail}`);
  }
}
