// Copies the default view's libraries into it, under `views/default/vendor/`, from the npm
// packages this workspace pins, each checked against its sha256 here: xterm.js, which draws
// terminals; marked, whose lexer reads markdown; and uqr, which encodes an invite's QR code.
// The view has no build step, so the copies are committed; a test checks them against the
// same pins, so a copy is never edited by hand and an upgrade is this script run with new pins.
//
//   bun run apps/cophylad/scripts/vendor-view.ts           copy, checking every pin
//   … --pin                                             copy without checking, print the hashes
//
// All are MIT; each one's licence travels with its copies.

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

export const VENDOR_DIR = join(import.meta.dir, "..", "views", "default", "vendor");

export interface VendoredFile {
  /** The npm package and the file in it. */
  pkg: string;
  from: string;
  /** Its name under `vendor/`. */
  to: string;
  sha256: string;
}

/** @xterm/xterm 6.0.0, @xterm/addon-fit 0.11.0, @xterm/addon-unicode11 0.9.0, @xterm/addon-web-links 0.12.0, marked 18.0.14, uqr 0.1.3. */
export const VENDORED: VendoredFile[] = [
  { pkg: "@xterm/xterm", from: "lib/xterm.mjs", to: "xterm.mjs", sha256: "b336ec65a086c056d4804b3d4c2347da5663d3f23c3f25be866467bd8857ad59" },
  { pkg: "@xterm/xterm", from: "css/xterm.css", to: "xterm.css", sha256: "854a7c0fb70e8b1a083c16797ab827299fb18744f5ad34f227b48337e33293c6" },
  { pkg: "@xterm/xterm", from: "LICENSE", to: "xterm-LICENSE.txt", sha256: "b569f629d00f2626a8100df2a1798210535621e42164dfd426a6fe5aac7b0ccd" },
  { pkg: "@xterm/addon-fit", from: "lib/addon-fit.mjs", to: "addon-fit.mjs", sha256: "2d87e1bddc73be9111de8beee5370c3bb7aac9c94e18e6f245f02ca741ef1769" },
  { pkg: "@xterm/addon-unicode11", from: "lib/addon-unicode11.mjs", to: "addon-unicode11.mjs", sha256: "37bb2d573c615661c875398be2a3497e02bd21d7202a5d1159f6ab70a8cfc2f2" },
  { pkg: "@xterm/addon-web-links", from: "lib/addon-web-links.mjs", to: "addon-web-links.mjs", sha256: "cce9cc1905c4d369dfa70ef0ed1eea12700754818a6c480d1fd94895dddd1a25" },
  // As `.mjs`, so its typings are found beside it under a relative import.
  { pkg: "marked", from: "lib/marked.esm.js", to: "marked.mjs", sha256: "528a1b88bef88fc27277e06036ce7f4afb6a220b18110ba57c09e292b24a7ce0" },
  { pkg: "marked", from: "lib/marked.d.ts", to: "marked.d.mts", sha256: "8e951d231740b141aa49197a98ee1f92aee121763fffe54f67cd76c68b311f77" },
  { pkg: "marked", from: "LICENSE", to: "marked-LICENSE.txt", sha256: "8e3a3f82f59a60958f56ca08f445647c32a4733dc7ca6c2c46f6eb898471ab9c" },
  { pkg: "uqr", from: "dist/index.mjs", to: "uqr.mjs", sha256: "7f0e61c2f13bb3724edee7bfb876e13c54ac9ee4fcfa283c9fa93cfb1241c325" },
  { pkg: "uqr", from: "dist/index.d.mts", to: "uqr.d.mts", sha256: "81f61380f15a2e782ae423f6df08796a3562da20354d735ae79c88117b83e65b" },
  { pkg: "uqr", from: "LICENSE", to: "uqr-LICENSE.txt", sha256: "b39d50e24727f341a0ebdb2ab040c57efaf4076a8ad5b1d0c8c45beb975b4571" },
];

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A package's directory: its main module sits one folder down (`lib/`, `dist/`). */
function packageDir(pkg: string): string {
  return dirname(dirname(Bun.resolveSync(pkg, import.meta.dir)));
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { pin: { type: "boolean", default: false } } });
  mkdirSync(VENDOR_DIR, { recursive: true });
  let failed = false;
  for (const f of VENDORED) {
    const source = join(packageDir(f.pkg), f.from);
    const hash = sha256(readFileSync(source));
    if (values.pin) {
      console.log(`${f.to}: ${hash}`);
    } else if (hash !== f.sha256) {
      console.error(`${source} has sha256 ${hash}; vendor-view.ts pins ${f.sha256}`);
      failed = true;
      continue;
    }
    copyFileSync(source, join(VENDOR_DIR, f.to));
  }
  if (failed) process.exit(1);
  console.log(`vendored ${VENDORED.length} files into ${VENDOR_DIR}`);
}
