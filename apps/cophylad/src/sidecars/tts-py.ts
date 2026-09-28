// Bootstrapping the `tts-py` sidecar, on demand. Chatterbox Turbo is a GPU engine behind a
// Python environment of about five gigabytes and weights of about two, which is why it is
// not in the installer: the platform ships the sidecar's sources and its locked requirements,
// and the daemon builds the rest the first time the user turns the stage on. Kokoro speaks
// in the meantime, so nothing waits on this.
//
// Every step writes a marker when it finishes, so a bootstrap interrupted by a restart
// resumes where it stopped rather than downloading gigabytes again, and every step is
// reported as `voice.setup` so the user can watch it. A step that fails leaves the stage
// unavailable with the reason, and never takes the daemon down with it.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientNotificationParams } from "@cophyla/protocol";
import type { VoiceConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";
import { download } from "../update/download.ts";
import { extractTarGz } from "../update/archive.ts";
import { defaultTar, hostOs } from "../update/platform.ts";
import type { HostOs } from "../update/platform.ts";
import { maskArg } from "../voice/affinity.ts";
import { Sidecars } from "./index.ts";
import type { Sidecar, SidecarSpec } from "./index.ts";

type VoiceSetup = ClientNotificationParams<"voice.setup">;

export const SIDECAR_NAME = "tts-py";
/** The Python the environment is built with; Chatterbox's wheels are built for it. */
export const PYTHON_VERSION = "3.11";
/** The uv release the bootstrap downloads, pinned by size and hash like any other artifact. */
export const UV_VERSION = "0.10.10";

export interface UvRelease {
  file: string;
  size: number;
  sha256: string;
}

export const UV_RELEASES: Record<string, UvRelease> = {
  "windows-x64": { file: "uv-x86_64-pc-windows-msvc.zip", size: 22371199, sha256: "d31a30f1dfb96e630a08d5a9b3f3f551254b7ed6e9b7e495f46a4232661c7252" },
  "linux-x64": { file: "uv-x86_64-unknown-linux-gnu.tar.gz", size: 22824522, sha256: "3e1027f26ce8c7e4c32e2277a7fed2cb410f2f1f9320d3df97653d40e21f415b" },
  "linux-arm64": { file: "uv-aarch64-unknown-linux-gnu.tar.gz", size: 21481230, sha256: "2b80457b950deda12e8d5dc3b9b7494ac143eae47f1fb11b1c6e5a8495a6421e" },
  "macos-arm64": { file: "uv-aarch64-apple-darwin.tar.gz", size: 19499129, sha256: "8a09f0ef51ee7f7170731b4cb8bde5bf9ba6da5304f49a7df6cdab42a1f37b5d" },
  "macos-x64": { file: "uv-x86_64-apple-darwin.tar.gz", size: 21213143, sha256: "dd18420591d625f9b4ca2b57a7a6fe3cce43910f02e02d90e47a4101428de14a" },
};

/** The Hugging Face revision the weights come from, so two machines fetch the same bytes. */
export const WEIGHTS_REVISION = "main";

export function uvUrl(release: UvRelease, version = UV_VERSION): string {
  return `https://github.com/astral-sh/uv/releases/download/${version}/${release.file}`;
}

export type Step = VoiceSetup["step"];

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (command: string[], opts: { cwd?: string; env?: Record<string, string>; onLine?: (line: string) => void }) => Promise<ExecResult>;

export interface TtsPyDeps {
  /** `<home>/data/sidecars/tts-py`: the environment, the weights cache and the markers. */
  root: string;
  /** The sources the platform ships: `server.py`, `fetch_weights.py` and the locks. */
  shipped: string;
  config: VoiceConfig;
  log: Logger;
  sidecars: Sidecars;
  /** Where each step is reported. */
  progress: (event: VoiceSetup) => void;
  fetch?: typeof fetch;
  exec?: Exec;
  /** The CPU mask the daemon pinned itself to, handed on to the child. */
  affinity?: bigint;
  os?: HostOs;
  arch?: string;
}

/** Runs a command, streaming its output to the log and to `onLine`. */
export const defaultExec: Exec = async (command, opts) => {
  const proc = Bun.spawn(command, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: { ...process.env, ...(opts.env ?? {}) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const read = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
    if (!stream) return "";
    let text = "";
    let held = "";
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const part = decoder.decode(chunk, { stream: true });
      text += part;
      held += part;
      const lines = held.split(/\r?\n/);
      held = lines.pop() ?? "";
      for (const line of lines) opts.onLine?.(line);
    }
    if (held) opts.onLine?.(held);
    return text;
  };
  const [code, stdout, stderr] = await Promise.all([proc.exited, read(proc.stdout as ReadableStream<Uint8Array>), read(proc.stderr as ReadableStream<Uint8Array>)]);
  return { code, stdout, stderr };
};

export class TtsPy {
  private deps: TtsPyDeps;
  private log: Logger;
  private running?: Promise<Sidecar>;

  constructor(deps: TtsPyDeps) {
    this.deps = deps;
    this.log = deps.log;
  }

  private get target(): string {
    return `${this.deps.os ?? hostOs()}-${this.deps.arch ?? process.arch}`;
  }

  private marker(step: string): string {
    return join(this.deps.root, `.${step}.done`);
  }

  private done(step: string): boolean {
    return existsSync(this.marker(step));
  }

  private finish(step: string, note = ""): void {
    mkdirSync(this.deps.root, { recursive: true });
    writeFileSync(this.marker(step), `${new Date().toISOString()} ${note}\n`, "utf8");
  }

  private say(step: Step, extra: { progress?: number; message?: string } = {}): void {
    this.deps.progress({ stage: "tts", engine: "chatterbox", step, ...extra });
  }

  /** The uv binary this bootstrap uses: the one it downloaded. */
  get uvPath(): string {
    return join(this.deps.root, "uv", process.platform === "win32" ? "uv.exe" : "uv");
  }

  /** The interpreter of the environment it built. */
  get pythonPath(): string {
    return process.platform === "win32" ? join(this.deps.root, ".venv", "Scripts", "python.exe") : join(this.deps.root, ".venv", "bin", "python");
  }

  private get env(): Record<string, string> {
    return {
      UV_PYTHON_INSTALL_DIR: join(this.deps.root, "python"),
      UV_CACHE_DIR: join(this.deps.root, "uv-cache"),
      HF_HOME: join(this.deps.root, "hf"),
      PYTHONUNBUFFERED: "1",
      PYTHONUTF8: "1",
    };
  }

  private exec(command: string[], opts: { cwd?: string; env?: Record<string, string>; onLine?: (line: string) => void } = {}): Promise<ExecResult> {
    return (this.deps.exec ?? defaultExec)(command, { ...opts, env: { ...this.env, ...(opts.env ?? {}) } });
  }

  /** Builds what is missing and returns the running sidecar. One bootstrap at a time. */
  ensure(): Promise<Sidecar> {
    if (!this.running) {
      this.running = this.run().catch((e) => {
        this.running = undefined;
        const message = e instanceof Error ? e.message : String(e);
        this.say("failed", { message });
        throw e;
      });
    }
    return this.running;
  }

  private async run(): Promise<Sidecar> {
    if (!this.deps.config.chatterbox_voice) {
      throw new Error("[voice] chatterbox_voice must name a reference clip for the voice to clone");
    }
    if (!existsSync(join(this.deps.shipped, "server.py"))) {
      throw new Error(`the speech sidecar's sources are not at ${this.deps.shipped}`);
    }
    mkdirSync(this.deps.root, { recursive: true });
    await this.stepUv();
    await this.stepVenv();
    await this.stepDeps();
    await this.stepWeights();
    return this.stepStart();
  }

  private async stepUv(): Promise<void> {
    if (this.done("uv") && existsSync(this.uvPath)) return;
    const release = UV_RELEASES[this.target];
    if (!release) throw new Error(`no uv release pinned for ${this.target}`);
    this.say("uv");
    const dir = join(this.deps.root, "uv");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const archive = join(this.deps.root, release.file);
    await download(uvUrl(release), archive, {
      size: release.size,
      sha256: release.sha256,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      onProgress: (f) => this.say("uv", { progress: f }),
    });
    // bsdtar, which both Windows and the Unix hosts have, reads a zip as happily as a tarball.
    // The archives hold one directory; its contents are what is wanted.
    await extractTarGz(archive, dir, { tar: defaultTar(), strip: release.file.endsWith(".zip") ? 0 : 1 });
    rmSync(archive, { force: true });
    if (!existsSync(this.uvPath)) throw new Error(`the uv archive did not hold ${this.uvPath}`);
    this.finish("uv", UV_VERSION);
    this.log.info("uv ready", { version: UV_VERSION, path: this.uvPath });
  }

  private async stepVenv(): Promise<void> {
    if (this.done("venv") && existsSync(this.pythonPath)) return;
    this.say("venv");
    const r = await this.exec([this.uvPath, "venv", "--python", PYTHON_VERSION, join(this.deps.root, ".venv")], { cwd: this.deps.root });
    if (r.code !== 0) throw new Error(`uv venv exited ${r.code}: ${r.stderr.trim().slice(0, 400)}`);
    if (!existsSync(this.pythonPath)) throw new Error(`no interpreter at ${this.pythonPath} after uv venv`);
    this.finish("venv", PYTHON_VERSION);
    this.log.info("python environment ready", { python: this.pythonPath });
  }

  private async stepDeps(): Promise<void> {
    if (this.done("deps")) return;
    const lock = join(this.deps.shipped, `requirements-${this.target}.lock`);
    if (!existsSync(lock)) throw new Error(`no locked requirements for ${this.target} at ${lock}`);
    this.say("deps");
    // `unsafe-best-match` lets the CUDA index serve torch while PyPI serves the rest.
    const r = await this.exec([this.uvPath, "pip", "install", "--python", this.pythonPath, "-r", lock, "--index-strategy", "unsafe-best-match"], {
      cwd: this.deps.shipped,
      onLine: (line) => this.log.debug("uv pip", { line: line.slice(0, 200) }),
    });
    if (r.code !== 0) throw new Error(`uv pip install exited ${r.code}: ${r.stderr.trim().slice(-400)}`);
    this.finish("deps", this.target);
    this.log.info("speech sidecar dependencies installed");
  }

  private async stepWeights(): Promise<void> {
    if (this.done("weights")) return;
    this.say("weights");
    const r = await this.exec([this.pythonPath, join(this.deps.shipped, "fetch_weights.py"), "--revision", WEIGHTS_REVISION], {
      cwd: this.deps.shipped,
      onLine: (line) => {
        // `progress <fraction>` on a line of its own is the script's way of reporting.
        const m = /^progress\s+([01](?:\.\d+)?)/.exec(line.trim());
        if (m) this.say("weights", { progress: Number(m[1]) });
        else if (line.trim()) this.log.debug("fetch_weights", { line: line.slice(0, 200) });
      },
    });
    if (r.code !== 0) throw new Error(`fetch_weights exited ${r.code}: ${r.stderr.trim().slice(-400)}`);
    this.finish("weights", WEIGHTS_REVISION);
    this.log.info("speech weights fetched");
  }

  /** The spawn spec: loopback only, the port from the parent, the voice and the CPU mask. */
  spec(): SidecarSpec {
    const args = [
      join(this.deps.shipped, "server.py"),
      "--port",
      "{port}",
      "--host",
      "127.0.0.1",
      "--device",
      this.deps.config.chatterbox_device,
      "--voice",
      this.deps.config.chatterbox_voice ?? "",
    ];
    if (this.deps.affinity !== undefined) args.push("--affinity", maskArg(this.deps.affinity));
    return {
      name: SIDECAR_NAME,
      command: this.pythonPath,
      args,
      cwd: this.deps.shipped,
      // An operator Apple's GPU (mps) lacks runs on the CPU rather than failing the request.
      env: { ...this.env, HF_HUB_OFFLINE: "1", PYTORCH_ENABLE_MPS_FALLBACK: "1" },
      // Loading Turbo and warming the kernels took 12.6 s in spike 10; a cold cache is slower.
      health: { path: "/health", intervalMs: 5000, timeoutMs: 2000, startTimeoutMs: 180000 },
      ...(this.deps.affinity !== undefined ? { affinity: this.deps.affinity } : {}),
      restart: { backoffMs: 2000, maxMs: 60000, max: 5 },
    };
  }

  private async stepStart(): Promise<Sidecar> {
    this.say("starting");
    const sidecar = this.deps.sidecars.spawn(this.spec());
    await sidecar.start();
    this.say("ready");
    return sidecar;
  }

  /** What the bootstrap has already done, for the log and the tests. */
  steps(): Record<string, boolean> {
    return { uv: this.done("uv"), venv: this.done("venv"), deps: this.done("deps"), weights: this.done("weights") };
  }

  /** Reads a marker's note, for a test. */
  note(step: string): string | undefined {
    try {
      return readFileSync(this.marker(step), "utf8").trim();
    } catch {
      return undefined;
    }
  }
}
