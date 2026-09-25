// Bundles the host page into dist/, which tauri.conf.json names as frontendDist.
//   bun run scripts/build-host.ts
// One entry, browser target, no minification in dev so stack traces stay readable.

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "host", "main.ts")],
  outdir: dist,
  target: "browser",
  format: "esm",
  naming: "main.js",
  minify: process.env["NODE_ENV"] === "production",
  sourcemap: "none",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const file of ["index.html", "host.css"]) copyFileSync(join(root, "host", file), join(dist, file));
// The view picker's and the settings' looks are viewhost's, shared with the controller.
copyFileSync(Bun.resolveSync("@cophyla/viewhost/chooser.css", root), join(dist, "chooser.css"));
copyFileSync(Bun.resolveSync("@cophyla/viewhost/settings.css", root), join(dist, "settings.css"));
console.log(`host built into ${dist}`);
