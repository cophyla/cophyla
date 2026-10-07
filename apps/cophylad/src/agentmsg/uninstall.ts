// `cophyla agents uninstall`: takes the `cophyla-agents` server out of every profile, with no
// daemon running. The uninstaller runs it before it deletes the shim, since a profile that
// still names a shim that is gone has every session report a server that failed to start. The
// profiles are the daemon's own, rebuilt from its store and configuration the way a start
// builds them; each harness's server is removed through the harness's own CLI (`claude mcp
// remove -s user`, `codex mcp remove`), the Claude profiles' tool rules go, and so does a
// `crossSessionInbound` cophylad set. Muse's server goes with cophylad's plugin, which a Muse
// profile keeps until its next start or `muse plugins remove cophylad`.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_MCP_SERVER } from "@cophyla/protocol";
import type { HarnessProfile } from "@cophyla/protocol";
import { loadConfig, paths, resolveHome } from "../config/load.ts";
import { silentLogger } from "../log.ts";
import { loadNodeIdentity } from "../nodes/self.ts";
import { agentEntry, applyAgentSettings } from "../sessions/claude/mcp.ts";
import { claudeEnv } from "../sessions/claude/start.ts";
import { codexAgentEntry } from "../sessions/codex/hooks.ts";
import { codexEnv } from "../sessions/codex/start.ts";
import { scrub } from "../sessions/env.ts";
import { AGENT_ACCEPT_NS } from "../sessions/index.ts";
import { claudeGlobalConfig, Profiles } from "../sessions/profiles.ts";
import { Store } from "../store/index.ts";

export type Run = (argv: string[], env: Record<string, string>, cwd: string) => Promise<{ code: number; out: string }>;

async function run(argv: string[], env: Record<string, string>, cwd: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const timer = setTimeout(() => p.kill(), 30_000);
  try {
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out: out + err };
  } finally {
    clearTimeout(timer);
  }
}

function envFor(base: Record<string, string | undefined>, dir: { set: Record<string, string>; unset: string[] }, own: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...base, ...dir.set, ...(own ?? {}) })) if (v !== undefined) env[k] = v;
  for (const k of dir.unset) delete env[k];
  return env;
}

/** The server out of each profile given; what was done, a line each. Answers the lines and whether every one went. */
export async function removeAgentServer(profiles: { claude: HarnessProfile[]; codex: HarnessProfile[] }, opts: { home: string; env: Record<string, string | undefined>; run?: Run; ours: (settings: string) => boolean; forget: (settings: string) => void }): Promise<{ lines: string[]; ok: boolean }> {
  const exec = opts.run ?? run;
  const lines: string[] = [];
  let ok = true;
  for (const p of profiles.claude) {
    const global = claudeGlobalConfig(p.configDir, opts.home);
    const env = envFor(opts.env, claudeEnv(p.configDir, opts.home), p.env as Record<string, string> | undefined);
    if (agentEntry(global)) {
      const claude = p.exec?.command && /^claude(\.exe)?$/i.test(p.exec.command.split(/[\\/]/).pop() ?? "") ? p.exec.command : (Bun.which("claude") ?? "claude");
      const r = await exec([claude, "mcp", "remove", "-s", "user", AGENT_MCP_SERVER], env, opts.home).catch((e: unknown) => ({ code: 1, out: e instanceof Error ? e.message : String(e) }));
      if (r.code === 0) lines.push(`${p.name}: ${AGENT_MCP_SERVER} removed from ${global}`);
      else {
        ok = false;
        lines.push(`${p.name}: claude mcp remove failed: ${r.out.trim().split(/\r?\n/).pop() ?? `exit ${r.code}`}`);
      }
    }
    const settings = join(p.configDir, "settings.json");
    if (existsSync(settings)) {
      try {
        const ours = opts.ours(settings);
        const r = applyAgentSettings(settings, { allow: false, accept: ours ? "clear" : "keep" });
        if (ours) opts.forget(settings);
        if (r.changed) lines.push(`${p.name}: its tools' rules${ours ? " and crossSessionInbound" : ""} taken out of ${settings}`);
      } catch (e) {
        ok = false;
        lines.push(`${p.name}: ${settings} could not be changed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  for (const p of profiles.codex) {
    if (!codexAgentEntry(join(p.configDir, "config.toml"))) continue;
    const dir = codexEnv(p.configDir, opts.home);
    const env = envFor(opts.env, dir, p.env as Record<string, string> | undefined);
    const codex = p.exec?.command ?? Bun.which("codex") ?? "codex";
    const r = await exec([codex, ...(p.exec?.args ?? []), "mcp", "remove", AGENT_MCP_SERVER], env, opts.home).catch((e: unknown) => ({ code: 1, out: e instanceof Error ? e.message : String(e) }));
    if (r.code === 0) lines.push(`${p.name}: ${AGENT_MCP_SERVER} removed from ${join(p.configDir, "config.toml")}`);
    else {
      ok = false;
      lines.push(`${p.name}: codex mcp remove failed: ${r.out.trim().split(/\r?\n/).pop() ?? `exit ${r.code}`}`);
    }
  }
  return { lines, ok };
}

/** `cophyla agents uninstall`, against the Cophyla home given (or the usual one). */
export async function uninstallAgents(homeArg?: string): Promise<{ lines: string[]; ok: boolean }> {
  const p = paths(resolveHome(homeArg));
  if (!existsSync(p.db)) return { lines: ["No Cophyla data here: nothing to take out."], ok: true };
  const config = loadConfig(p, { writeDefault: false });
  const store = new Store(p.db);
  try {
    store.migrate();
    const identity = loadNodeIdentity(store, config);
    const profiles = new Profiles({ store, nodeId: identity.id, config, log: silentLogger });
    const live = (h: "claude" | "codex") => profiles.byHarness(h).filter((x) => x.status !== "missing");
    const r = await removeAgentServer(
      { claude: live("claude"), codex: live("codex") },
      {
        home: homedir(),
        env: scrub(process.env),
        ours: (settings) => store.kv.get(AGENT_ACCEPT_NS, settings) === true,
        forget: (settings) => void store.kv.delete(AGENT_ACCEPT_NS, settings),
      },
    );
    if (r.lines.length === 0) r.lines.push("No profile had the agents' server.");
    return r;
  } finally {
    store.close();
  }
}
