// Writes the signed release entry for one artifact: name, version, channel, target, protocol
// range, size, hash, download URL and publication time, signed with the offline release key
// over everything but the URL. The entry lands beside the artifact as `<artifact>.release.json`
// and, with `--into <dir>`, as `<dir>/release.json` (the version directory or the brain's).
// The target is this host's unless `--target <os>-<arch>` says otherwise, so the key holder
// can sign an artifact built on another machine. A `model` release is the exception: it is
// bytes a stage loads, the same on every target, so it takes `--name <model>` and its entry
// carries no os, arch or protocol range.
//   bun run apps/installer/scripts/sign-release.ts --component platform --version 0.1.0 \
//     --file stage/out/platform-0.1.0-windows-x64.tar.gz --into stage/versions/0.1.0 \
//     [--target macos-arm64] [--url …] [--protocol 1-1] [--channel stable] [--key <path>]
//   bun run apps/installer/scripts/sign-release.ts --component model --name tts-kokoro-en \
//     --version 1.0.0 --file stage/out/model-tts-kokoro-en-1.0.0.tar.gz

import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION, Release, releaseFileName } from "@cophyla/protocol";
import { sha256File, signRelease, verifyRelease } from "../../cophylad/src/update/verify.ts";
import { RELEASE_KEYS } from "../../cophylad/src/update/keys.ts";
import { ARCH, ARTIFACT_BASE, ensureDir, fail, fileSize, log, MODEL_NAME, OS, parseTarget, releaseKeyPath, releaseTag, SEMVER } from "./lib.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    component: { type: "string" },
    version: { type: "string" },
    file: { type: "string" },
    into: { type: "string" },
    target: { type: "string" },
    name: { type: "string" },
    url: { type: "string" },
    protocol: { type: "string" },
    channel: { type: "string", default: "stable" },
    key: { type: "string" },
  },
  strict: true,
});

const target = values.target === undefined ? { os: OS, arch: ARCH } : (parseTarget(values.target) ?? fail(`--target <os>-<arch> with os windows|macos|linux and arch x64|arm64, not ${values.target}`));

const component = values.component;
if (component !== "platform" && component !== "brain" && component !== "model") fail("--component platform|brain|model");
const version = values.version;
if (!version || !SEMVER.test(version)) fail("--version <semver>");
const file = values.file;
if (!file || !existsSync(file)) fail(`--file <artifact>: ${file ?? "(none)"} not found`);
const channel = values.channel;
if (channel !== "stable" && channel !== "beta") fail("--channel stable|beta");
const range = values.protocol ?? `${PROTOCOL_VERSION}-${PROTOCOL_VERSION}`;
const m = /^(\d+)-(\d+)$/.exec(range);
if (!m) fail("--protocol min-max");
const protocol = { min: Number(m[1]), max: Number(m[2]) };
// A model's `name` is the model's own, and the file name follows from it; everything else
// names its artifact and carries the target it was built for.
const modelName = values.name;
if (component === "model" && (!modelName || !MODEL_NAME.test(modelName))) fail("--name <model> is required for a model release, lowercase with dots and dashes");
const name = component === "model" ? modelName! : basename(file);
const expectedFile = releaseFileName({ component, version, name, os: target.os, arch: target.arch });
if (basename(file) !== expectedFile) fail(`--file is ${basename(file)}; the feed names this release ${expectedFile}`);
const url = values.url ?? `${ARTIFACT_BASE}/${releaseTag(component, version, name)}/${basename(file)}`;

const keyPem = await Bun.file(releaseKeyPath(values.key)).text();
const unsigned = {
  component,
  name,
  version,
  channel,
  // A model runs anywhere the platform does: it names no OS, no architecture and no protocol range.
  ...(component === "model" ? {} : { os: target.os, arch: target.arch, protocol }),
  url,
  size: fileSize(file),
  sha256: await sha256File(file),
  publishedAt: Date.now(),
};
const release = signRelease(unsigned, keyPem);
const parsed = Release.safeParse(release);
if (!parsed.success) fail(`the entry does not parse as a Release: ${parsed.error.message}`);
if (RELEASE_KEYS.length > 0 && !verifyRelease(release, RELEASE_KEYS)) {
  fail("the entry does not verify against RELEASE_KEYS in apps/cophylad/src/update/keys.ts: the key you signed with is not the one the platform ships");
}

const text = JSON.stringify(release, null, 2) + "\n";
const beside = `${file}.release.json`;
writeFileSync(beside, text);
log(`wrote ${beside}`);
if (values.into) {
  ensureDir(values.into);
  writeFileSync(join(values.into, "release.json"), text);
  log(`wrote ${join(values.into, "release.json")}`);
}
log(`${component} ${version} ${component === "model" ? name : `${target.os}-${target.arch}`}: ${release.size} bytes, sha256 ${release.sha256.slice(0, 16)}…, url ${url}`);
