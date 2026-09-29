// The vendors' keys the user typed in the app: `data/provider-keys.json`, mode 0600, beside
// the account token and kept like it on this node alone. Not in the store, whose `voice`
// namespace the brain reads; so in no backup and never replicated to another node. A key
// typed here is used over config.toml's `[providers.<vendor>] api_key`, and that over the
// environment's `GEMINI_API_KEY` or `DEEPINFRA_API_KEY`. The model's route and the online
// engines ask for the key at every call, so one set or cleared is used from the next. Nothing
// but a key's source and its last four characters leaves the node: not the log, not a client.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderKeyName, ProviderKeys, ProviderKeyState } from "@cophyla/protocol";
import type { ProvidersConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";

export const PROVIDER_KEYS_FILE = "provider-keys.json";

/** A key shorter than this shows no last four: they would be most of it. */
const SHOWN_FROM = 12;

const ENV: Record<ProviderKeyName, string> = { gemini: "GEMINI_API_KEY", deepinfra: "DEEPINFRA_API_KEY" };

/** Writes `text` so only its owner can read it, whole or not at all: a temporary file renamed over the old one. */
export function writePrivate(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export interface ProviderKeysDeps {
  /** `<home>/data`. */
  dataDir: string;
  config: ProvidersConfig;
  env: Record<string, string | undefined>;
  log: Logger;
  /** How the file is written; `writePrivate` unless a test watches it. */
  write?: (path: string, text: string) => void;
}

export interface ProviderKeyStore {
  /** The key each vendor's calls use now: the app's, config.toml's, or the environment's. */
  gemini(): string | undefined;
  deepinfra(): string | undefined;
  /** Where each key comes from and its last four characters, never the key. */
  status(): ProviderKeys;
  /** Keeps a key typed in the app, or forgets it with `null`; the answer is `status()` after. */
  set(provider: ProviderKeyName, apiKey: string | null): ProviderKeys;
}

export function openProviderKeys(deps: ProviderKeysDeps): ProviderKeyStore {
  const path = join(deps.dataDir, PROVIDER_KEYS_FILE);
  const write = deps.write ?? writePrivate;
  const typed: Partial<Record<ProviderKeyName, string>> = read(path, deps.log);

  const resolve = (provider: ProviderKeyName): { key?: string; source: ProviderKeyState["source"] } => {
    const app = typed[provider];
    if (app) return { key: app, source: "app" };
    const config = deps.config[provider].api_key?.trim();
    if (config) return { key: config, source: "config" };
    const env = deps.env[ENV[provider]]?.trim();
    if (env) return { key: env, source: "env" };
    return { source: "none" };
  };
  const state = (provider: ProviderKeyName): ProviderKeyState => {
    const { key, source } = resolve(provider);
    return key && key.length >= SHOWN_FROM ? { source, last4: key.slice(-4) } : { source };
  };
  const status = (): ProviderKeys => ({ gemini: state("gemini"), deepinfra: state("deepinfra") });

  return {
    gemini: () => resolve("gemini").key,
    deepinfra: () => resolve("deepinfra").key,
    status,
    set(provider, apiKey) {
      const key = apiKey?.trim();
      if (key) typed[provider] = key;
      else delete typed[provider];
      if (Object.keys(typed).length === 0) rmSync(path, { force: true });
      else write(path, JSON.stringify(typed) + "\n");
      deps.log.info(key ? "provider key set" : "provider key cleared", { provider, source: resolve(provider).source });
      return status();
    },
  };
}

/** The keys the file holds; none when it is missing, and none (said in the log, not what it held) when it cannot be read. */
function read(path: string, log: Logger): Partial<Record<ProviderKeyName, string>> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const out: Partial<Record<ProviderKeyName, string>> = {};
    for (const provider of ["gemini", "deepinfra"] as const) {
      const v = raw[provider];
      if (typeof v === "string" && v.trim()) out[provider] = v.trim();
    }
    return out;
  } catch (e) {
    log.warn("the provider keys file could not be read; the keys typed in the app are not used", { path, error: e instanceof SyntaxError ? "not JSON" : e instanceof Error ? e.message : String(e) });
    return {};
  }
}
