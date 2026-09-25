// Where the user data directory is, what lives in it, and loading config.toml from it.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Config, DEFAULT_CONFIG_TOML } from "./schema.ts";

export interface Paths {
  home: string;
  config: string;
  /** The contract for whoever writes into the editable layer; written once. */
  readme: string;
  tools: string;
  views: string;
  hooks: string;
  prompts: string;
  memory: string;
  data: string;
  audio: string;
  /** The controller listener's key and certificate. */
  tls: string;
  /** Voice models, one directory per model, unpacked from the feed. */
  models: string;
  /** Sidecar working directories and their logs. */
  sidecars: string;
  /** What the voice module writes for itself: the ORT session config. */
  voice: string;
  db: string;
  clientToken: string;
  /** The bearer token the harness hooks present; separate from the client token. */
  hookToken: string;
  /** This node's membership of a cluster: its grant, its key, the cluster, and whom it joined. */
  linkFile: string;
  /** Where the shared node token lived before grants; removed at start when it is still there. */
  legacyNodeToken: string;
  /** The account token the device-code login wrote; absent when signed out. */
  accountToken: string;
  /** The cloud backup's key, derived from the passphrase when backup was turned on; absent while it is off. */
  backupKey: string;
}

/** `--home`, then `COPHYLA_HOME`, then `~/.cophyla`. */
export function resolveHome(override?: string): string {
  const raw = override ?? process.env["COPHYLA_HOME"] ?? join(homedir(), ".cophyla");
  return resolve(raw);
}

export function paths(home: string): Paths {
  return {
    home,
    config: join(home, "config.toml"),
    readme: join(home, "README.md"),
    tools: join(home, "tools"),
    views: join(home, "views"),
    hooks: join(home, "hooks"),
    prompts: join(home, "prompts"),
    memory: join(home, "memory"),
    data: join(home, "data"),
    audio: join(home, "audio"),
    tls: join(home, "data", "tls"),
    models: join(home, "data", "models"),
    sidecars: join(home, "data", "sidecars"),
    voice: join(home, "data", "voice"),
    db: join(home, "data", "cophyla.sqlite"),
    clientToken: join(home, "data", "client.token"),
    hookToken: join(home, "data", "hook.token"),
    linkFile: join(home, "data", "link.json"),
    legacyNodeToken: join(home, "data", "node.token"),
    accountToken: join(home, "data", "account.token"),
    backupKey: join(home, "data", "backup.key"),
  };
}

/** Creates the directories the daemon writes to. The editable layer's directories are the user's. */
export function ensureDirs(p: Paths): void {
  for (const dir of [p.home, p.data, p.tools, p.views, p.hooks, p.prompts, p.memory, p.audio, p.tls, p.models, p.sidecars, p.voice]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Reads a token file, or mints one (32 random bytes as hex, mode 0600) when it is missing or too short. */
export function loadOrCreateToken(path: string): string {
  const existing = readToken(path);
  if (existing) return existing;
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, token + "\n", { encoding: "utf8", mode: 0o600 });
  return token;
}

/** Reads a token file; undefined when it is missing or too short to be one. */
export function readToken(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const token = readFileSync(path, "utf8").trim();
  return token.length >= 32 ? token : undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parseConfig(toml: string, source = "config.toml"): Config {
  let raw: unknown;
  try {
    // A byte-order mark (Notepad, PowerShell's Set-Content) makes Bun's parser return an
    // empty document without a word; strip it so the file is read as written.
    raw = Bun.TOML.parse(toml.replace(/^﻿/, ""));
  } catch (e) {
    throw new ConfigError(`${source}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = Config.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new ConfigError(`${source} is not valid:\n${issues}`);
  }
  return parsed.data;
}

/**
 * Loads config.toml. A missing file is written with the commented defaults first, so the
 * user has something to edit.
 */
export function loadConfig(p: Paths, opts: { writeDefault?: boolean } = {}): Config {
  const writeDefault = opts.writeDefault ?? true;
  if (!existsSync(p.config)) {
    if (!writeDefault) return parseConfig("", p.config);
    mkdirSync(p.home, { recursive: true });
    writeFileSync(p.config, DEFAULT_CONFIG_TOML, { encoding: "utf8", flag: "wx" });
  }
  return parseConfig(readFileSync(p.config, "utf8"), p.config);
}
