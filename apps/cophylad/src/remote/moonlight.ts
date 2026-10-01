// The desktop viewer: moonlight-qt driven from the command line. `list <host>` is the
// "already paired" check (exit 0 with the app names; 255 and "has not been paired"
// otherwise, in well under a second); `pair <host> --pin NNNN` opens a pairing session the
// host completes once cophylad posts the same PIN there — the process then idles for most of
// a minute before it exits by itself, so nothing waits on it; `stream <host> Desktop` opens
// the window, detached from the daemon so it outlives a restart. A new stream replaces the
// last by ending that process, never with `quit <host>`, which ends the host's app for every
// viewer. The streaming process may linger without a window after its stream ends, so the
// record of it says only what this node started, not what is on screen. moonlight-qt is a
// GUI-subsystem program on Windows: it writes its log to stderr and nothing useful to stdout
// but the list. `stream` loads the user's saved settings first and then takes its flags over
// them, so the size, frame rate and bitrate are given only while the user has saved none:
// moonlight-qt saves them (QSettings: `width`, `height`, `fps`, `bitrate`) when its Settings
// page closes, and run with no arguments it opens its own window, where that page is.

import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../log.ts";
import type { Exec } from "../sidecars/tts-py.ts";
import type { HostOs } from "../update/platform.ts";
import type { StreamVideo } from "./quality.ts";

export interface Spawned {
  pid?: number;
  exited: Promise<number | null>;
  kill(): void;
}

export type Spawner = (command: string, args: string[]) => Spawned;

/** A child in its own process group, with no pipes to the daemon, so it lives on when the daemon stops. */
export const detachedSpawn: Spawner = (command, args) => {
  const child = nodeSpawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });
  child.unref();
  return {
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    exited,
    kill: () => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    },
  };
};

export interface MoonlightDeps {
  /** The binary, located or installed on first use. */
  command: () => Promise<string>;
  exec: Exec;
  spawn?: Spawner;
  log: Logger;
}

export interface Stream {
  host: string;
  since: number;
  child: Spawned;
}

export class Moonlight {
  private deps: MoonlightDeps;
  private log: Logger;
  private current?: Stream;

  constructor(deps: MoonlightDeps) {
    this.deps = deps;
    this.log = deps.log;
  }

  /** The stream this node's viewer started last, while its process runs. */
  streaming(): Stream | undefined {
    return this.current;
  }

  /** Whether this viewer is paired with `host`: the app list comes back only when it is. */
  async paired(host: string): Promise<boolean> {
    const cmd = await this.deps.command();
    const r = await this.deps.exec([cmd, "list", host], {});
    return r.code === 0;
  }

  /** Opens a pairing session with `host` under `pin`; resolves at once with the process, which the host's answer completes. */
  async pair(host: string, pin: string): Promise<Spawned> {
    const cmd = await this.deps.command();
    const child = (this.deps.spawn ?? detachedSpawn)(cmd, ["pair", host, "--pin", pin]);
    this.log.info("moonlight pairing", { host, pid: child.pid });
    return child;
  }

  /** Opens moonlight-qt's own window, where its settings are; it lives on by itself, as the user's. */
  async settings(): Promise<Spawned> {
    const cmd = await this.deps.command();
    const child = (this.deps.spawn ?? detachedSpawn)(cmd, []);
    this.log.info("moonlight window opened for its settings", { pid: child.pid });
    return child;
  }

  /** Opens the stream window for `host`'s desktop, sized as `video` says when given; one stream at a time, the last one wins. */
  async stream(host: string, app = "Desktop", video?: StreamVideo): Promise<Stream> {
    const previous = this.current;
    if (previous) {
      this.current = undefined;
      previous.child.kill();
      this.log.info("moonlight stream replaced", { host: previous.host, pid: previous.child.pid });
    }
    const cmd = await this.deps.command();
    const sized = video ? ["--resolution", `${video.width}x${video.height}`, "--fps", String(video.fps), "--bitrate", String(video.bitrate)] : [];
    const child = (this.deps.spawn ?? detachedSpawn)(cmd, ["stream", host, app, ...sized, "--display-mode", "windowed", "--absolute-mouse", "--quit-after"]);
    const stream: Stream = { host, since: Date.now(), child };
    this.current = stream;
    this.log.info("moonlight streaming", { host, app, pid: child.pid, ...(video ? { video: `${video.width}x${video.height}@${video.fps} ${video.bitrate} kbps` } : { video: "its own settings" }) });
    void child.exited.then((code) => {
      if (this.current !== stream) return;
      this.current = undefined;
      this.log.info("moonlight stream ended", { host, code });
    });
    return stream;
  }

  /** For the daemon going down: the window stays, the record does not. */
  stop(): void {
    this.current = undefined;
  }
}

/** moonlight-qt's QSettings: its organisation and application, as it names them. */
const MOONLIGHT_KEY = "HKCU\\Software\\Moonlight Game Streaming Project\\Moonlight";
const MOONLIGHT_DOMAIN = "com.moonlight-stream.Moonlight";
const MOONLIGHT_CONF = join("Moonlight Game Streaming Project", "Moonlight.conf");

/**
 * Whether the user saved moonlight-qt's stream settings: its QSettings hold a `width` once its
 * Settings page has closed. Windows keeps them in the registry, macOS in its defaults, Linux in
 * an INI file, under the flatpak's own config folder when it is the flatpak.
 */
export async function moonlightSaved(os: HostOs, exec: Exec, env: Record<string, string | undefined> = process.env, read: (path: string) => string = (p) => readFileSync(p, "utf8")): Promise<boolean> {
  try {
    if (os === "windows") return (await exec(["reg", "query", MOONLIGHT_KEY, "/v", "width"], {})).code === 0;
    if (os === "macos") return (await exec(["defaults", "read", MOONLIGHT_DOMAIN, "width"], {})).code === 0;
  } catch {
    return false;
  }
  const home = env["HOME"] ?? homedir();
  const files = [join(env["XDG_CONFIG_HOME"] ?? join(home, ".config"), MOONLIGHT_CONF), join(home, ".var", "app", "com.moonlight_stream.Moonlight", "config", MOONLIGHT_CONF)];
  return files.some((f) => {
    try {
      return /^width=/m.test(read(f));
    } catch {
      return false;
    }
  });
}

/** A four-digit PIN, as moonlight and the hosts expect. */
export function randomPin(): string {
  return String(1000 + Math.floor(Math.random() * 9000));
}

/** `host:port` or `[v6]:port` without the port: what moonlight is given. */
export function hostOfEndpoint(endpoint: string): string {
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(endpoint);
  if (v6) return v6[1]!;
  const i = endpoint.lastIndexOf(":");
  return i > 0 && endpoint.indexOf(":") === i ? endpoint.slice(0, i) : endpoint;
}
