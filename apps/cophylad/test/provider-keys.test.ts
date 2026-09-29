// The vendors' keys typed in the app: kept in `data/provider-keys.json` through the helper
// that writes it owner-only (0600 where the file system has modes), used over config.toml's
// and that over the environment's, shown only as a source and a last four, and gone again
// with a clear. Through the daemon: `account.apiKey` answers the same, the audit row keeps
// neither the key nor its answer's key, `voice.settings` never carries it, the log never
// names it, and it is in no backup kind and nothing a backup node is sent.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderKeys } from "@cophyla/protocol";
import { fileKind } from "../src/cloud/backup.ts";
import { openProviderKeys, PROVIDER_KEYS_FILE, writePrivate } from "../src/cloud/provider-keys.ts";
import { ProvidersConfig } from "../src/config/schema.ts";
import type { Daemon } from "../src/daemon.ts";
import { createLogger, silentLogger } from "../src/log.ts";
import { editableFiles } from "../src/nodes/replication.ts";
import { stopDaemon, testDaemon, TestClient } from "./helpers.ts";

const APP_KEY = "AIzaSyD-typed-in-the-app-7Hq2";
const CONFIG_KEY = "config-toml-gemini-key-Lm3x";
const ENV_KEY = "env-gemini-key-000011112222";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dataDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cophyla-keys-"));
  dirs.push(d);
  return d;
}

describe("the provider keys", () => {
  test("the app's key over config.toml's over the environment's; a clear hands back to the next; the status shows only where and the last four", () => {
    const dir = dataDir();
    const config = ProvidersConfig.parse({ gemini: { api_key: CONFIG_KEY } });
    const keys = openProviderKeys({ dataDir: dir, config, env: { GEMINI_API_KEY: ENV_KEY, DEEPINFRA_API_KEY: "short" }, log: silentLogger });
    expect(keys.gemini()).toBe(CONFIG_KEY);
    // A key too short to show four of shows none.
    expect(keys.status()).toEqual({ gemini: { source: "config", last4: "Lm3x" }, deepinfra: { source: "env" } });
    expect(keys.set("gemini", `  ${APP_KEY}  `)).toEqual({ gemini: { source: "app", last4: "7Hq2" }, deepinfra: { source: "env" } });
    expect(keys.gemini()).toBe(APP_KEY);
    expect(JSON.stringify(keys.status())).not.toContain(APP_KEY.slice(0, -4));
    keys.set("gemini", null);
    expect(keys.gemini()).toBe(CONFIG_KEY);
    const bare = openProviderKeys({ dataDir: dir, config: ProvidersConfig.parse({}), env: { GEMINI_API_KEY: ENV_KEY }, log: silentLogger });
    expect(bare.gemini()).toBe(ENV_KEY);
    expect(bare.status().gemini).toEqual({ source: "env", last4: "2222" });
    expect(bare.deepinfra()).toBeUndefined();
    expect(bare.status().deepinfra).toEqual({ source: "none" });
  });

  test("the file goes through the owner-only writer, is read again at the next start, and is gone with the last key", () => {
    const dir = dataDir();
    const path = join(dir, PROVIDER_KEYS_FILE);
    const written: string[] = [];
    const keys = openProviderKeys({ dataDir: dir, config: ProvidersConfig.parse({}), env: {}, log: silentLogger, write: (p, text) => (written.push(p), writePrivate(p, text)) });
    keys.set("deepinfra", "deepinfra-key-0123456789abcd");
    keys.set("gemini", APP_KEY);
    expect(written).toEqual([path, path]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ deepinfra: "deepinfra-key-0123456789abcd", gemini: APP_KEY });
    expect(existsSync(`${path}.tmp`)).toBe(false);
    const again = openProviderKeys({ dataDir: dir, config: ProvidersConfig.parse({}), env: {}, log: silentLogger });
    expect(again.gemini()).toBe(APP_KEY);
    expect(again.status().deepinfra).toEqual({ source: "app", last4: "abcd" });
    again.set("gemini", null);
    expect(existsSync(path)).toBe(true);
    again.set("deepinfra", null);
    expect(existsSync(path)).toBe(false);
  });

  test.skipIf(process.platform === "win32")("the file is readable by its owner alone", () => {
    const dir = dataDir();
    openProviderKeys({ dataDir: dir, config: ProvidersConfig.parse({}), env: {}, log: silentLogger }).set("gemini", APP_KEY);
    expect(statSync(join(dir, PROVIDER_KEYS_FILE)).mode & 0o777).toBe(0o600);
    writePrivate(join(dir, "other"), "x");
    expect(statSync(join(dir, "other")).mode & 0o777).toBe(0o600);
  });

  test("a file that cannot be read is no keys, and the log says so without what it held", () => {
    const dir = dataDir();
    writeFileSync(join(dir, PROVIDER_KEYS_FILE), `{"gemini": ${APP_KEY}`, "utf8");
    const lines: string[] = [];
    const keys = openProviderKeys({ dataDir: dir, config: ProvidersConfig.parse({}), env: {}, log: createLogger("debug", (l) => lines.push(l)) });
    expect(keys.gemini()).toBeUndefined();
    expect(lines.join("\n")).toContain("could not be read");
    expect(lines.join("\n")).not.toContain(APP_KEY.slice(0, 12));
  });
});

