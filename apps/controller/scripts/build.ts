// Bundles the controller app into `dist/`, which the node serves on the controller listener,
// or, with `--native`, into `dist-native/`, which the Capacitor shell wraps; `--server` is
// the server the native app signs in to (the production one by default).
//   bun run apps/controller/scripts/build.ts [--native [--server https://orc.example]]
// The page is one entry point; the native build takes `native.ts` as the page: the same app
// over the shell's plugins, with the relay on. Beside it, voicehost's assets, which the
// desktop app's host page carries too: the capture worklet, the wake word's worker, and the
// wake word's files under `wake/`, each checked against its pin, with a NOTICE of their
// licences.

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildVoiceAssets } from "@cophyla/voicehost/build";

const native = process.argv.includes("--native");
const serverAt = process.argv.indexOf("--server");
const server = serverAt > 0 ? process.argv[serverAt + 1] : (process.env["COPHYLA_SERVER_URL"] ?? "https://api.getcophyla.com");
if (!server || !/^https?:\/\/[^/]+$/.test(server.replace(/\/$/, ""))) {
  console.error(`--server must be an origin, like https://orc.example (got ${server ?? "nothing"})`);
  process.exit(1);
}
const root = join(import.meta.dir, "..");
const dist = join(root, native ? "dist-native" : "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const build = async (entry: string, naming: string) => {
  const result = await Bun.build({
    entrypoints: [join(root, "src", entry)],
    outdir: dist,
    target: "browser",
    format: "esm",
    naming,
    minify: process.env["NODE_ENV"] === "production",
    sourcemap: "none",
    define: { COPHYLA_SERVER_URL: JSON.stringify(server.replace(/\/$/, "")) },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
};

await build(native ? "native.ts" : "main.ts", "main.js");
for (const file of ["index.html", "controller.css"]) copyFileSync(join(root, "src", file), join(dist, file));
// The view picker's and the settings' looks are viewhost's, shared with the desktop app.
copyFileSync(Bun.resolveSync("@cophyla/viewhost/chooser.css", root), join(dist, "chooser.css"));
copyFileSync(Bun.resolveSync("@cophyla/viewhost/settings.css", root), join(dist, "settings.css"));
if (native) {
  // the shell serves the page from its own origin and the link goes wherever the node is: no `'self'` policy holds
  const html = (await Bun.file(join(root, "src", "index.html")).text()).replace(/<meta\s+http-equiv="content-security-policy"[\s\S]*?\/>\s*/i, "");
  await Bun.write(join(dist, "index.html"), html);
}

await buildVoiceAssets({ outDir: dist, minify: process.env["NODE_ENV"] === "production" });

console.log(`controller built into ${dist}${native ? ` (native, signs in to ${server})` : ""}`);
