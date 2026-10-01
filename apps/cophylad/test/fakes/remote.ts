// The remote module's seams for the tests: a command runner that records every call and
// answers as winget, `sc`, moonlight-qt's `list` and `quit`, and the reads of its saved
// settings (`reg query`, `defaults read`) would; a spawner that records moonlight's `pair`,
// `stream` and settings children and lets a test end them; a capture that returns a tiny
// JPEG; the screen's size; and the fake web sidecar's command.

import { join } from "node:path";
import type { DisplaySize } from "@cophyla/protocol";
import type { Spawned, Spawner } from "../../src/remote/moonlight.ts";
import type { Capture } from "../../src/remote/screenshot.ts";
import type { Exec } from "../../src/sidecars/tts-py.ts";

export const FAKE_WEB = join(import.meta.dir, "moonlight-web.ts");

/** A 1×1 JPEG. */
export const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

export interface FakeChild extends Spawned {
  command: string;
  args: string[];
  exit(code?: number): void;
  killed: boolean;
}

export interface RemoteSeams {
  exec: Exec;
  spawn: Spawner;
  screenshot: Capture;
  /** The display seam: answers `screen`. */
  display: () => DisplaySize | undefined;
  /** This machine's primary display, as the display seam reads it; unknown until a test sets it. */
  screen?: DisplaySize;
  /** Whether the user saved moonlight-qt's settings: its `width` is in the registry or the defaults. */
  moonlightSaved: boolean;
  /** Every command the runner saw, as `name arg arg…`. */
  commands: string[];
  children: FakeChild[];
  /** Hosts moonlight is paired with, by address; `list` answers 0 for these. */
  paired: Set<string>;
  /** The Windows service's state `sc query` reports. */
  service: "RUNNING" | "STOPPED" | "absent";
  /** Whether `winget install` succeeds. */
  installOk: boolean;
  /** The moonlight binary the `command` seam names; the exec answers for it. */
  moonlight: string;
  /** What a `moonlight pair` spawn does on the host side: the test points it at the fake host's `expectPin`. */
  onPair?: (host: string, pin: string) => void;
}

export function remoteSeams(opts: { paired?: string[]; service?: RemoteSeams["service"]; installOk?: boolean } = {}): RemoteSeams {
  const seams: RemoteSeams = {
    commands: [],
    children: [],
    paired: new Set(opts.paired ?? []),
    service: opts.service ?? "RUNNING",
    installOk: opts.installOk ?? true,
    moonlight: "C:\\fake\\Moonlight.exe",
    moonlightSaved: false,
    display: () => seams.screen,
    exec: async (command, execOpts) => {
      const [file, ...args] = command;
      seams.commands.push([file, ...args].join(" "));
      const say = (line: string) => execOpts.onLine?.(line);
      if ((file === "reg" && args[0] === "query") || (file === "defaults" && args[0] === "read")) {
        return seams.moonlightSaved ? { code: 0, stdout: "    width    REG_DWORD    0x780\n", stderr: "" } : { code: 1, stdout: "", stderr: "ERROR: The system was unable to find the specified registry key or value." };
      }
      if (file === "winget" || file === "brew" || file === "flatpak") {
        say(`Found ${args[3] ?? args[2] ?? "package"}`);
        say("Successfully installed");
        return seams.installOk ? { code: 0, stdout: "Successfully installed\n", stderr: "" } : { code: 1, stdout: "", stderr: "Installer failed with exit code: 1603" };
      }
      if (file === "sc") {
        if (args[0] === "query") {
          if (seams.service === "absent") return { code: 1060, stdout: "", stderr: "[SC] EnumQueryServicesStatus:OpenService FAILED 1060: The specified service does not exist as an installed service." };
          return { code: 0, stdout: `SERVICE_NAME: ${args[1]}\n        TYPE               : 10  WIN32_OWN_PROCESS\n        STATE              : ${seams.service === "RUNNING" ? "4  RUNNING" : "1  STOPPED"}\n`, stderr: "" };
        }
        if (args[0] === "start") {
          seams.service = "RUNNING";
          return { code: 0, stdout: "START_PENDING", stderr: "" };
        }
      }
      if (file === seams.moonlight) {
        const verb = args[0];
        const host = args[1] ?? "";
        if (verb === "list") return seams.paired.has(host) ? { code: 0, stdout: "Desktop\nSteam Big Picture\n", stderr: "" } : { code: 255, stdout: "", stderr: `Computer ${host} has not been paired. Please open Moonlight to pair before retrieving games list.` };
        if (verb === "quit") {
          for (const c of seams.children) if (c.args[0] === "stream" && c.args[1] === host && !c.killed) c.exit(0);
          return { code: 0, stdout: "", stderr: "" };
        }
      }
      return { code: 127, stdout: "", stderr: `fake exec: unknown command ${file}` };
    },
    spawn: (command, args) => {
      let resolveExit!: (code: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      const child: FakeChild = {
        command,
        args,
        pid: 1000 + seams.children.length,
        exited,
        killed: false,
        kill: () => {
          child.killed = true;
          resolveExit(null);
        },
        exit: (code = 0) => {
          child.killed = true;
          resolveExit(code);
        },
      };
      seams.children.push(child);
      seams.commands.push([command, ...args].join(" "));
      // A `pair` marks the host paired once the daemon posted the PIN; the process idles, as the real one does.
      if (args[0] === "pair" && args[1]) {
        seams.paired.add(args[1]);
        seams.onPair?.(args[1], args[3] ?? "");
      }
      return child;
    },
    screenshot: async (display, maxWidth) => ({ mime: "image/jpeg", base64: TINY_JPEG.toString("base64"), width: Math.min(maxWidth, 1280), height: 800, display: display ?? 0 }),
  };
  return seams;
}
