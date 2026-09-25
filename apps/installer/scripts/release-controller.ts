// The phone app, end to end: the native web bundle (`dist-native/`), `cap sync android`
// copying it into the Android project, and Gradle building the APK — signed with the release
// keystore under `~/.cophyla-release/controller.jks` (named by `COPHYLA_ANDROID_KEYSTORE`, its
// password by `COPHYLA_ANDROID_KEYSTORE_PASSWORD`, never read from a file in the tree), or the
// debug build with `--debug`. The APK goes to `stage/out/cophyla-controller-<v>[-debug].apk`;
// it is a release asset beside the platform's, never a feed entry — the phone updates through
// the store or by installing the next one, not through cophylad.
//   bun run apps/installer/scripts/release-controller.ts [--debug] [--skip-build]
// The Android toolchain is found the way Gradle finds it: `JAVA_HOME` (or `COPHYLA_JAVA_HOME`,
// which wins), and the SDK from `android/local.properties` or `ANDROID_HOME`.

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BUILD_JOBS, CONTROLLER, ensureDir, fail, fileSize, log, OUT, RELEASE_HOME, run } from "./lib.ts";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { debug: { type: "boolean" }, "skip-build": { type: "boolean" } }, strict: true });

const ANDROID = join(CONTROLLER, "android");
if (!existsSync(join(ANDROID, "gradlew"))) fail(`no Android project at ${ANDROID}`);
const { version } = JSON.parse(readFileSync(join(CONTROLLER, "package.json"), "utf8")) as { version: string };

// Firebase's file is the user's, gitignored; Gradle skips the google-services plugin without it, so a debug APK
// still builds (pairing and the relay work, push does not) while a release must have it
if (!existsSync(join(ANDROID, "app", "google-services.json"))) {
  const where = `no google-services.json in ${join(ANDROID, "app")}: the Firebase project's file goes there (it is gitignored)`;
  if (!values.debug) fail(where);
  console.warn(`warning: ${where}; this debug build cannot receive pushes`);
}

const env: Record<string, string | undefined> = {};
const javaHome = process.env["COPHYLA_JAVA_HOME"] ?? process.env["JAVA_HOME"];
if (javaHome) env["JAVA_HOME"] = javaHome;

if (!values.debug) {
  const keystore = process.env["COPHYLA_ANDROID_KEYSTORE"] ?? join(RELEASE_HOME, "controller.jks");
  if (!existsSync(keystore)) fail(`no keystore at ${keystore}: make one with keytool, or build with --debug`);
  if (!process.env["COPHYLA_ANDROID_KEYSTORE_PASSWORD"]) fail("COPHYLA_ANDROID_KEYSTORE_PASSWORD is not set");
  env["COPHYLA_ANDROID_KEYSTORE"] = keystore;
}

if (!values["skip-build"]) {
  log("building the controller app (native)…");
  await run(["bun", "run", join(CONTROLLER, "scripts", "build.ts"), "--native"], { env: { NODE_ENV: "production" } });
  log("syncing the Android project…");
  await run(["bunx", "cap", "sync", "android"], { cwd: CONTROLLER });
}

const gradlew = process.platform === "win32" ? join(ANDROID, "gradlew.bat") : join(ANDROID, "gradlew");
const task = values.debug ? "assembleDebug" : "assembleRelease";
log(`gradle ${task} (${BUILD_JOBS} workers)…`);
await run([gradlew, task, "--no-daemon", "-q", `--max-workers=${BUILD_JOBS}`], { cwd: ANDROID, env });

const built = join(ANDROID, "app", "build", "outputs", "apk", values.debug ? "debug" : "release", values.debug ? "app-debug.apk" : "app-release.apk");
if (!existsSync(built)) fail(`no APK at ${built} after the build`);
ensureDir(OUT);
const artifact = join(OUT, `cophyla-controller-${version}${values.debug ? "-debug" : ""}.apk`);
copyFileSync(built, artifact);
log(`controller ${version}: ${artifact} (${(fileSize(artifact) / 1_048_576).toFixed(1)} MiB)${values.debug ? " — debug, not for release" : ""}`);
