// One platform release, end to end: the staged version directory (shell build, runtime,
// cophylad's tree, icons, the shell signed), the archive the feed serves, and the signed entry
// beside the archive and inside the version directory as its `release.json`.
//   bun run apps/installer/scripts/release-platform.ts [--skip-shell-build] [--url <artifact url>]

import { join } from "node:path";
import { parseArgs } from "node:util";
import { releaseFileName } from "@cophyla/protocol";
import { ARCH, INSTALLER, log, OS, OUT, platformVersion, run, STAGE } from "./lib.ts";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { "skip-shell-build": { type: "boolean" }, url: { type: "string" } }, strict: true });
const version = platformVersion();
const scripts = join(INSTALLER, "scripts");

await run(["bun", "run", join(scripts, "stage-platform.ts"), "--version", version, ...(values["skip-shell-build"] ? ["--skip-shell-build"] : [])]);
await run(["bun", "run", join(scripts, "pack-platform.ts"), "--version", version]);
const archive = join(OUT, releaseFileName({ component: "platform", version, os: OS, arch: ARCH }));
const args = ["--component", "platform", "--version", version, "--file", archive, "--into", join(STAGE, "versions", version)];
if (values.url) args.push("--url", values.url);
await run(["bun", "run", join(scripts, "sign-release.ts"), ...args]);
log(`platform ${version}: ${archive}, its .release.json, and stage/versions/${version}/release.json`);
