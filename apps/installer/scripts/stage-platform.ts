// Builds one platform version directory under `stage/versions/<v>`: the desktop shell (built
// by `tauri build --no-bundle` in apps/ui; on macOS as a whole `Cophyla.app` bundle, signed by
// the bundler), the Bun runtime this script runs on, tether (built from `tether/`, under
// `bin/`, where cophylad finds it and copies it out before running it), cophyla-net (the direct
// connections' helper, built from `apps/net/`, under `bin/` likewise, with its crates'
// licences beside it), cophylad's source tree
// with a hoisted production `node_modules` (no optional dependencies: the harness binaries
// are never shipped; cophylad finds the user's own) and physical copies of the workspace
// packages it depends on (tether's TypeScript SDK among them), and the icons, the built
// controller app cophylad serves on the LAN (with the wake word's models and runtime under its
// `wake/`), and the speech sidecar's sources (its Python environment is built on the node,
// never shipped). Signs what needs signing here, so the bundler leaves it alone: the shell,
// tether and cophyla-net on Windows (Authenticode), the runtime, tether and every Mach-O under
// cophylad's tree on macOS (hardened runtime with Bun's entitlements) and cophyla-net (hardened
// runtime with none), nothing on Linux. Writes
// `stage/current` for the installer. `release.json` is added by sign-release.ts. The node's
// voice models are not staged: the wake word's and the VAD's are `model` releases of their
// own; the controller's copy of the wake word is the one exception, since the phone runs it.
// No speech engine is staged either, nor sherpa-onnx, the runtime they run on (its native
// library carries espeak-ng, GPL-3.0): a node installs one from where its makers publish it
// when its user asks, and the stage fails if any of it lands here.
//   bun run apps/installer/scripts/stage-platform.ts --version 0.1.0 [--skip-shell-build]

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { BUILD_JOBS, BUN_NAME, cargoPath, ensureDir, fail, INSTALLER, log, NET, NET_LICENCES, NET_LICENCES_REL, NET_REL, COPHYLAD, OS, platformVersion, REPO, run, SHELL_REL, STAGE, TETHER, TETHER_REL, UI } from "./lib.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { version: { type: "string" }, "skip-shell-build": { type: "boolean" } },
  strict: true,
});

const version = values.version ?? platformVersion();
if (version !== platformVersion()) fail(`--version ${version} is not apps/cophylad/package.json's ${platformVersion()}; run version.ts --set first`);
await run(["bun", "run", join(INSTALLER, "scripts", "version.ts"), "--check"]);

const dir = join(STAGE, "versions", version);
const target = join(UI, "src-tauri", "target", "release");
/** What the shell build leaves: the executable, or on macOS the bundle the bundler assembled. */
const shellSrc = OS === "macos" ? join(target, "bundle", "macos", "Cophyla.app") : join(target, SHELL_REL);
const signingIdentity = process.env["APPLE_SIGNING_IDENTITY"] ?? "-";

// 1. The shell.
if (!values["skip-shell-build"]) {
  const env = { PATH: cargoPath(), CARGO_BUILD_JOBS: BUILD_JOBS, NODE_ENV: "production" };
  if (OS === "macos") {
    // A bundle per version: the shell's own identity, Dock icon and Info.plist (the Automation
    // usage string) live in it. The bundler signs it with the identity from the environment,
    // ad-hoc when none is set; notarization is the installer's, over the DMG.
    // Its entitlements (the microphone, Apple Events): the bundler signs it under the hardened runtime.
    const overlay = { bundle: { active: true, targets: ["app"], macOS: { signingIdentity, minimumSystemVersion: "11.0", entitlements: join(INSTALLER, "entitlements-shell.plist") } } };
    const overlayPath = join(ensureDir(STAGE), "ui-overlay.json");
    writeFileSync(overlayPath, JSON.stringify(overlay, null, 2) + "\n");
    if (signingIdentity === "-") log("APPLE_SIGNING_IDENTITY is not set: the shell bundle is signed ad-hoc");
    log("building the desktop shell as a bundle (tauri build --bundles app)…");
    await run(["bunx", "tauri", "build", "--bundles", "app", "--config", overlayPath], { cwd: UI, env });
  } else {
    log("building the desktop shell (tauri build --no-bundle)…");
    await run(["bun", "run", "build"], { cwd: UI, env });
  }
}
if (!existsSync(shellSrc)) fail(`no shell at ${shellSrc}`);

