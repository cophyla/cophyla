// Builds the moonlight-web release a Mac serves phones from, since upstream publishes none for
// macOS: the tag `remote/manifest.ts` pins (`WEB_VERSION`), its web frontend (`npm run build`,
// whose bindings step runs cargo) and its two binaries (`cargo build --release` for
// aarch64-apple-darwin, on the nightly the project pins, with Homebrew's OpenSSL linked in
// statically so nothing outside the system is loaded), laid out as every upstream archive is:
// `package/web-server`, `package/streamer`, `package/static/`. The archive also carries the
// GPL's text and where its source is (`SOURCE`), since it is theirs, built, not ours.
//
// It prints the archive's size and SHA-256, the entry `WEB_ASSETS` takes once the archive is
// published somewhere cophylad can fetch it; until then `[remote] web_server` names the
// unpacked `package/web-server`. Upstream's build scripts run here: npm's and cargo's.
//   bun run apps/installer/scripts/build-moonlight-web.ts [--src <checkout>] [--out <dir>]

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { WEB_VERSION } from "../../cophylad/src/remote/manifest.ts";
import { cargoPath, fail, fileSize, log, OS, run, STAGE } from "./lib.ts";

const REPO_URL = "https://github.com/MrCreativ3001/moonlight-web-stream";
const TARGET = "aarch64-apple-darwin";
export const ARCHIVE = `moonlight-web-${TARGET}.tar.gz`;

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { src: { type: "string" }, out: { type: "string" } }, strict: true });

if (OS !== "macos" || process.arch !== "arm64") fail("this builds the Apple Silicon release, on an Apple Silicon Mac");
const out = values.out ?? join(STAGE, "moonlight-web");
const src = values.src ?? join(out, "src");

if (!values.src) {
  rmSync(src, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  log(`cloning moonlight-web-stream ${WEB_VERSION}…`);
  await run(["git", "clone", "--depth", "1", "--branch", WEB_VERSION, "--recurse-submodules", "--shallow-submodules", `${REPO_URL}.git`, src]);
}

const openssl = (await run(["brew", "--prefix", "openssl@3"], { capture: true, allowFailure: true })).stdout.trim();
if (!openssl || !existsSync(join(openssl, "lib", "libssl.a"))) fail("OpenSSL 3's static libraries are needed: brew install openssl@3");
const env = { PATH: cargoPath(), OPENSSL_DIR: openssl, OPENSSL_STATIC: "1", MACOSX_DEPLOYMENT_TARGET: "11.0" };

log("building the web frontend (npm ci, npm run build)…");
await run(["npm", "ci", "--no-audit", "--no-fund"], { cwd: src, env });
await run(["npm", "run", "build"], { cwd: src, env });
log(`building web-server and streamer (cargo build --release --target ${TARGET})…`);
await run(["cargo", "build", "--release", "--locked", "--target", TARGET], { cwd: src, env });

const bins = join(src, "target", TARGET, "release");
const pkg = join(out, "package");
rmSync(pkg, { recursive: true, force: true });
mkdirSync(pkg, { recursive: true });
for (const bin of ["web-server", "streamer"]) {
  cpSync(join(bins, bin), join(pkg, bin));
  // Only the system's libraries: a Homebrew path would tie the build to this Mac.
  const linked = (await run(["otool", "-L", join(pkg, bin)], { capture: true })).stdout.split("\n").slice(1).map((l) => l.trim().split(" ")[0]!).filter(Boolean);
  const foreign = linked.filter((l) => !l.startsWith("/usr/lib/") && !l.startsWith("/System/Library/"));
  if (foreign.length > 0) fail(`${bin} links ${foreign.join(", ")}: not only the system's`);
}
cpSync(join(src, "dist"), join(pkg, "static"), { recursive: true });
cpSync(join(src, "LICENSE"), join(pkg, "LICENSE"));
const commit = (await run(["git", "rev-parse", "HEAD"], { cwd: src, capture: true })).stdout.trim();
writeFileSync(join(pkg, "SOURCE"), `moonlight-web-stream ${WEB_VERSION} (${commit}), GPL-3.0-or-later: ${REPO_URL}/tree/${WEB_VERSION}\nBuilt for ${TARGET} by apps/installer/scripts/build-moonlight-web.ts.\n`);
log(`package: ${readdirSync(pkg).join(", ")}`);

const archive = join(out, ARCHIVE);
rmSync(archive, { force: true });
await run(["tar", "-czf", archive, "-C", out, "package"], { env: { COPYFILE_DISABLE: "1" } });
const sha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex");
log(`${archive}: ${fileSize(archive)} bytes, sha256 ${sha256}`);
log(`WEB_ASSETS entry once published: "macos-arm64": { url: <where it is>, size: ${fileSize(archive)}, sha256: "${sha256}", kind: "tar.gz" }`);
log(`until then: [remote] web_server = "${join(pkg, "web-server")}"`);
