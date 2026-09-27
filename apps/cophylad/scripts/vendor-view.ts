// Copies the default view's libraries into it, under `views/default/vendor/`, from the npm
// packages this workspace pins, each checked against its sha256 here: xterm.js, which draws
// terminals; marked, whose lexer reads markdown; uqr, which encodes an invite's QR code; and
// speed-highlight's tokenizer, with the grammars it colours a file's text by in the viewer.
// The view has no build step, so the copies are committed; a test checks them against the
// same pins, so a copy is never edited by hand and an upgrade is this script run with new pins.
//
//   bun run apps/cophylad/scripts/vendor-view.ts           copy, checking every pin
//   … --pin                                             copy without checking, print the hashes
//
// All are MIT but speed-highlight, which is CC0; each one's licence travels with its copies.

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

/**
 * The grammars the file viewer colours with (fileview.ts), under `vendor/shj/` by name, as the
 * tokenizer asks for them: the languages a coding agent's folder mostly holds, and the ones they
 * reach into (a comment's TODO, a script's regex, a page's style).
 */
const SHJ_LANGUAGES: Record<string, string> = {
  asm: "9694ee2a8da8ce4e09cf00609191b2f89c71b5b76a49666e0dad0c279e50bffa",
  bash: "f802c2739b95e269f2b3febefcddc8d57d6c0bfc5bcde21b21fd21b5df208af5",
  c: "dbd35595aea9544e3ed87a9ffa01cd929150397188e6a974cad7368b6163ee9f",
  css: "b70161212b2cc0d0eb4a06eb51694339de8f04ab0e64c17f7e1bd79e4a66fe9e",
  diff: "27c8802d582de11455eea3a2453176f6b77e74f900863d83934dc79e47b475f5",
  docker: "2abbc270a671b7ac3a6573b43a074789fb727ebce92de78de2d40f4af9d0cd4a",
  go: "04e7efdfe9fbc57a231ab80d9226f445a4142d325e45f891897e4a50a7110d88",
  html: "1c6bef0ab4aa83e65551bcae3539ff23288ee95a6e4b6e69423ba6748f4c1317",
  ini: "7d733c7d9307cf94ed606039649acabf558fbd8fca385eb8e59fe864f4702a5d",
  java: "a3650a339c639bc8023354956e69bce9f7c000282bf2437b8146c3b22e4cad97",
  js: "6d7b1471401b24e5fefcdb04050ea6e87b5b26e00673817f37c45db14231cc71",
  jsdoc: "a0610a4282f9403cf6ebd3b9cea92f7af6f70ba37b7b7de6ffb03624ecd6153a",
  json: "ce55070f775ad862f19509deccb29c93751fdc47a56e2f97ef4600eb554023e9",
  log: "d84f42c29aaf0b5bdb843475392795a20631604674433a34293f65991fc8566a",
  lua: "63c229f63749f83e7f7edfe9b2fe76ce50dc06c0938990889f76cf98c8a4226b",
  make: "caf7581ae4e0745ff6f248657a0d4a86ec70d5ae6534a7d6b0ab0c1f1b615721",
  md: "7bb46d9d159b3cc253b5f50fb63f073405ccb2d0c1c917454820bd737f6b27c4",
  py: "a09ac971bae2e2c1477c3e8bdf008e1ce52c4954890b416ebc4688088b71070f",
  regex: "51037223fb0648aa6e6a7bb9518589f8816f7bf8b92fed57b58437b61c94b247",
  rs: "6b5fb61a5d4174e90ddcbcc30d3322258caeed7e5b69bc84a7b04570b3a6c19b",
  sql: "7ba4ee121895e7c2c65426408276328ddfa5cd11a4f9a883f258f07c002d5ef2",
  todo: "5c6b1ac4b6adfac602f864a6062741f97f3def9b588f96c0bba12185dad8977c",
  toml: "e7d412712552f20e27c2c986cc3d52e2fb12f1cf1cd194d52e2b884f22febe99",
  ts: "661cefebd99fe943a8c54ac4392d6d2964ed004133f2b9fb7e55d8caa9b66525",
  xml: "44393e25a449b1eaa54022e7fc80ed0f247311fabd95c9bd55e69ca85699754f",
  yaml: "7a13094c73e5899bb2a3d5400ab1083228f85f2a55cf4655378e28c566c29dfc",
};

/** @xterm/xterm 6.0.0, @xterm/addon-fit 0.11.0, @xterm/addon-unicode11 0.9.0, @xterm/addon-web-links 0.12.0, marked 18.0.14, uqr 0.1.3, @speed-highlight/core 2.1.0. */
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
  { pkg: "@speed-highlight/core", from: "dist/tokenize.js", to: "shj-tokenize.mjs", sha256: "23a517dfe83e6faa11e2d6adff9c663db573c4a48d2010d13e9d81bb43c58af9" },
  { pkg: "@speed-highlight/core", from: "dist/tokenize.d.ts", to: "shj-tokenize.d.mts", sha256: "8e9e32b4be83d1eb104ed710aab408771edcc754a73ee9bcaab5b6bcd7685e42" },
  { pkg: "@speed-highlight/core", from: "LICENSE", to: "speed-highlight-LICENSE.txt", sha256: "a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499" },
  ...Object.entries(SHJ_LANGUAGES).map(([name, sha256]) => ({ pkg: "@speed-highlight/core", from: `dist/languages/${name}.js`, to: `shj/${name}.js`, sha256 })),
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
    mkdirSync(dirname(join(VENDOR_DIR, f.to)), { recursive: true });
    copyFileSync(source, join(VENDOR_DIR, f.to));
  }
  if (failed) process.exit(1);
  console.log(`vendored ${VENDORED.length} files into ${VENDOR_DIR}`);
}