// tether, which sessions run in: its own workspace, released with its locked dependencies.
log("building tether (cargo build --release --locked)…");
await run(["cargo", "build", "--release", "--locked", "-p", "tether-pty", "-j", BUILD_JOBS], { cwd: TETHER, env: { PATH: cargoPath() } });
const tetherSrc = join(TETHER, "target", "release", basename(TETHER_REL));
if (!existsSync(tetherSrc)) fail(`no tether at ${tetherSrc} after the build`);

// cophyla-net, the direct connections' helper: its own workspace too, and its crates' licences.
log("building cophyla-net (cargo build --release --locked)…");
await run(["cargo", "build", "--release", "--locked", "-p", "cophyla-net", "-j", BUILD_JOBS], { cwd: NET, env: { PATH: cargoPath() } });
const netSrc = join(NET, "target", "release", basename(NET_REL));
if (!existsSync(netSrc)) fail(`no cophyla-net at ${netSrc} after the build`);
if (!existsSync(join(NET, NET_LICENCES))) fail(`no ${NET_LICENCES} in apps/net: run cargo about generate about.hbs > ${NET_LICENCES} there`);

// 2. The version directory, from scratch.
rmSync(dir, { recursive: true, force: true });
rmSync(dir + ".partial", { recursive: true, force: true });
ensureDir(dir);
if (OS === "macos") cpSync(shellSrc, join(dir, "Cophyla.app"), { recursive: true, verbatimSymlinks: true });
else cpSync(shellSrc, join(dir, SHELL_REL));
if (!existsSync(join(dir, SHELL_REL))) fail(`the shell is not at ${join(dir, SHELL_REL)} after the copy`);
cpSync(process.execPath, join(dir, BUN_NAME));
mkdirSync(join(dir, "bin"), { recursive: true });
cpSync(tetherSrc, join(dir, TETHER_REL));
cpSync(netSrc, join(dir, NET_REL));
cpSync(join(NET, NET_LICENCES), join(dir, NET_LICENCES_REL));
if (OS !== "windows") {
  chmodSync(join(dir, BUN_NAME), 0o755);
  chmodSync(join(dir, SHELL_REL), 0o755);
  chmodSync(join(dir, TETHER_REL), 0o755);
  chmodSync(join(dir, NET_REL), 0o755);
}
log(`shell, runtime, tether and cophyla-net copied (bun ${Bun.version})`);

