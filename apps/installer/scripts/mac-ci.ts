// A platform release's macOS pieces, built on GitHub's Mac (.github/workflows/macos.yml) and
// brought into `stage/out` signed, so a release needs no Mac of the user's: the workflow's
// `platform` step stages and packs the tree at `--ref`; this downloads the archive and signs its
// entry here with the release key (sign-release.ts --target macos-arm64), which never leaves
// this machine; the `installer` step then builds the DMG over that very archive, its signed entry
// and the published macOS brain, and this downloads it. What lands is what publish.ts takes:
// `platform-<v>-macos-arm64.tar.gz` with its `.release.json`, and `Cophyla_<v>_aarch64.dmg`.
// `--ref` must be a commit GitHub has (pushed), and the tree there must say the version this
// tree says. Needs `gh` logged in and the release key.
//   bun run apps/installer/scripts/mac-ci.ts [--ref <commit>] [--brain 0.19.0] [--out <dir>]

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { sha256File } from "../../cophylad/src/update/verify.ts";
import { ensureDir, fail, INSTALLER, log, OUT, platformVersion, REPO, run } from "./lib.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { ref: { type: "string" }, brain: { type: "string", default: "0.19.0" }, out: { type: "string" } },
  strict: true,
});

const WORKFLOW = "macos.yml";
const POLL_MS = 30_000;
const version = platformVersion();
const out = values.out ?? OUT;
const brain = values.brain!;
// the workflow's checkout takes a commit by its whole id: a short one is looked for as a branch or tag
const ref = (await capture(["git", "rev-parse", `${values.ref ?? "HEAD"}^{commit}`])).trim();
if (!/^[0-9a-f]{40}$/.test(ref)) fail(`--ref ${values.ref} is not a commit here`);

/** A command's output; a failure ends this script with what it said. */
async function capture(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) fail(`${cmd.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`);
  return stdout;
}

/** Starts one step of the workflow and answers its run's id, found as the newest dispatch since. */
async function dispatch(fields: Record<string, string>): Promise<string> {
  const since = Date.now() - 5_000;
  await capture(["gh", "workflow", "run", WORKFLOW, ...Object.entries(fields).flatMap(([k, v]) => ["-f", `${k}=${v}`])]);
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(3_000);
    const runs = JSON.parse(await capture(["gh", "run", "list", "--workflow", WORKFLOW, "--event", "workflow_dispatch", "--limit", "5", "--json", "databaseId,createdAt"])) as { databaseId: number; createdAt: string }[];
    const fresh = runs.find((r) => Date.parse(r.createdAt) >= since);
    if (fresh) return String(fresh.databaseId);
  }
  fail(`the ${fields["step"]} run did not appear`);
}

/** Waits for a run to end; one that did not succeed ends this script with its failed steps' last lines. */
async function finished(id: string, what: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const r = JSON.parse(await capture(["gh", "run", "view", id, "--json", "status,conclusion"])) as { status: string; conclusion: string };
    if (r.status === "completed") {
      if (r.conclusion === "success") {
        log(`${what}: run ${id} done in ${Math.round((Date.now() - started) / 60_000)} min`);
        return;
      }
      const lines = await capture(["gh", "run", "view", id, "--log-failed"]).catch(() => "");
      fail(`${what}: run ${id} ended ${r.conclusion}\n${lines.split("\n").slice(-30).join("\n")}`);
    }
    await Bun.sleep(POLL_MS);
  }
}

ensureDir(out);
const archive = join(out, `platform-${version}-macos-arm64.tar.gz`);
const dmg = join(out, `Cophyla_${version}_aarch64.dmg`);
for (const f of [archive, `${archive}.release.json`, dmg]) if (existsSync(f)) fail(`${f} is there already: move it aside first`);

log(`platform ${version} for macos-arm64 at ${ref}, on GitHub's Mac`);
const platformRun = await dispatch({ step: "platform", version, ref });
log(`platform: run ${platformRun}`);
await finished(platformRun, "platform");
await capture(["gh", "run", "download", platformRun, "--name", "platform", "--dir", out]);
if (!existsSync(archive)) fail(`run ${platformRun} gave no ${archive}`);

// the entry is signed here, with the key this machine alone holds
await run(["bun", "run", join(INSTALLER, "scripts", "sign-release.ts"), "--component", "platform", "--version", version, "--file", archive, "--target", "macos-arm64"]);
const entry = readFileSync(`${archive}.release.json`, "utf8");

const installerRun = await dispatch({ step: "installer", version, ref, platform_run: platformRun, entry: JSON.stringify(JSON.parse(entry)), brain });
log(`installer: run ${installerRun}`);
await finished(installerRun, "installer");
await capture(["gh", "run", "download", installerRun, "--name", "installer", "--dir", out]);
if (!existsSync(dmg)) fail(`run ${installerRun} gave no ${dmg}`);

log(`${archive}: sha256 ${await sha256File(archive)}`);
log(`${dmg}: sha256 ${await sha256File(dmg)}`);
log("macOS pieces in place: publish.ts --release platform@" + version + " --installer takes them with the rest");
