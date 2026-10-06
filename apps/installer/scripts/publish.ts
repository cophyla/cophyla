// Publishes to GitHub: every OS's artifact of a component version and its signed entry as
// assets of the one release `<component>-v<version>` on the public repository, the
// installers as assets of the same release, and the feed files onto the orphan `feed`
// branch that GitHub Pages serves as the public feed, at the domain its `CNAME` names
// (`DEFAULT_FEED`'s host). Needs `gh` logged in
// and the repository to exist. Does nothing without `--yes`: publishing is the one step that
// cannot be undone quietly.
//
// `--release <component>@<version>` takes what `stage/out` holds for that version, whatever
// target each file is for (the Windows build's, and the Mac's and WSL's copied in), and
// checks each name against the feed's naming; the release is created once and every asset
// uploaded with `--clobber`, so a second run adds the targets that arrived since.
// `--installer` uploads the `Cophyla_<v>_*` packages to the platform's release; a brain
// release takes the brain repository's `EULA.md` with it. `--feed` clones the `feed` branch and
// merges every `.release.json` under `stage/out` into it with feed.ts --add, so a target
// published from another machine is never dropped.
//   bun run apps/installer/scripts/publish.ts --release platform@0.1.0 --release brain@0.1.1 --installer --feed --yes

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { releaseFileName } from "@cophyla/protocol";
import type { Release } from "@cophyla/protocol";
import { BRAIN_REPO, COMMIT_EMAIL, COMMIT_NAME, DEFAULT_FEED, fail, GITHUB_REPO, INSTALLER, log, OUT, PRODUCT, readJson, releaseTag, run } from "./lib.ts";

export interface Asset {
  artifact: string;
  entry: string;
  target: string;
}

export interface Plan {
  tag: string;
  title: string;
  assets: Asset[];
  problems: string[];
}

/**
 * What one `--release <component>@<version>` uploads: every `<component>-<version>-<os>-<arch>…`
 * in `out` with a `.release.json` beside it whose name, target and URL agree. Pure over the
 * directory listing and the entries, so it is tested without a GitHub.
 */
export function mergePlan(component: string, version: string, files: string[], entryOf: (file: string) => Release | undefined, repo: string, out = OUT, modelName?: string): Plan {
  const tag = releaseTag(component, version, modelName);
  const plan: Plan = { tag, title: component === "model" ? `${modelName} ${version}` : `${component} ${version}`, assets: [], problems: [] };
  // A model's one artifact is `model-<name>-<version>.tar.gz`; everything else is per target.
  const prefix = component === "model" ? `model-${modelName}-${version}.` : `${component}-${version}-`;
  for (const name of files.filter((f) => f.startsWith(prefix) && !f.endsWith(".release.json")).sort()) {
    const artifact = join(out, name);
    const entryPath = `${artifact}.release.json`;
    const release = entryOf(entryPath);
    if (!release) {
      plan.problems.push(`${name} has no .release.json beside it`);
      continue;
    }
    const expectedName = releaseFileName(release);
    if (expectedName !== name) {
      plan.problems.push(`${name} is named for the feed as ${expectedName}`);
      continue;
    }
    if (release.component !== component || release.version !== version) {
      plan.problems.push(`${name}'s entry is ${release.component} ${release.version}`);
      continue;
    }
    const expectedUrl = `https://github.com/${repo}/releases/download/${tag}/${name}`;
    if (release.url !== expectedUrl) {
      plan.problems.push(`${name}'s entry names ${release.url}, not ${expectedUrl}; sign-release without --url for the public feed`);
      continue;
    }
    plan.assets.push({ artifact, entry: entryPath, target: release.component === "model" ? "any" : `${release.os}-${release.arch}` });
  }
  if (plan.assets.length === 0 && plan.problems.length === 0) plan.problems.push(`nothing in ${out} for ${component === "model" ? modelName : component} ${version}`);
  return plan;
}

/** The packages in `out` for a version: `Cophyla_<v>_*`. */
export function installerAssets(version: string, files: string[]): string[] {
  return files.filter((f) => f.startsWith(`${PRODUCT}_${version}_`) && !f.endsWith(".release.json")).sort();
}

/**
 * The page at the feed's own address, for a person who opens it: the feed is read by
 * daemons at `<channel>/<os>-<arch>.json`, and without a page its root is the host's 404.
 */
