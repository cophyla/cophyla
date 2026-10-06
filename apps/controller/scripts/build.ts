// Bundles the controller app into `dist/`, which the node serves on the controller listener,
// or, with `--native`, into `dist-native/`, which the Capacitor shell wraps; `--server` is
// the server the native app signs in to (the production one by default).
//   bun run apps/controller/scripts/build.ts [--native [--server https://orc.example]]
// The page is one entry point; the native build takes `native.ts` as the page: the same app
// over the shell's plugins, with the relay on. Beside it, voicehost's assets, which the
// desktop app's host page carries too: the capture worklet, the wake word's worker, and the
// wake word's files under `wake/`, each checked against its pin, with a NOTICE of their
// licences. Neither build keeps the policy the page's source carries in a `<meta>`: the node
// sends the page its policy as a header, which can say more than a `<meta>` can, and the
// shell serves the native page from an origin of its own, where no `'self'` policy holds.
// The node's page takes its manifest and its icons along, so a browser can install it as an
// app; the native page, which is installed as its shell, carries neither nor a word of them.

import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONTROLLER_INSTALL_TAGS, CONTROLLER_META_CSP } from "@cophyla/protocol";
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
copyFileSync(join(root, "src", "controller.css"), join(dist, "controller.css"));
const page = (await Bun.file(join(root, "src", "index.html")).text()).replace(CONTROLLER_META_CSP, "");
await Bun.write(join(dist, "index.html"), native ? page.replace(CONTROLLER_INSTALL_TAGS, "") : page);
if (!native) {
  copyFileSync(join(root, "src", "app.webmanifest"), join(dist, "app.webmanifest"));
  cpSync(join(root, "src", "icons"), join(dist, "icons"), { recursive: true });
}
// The view picker's and the settings' looks are viewhost's, shared with the desktop app.
copyFileSync(Bun.resolveSync("@cophyla/viewhost/chooser.css", root), join(dist, "chooser.css"));
copyFileSync(Bun.resolveSync("@cophyla/viewhost/settings.css", root), join(dist, "settings.css"));

await buildVoiceAssets({ outDir: dist, minify: process.env["NODE_ENV"] === "production" });

console.log(`controller built into ${dist}${native ? ` (native, signs in to ${server})` : ""}`);