// 3. cophylad: package.json without the workspace links and the dev dependencies, its sources and views.
const cophyladDir = join(dir, "cophylad", "apps", "cophylad");
mkdirSync(cophyladDir, { recursive: true });
const pkg = JSON.parse(readFileSync(join(COPHYLAD, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies?: unknown; scripts?: unknown };
// sherpa-onnx is a development dependency: the stage installs production ones only.
if (pkg.dependencies["sherpa-onnx-node"]) fail("apps/cophylad/package.json depends on sherpa-onnx-node; the speech runtime is never shipped, a node installs it");
// The workspace packages are published nowhere: they leave the install and are copied in after it.
const workspace = Object.keys(pkg.dependencies).filter((name) => pkg.dependencies[name]!.startsWith("workspace:"));
/** Where a workspace package lives: `packages/` for cophylad's own, `tether/sdk/typescript` for tether's SDK. */
const workspaceDir = (name: string): string | undefined =>
  name.startsWith("@cophyla/") ? join(REPO, "packages", name.slice("@cophyla/".length)) : name === "@tether-pty/client" ? join(TETHER, "sdk", "typescript") : undefined;
for (const name of workspace) {
  const src = workspaceDir(name);
  if (!src || !existsSync(join(src, "package.json"))) fail(`${name} is a workspace dependency with no directory the stage knows`);
  delete pkg.dependencies[name];
}
delete pkg.devDependencies;
delete pkg.scripts;
writeFileSync(join(cophyladDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
cpSync(join(COPHYLAD, "src"), join(cophyladDir, "src"), { recursive: true });
cpSync(join(COPHYLAD, "views"), join(cophyladDir, "views"), { recursive: true, filter: (src) => !src.endsWith("tsconfig.json") });
log("installing cophylad's dependencies (production, no optional, hoisted)…");
await run(["bun", "install", "--production", "--omit=optional", "--linker=hoisted", "--no-summary"], { cwd: cophyladDir });
rmSync(join(cophyladDir, "bun.lock"), { force: true });
// The install's `.bin` shims are unsigned executables cophylad never calls.
rmSync(join(cophyladDir, "node_modules", ".bin"), { recursive: true, force: true });
for (const name of workspace) {
  const src = workspaceDir(name)!;
  const own = JSON.parse(readFileSync(join(src, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  // A workspace package that needs another must have cophylad name it too, or the copy would be missing it.
  for (const [dep, range] of Object.entries(own.dependencies ?? {})) if (range.startsWith("workspace:") && !workspace.includes(dep)) fail(`${name} needs ${dep}, which apps/cophylad/package.json does not name`);
  const dst = join(cophyladDir, "node_modules", ...name.split("/"));
  mkdirSync(dst, { recursive: true });
  cpSync(join(src, "package.json"), join(dst, "package.json"));
  cpSync(join(src, "src"), join(dst, "src"), { recursive: true });
}
log(`workspace packages copied: ${workspace.join(", ")}`);
// The harness binaries are optional dependencies of the SDKs and are never shipped.
const HARNESS_BINARY = /^(claude-agent-sdk|codex)-(win32|darwin|linux)-/;
for (const scope of ["@anthropic-ai", "@openai"]) {
  const scopeDir = join(cophyladDir, "node_modules", scope);
  if (!existsSync(scopeDir)) continue;
  for (const name of readdirSync(scopeDir)) if (HARNESS_BINARY.test(name)) fail(`${scope}/${name} landed in the stage; the harness binaries are never shipped`);
}
// The embedding model beside `src/` (the daemon resolves `../models` from its own tree), and
// onnxruntime-node's binaries for this target only: the package carries every platform's.
const modelsSrc = join(COPHYLAD, "models");
if (!existsSync(join(modelsSrc, "bge-small-en-v1.5", "manifest.json"))) fail(`no embedding model at ${modelsSrc}; run apps/cophylad/scripts/fetch-models.ts`);
// `models/voice` is a gigabyte of `model` releases the daemon fetches on demand; the archive
// carries only the embedding model, which recall needs from the first run.
const voiceModels = join(modelsSrc, "voice");
cpSync(modelsSrc, join(cophyladDir, "models"), { recursive: true, filter: (src) => src !== voiceModels });
// None of sherpa-onnx belongs in the stage, not even pulled in by something else.
const sherpaFound = readdirSync(join(cophyladDir, "node_modules")).filter((n) => n.startsWith("sherpa-onnx"));
if (sherpaFound.length > 0) fail(`the stage carries ${sherpaFound.join(", ")}; the speech runtime is never shipped, a node installs it`);
const ortBin = join(cophyladDir, "node_modules", "onnxruntime-node", "bin", "napi-v6");
if (!existsSync(join(ortBin, process.platform, process.arch))) fail(`onnxruntime-node has no binaries for ${process.platform}/${process.arch} under ${ortBin}`);
for (const os of readdirSync(ortBin)) {
  for (const arch of readdirSync(join(ortBin, os))) {
    if (os === process.platform && arch === process.arch) continue;
    rmSync(join(ortBin, os, arch), { recursive: true, force: true });
  }
  if (readdirSync(join(ortBin, os)).length === 0) rmSync(join(ortBin, os), { recursive: true, force: true });
}
// On macOS the package carries its library twice, `libonnxruntime.1.dylib` (what the binding
// links, `@rpath/libonnxruntime.1.dylib`) and a byte-identical `libonnxruntime.<version>.dylib`: 44 MB.
const ortHere = join(ortBin, process.platform, process.arch);
if (OS === "macos" && existsSync(join(ortHere, "libonnxruntime.1.dylib"))) {
  for (const name of readdirSync(ortHere)) if (/^libonnxruntime\.\d+\.\d+\.\d+\.dylib$/.test(name)) rmSync(join(ortHere, name));
}
log(`embedding model staged; onnxruntime-node pruned to ${process.platform}/${process.arch}`);

// 4. The controller app cophylad serves to a phone, beside cophylad's tree where daemon.ts looks
// for it, and the speech sidecar's sources. The sidecar's Python environment and weights are
// five gigabytes built on the node the first time the stage is turned on: never shipped.
log("building the controller app…");
await run(["bun", "run", join(REPO, "apps", "controller", "scripts", "build.ts")], { env: { NODE_ENV: "production" } });
const controllerDist = join(REPO, "apps", "controller", "dist");
if (!existsSync(join(controllerDist, "index.html"))) fail(`no controller app at ${controllerDist} after the build`);
if (!existsSync(join(controllerDist, "wake", "ort-wasm-simd-threaded.wasm"))) fail(`the controller app at ${controllerDist} carries no wake word`);
cpSync(controllerDist, join(dir, "cophylad", "apps", "controller", "dist"), { recursive: true });

const SIDECAR_SKIP = new Set([".venv", "__pycache__", "out"]);
const ttsPySrc = join(REPO, "sidecars", "tts-py");
if (!existsSync(join(ttsPySrc, "server.py"))) fail(`no speech sidecar at ${ttsPySrc}`);
cpSync(ttsPySrc, join(dir, "cophylad", "sidecars", "tts-py"), { recursive: true, filter: (src) => !SIDECAR_SKIP.has(basename(src)) });
log("controller app and the speech sidecar's sources staged");

// 5. Icons, for the toast registration, the Linux notification and the tray.
mkdirSync(join(dir, "icons"), { recursive: true });
for (const icon of ["128x128.png", "icon.ico"]) cpSync(join(UI, "src-tauri", "icons", icon), join(dir, "icons", icon));

// 6. Sign here what the bundler must leave alone (sign.ts without --staged skips staged files).
const sign = (...args: string[]) => run(["bun", "run", join(INSTALLER, "scripts", "sign.ts"), "--staged", ...args]);
if (OS === "windows") {
  await sign(join(dir, SHELL_REL));
  await sign(join(dir, TETHER_REL));
  await sign(join(dir, NET_REL));
} else if (OS === "macos") {
  // The bundle was signed by the bundler; the runtime, tether and cophylad's native modules get the
  // hardened runtime with Bun's entitlements, so a notarized package carries no unsigned Mach-O;
  // cophyla-net, which runs no JavaScript, gets the hardened runtime with none.
  await sign(join(dir, BUN_NAME));
  await sign(join(dir, TETHER_REL));
  await sign("--entitlements", join(INSTALLER, "entitlements-net.plist"), join(dir, NET_REL));
  await sign("--tree", join(cophyladDir, "node_modules"));
} else {
  log("linux: nothing to sign");
}

writeFileSync(join(STAGE, "current"), version + "\n");
const size = await run(["bun", "-e", `const g=new Bun.Glob("**/*");let n=0,b=0;for(const f of g.scanSync({cwd:process.argv[1],onlyFiles:true})){n++;b+=Bun.file(process.argv[1]+"/"+f).size}console.log(n+" files, "+(b/1048576).toFixed(1)+" MB")`, dir], { capture: true });
log(`staged platform ${version} at ${dir}: ${size.stdout.trim()}`);
