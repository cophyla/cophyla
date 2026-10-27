// The sign-in door's names and numbers, one definition each. The Windows service shim
// (apps/door, Rust) has its own copy of the shared ones in `src/constants.rs`;
// test/door-constants.test.ts pins the two equal.

import { join } from "node:path";

/** The Windows service the shim runs as. */
export const DOOR_SERVICE = "CophylaDoor";
/** The pipe the shim owns; the user's daemon attaches to it, the door's child serves it. */
export const DOOR_PIPE = "\\\\.\\pipe\\cophyla-door";
/** The folder the door lives in, under Program Files and ProgramData alike. */
export const DOOR_FOLDER = "Cophyla Door";
/** The shim's binary, in Program Files and in a platform version's `bin/`. */
export const DOOR_EXE = "cophyla-door.exe";
/** The shim's stdio protocol with its child (`shim.hello`'s `protocol`). */
export const SHIM_PROTOCOL = 1;
/** The daemon's protocol with the door over the pipe (`door.attach`'s `protocol`). */
export const DOOR_PROTOCOL = 1;
/** The child's exit code that asks the shim to start it again at once, from the version `current` names now. */
export const EXIT_UPDATED = 75;

/** How long after a sign-in or an unlock the door keeps a stream it holds, for Cophyla to start there and take it. */
export const GRACE_MS = 120_000;
/** How long the daemon must be gone before the door serves: a restart or an update is not a sign-out. */
export const GONE_DEBOUNCE_MS = 30_000;
/** How long a kit stays good after the daemon last attached: a machine nobody signed in to for a month opens no door. */
export const KIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How long the daemon waits for the door to stand down and answer its attach before it starts anyway. */
export const ATTACH_TIMEOUT_MS = 8000;
/** How long the viewers the door held may open the machine's desktop again unasked once the daemon is back. */
export const REOPEN_MS = 180_000;

/** The console as the shim reads it: at the sign-in screen, locked, or someone working. */
export type ConsoleState = "signin" | "locked" | "active";

/** The door's folders on a machine: the program (binaries, versions) and the data root (its home, its kit). */
export interface DoorFolders {
  /** `%ProgramFiles%\Cophyla Door`: the shim's image, admins only. */
  root: string;
  /** `…\program`: the service account may change it: versions, `current`, the fixed binaries. */
  program: string;
  /** `%ProgramData%\Cophyla Door`: protected, the service's and the administrators' alone. */
  data: string;
  /** `…\home`: the door's `--home`. */
  home: string;
}

/** Where the door is installed, from the environment's Program Files and ProgramData. */
export function doorFolders(env: Record<string, string | undefined> = process.env): DoorFolders {
  const pf = env["ProgramFiles"] ?? "C:\\Program Files";
  const pd = env["ProgramData"] ?? "C:\\ProgramData";
  const root = join(pf, DOOR_FOLDER);
  const data = join(pd, DOOR_FOLDER);
  return { root, program: join(root, "program"), data, home: join(data, "home") };
}

/** The fixed places in the program folder the firewall rules name. */
export function programPaths(program: string): { net: string; web: string; webServer: string; streamer: string; versions: string } {
  const web = join(program, "moonlight-web");
  return { net: join(program, "bin", "cophyla-net.exe"), web, webServer: join(web, "web-server.exe"), streamer: join(web, "streamer.exe"), versions: join(program, "versions") };
}
