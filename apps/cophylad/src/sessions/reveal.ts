// A file or a folder shown in the computer's own file manager, as an editor's "Reveal in File
// Explorer" does it: on Windows File Explorer with the file selected (`explorer.exe /select,`),
// on a Mac the Finder (`open -R`), on Linux the desktop's file manager through the freedesktop
// FileManager1 interface over D-Bus, which selects the file too, or else its folder opened with
// `xdg-open`. A folder is opened. The program starts detached and is not waited on, the window
// being the file manager's from then on; only the D-Bus call is waited on, briefly, to know
// whether the fallback is needed. A Linux with no display (a server, WSL without WSLg) has no
// file manager to show anything in, and says so.

import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { RpcError } from "@cophyla/protocol";
import { detach } from "./terminals.ts";

/** Shows a path, a file selected in its folder or a folder opened; throws `unsupported` where there is nothing to show it in. */
export type Revealer = (path: string, kind: "file" | "dir") => Promise<void>;

/** How long the D-Bus call may take before its fallback opens the folder instead. */
const DBUS_WAIT_MS = 5000;

export interface RevealDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  which: (command: string) => string | null;
  /** Starts a program that outlives the call, not waited on. */
  detach: (command: string, args: string[], opts: { verbatim?: boolean }) => void;
  /** Runs a program to its end, or DBUS_WAIT_MS: whether it succeeded. */
  run: (command: string, args: string[]) => Promise<boolean>;
}

function runQuietly(command: string, args: string[]): Promise<boolean> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    } catch {
      return done(false);
    }
    const timer = setTimeout(() => {
      child.kill();
      done(false);
    }, DBUS_WAIT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

const defaults: RevealDeps = {
  platform: process.platform,
  env: process.env,
  which: (command) => Bun.which(command),
  detach: (command, args, opts) => detach(command, args, opts),
  run: runQuietly,
};

/** A `file://` URL as a GVariant string holds it: a quote in it would end the string, so it is escaped as the URL would. */
function fileUrl(path: string): string {
  return pathToFileURL(path).href.replace(/'/g, "%27");
}

/** The file manager of the computer this runs on, as `platform` has one. */
export function systemRevealer(over: Partial<RevealDeps> = {}): Revealer {
  const deps: RevealDeps = { ...defaults, ...over };
  return async (path, kind) => {
    switch (deps.platform) {
      case "win32":
        // explorer.exe reads its own command line: the comma after /select is its, and the path in quotes.
        deps.detach("explorer.exe", [kind === "file" ? `/select,"${path}"` : `"${path}"`], { verbatim: true });
        return;
      case "darwin":
        deps.detach("open", kind === "file" ? ["-R", path] : [path], {});
        return;
      default: {
        if (!deps.env["DISPLAY"] && !deps.env["WAYLAND_DISPLAY"]) throw new RpcError("unsupported", "this computer has no desktop to show files on");
        if (kind === "file") {
          const gdbus = deps.which("gdbus");
          const args = ["call", "--session", "--dest", "org.freedesktop.FileManager1", "--object-path", "/org/freedesktop/FileManager1", "--method", "org.freedesktop.FileManager1.ShowItems", `['${fileUrl(path)}']`, ""];
          if (gdbus && (await deps.run(gdbus, args))) return;
        }
        const open = deps.which("xdg-open");
        if (!open) throw new RpcError("unsupported", "this computer has no file manager to show files in (no xdg-open)");
        deps.detach(open, [kind === "file" ? dirname(path) : path], {});
      }
    }
  };
}
