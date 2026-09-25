// The platform version has one source, `apps/cophylad/package.json`; the shell's Cargo.toml and
// tauri.conf.json, the launcher's Cargo.toml and tauri.conf.json, the ui and installer
// package.json files, and the controller's package.json and its Android `version.properties`
// (`versionName` and a `versionCode` derived from it) follow it. `--check` fails when any of
// them differ; `--set <v>` writes the version everywhere.
//   bun run apps/installer/scripts/version.ts --check
//   bun run apps/installer/scripts/version.ts --set 0.1.1

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CONTROLLER, fail, INSTALLER, log, COPHYLAD, platformVersion, SEMVER, UI } from "./lib.ts";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { check: { type: "boolean" }, set: { type: "string" } }, strict: true });

interface Target {
  path: string;
  read: (text: string) => string | undefined;
  write: (text: string, version: string) => string;
}

const jsonVersion = (path: string): Target => ({
  path,
  read: (text) => (JSON.parse(text) as { version?: string }).version,
  write: (text, version) => text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`),
});

const cargoVersion = (path: string): Target => ({
  path,
  // The [package] table's version: the first `version = "…"` line, before any dependency table.
  read: (text) => /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(text)?.[1],
  write: (text, version) => text.replace(/(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m, `$1${version}$2`),
});

/** Android's integer version: `major * 10000 + minor * 100 + patch`, so 0.6.0 is 600 and 1.2.3 is 10203; a prerelease suffix does not count. */
export function androidVersionCode(version: string): number {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) fail(`not a version: ${version}`);
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

/** `android/version.properties`: `versionName` is the version, `versionCode` follows from it. */
const propertiesVersion = (path: string): Target => ({
  path,
  read: (text) => /^versionName=(.*)$/m.exec(text)?.[1]?.trim(),
  write: (text, version) => text.replace(/^versionName=.*$/m, `versionName=${version}`).replace(/^versionCode=.*$/m, `versionCode=${androidVersionCode(version)}`),
});

const targets: Target[] = [
  jsonVersion(join(UI, "package.json")),
  jsonVersion(join(UI, "src-tauri", "tauri.conf.json")),
  cargoVersion(join(UI, "src-tauri", "Cargo.toml")),
  jsonVersion(join(INSTALLER, "package.json")),
  jsonVersion(join(INSTALLER, "src-tauri", "tauri.conf.json")),
  cargoVersion(join(INSTALLER, "src-tauri", "Cargo.toml")),
  jsonVersion(join(CONTROLLER, "package.json")),
  propertiesVersion(join(CONTROLLER, "android", "version.properties")),
];

if (values.set !== undefined) {
  const version = values.set;
  if (!SEMVER.test(version)) fail(`not a version: ${version}`);
  for (const t of [jsonVersion(join(COPHYLAD, "package.json")), ...targets]) {
    const text = readFileSync(t.path, "utf8");
    const next = t.write(text, version);
    if (next === text && t.read(text) !== version) fail(`could not set the version in ${t.path}`);
    writeFileSync(t.path, next);
    log(`${t.path}: ${version}`);
  }
  log("Cargo.lock files follow at the next cargo build.");
} else {
  const source = platformVersion();
  let bad = 0;
  for (const t of targets) {
    const v = t.read(readFileSync(t.path, "utf8"));
    if (v !== source) {
      console.error(`${t.path}: ${v ?? "(none)"} ≠ ${source}`);
      bad++;
    }
  }
  if (bad > 0) fail(`${bad} file(s) disagree with apps/cophylad/package.json (${source}); run version.ts --set ${source}`);
  log(`platform version ${source} everywhere`);
}
