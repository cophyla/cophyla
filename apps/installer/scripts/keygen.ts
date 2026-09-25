// Generates the Ed25519 release key pair. The private half goes to `--out` (default
// `%USERPROFILE%\.cophyla-release`), which must be outside the repository; the public half is
// printed as the line to put in `apps/cophylad/src/update/keys.ts`. Refuses to overwrite a key.
//   bun run apps/installer/scripts/keygen.ts [--out <dir>] [--force]

import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ensureDir, fail, insideRepo, log, RELEASE_HOME } from "./lib.ts";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { out: { type: "string" }, force: { type: "boolean" } }, strict: true });

const out = values.out ?? RELEASE_HOME;
if (insideRepo(out)) fail(`refusing to write a private key inside the repository: ${out}`);
ensureDir(out);
const keyPath = join(out, "release.key");
const pubPath = join(out, "release.pub");
if (existsSync(keyPath) && !values.force) fail(`${keyPath} exists; pass --force to replace it (every release signed with the old key stops verifying)`);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
writeFileSync(keyPath, pem, { encoding: "utf8", mode: 0o600 });
writeFileSync(pubPath, spki + "\n", "utf8");

log(`private key: ${keyPath}   (move it offline; the scripts read COPHYLA_RELEASE_KEY or this path)`);
log(`public key:  ${pubPath}`);
log("");
log("put this line into RELEASE_KEYS in apps/cophylad/src/update/keys.ts:");
log(`  ${JSON.stringify(spki)},`);
