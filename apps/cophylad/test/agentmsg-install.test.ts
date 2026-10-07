// The agents' MCP server in each profile. Claude: added through its own CLI at user scope only
// when the profile's global config lacks it or names another command, again after a running
// session wrote the file over, its two tools allowed in `settings.json`, the bypass switch's
// `crossSessionInbound` set and taken back only where cophylad set it, and all of it taken
// out. Codex: written as two leaves through the app-server, once, and taken out. Muse: a
// command array in the plugin's manifest. An ACP spawn: given the server with a nonce that
// names the session. And `cophyla agents uninstall`'s removal, through each harness's CLI.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_MCP_SERVER } from "@cophyla/protocol";
import type { HarnessProfile, SessionEvent } from "@cophyla/protocol";
import { removeAgentServer } from "../src/agentmsg/uninstall.ts";
import { AGENT_TOOL_RULES } from "../src/sessions/claude/mcp.ts";
import { CodexAdapter } from "../src/sessions/codex/adapter.ts";
import { AGENT_ACCEPT_NS } from "../src/sessions/index.ts";
import type { AgentInstall, HarnessAdapter, HookInstallSpec, SessionRecord } from "../src/sessions/model.ts";
import { museManifest } from "../src/sessions/muse/plugin.ts";
import { FAKE_CODEX, miniSessions, tempHome, tomlString, waitFor } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

const SHIM = "C:/Cophyla/bin/cophyla-mcp.exe";
const spec = (hookJson: string) => ({ command: SHIM, args: (harness: string, profileId: string, nonce?: string) => [hookJson, harness, profileId, ...(nonce ? [nonce] : [])] });
const minis: Mini[] = [];

afterAll(async () => {
  for (const m of minis) await m.stop();
});

/** An attached adapter that does nothing: the Claude install is the sessions module's own. */
class Quiet implements HarnessAdapter {
  readonly harness = "claude" as const;
  async start(_p: unknown, _h: HookInstallSpec | undefined): Promise<void> {}
  async stop(): Promise<void> {}
  async tick(): Promise<void> {}
  async send(): Promise<{ status: "queued" }> {
    return { status: "queued" };
  }
  onHook(_h: unknown, rec: SessionRecord | undefined): SessionRecord | undefined {
    return rec;
  }
}

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