describe("account.apiKey through the daemon", () => {
  let current: (Daemon & { home: string }) | undefined;
  afterEach(async () => {
    if (current) await stopDaemon(current);
    current = undefined;
  });

  test("set and cleared from the app, it never reaches the audit, voice.settings, the log, a backup or a backup node", async () => {
    const lines: string[] = [];
    const d = (current = await testDaemon("", { log: createLogger("debug", (l) => lines.push(l)), env: { ...process.env, GEMINI_API_KEY: ENV_KEY, DEEPINFRA_API_KEY: undefined } }));
    const ui = await TestClient.connect(d.api.url);
    await ui.hello(d.token, { name: "desktop" });

    expect(await ui.request<ProviderKeys>("account.apiKey", { provider: "gemini", apiKey: APP_KEY })).toEqual({ gemini: { source: "app", last4: "7Hq2" }, deepinfra: { source: "none" } });
    expect(readFileSync(join(d.paths.data, PROVIDER_KEYS_FILE), "utf8")).toContain(APP_KEY);

    const settings = await ui.request<{ keys?: ProviderKeys }>("voice.settings", {});
    expect(JSON.stringify(settings)).not.toContain(APP_KEY);
    expect(settings.keys ?? { gemini: { source: "app", last4: "7Hq2" }, deepinfra: { source: "none" } }).toEqual({ gemini: { source: "app", last4: "7Hq2" }, deepinfra: { source: "none" } });

    // The audit row names the vendor and that a key was given; the answer it keeps has only the last four.
    const row = d.store.audit.list({ limit: 100 }).find((e) => e.action === "account.apiKey")!;
    expect(row.target).toBe("gemini");
    expect(row.args).toEqual({ provider: "gemini", key: "given" });
    expect(JSON.stringify(d.store.audit.list({ limit: 100 }))).not.toContain(APP_KEY);

    // Nothing a backup takes, nor what a backup node is sent: the store's tables, every kv namespace, the editable files.
    const replica = JSON.stringify({ tables: d.store.replicaSnapshot([]), files: editableFiles(d.paths) });
    expect(replica).not.toContain(APP_KEY);
    expect(fileKind(`data/${PROVIDER_KEYS_FILE}`)).toBeUndefined();

    expect(await ui.request<ProviderKeys>("account.apiKey", { provider: "gemini", apiKey: null })).toEqual({ gemini: { source: "env", last4: "2222" }, deepinfra: { source: "none" } });
    expect(d.store.audit.list({ limit: 100 }).filter((e) => e.action === "account.apiKey").map((e) => e.args)).toContainEqual({ provider: "gemini", key: "cleared" });
    // Too short a key is refused before it is kept.
    const short = await ui.call("account.apiKey", { provider: "deepinfra", apiKey: "abc" });
    expect("error" in short).toBe(true);
    expect(existsSync(join(d.paths.data, PROVIDER_KEYS_FILE))).toBe(false);

    ui.close();
    const log = lines.join("\n");
    expect(log).toContain("provider key set");
    expect(log).not.toContain(APP_KEY);
    expect(log).not.toContain(ENV_KEY);
  });
});
