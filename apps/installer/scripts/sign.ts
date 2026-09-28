// Signs one file, or with `--tree` every Mach-O under a directory, the way the platform
// signs: Authenticode with signtool on Windows, `codesign` with the hardened runtime and
// Bun's entitlements on macOS, nothing on Linux. The certificate comes from the environment,
// never from a config file.
//
// Windows: `COPHYLA_SIGN_PFX` (path) and `COPHYLA_SIGN_PASSWORD`, or `COPHYLA_SIGN_THUMBPRINT` for a
// certificate in the user's store (a hardware token, or the real certificate once it
// exists). `COPHYLA_SIGN_TIMESTAMP` names the RFC 3161 server (DigiCert's by default); a
// timestamp failure is retried without one, so an offline build still signs.
//
// macOS: `APPLE_SIGNING_IDENTITY` (the Developer ID Application identity, as the Tauri
// bundler reads it); unset, the signature is ad-hoc (`-`), which runs on the building Mac
// and is what the pipeline does until a Developer ID exists. A Developer ID signature needs
// Apple's secure timestamp to be notarized, so a timestamp failure fails the signing, where
// Windows retries without one: `COPHYLA_SIGN_UNSTAMPED=1` signs without it, for a build that is
// never to be notarized. `--tree` signs every Mach-O
// outside a `.app` (a bundle is signed whole, by the bundler). `--entitlements <plist>`
// replaces Bun's entitlements, for a binary that needs none of them (cophyla-net).
//
// The Tauri bundler calls this as `signCommand` on Windows for the launcher, the installer,
// the uninstaller and its NSIS plugins, and also for every executable it bundles as a
// resource; those under `stage/` were signed when staged and are hashed by a release entry,
// so without `--staged` a path under `stage/` is left exactly as it is.
//   bun run apps/installer/scripts/sign.ts [--staged] [--tree] [--entitlements <plist>] <file-or-dir>

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fail, findMachO, findSigntool, INSTALLER, insideStage, isMachO, log, OS, parseSignArgs, run } from "./lib.ts";

const { staged, tree, entitlements: entitlementsArg, file } = parseSignArgs(Bun.argv.slice(2));
if (!file) fail("usage: sign.ts [--staged] [--tree] [--entitlements <plist>] <file-or-dir>");
if (!existsSync(file)) fail(`no such file: ${file}`);
if (entitlementsArg !== undefined && !existsSync(entitlementsArg)) fail(`no such entitlements file: ${entitlementsArg}`);
const entitlements = entitlementsArg ?? join(INSTALLER, "entitlements.plist");

if (!staged && insideStage(file)) {
  log(`left as staged (already signed; a release entry hashes it): ${resolve(file)}`);
  process.exit(0);
}

if (OS === "linux") {
  log(`linux: nothing to sign (${file})`);
  process.exit(0);
}

if (OS === "windows") {
  if (tree) fail("--tree is a macOS option; Windows signs one file at a time");
  await signtool(file);
} else {
  const files = tree ? findMachO(file) : [file];
  if (tree && !statSync(file).isDirectory()) fail(`--tree needs a directory: ${file}`);
  if (!tree && !isMachO(file)) fail(`not a Mach-O file: ${file}`);
  for (const f of files) await codesign(f);
  if (tree) log(`signed ${files.length} Mach-O files under ${file}`);
}

async function signtool(path: string): Promise<void> {
  const pfx = process.env["COPHYLA_SIGN_PFX"];
  const password = process.env["COPHYLA_SIGN_PASSWORD"];
  const thumbprint = process.env["COPHYLA_SIGN_THUMBPRINT"];
  const timestamp = process.env["COPHYLA_SIGN_TIMESTAMP"] ?? "http://timestamp.digicert.com";

  if (!pfx && !thumbprint) fail("set COPHYLA_SIGN_PFX (+ COPHYLA_SIGN_PASSWORD) or COPHYLA_SIGN_THUMBPRINT; nothing is shipped unsigned");
  const tool = findSigntool();
  if (!tool) fail("signtool.exe not found: install the Windows SDK or set COPHYLA_SIGNTOOL");

  const cert = thumbprint ? ["/sha1", thumbprint] : ["/f", pfx!, ...(password !== undefined ? ["/p", password] : [])];
  const base = [tool, "sign", "/fd", "SHA256", ...cert];

  const withStamp = await run([...base, "/tr", timestamp, "/td", "SHA256", path], { allowFailure: true });
  if (withStamp.code === 0) {
    log(`signed ${path} (timestamped by ${timestamp})`);
  } else {
    console.warn(`timestamping failed (exit ${withStamp.code}); signing without a timestamp`);
    await run([...base, path]);
    log(`signed ${path} (no timestamp)`);
  }
}

async function codesign(path: string): Promise<void> {
  const identity = process.env["APPLE_SIGNING_IDENTITY"] ?? "-";
  const base = ["codesign", "--force", "--options", "runtime", "--entitlements", entitlements, "--sign", identity];
  if (identity === "-") {
    await run([...base, path]);
    log(`signed ${path} (ad-hoc)`);
    return;
  }
  // A secure timestamp needs Apple's server, and notarization refuses a signature without one.
  const stamped = await run([...base, "--timestamp", path], { allowFailure: true });
  if (stamped.code === 0) {
    log(`signed ${path} (${identity}, timestamped)`);
    return;
  }
  if (process.env["COPHYLA_SIGN_UNSTAMPED"] !== "1") {
    fail(`codesign could not reach Apple's timestamp server (exit ${stamped.code}), and a signature without a secure timestamp cannot be notarized; retry online, or set COPHYLA_SIGN_UNSTAMPED=1 for a build that is never to be notarized`);
  }
  console.warn(`timestamping failed (exit ${stamped.code}); signing without a timestamp, as COPHYLA_SIGN_UNSTAMPED asks: this build cannot be notarized`);
  await run([...base, path]);
  log(`signed ${path} (${identity}, no timestamp)`);
}
