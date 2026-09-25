// What the release scripts share: where things are, running a command and failing loudly,
// the version rule, the signing tool, and the release key's whereabouts. Nothing here reads
// a secret from a file inside the repository.

import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BUN_NAMES, hostOs, NET_PATHS, SHELL_PATHS, TETHER_PATHS } from "../../cophylad/src/update/platform.ts";
import type { HostOs } from "../../cophylad/src/update/platform.ts";

export const REPO = resolve(import.meta.dir, "..", "..", "..");
export const INSTALLER = join(REPO, "apps", "installer");
/** Everything a release build produces, gitignored: version trees, the brain seed, overlays, out/, feed/. */
export const STAGE = join(INSTALLER, "stage");
export const OUT = join(STAGE, "out");
export const FEED_DIR = join(STAGE, "feed");
export const COPHYLAD = join(REPO, "apps", "cophylad");
export const UI = join(REPO, "apps", "ui");
export const CONTROLLER = join(REPO, "apps", "controller");
export const BRAIN_REPO = join(REPO, "brain");

export const PRODUCT = "Cophyla";
export const GITHUB_REPO = "cophyla/cophyla";
/** The public feed: GitHub Pages serving the repository's `feed` branch under its own domain. */
export const DEFAULT_FEED = "https://feed.getcophyla.com";
export const ARTIFACT_BASE = `https://github.com/${GITHUB_REPO}/releases/download`;
/** Who the feed branch's commits name: the maintainer's GitHub noreply address, never a personal one. */
export const COMMIT_NAME = "feritmelih";
export const COMMIT_EMAIL = "4356196+FeritMelih@users.noreply.github.com";

export const OS: HostOs = hostOs();
export const ARCH = process.arch;
export const TARGET = `${OS}-${ARCH}`;

/** The shell inside a version directory, relative: `cophyla-ui.exe`, `Cophyla.app/Contents/MacOS/cophyla-ui`, `cophyla-ui`. */
export const SHELL_REL = SHELL_PATHS[OS];
/** The runtime inside a version directory: `bun.exe` or `bun`. */
export const BUN_NAME = BUN_NAMES[OS];
/** tether in a version folder, and the checkout it is built in. */
export const TETHER_REL = TETHER_PATHS[OS];
export const TETHER = join(REPO, "tether");
/** cophyla-net, the direct connections' helper, in a version folder; its workspace; its crates' licences, generated there and staged beside it. */
export const NET_REL = NET_PATHS[OS];
export const NET = join(REPO, "apps", "net");
export const NET_LICENCES = "THIRD-PARTY-LICENSES.html";
export const NET_LICENCES_REL = "bin/cophyla-net-THIRD-PARTY-LICENSES.html";

/** sign.ts's arguments: its flags, the entitlements file after `--entitlements`, and the one path. */
export function parseSignArgs(args: string[]): { staged: boolean; tree: boolean; entitlements?: string; file?: string } {
  const out: { staged: boolean; tree: boolean; entitlements?: string; file?: string } = { staged: false, tree: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--staged") out.staged = true;
    else if (a === "--tree") out.tree = true;
    else if (a === "--entitlements") {
      const next = args[++i];
      if (next !== undefined) out.entitlements = next;
    } else if (!a.startsWith("--") && out.file === undefined) out.file = a;
  }
  return out;
}

/** `<os>-<arch>` as the feed names targets, or nothing for anything else. */
export function parseTarget(spec: string): { os: HostOs; arch: string } | undefined {
  const m = /^(windows|macos|linux)-(x64|arm64)$/.exec(spec);
  return m ? { os: m[1] as HostOs, arch: m[2]! } : undefined;
}

/** Every target the feed carries a file for. A model entry goes into all of them. */
export const TARGETS: { os: HostOs; arch: string }[] = [
  { os: "windows", arch: "x64" },
  { os: "macos", arch: "arm64" },
  { os: "macos", arch: "x64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
];

/**
 * sherpa-onnx ships one native package per target, as optional dependencies of
 * `sherpa-onnx-node`. The stage installs with `--omit=optional` (the harness binaries are
 * never shipped), so the one for this target is named as a direct dependency instead, from
 * Node's own platform and arch words — with `win32` spelled `win`, as the packages are.
 */
export function sherpaBinaryPackage(platform: string, arch: string): string {
  return `sherpa-onnx-${platform === "win32" ? "win" : platform}-${arch}`;
}

/** A model's name: what `data/models/<name>/` is called, and what the feed keys its entries on. */
export const MODEL_NAME = /^[a-z0-9][a-z0-9.-]{1,63}$/;

/** The GitHub release a component's artifacts are assets of. */
export function releaseTag(component: string, version: string, name?: string): string {
  return component === "model" ? `model-${name}-v${version}` : `${component}-v${version}`;
}

/** The Tauri bundler's architecture word in a package name. */
export function bundleArch(os: HostOs, arch: string): string {
  if (arch === "x64") return os === "linux" ? "amd64" : "x64";
  if (arch === "arm64") return os === "linux" ? "arm64" : "aarch64";
  return arch;
}

/** The package the bundler writes for a target, and the AppImage that may go beside it on Linux. */
export function installerNames(os: HostOs, arch: string, version: string): { installer: string; bundleDir: string; appimage?: string } {
  const a = bundleArch(os, arch);
  switch (os) {
    case "windows":
      return { installer: `${PRODUCT}_${version}_${a}-setup.exe`, bundleDir: "nsis" };
    case "macos":
      return { installer: `${PRODUCT}_${version}_${a}.dmg`, bundleDir: "dmg" };
    case "linux":
      return { installer: `${PRODUCT}_${version}_${a}.deb`, bundleDir: "deb", appimage: `${PRODUCT}_${version}_${a}.AppImage` };
  }
}

/** Whether a file starts with a Mach-O magic (thin, either byte order) or a fat header. */
export function isMachO(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(4);
    if (readSync(fd, head, 0, 4, 0) < 4) return false;
    return isMachOHeader(head);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function isMachOHeader(head: Uint8Array): boolean {
  if (head.length < 4) return false;
  const magic = ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
  return magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcefaedfe || magic === 0xcffaedfe || magic === 0xcafebabe || magic === 0xbebafeca;
}

/** Every Mach-O file under a directory, outside any `.app` bundle (a bundle is signed whole). */
export function findMachO(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!entry.name.endsWith(".app")) walk(path);
      } else if (entry.isFile() && isMachO(path)) out.push(path);
    }
  };
  walk(dir);
  return out.sort();
}