describe("in a Claude profile", () => {
  test("added through Claude's own CLI only when missing or different, its tools allowed, the bypass switch's setting its own to take back, and all of it taken out", async () => {
    const scratch = tempHome();
    const dir = join(scratch, "claude-profile");
    mkdirSync(dir, { recursive: true });
    const global = join(dir, ".claude.json");
    const settings = join(dir, "settings.json");
    const runs: { argv: string[]; env: Record<string, string> }[] = [];
    // Claude's CLI, played: `mcp add` and `mcp remove` write the user-scope entry as it does.
    const run = async (argv: string[], env: Record<string, string>) => {
      runs.push({ argv, env });
      const doc = existsSync(global) ? readJson(global) : {};
      const servers = (doc["mcpServers"] ?? {}) as Record<string, unknown>;
      if (argv[2] === "add") servers[AGENT_MCP_SERVER] = { type: "stdio", command: argv[argv.indexOf("--") + 1], args: argv.slice(argv.indexOf("--") + 2), env: {} };
      if (argv[2] === "remove") delete servers[AGENT_MCP_SERVER];
      writeFileSync(global, JSON.stringify({ ...doc, mcpServers: servers }));
      return { code: 0, out: argv[2] === "add" ? "Added stdio MCP server" : "Removed" };
    };
    let want: AgentInstall | undefined = undefined;
    const mini = await miniSessions(`[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\n\n[[profiles]]\nharness = "claude"\nname = "work"\nconfig_dir = ${tomlString(dir)}\n`, () => [new Quiet()], { deps: { run, home: scratch, agents: () => want } });
    minis.push(mini);
    const profile = mini.profiles.byHarness("claude")[0]!;
    const hookJson = join(mini.home, "data", "hook.json");
    want = { kind: "install", spec: spec(hookJson), acceptInBypass: false };
    await mini.sessions.installAgents();
    expect(runs.map((r) => r.argv.slice(1))).toEqual([["mcp", "add", "-s", "user", AGENT_MCP_SERVER, "--", SHIM, hookJson, "claude", profile.id]]);
    // the profile's own directory, as its sessions run under
    expect(runs[0]!.env["CLAUDE_CONFIG_DIR"]).toBe(dir);
    expect((readJson(settings)["permissions"] as { allow: string[] }).allow).toEqual([...AGENT_TOOL_RULES]);
    expect(readJson(settings)["crossSessionInbound"]).toBeUndefined();

    // as it should be: nothing is run
    await mini.sessions.installAgents();
    expect(runs).toHaveLength(1);
    // a running session wrote the file over without it: it goes back in
    writeFileSync(global, JSON.stringify({ numStartups: 4 }));
    await mini.sessions.installAgents();
    expect(runs.map((r) => r.argv[2])).toEqual(["add", "add"]);
    expect(readJson(global)["numStartups"]).toBe(4);

    // the bypass switch: set, remembered as cophylad's, and taken back
    want = { kind: "install", spec: spec(hookJson), acceptInBypass: true };
    await mini.sessions.installAgents();
    expect(readJson(settings)["crossSessionInbound"]).toBe("accept");
    expect(mini.store.kv.get(AGENT_ACCEPT_NS, settings)).toBe(true);
    want = { kind: "install", spec: spec(hookJson), acceptInBypass: false };
    await mini.sessions.installAgents();
    expect(readJson(settings)["crossSessionInbound"]).toBeUndefined();
    expect(mini.store.kv.get(AGENT_ACCEPT_NS, settings)).toBeUndefined();
    // one the user set is the user's
    writeFileSync(settings, JSON.stringify({ ...readJson(settings), crossSessionInbound: "accept", permissions: { allow: ["Bash(ls)", ...AGENT_TOOL_RULES] } }));
    await mini.sessions.installAgents();
    expect(readJson(settings)["crossSessionInbound"]).toBe("accept");

    // taken out: the entry and the tools' rules, nothing of the user's
    want = { kind: "remove" };
    await mini.sessions.installAgents();
    expect(runs.at(-1)!.argv.slice(1)).toEqual(["mcp", "remove", "-s", "user", AGENT_MCP_SERVER]);
    expect((readJson(global)["mcpServers"] as Record<string, unknown>)[AGENT_MCP_SERVER]).toBeUndefined();
    expect(readJson(settings)["permissions"]).toEqual({ allow: ["Bash(ls)"] });
    expect(readJson(settings)["crossSessionInbound"]).toBe("accept");
  }, 30_000);
});

describe("in a Codex profile", () => {
  test("written as its command and arguments through the app-server, once, and taken out", async () => {
    const scratch = tempHome();
    const home = join(scratch, "codex-home");
    mkdirSync(home, { recursive: true });
    const trace = join(scratch, "trace.log");
    let want: AgentInstall | undefined = { kind: "install", spec: spec("C:/data/hook.json"), acceptInBypass: false };
    const toml = `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\n\n[[profiles]]\nharness = "codex"\nname = "fake"\nconfig_dir = ${tomlString(home)}\ncommand = ${tomlString(process.execPath)}\nargs = [${tomlString(FAKE_CODEX)}]\n`;
    // one store across the starts, as a daemon's: the profile keeps its id, and the arguments their words
    const start = () => miniSessions(toml, (host, log) => [new CodexAdapter({ host, log, version: "0.1.0", env: { ...process.env, FAKE_TRACE: trace } })], { deps: { agents: () => want }, storePath: join(scratch, "store.sqlite") });
    const first = await start();
    const profile = first.profiles.byHarness("codex")[0]!;
    const config = readFileSync(join(home, "config.toml"), "utf8");
    const parsed = Bun.TOML.parse(config) as { mcp_servers: Record<string, { command: string; args: string[] }> };
    expect(parsed.mcp_servers[AGENT_MCP_SERVER]).toEqual({ command: SHIM, args: ["C:/data/hook.json", "codex", profile.id] });
    await first.stop();
    const writes = () => readFileSync(trace, "utf8").split("\n").filter((l) => l.startsWith("IN ") && l.includes("config/batchWrite") && l.includes("mcp_servers")).length;
    expect(writes()).toBe(1);
    // a start that finds it as it should be writes nothing
    const second = await start();
    await second.stop();
    expect(writes()).toBe(1);
    // taken out
    want = { kind: "remove" };
    const third = await start();
    await third.stop();
    expect(writes()).toBe(2);
    expect((Bun.TOML.parse(readFileSync(join(home, "config.toml"), "utf8")) as { mcp_servers?: object }).mcp_servers).toBeUndefined();
  }, 60_000);
});

