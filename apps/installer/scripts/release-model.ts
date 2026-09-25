// One model release, end to end: the directory `fetch-models.ts --voice` wrote, packed into
// `stage/out/model-<name>-<v>.tar.gz` and signed. A model release carries no OS, no
// architecture and no protocol range — it is bytes a stage loads, the same on every target —
// so its entry goes into every target's feed file, and the daemon unpacks it under
// `data/models/<name>/<version>/` when a stage that needs it is turned on. The archive holds
// the model's files at its root, `manifest.json` among them: that manifest is what the daemon
// checks the unpacked files against.
//   bun run apps/installer/scripts/release-model.ts --name tts-kokoro-en
//   bun run apps/installer/scripts/release-model.ts --name wake-openwakeword --version 1.1.0 --channel beta

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { releaseFileName } from "@cophyla/protocol";
import { defaultTar } from "../../cophylad/src/update/platform.ts";
import { ensureDir, fail, fileSize, INSTALLER, log, MODEL_NAME, COPHYLAD, OS, OUT, run, SEMVER } from "./lib.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    name: { type: "string" },
    version: { type: "string" },
    dir: { type: "string" },
    channel: { type: "string" },
    url: { type: "string" },
    key: { type: "string" },
  },
  strict: true,
});

const name = values.name;
if (!name || !MODEL_NAME.test(name)) fail("--name <model>: lowercase letters, digits, dots and dashes, as `data/models/<name>/` is called");
const dir = values.dir ?? join(COPHYLAD, "models", "voice", name);
if (!existsSync(join(dir, "manifest.json"))) fail(`no manifest.json under ${dir}; run: bun run apps/cophylad/scripts/fetch-models.ts --voice --only ${name}`);

const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { name?: string; version?: string };
if (manifest.name !== name) fail(`${join(dir, "manifest.json")} names the model ${manifest.name}, not ${name}`);
// The manifest's version is the model's; `--version` is for re-cutting the same bytes.
const version = values.version ?? manifest.version;
if (!version || !SEMVER.test(version)) fail(`--version <semver>: ${join(dir, "manifest.json")} carries ${manifest.version ?? "none"}`);

// The archive holds the directory's contents at its root, so unpacking it into
// `data/models/<name>/<version>/` puts `manifest.json` where the daemon looks for it.
const entries = readdirSync(dir)
  .filter((e) => !e.startsWith("."))
  .sort();
if (!entries.includes("manifest.json")) fail(`${dir} has no manifest.json`);

ensureDir(OUT);
const artifact = join(OUT, releaseFileName({ component: "model", version, name }));
rmSync(artifact, { force: true });
log(`packing ${entries.join(", ")} from ${dir}…`);
await run([defaultTar(), "-czf", artifact, "-C", dir, ...entries], { env: OS === "macos" ? { COPYFILE_DISABLE: "1" } : {} });

const args = ["--component", "model", "--name", name, "--version", version, "--file", artifact];
if (values.channel) args.push("--channel", values.channel);
if (values.url) args.push("--url", values.url);
if (values.key) args.push("--key", values.key);
await run(["bun", "run", join(INSTALLER, "scripts", "sign-release.ts"), ...args]);
log(`model ${name} ${version}: ${artifact} (${(fileSize(artifact) / 1048576).toFixed(1)} MB) and its .release.json; feed.ts --add puts it in every target's file`);
