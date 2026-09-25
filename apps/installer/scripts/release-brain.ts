// One brain release, end to end: `bun run build` in the brain repository (which emits
// `dist/brain.exe` on Windows and `dist/brain` elsewhere), the platform's signature on the
// executable, the copy the feed serves under `stage/out/brain-<v>-<os>-<arch>[.exe]`, and
// the signed entry beside it and in the brain's `dist/` (what stage-brain.ts --from bundles).
// The brain is built on each host; a cross-built binary (`bun build --compile --target`)
// goes through `--skip-build` on the host that signs it.
//   bun run apps/installer/scripts/release-brain.ts [--skip-build] [--url <artifact url>]

import { chmodSync, cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { releaseFileName } from "@cophyla/protocol";
import { ARCH, BRAIN_REPO, ensureDir, fail, INSTALLER, log, OS, OUT, run } from "./lib.ts";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { "skip-build": { type: "boolean" }, url: { type: "string" } }, strict: true });

if (!existsSync(join(BRAIN_REPO, "package.json"))) fail(`no brain repository at ${BRAIN_REPO}`);
const { version } = JSON.parse(readFileSync(join(BRAIN_REPO, "package.json"), "utf8")) as { version: string };
const built = join(BRAIN_REPO, "dist", OS === "windows" ? "brain.exe" : "brain");

if (!values["skip-build"]) await run(["bun", "run", "build"], { cwd: BRAIN_REPO });
if (!existsSync(built)) fail(`no build at ${built}`);
if (OS !== "windows") chmodSync(built, 0o755);
await run(["bun", "run", join(INSTALLER, "scripts", "sign.ts"), built]);

ensureDir(OUT);
const artifact = join(OUT, releaseFileName({ component: "brain", version, os: OS, arch: ARCH }));
cpSync(built, artifact);
const args = ["--component", "brain", "--version", version, "--file", artifact, "--into", join(BRAIN_REPO, "dist")];
if (values.url) args.push("--url", values.url);
await run(["bun", "run", join(INSTALLER, "scripts", "sign-release.ts"), ...args]);
log(`brain ${version}: ${artifact} and its .release.json; dist/ carries the entry for stage-brain.ts --from`);
