// Puts the brain the installer bundles under `stage/brain/`: `brain.exe` and its signed
// `release.json`, the same shape the daemon keeps under `data/brain/current`, verified the
// same way. `--from <dir>` takes a directory that sign-release.ts wrote into (a local build);
// `--feed` fetches the newest stable brain from the public feed and verifies it: the brain
// is fetched at build, the platform tree never holds its source.
//   bun run apps/installer/scripts/stage-brain.ts --from ../../brain/dist
//   bun run apps/installer/scripts/stage-brain.ts --feed [--feed-url <base>]

import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { brainBinary, makeExecutable, verifyBrainDir } from "../../cophylad/src/update/brain.ts";
import { download } from "../../cophylad/src/update/download.ts";
import { feedUrl, newest, selectReleases } from "../../cophylad/src/update/feed.ts";
import { RELEASE_KEYS } from "../../cophylad/src/update/keys.ts";
import { ARCH, DEFAULT_FEED, ensureDir, fail, log, OS, STAGE } from "./lib.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { from: { type: "string" }, feed: { type: "boolean" }, "feed-url": { type: "string" }, channel: { type: "string", default: "stable" } },
  strict: true,
});

const dest = join(STAGE, "brain");
rmSync(dest, { recursive: true, force: true });
ensureDir(dest);

if (values.from) {
  const binary = brainBinary(values.from);
  if (!binary) fail(`no brain binary in ${values.from}`);
  if (!existsSync(join(values.from, "release.json"))) fail(`no release.json in ${values.from}; run sign-release.ts --component brain --into ${values.from}`);
  cpSync(binary, join(dest, binary.slice(binary.lastIndexOf(process.platform === "win32" ? "\\" : "/") + 1)));
  cpSync(join(values.from, "release.json"), join(dest, "release.json"));
} else if (values.feed) {
  const base = values["feed-url"] ?? DEFAULT_FEED;
  const url = feedUrl(base, values.channel, OS, ARCH);
  log(`reading ${url}…`);
  const res = await fetch(url);
  if (!res.ok) fail(`feed: HTTP ${res.status}`);
  const { accepted, dropped } = selectReleases(await res.json(), { os: OS, arch: ARCH, channel: values.channel }, RELEASE_KEYS);
  for (const d of dropped) console.warn(`dropped ${String(d.release["component"])}@${String(d.release["version"])}: ${d.reason}`);
  const release = newest(accepted, "brain", "0.0.0");
  if (!release) fail("the feed has no brain release for this target");
  const file = join(dest, process.platform === "win32" ? "brain.exe" : "brain");
  log(`downloading brain ${release.version} (${release.size} bytes)…`);
  await download(release.url, file, { size: release.size, sha256: release.sha256 });
  makeExecutable(file);
  writeFileSync(join(dest, "release.json"), JSON.stringify(release, null, 2) + "\n");
} else {
  fail("pass --from <dir> or --feed");
}

const check = await verifyBrainDir(dest, RELEASE_KEYS);
if (!check.ok) fail(`the staged brain does not verify: ${check.reason}`);
log(`staged brain ${check.release.version} at ${dest}`);
