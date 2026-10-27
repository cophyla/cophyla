// Readying the sign-in door while someone is signed in, so nothing is left to do when no one
// is: the web viewer (moonlight-web, a GPL program fetched from its own releases, pinned by
// size and hash in `remote/manifest.ts`) is put in the program folder's fixed place, the one
// the firewall rule names, and paired with this machine's host under the machine's name and
// " sign-in", the PIN posted on the host's own API with the kit's credentials; then the
// desktop module is stopped again. The pairing and the viewer's own state stay in the door's
// protected folders. A version the door already holds is not fetched again.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log.ts";
import { WEB_VERSION, webAssetFor } from "../remote/manifest.ts";
import { extractZip } from "../update/archive.ts";
import { download } from "../update/download.ts";
import { defaultTar } from "../update/platform.ts";
import { programPaths } from "./constants.ts";
import type { Remote } from "../remote/index.ts";

/** The file in the fixed folder that says which release it holds. */
const VERSION_FILE = "VERSION";

/** Whether the fixed folder holds the pinned release. */
export function webStaged(program: string): boolean {
  const p = programPaths(program);
  try {
    return existsSync(p.webServer) && existsSync(p.streamer) && readFileSync(join(p.web, VERSION_FILE), "utf8").trim() === WEB_VERSION;
  } catch {
    return false;
  }
}

/**
 * Puts the pinned moonlight-web in the program folder's fixed place: fetched, checked against
 * its size and hash, unpacked aside and copied in, the viewer's own `server/` state kept.
 */
export async function stageWeb(program: string, tmp: string, log: Logger, opts: { fetch?: typeof fetch; tar?: string; target?: string } = {}): Promise<void> {
  if (webStaged(program)) return;
  const asset = webAssetFor(opts.target ?? `windows-${process.arch}`);
  if (!asset) throw new Error(`moonlight-web publishes no build for windows-${process.arch}`);
  const p = programPaths(program);
  const work = join(tmp, `moonlight-web-${WEB_VERSION}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const archive = join(tmp, `moonlight-web-${WEB_VERSION}.${asset.kind}`);
  try {
    log.info("fetching moonlight-web for the sign-in door", { version: WEB_VERSION });
    await download(asset.url, archive, { size: asset.size, sha256: asset.sha256, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    await extractZip(archive, work, { tar: opts.tar ?? defaultTar() });
    const pkg = join(work, "package");
    if (!existsSync(join(pkg, "web-server.exe"))) throw new Error(`moonlight-web ${WEB_VERSION} unpacked without web-server.exe`);
    mkdirSync(p.web, { recursive: true });
    for (const name of readdirSync(pkg)) {
      if (name === "server") continue;
      rmSync(join(p.web, name), { recursive: true, force: true });
      cpSync(join(pkg, name), join(p.web, name), { recursive: true });
    }
    writeFileSync(join(p.web, VERSION_FILE), WEB_VERSION + "\n", "utf8");
  } finally {
    rmSync(archive, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

/** Brings the desktop module up long enough for its web viewer to pair with the host, then down again. */
export async function pairDoorViewer(remote: Remote, stop: () => Promise<void>): Promise<void> {
  try {
    remote.start();
    await remote.ready();
    const host = remote.state().host;
    if (host.status !== "ready") throw new Error(`the desktop host is ${host.status}${host.reason ? `: ${host.reason}` : ""}`);
    await remote.pairWebViewer();
  } finally {
    await stop();
  }
}
