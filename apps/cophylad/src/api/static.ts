// The controller app's own files, served by the controller listener from the directory the
// release staged (`apps/controller/dist`). A checkout that has not built it gets one line
// saying so rather than a blank 404, because that is the first thing a phone would see.
// The view's files do not come through here: they are ticketed, with a policy of their own.

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { MIME } from "../views/files.ts";

const DEFAULT_MIME = "application/octet-stream";

export interface StaticFile {
  bytes: Uint8Array;
  mime: string;
}

/**
 * One file under `dir`, or nothing. `/` serves `index.html`. A path that leaves the
 * directory, by traversal or by a symlink, is refused.
 */
export function serveStatic(dir: string, pathname: string): StaticFile | undefined {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  const wanted = rel === "" || rel.endsWith("/") ? rel + "index.html" : rel;
  if (wanted.includes("\0")) return undefined;
  const root = resolve(dir);
  const path = resolve(root, normalize(wanted));
  if (path !== root && !path.startsWith(root + sep)) return undefined;
  try {
    if (!statSync(path).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return { bytes: new Uint8Array(readFileSync(path)), mime: MIME[extname(path).toLowerCase()] ?? DEFAULT_MIME };
}

/** Whether a directory holds a built controller app. */
export function isBuilt(dir: string | undefined): boolean {
  return dir !== undefined && existsSync(join(dir, "index.html"));
}

/** What a phone sees when the app was never built: one line, not a blank page. */
export const NOT_BUILT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cophyla</title></head>
<body style="font: 16px/1.5 system-ui, sans-serif; margin: 2rem; color: #222">
<p>The controller app is not built. Run <code>bun run apps/controller/scripts/build.ts</code> on the node, or set <code>[controller] app_dir</code> to a directory that holds one.</p>
</body></html>
`;