describe("in a Muse plugin, and an ACP spawn", () => {
  test("Muse takes the server as a command array beside the hooks", () => {
    const manifest = museManifest((shim) => ["bun", shim], 7200, "1.0.0", [SHIM, "C:/data/hook.json", "muse", "prof_1"]) as { capabilities: { mcpServers: unknown[] } };
    expect(manifest.capabilities.mcpServers).toEqual([{ id: AGENT_MCP_SERVER, command: [SHIM, "C:/data/hook.json", "muse", "prof_1"] }]);
    expect((museManifest((shim) => ["bun", shim], 7200, "1.0.0") as { capabilities: { mcpServers: unknown[] } }).capabilities.mcpServers).toEqual([]);
  });

  test("an ACP spawn is given the server with a nonce of its own, which names its session", async () => {
    const scratch = tempHome();
    const cwd = join(scratch, "work");
    const configDir = join(scratch, "claude-home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    const agent = join(import.meta.dir, "fakes", "acp-agent.ts");
    const toml = `[sessions]\ndiscover = false\ninstall_hooks = false\nlaunch = "acp"\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(configDir)}\n\n[acp]\nspawn_timeout_ms = 10000\n[acp.claude]\ncommand = ${tomlString(agent)}\n`;
    const mini = await miniSessions(toml, () => [new Quiet()], { acp: (config) => ({ config: config.acp, env: { ...process.env } }), deps: { agents: () => ({ kind: "install", spec: spec("C:/data/hook.json"), acceptInBypass: false }), run: async () => ({ code: 0, out: "" }) } });
    minis.push(mini);
    const ws = mini.workspaces.put({ node: mini.sessions.nodeId, path: cwd, name: "work" }).id;
    const s = await mini.sessions.spawn({ harness: "claude", workspace: ws, prompt: "servers" }, { profiles: mini.profiles });
    const reply = await waitFor(() => mini.store.sessionEvents.history(s.id, { limit: 50 }).find((e: SessionEvent) => e.kind === "assistant_text"), 10_000);
    const servers = JSON.parse((reply.payload as { text: string }).text) as { name: string; command: string; args: string[]; env: unknown[] }[];
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: AGENT_MCP_SERVER, command: SHIM, env: [] });
    const [hookJson, harness, profile, nonce] = servers[0]!.args;
    expect([hookJson, harness, profile]).toEqual(["C:/data/hook.json", "acp", s.profile]);
    expect(mini.sessions.byNonce(nonce!)?.id).toBe(s.id);
  }, 30_000);
});

describe("cophyla agents uninstall", () => {
  test("takes the server out through each harness's CLI, with the tools' rules and only cophylad's accept", async () => {
    const scratch = tempHome();
    const claudeDir = join(scratch, "claude");
    const codexDir = join(scratch, "codex");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(claudeDir, ".claude.json"), JSON.stringify({ mcpServers: { [AGENT_MCP_SERVER]: { command: SHIM, args: [] } } }));
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ permissions: { allow: [...AGENT_TOOL_RULES, "Read"] }, crossSessionInbound: "accept" }));
    writeFileSync(join(codexDir, "config.toml"), `[mcp_servers.${AGENT_MCP_SERVER}]\ncommand = "x"\nargs = []\n`);
    const runs: { argv: string[]; env: Record<string, string> }[] = [];
    const profile = (harness: "claude" | "codex", configDir: string) => ({ id: `prof_${harness}`, harness, name: harness, configDir, env: {}, status: "ok" }) as unknown as HarnessProfile;
    const forgotten: string[] = [];
    const r = await removeAgentServer(
      { claude: [profile("claude", claudeDir)], codex: [profile("codex", codexDir)] },
      {
        home: scratch,
        env: { PATH: "x" },
        run: async (argv, env) => {
          runs.push({ argv, env });
          return { code: 0, out: "" };
        },
        ours: () => true,
        forget: (s) => forgotten.push(s),
      },
    );
    expect(r.ok).toBe(true);
    expect(runs.map((x) => x.argv.slice(1))).toEqual([
      ["mcp", "remove", "-s", "user", AGENT_MCP_SERVER],
      ["mcp", "remove", AGENT_MCP_SERVER],
    ]);
    expect(runs[0]!.env["CLAUDE_CONFIG_DIR"]).toBe(claudeDir);
    expect(runs[1]!.env["CODEX_HOME"]).toBe(codexDir);
    expect(readJson(join(claudeDir, "settings.json"))).toEqual({ permissions: { allow: ["Read"] } });
    expect(forgotten).toEqual([join(claudeDir, "settings.json")]);
  });
});
