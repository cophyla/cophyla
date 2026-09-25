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
// but the list.

import { spawn as nodeSpawn } from "node:child_process";
import type { Logger } from "../log.ts";
import type { Exec } from "../sidecars/tts-py.ts";

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

  /** Opens the stream window for `host`'s desktop; one stream at a time, the last one wins. */
  async stream(host: string, app = "Desktop"): Promise<Stream> {
    const previous = this.current;
    if (previous) {
      this.current = undefined;
      previous.child.kill();
      this.log.info("moonlight stream replaced", { host: previous.host, pid: previous.child.pid });
    }
    const cmd = await this.deps.command();
    const child = (this.deps.spawn ?? detachedSpawn)(cmd, ["stream", host, app, "--display-mode", "windowed", "--absolute-mouse", "--quit-after"]);
    const stream: Stream = { host, since: Date.now(), child };
    this.current = stream;
    this.log.info("moonlight streaming", { host, app, pid: child.pid });
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