/** `%USERPROFILE%\.cophyla-release`: the release key and the test certificate live here, outside the tree. */
export const RELEASE_HOME = process.env["COPHYLA_RELEASE_HOME"] ?? join(homedir(), ".cophyla-release");

export const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

export function log(message: string): void {
  console.log(message);
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function fileSize(path: string): number {
  return statSync(path).size;
}

/** True when `path` is inside the repository checkout. */
export function insideRepo(path: string): boolean {
  const rel = relative(REPO, resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The single source of truth for the platform version. */
export function platformVersion(): string {
  return readJson<{ version: string }>(join(COPHYLAD, "package.json")).version;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Capture stdout instead of inheriting it. */
  capture?: boolean;
  /** Do not fail on a non-zero exit. */
  allowFailure?: boolean;
}

/** Runs a command, inheriting stdio unless `capture`; a non-zero exit fails the script. */
export async function run(cmd: string[], opts: RunOptions = {}): Promise<{ code: number; stdout: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...opts.env })) if (v !== undefined) env[k] = v;
  const proc = Bun.spawn(cmd, { cwd: opts.cwd ?? process.cwd(), env, stdin: "inherit", stdout: opts.capture ? "pipe" : "inherit", stderr: "inherit" });
  const stdout = opts.capture ? await new Response(proc.stdout).text() : "";
  const code = await proc.exited;
  if (code !== 0 && !opts.allowFailure) fail(`${cmd.map((c) => (c.includes(" ") ? JSON.stringify(c) : c)).join(" ")} exited ${code}`);
  return { code, stdout };
}

/** Cargo's bin directory on PATH, so the Tauri CLI and cargo itself are found. */
export function cargoPath(): string {
  const bin = join(homedir(), ".cargo", "bin");
  const sep = process.platform === "win32" ? ";" : ":";
  return existsSync(bin) ? `${process.env["PATH"] ?? ""}${sep}${bin}` : (process.env["PATH"] ?? "");
}

/** Half the machine, as the user asked. */
export const BUILD_JOBS = String(Math.max(1, Math.floor((navigator.hardwareConcurrency || 8) / 2)));

/** signtool from the Windows Kits, newest first, or `COPHYLA_SIGNTOOL`. */
export function findSigntool(): string | undefined {
  const fromEnv = process.env["COPHYLA_SIGNTOOL"];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (process.platform !== "win32") return undefined;
  const kits = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  if (!existsSync(kits)) return undefined;
  const versions = readdirSync(kits)
    .filter((d) => /^10\.\d+\.\d+\.\d+$/.test(d) && existsSync(join(kits, d, "x64", "signtool.exe")))
    .sort((a, b) => Bun.semver.order(a.replace(/^10\./, ""), b.replace(/^10\./, "")))
    .reverse();
  return versions[0] ? join(kits, versions[0], "x64", "signtool.exe") : undefined;
}

/** The private release key: `--key`, `COPHYLA_RELEASE_KEY`, else `<RELEASE_HOME>/release.key`. Refuses one inside the repo. */
export function releaseKeyPath(explicit?: string): string {
  const path = explicit ?? process.env["COPHYLA_RELEASE_KEY"] ?? join(RELEASE_HOME, "release.key");
  if (insideRepo(path)) fail(`the release key must live outside the repository: ${path}`);
  if (!existsSync(path)) fail(`no release key at ${path}; run keygen.ts first (or set COPHYLA_RELEASE_KEY)`);
  return path;
}

export function parentDir(path: string): string {
  return dirname(resolve(path));
}

/** True when `path` is under the stage directory: signed when staged, hashed by a release entry. */
export function insideStage(path: string): boolean {
  const rel = relative(STAGE, resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
