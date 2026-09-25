// Packs a staged platform version into the archive the feed serves:
// `stage/out/platform-<v>-<os>-<arch>.tar.gz`, holding what `versions/<v>` holds except
// `release.json`, which the daemon writes from the signed entry it verified. bsdtar from
// Windows (`tar.exe`) or the system `tar` elsewhere, both here and in the daemon that
// unpacks it; on macOS without the AppleDouble `._*` companions.
//   bun run apps/installer/scripts/pack-platform.ts --version 0.1.0

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultTar } from "../../cophylad/src/update/platform.ts";
import { ensureDir, fail, fileSize, log, OS, OUT, platformVersion, run, SHELL_REL, STAGE, TARGET } from "./lib.ts";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { version: { type: "string" } }, strict: true });
const version = values.version ?? platformVersion();
const dir = join(STAGE, "versions", version);
if (!existsSync(join(dir, SHELL_REL))) fail(`no staged platform at ${dir}; run stage-platform.ts first`);

const entries = readdirSync(dir).filter((e) => e !== "release.json" && !e.startsWith(".")).sort();
ensureDir(OUT);
const out = join(OUT, `platform-${version}-${TARGET}.tar.gz`);
rmSync(out, { force: true });
log(`packing ${entries.join(", ")} from ${dir}…`);
await run([defaultTar(), "-czf", out, "-C", dir, ...entries], { env: OS === "macos" ? { COPYFILE_DISABLE: "1" } : {} });
log(`wrote ${out} (${(fileSize(out) / 1048576).toFixed(1)} MB)`);