export function feedIndex(repo: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${PRODUCT} release feed</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem}code{font-size:.95em}</style>
<h1>${PRODUCT} release feed</h1>
<p>This address is read by installed copies of ${PRODUCT}, not by people. It serves static, signed release entries per channel, OS and architecture, at <code>/&lt;channel&gt;/&lt;os&gt;-&lt;arch&gt;.json</code>. A daemon checks every entry against the release key shipped in the platform before it downloads anything.</p>
<p>To install ${PRODUCT}, go to its <a href="https://github.com/${repo}/releases">releases</a>.</p>
</html>
`;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      release: { type: "string", multiple: true },
      installer: { type: "boolean" },
      feed: { type: "boolean" },
      yes: { type: "boolean" },
      repo: { type: "string" },
    },
    strict: true,
  });
  const repo = values.repo ?? GITHUB_REPO;
  if (!values.yes) fail("nothing published: pass --yes once the tree is public and the artifacts are the ones you mean");
  const files = existsSync(OUT) ? readdirSync(OUT) : [];
  const entryOf = (path: string): Release | undefined => (existsSync(path) ? readJson<Release>(path) : undefined);

  // `--release model/<name>@<version>` names the model; the other two name only a version.
  const releases = (values.release ?? []).map((spec) => {
    const m = /^(platform|brain)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec);
    if (m) return { component: m[1]!, version: m[2]! };
    const model = /^model\/([a-z0-9][a-z0-9.-]{1,63})@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec);
    if (model) return { component: "model", version: model[2]!, name: model[1]! };
    return fail(`--release <component>@<version> or model/<name>@<version>, not ${spec}`);
  });

  for (const { component, version, name } of releases) {
    const plan = mergePlan(component, version, files, entryOf, repo, OUT, name);
    for (const p of plan.problems) console.warn(`skipped: ${p}`);
    if (plan.assets.length === 0) fail(`nothing to publish for ${plan.tag}`);
    const exists = await run(["gh", "release", "view", plan.tag, "--repo", repo], { capture: true, allowFailure: true });
    if (exists.code !== 0) {
      await run(["gh", "release", "create", plan.tag, "--repo", repo, "--title", plan.title, "--notes", `Signed ${component} release ${version}. The feed entry beside each artifact is what the daemon verifies.`]);
    }
    for (const a of plan.assets) {
      await run(["gh", "release", "upload", plan.tag, a.artifact, a.entry, "--repo", repo, "--clobber"]);
      log(`${plan.tag}: ${a.target} uploaded`);
    }
    // The packages carry the platform's version and go with its release alone.
    if (values.installer && component === "platform") {
      const packages = installerAssets(version, files);
      if (packages.length === 0) console.warn(`no ${PRODUCT}_${version}_* package in ${OUT}`);
      for (const p of packages) {
        await run(["gh", "release", "upload", plan.tag, join(OUT, p), "--repo", repo, "--clobber"]);
        log(`${plan.tag}: ${p} uploaded`);
      }
    }
    // The brain's licence is published with every brain release: the installer's licence page says so.
    if (component === "brain") {
      const eula = join(BRAIN_REPO, "EULA.md");
      if (existsSync(eula)) {
        await run(["gh", "release", "upload", plan.tag, eula, "--repo", repo, "--clobber"]);
        log(`${plan.tag}: EULA.md uploaded`);
      } else console.warn(`no EULA.md in ${BRAIN_REPO}: the brain release goes out without its licence`);
    }
    log(`published ${plan.tag}`);
  }

  if (values.feed) {
    const entries = files.filter((f) => f.endsWith(".release.json")).map((f) => join(OUT, f));
    if (entries.length === 0) fail(`no .release.json under ${OUT}`);
    const work = mkdtempSync(join(tmpdir(), "cophyla-feed-"));
    const remote = `https://github.com/${repo}.git`;
    const fetched = await run(["git", "clone", "--branch", "feed", "--depth", "1", remote, work], { allowFailure: true, capture: true });
    if (fetched.code !== 0) {
      rmSync(work, { recursive: true, force: true });
      await run(["git", "init", "-b", "feed", work]);
      await run(["git", "-C", work, "remote", "add", "origin", remote]);
    }
    // Merge, never wipe: the branch may carry targets published from another machine.
    await run(["bun", "run", join(INSTALLER, "scripts", "feed.ts"), "--dir", work, "--add", ...entries]);
    await Bun.write(join(work, "README.md"), `# Cophyla release feed\n\nStatic, signed release entries per channel, OS and architecture: \`<channel>/<os>-<arch>.json\`.\nThe daemon verifies every entry against the release key shipped in the platform before it stages anything.\nThe artifacts are the assets of the \`<component>-v<version>\` releases in this repository.\n`);
    // What a person who opens the feed's address sees, where the host's 404 would be.
    await Bun.write(join(work, "index.html"), feedIndex(repo));
    // Pages drops a custom domain the branch doesn't name, so every push carries it; and it
    // serves the files as they are, with no Jekyll pass.
    await Bun.write(join(work, "CNAME"), `${new URL(DEFAULT_FEED).host}\n`);
    await Bun.write(join(work, ".nojekyll"), "");
    await run(["git", "-C", work, "add", "-A"]);
    const status = await run(["git", "-C", work, "status", "--porcelain"], { capture: true });
    if (status.stdout.trim() === "") log("feed branch unchanged");
    else {
      await run(["git", "-C", work, "-c", `user.name=${COMMIT_NAME}`, "-c", `user.email=${COMMIT_EMAIL}`, "commit", "-q", "-m", `feed: ${new Date().toISOString()}`]);
      // The feed branch alone, whatever else the clone holds.
      await run(["git", "-C", work, "push", "-u", "origin", "refs/heads/feed:refs/heads/feed"]);
      log(`feed pushed to ${repo}@feed`);
    }
    rmSync(work, { recursive: true, force: true });
  }
}
