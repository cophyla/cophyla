// Builds the package with the Tauri bundler over the launcher crate: `Cophyla_<v>_x64-setup.exe`
// (NSIS) on Windows, `Cophyla_<v>_aarch64.dmg` (and the `.app` in it) on macOS,
// `Cophyla_<v>_amd64.deb` on Linux, where `--appimage` adds a second, failure-tolerant run
// for `Cophyla_<v>_amd64.AppImage`. The version-specific parts of the bundle configuration
// (the `resources` map with the staged version directory, the `current` pointer and the
// bundled brain; the identifier and signing on macOS and Linux; the `signCommand` with its
// absolute path on Windows) come from overlay.ts and are written to a generated overlay
// under `stage/` merged with `--config`, so nothing version- or machine-specific sits in
// tauri.conf.json. Certificates reach the bundler and sign.ts through the environment only:
// `COPHYLA_SIGN_*` on Windows; Tauri's `APPLE_SIGNING_IDENTITY` / `APPLE_CERTIFICATE(_PASSWORD)`
// and `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID` (notarization) on macOS, ad-hoc when
// unset.
//   bun run apps/installer/scripts/build-installer.ts [--version 0.1.0] [--appimage]

import { cpSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ARCH, BUILD_JOBS, cargoPath, ensureDir, fail, fileSize, INSTALLER, installerNames, log, OS, OUT, platformVersion, run, SHELL_REL, STAGE } from "./lib.ts";
import { overlayFor } from "./overlay.ts";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { version: { type: "string" }, appimage: { type: "boolean" } }, strict: true });
const version = values.version ?? platformVersion();
if (version !== platformVersion()) fail(`--version ${version} is not the tree's ${platformVersion()}`);

const versionDir = join(STAGE, "versions", version);
for (const required of [join(versionDir, SHELL_REL), join(versionDir, "release.json"), join(STAGE, "current"), join(STAGE, "brain", "release.json")]) {
  if (!existsSync(required)) fail(`missing ${required}; run stage-platform, sign-release --into and stage-brain first`);
}
if ((await Bun.file(join(STAGE, "current")).text()).trim() !== version) fail(`stage/current does not name ${version}`);
if (OS === "windows" && !process.env["COPHYLA_SIGN_PFX"] && !process.env["COPHYLA_SIGN_THUMBPRINT"]) {
  fail("set COPHYLA_SIGN_PFX (+ COPHYLA_SIGN_PASSWORD) or COPHYLA_SIGN_THUMBPRINT: the launcher, installer and uninstaller are signed by the bundler through sign.ts");
}
if (OS === "macos" && !process.env["APPLE_SIGNING_IDENTITY"]) log("APPLE_SIGNING_IDENTITY is not set: the launcher bundle and the DMG are signed ad-hoc and not notarized");
if (OS === "macos" && process.env["APPLE_SIGNING_IDENTITY"] && !process.env["APPLE_ID"] && !process.env["APPLE_API_KEY"]) log("no APPLE_ID/APPLE_API_KEY: signed, not notarized");

const env = { bun: process.execPath, signScript: join(INSTALLER, "scripts", "sign.ts"), appleSigningIdentity: process.env["APPLE_SIGNING_IDENTITY"] };
const names = installerNames(OS, ARCH, version);
const bundles = join(INSTALLER, "src-tauri", "target", "release", "bundle");
ensureDir(OUT);

/** One bundler run; a non-zero exit fails the script unless `tolerant`. Returns the exit code. */
async function build(appimage: boolean, tolerant = false): Promise<number> {
  const overlay = overlayFor(OS, version, env, { appimage });
  const overlayPath = join(STAGE, `overlay-${version}${appimage ? "-appimage" : ""}.json`);
  writeFileSync(overlayPath, JSON.stringify(overlay, null, 2) + "\n");
  log(`overlay written to ${overlayPath}`);
  await run(["bun", "run", join(INSTALLER, "scripts", "version.ts"), "--check"]);
  log(`running tauri build (cargo for the launcher, then the ${appimage ? "AppImage" : names.bundleDir} bundle over the stage)…`);
  const r = await run(["bunx", "tauri", "build", "--config", overlayPath], { cwd: INSTALLER, env: { PATH: cargoPath(), CARGO_BUILD_JOBS: BUILD_JOBS }, allowFailure: tolerant });
  return r.code;
}

await build(false);
const built = join(bundles, names.bundleDir, names.installer);
if (!existsSync(built)) fail(`the bundler produced no ${built}`);
const dest = join(OUT, names.installer);
cpSync(built, dest);
log(`installer: ${dest} (${(fileSize(dest) / 1048576).toFixed(1)} MB)`);

if (values.appimage) {
  if (OS !== "linux" || !names.appimage) fail("--appimage is a Linux option");
  // A second target, tolerated to fail: linuxdeploy fetches tools at build time and the
  // result is published only once it runs on a non-Ubuntu distribution.
  const code = await build(true, true);
  const image = join(bundles, "appimage", names.appimage);
  if (code !== 0) console.warn(`appimage skipped: tauri build exited ${code}`);
  else if (!existsSync(image)) console.warn(`appimage skipped: the bundler produced no ${image}`);
  else {
    cpSync(image, join(OUT, names.appimage));
    log(`appimage: ${join(OUT, names.appimage)} (${(fileSize(image) / 1048576).toFixed(1)} MB)`);
  }
}
