// Spike 08: start a Claude Code and a Codex session through their ACP adapters on Windows,
// prompt them, read status and asks off `session/update` and `session/request_permission`,
// cancel a turn, and see which cophylad hooks fire in the spawned session and under which id.
//
//   bun run acp-spike.ts --agent claude|codex [--runtime node|bun] [--keep]
//
// Everything runs in ./target on the cheapest model. The adapters are spawned the way cophylad
// will spawn them: `<runtime> node_modules/@agentclientprotocol/<pkg>/dist/index.js` with
// CLAUDE_CODE_EXECUTABLE / CODEX_PATH naming the installed binaries and the CLAUDE_CODE_*
// variables of this shell scrubbed. A stub hook listener on a free port records every hook
// that reaches it; for Claude the hooks are installed as project settings in ./target/.claude,
// so the user's own settings (and any daemon they point at) are untouched.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { agent: { type: "string", default: "claude" }, runtime: { type: "string", default: "node" }, keep: { type: "boolean", default: false }, outside: { type: "boolean", default: false } },
});
const AGENT = values.agent === "codex" ? "codex" : "claude";
const RUNTIME = values.runtime === "bun" ? "bun" : "node";

const HERE = import.meta.dir;
const TARGET = join(HERE, "target");
const OUT = join(HERE, "out");
mkdirSync(TARGET, { recursive: true });
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, `${AGENT}-${RUNTIME}.jsonl`);
writeFileSync(LOG, "");
const log = (kind: string, data: unknown) => {
  const line = JSON.stringify({ at: Date.now(), kind, data });
  appendFileSync(LOG, line + "\n");
  const short = line.length > 400 ? line.slice(0, 400) + "…" : line;
  console.log(short);
};

const CLAUDE = join(homedir(), ".local", "bin", "claude.exe");
const CODEX = join(homedir(), "AppData", "Local", "Programs", "OpenAI", "Codex", "bin", "codex.exe");
const CLAUDE_CONFIG_DIR = join(homedir(), ".claude");
const CODEX_HOME = join(homedir(), ".codex");

// --- the stub hook listener --------------------------------------------------------------------

const hooksSeen: { at: number; harness: string; event: string; session_id: string; cwd?: string; via: string }[] = [];
const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/hooks/")) return new Response("nope", { status: 404 });
    const harness = url.pathname.slice("/hooks/".length);
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      // ignore
    }
    const rec = {
      at: Date.now(),
      harness,
      event: String(body["hook_event_name"] ?? "?"),
      session_id: String(body["session_id"] ?? "?"),
      cwd: typeof body["cwd"] === "string" ? body["cwd"] : undefined,
      via: req.headers.get("x-cophylad") ? "http" : "command",
    };
    hooksSeen.push(rec);
    log("hook", { ...rec, keys: Object.keys(body) });
    // Never hold: `{}` lets everything through, including a PermissionRequest.
    return new Response("{}", { headers: { "content-type": "application/json" } });
  },
});
log("stub", { port: stub.port });

if (AGENT === "claude") {
  // Project-level settings: loaded by the SDK's `settingSources: [user, project, local]`.
  const dir = join(TARGET, ".claude");
  mkdirSync(dir, { recursive: true });
  const hook = (event: string) => [
    {
      matcher: "",
      hooks: [{ type: "http", url: `http://127.0.0.1:${stub.port}/hooks/claude`, timeout: 60, headers: { "x-cophylad": "1", "x-cophyla-profile": "spike" } }],
    },
  ];
  const events = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Elicitation", "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "SessionEnd"];
  const hooks: Record<string, unknown> = {};
  for (const e of events) hooks[e] = hook(e);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks }, null, 2));
}

// --- the adapter child ----------------------------------------------------------------------------

const pkg = AGENT === "claude" ? "claude-agent-acp" : "codex-acp";
const entry = join(HERE, "node_modules", "@agentclientprotocol", pkg, "dist", "index.js");
if (!existsSync(entry)) throw new Error(`missing ${entry}; run bun install here first`);

const env: Record<string, string | undefined> = { ...process.env };
for (const k of Object.keys(env)) {
  if (/^CLAUDE_CODE_/.test(k) || ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"].includes(k)) delete env[k];
}
if (AGENT === "claude") {
  env["CLAUDE_CODE_EXECUTABLE"] = CLAUDE;
  env["CLAUDE_CONFIG_DIR"] = CLAUDE_CONFIG_DIR;
} else {
  env["CODEX_PATH"] = CODEX;
  env["CODEX_HOME"] = CODEX_HOME;
}

const command = RUNTIME === "bun" ? process.execPath : "node";
log("spawn", { command, entry, cwd: TARGET });
const child: ChildProcess = spawn(command, [entry], { cwd: TARGET, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
child.stderr!.setEncoding("utf8");
child.stderr!.on("data", (d: string) => {
  for (const line of d.split(/\r?\n/)) if (line.trim()) appendFileSync(join(OUT, `${AGENT}-${RUNTIME}.stderr.log`), line + "\n");
});
child.on("exit", (code, signal) => log("exit", { code, signal }));

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string; sentAt: number }>();
const updates: { at: number; kind: string; update: unknown }[] = [];
let permissionAnswer: (params: unknown) => unknown = () => ({ outcome: { outcome: "cancelled" } });

function write(msg: unknown): void {
  const text = JSON.stringify(msg);
  log("→", msg);
  child.stdin!.write(text + "\n");
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method, sentAt: Date.now() });
    write({ jsonrpc: "2.0", id, method, params });
  });
}

function notify(method: string, params: unknown): void {
  write({ jsonrpc: "2.0", method, params });
}

createInterface({ input: child.stdout! }).on("line", (line) => {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(line) as Record<string, unknown>;
  } catch {
    log("junk", line.slice(0, 200));
    return;
  }
  const id = m["id"];
  if (typeof m["method"] === "string") {
    const method = m["method"];
    if (id !== undefined && id !== null) {
      log("←req", m);
      if (method === "session/request_permission") {
        const answer = permissionAnswer(m["params"]);
        write({ jsonrpc: "2.0", id, result: answer });
      } else {
        write({ jsonrpc: "2.0", id, error: { code: -32601, message: `spike does not serve ${method}` } });
      }
      return;
    }
    if (method === "session/update") {
      const p = m["params"] as { update?: { sessionUpdate?: string } };
      const kind = p?.update?.sessionUpdate ?? "?";
      updates.push({ at: Date.now(), kind, update: p?.update });
      log("←upd", { kind, update: p?.update });
    } else {
      log("←ntf", m);
    }
    return;
  }
  if (typeof id === "number") {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    log("←res", { method: p.method, ms: Date.now() - p.sentAt, result: m["result"], error: m["error"] });
    if (m["error"] !== undefined && m["error"] !== null) p.reject(Object.assign(new Error(JSON.stringify(m["error"])), { rpc: m["error"] }));
    else p.resolve(m["result"]);
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- the scenario --------------------------------------------------------------------------------

async function main(): Promise<void> {
  const init = (await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "cophylad-spike", version: "0.0.0" },
  })) as Record<string, unknown>;
  log("initialized", { authMethods: init["authMethods"], agentInfo: init["agentInfo"], caps: init["agentCapabilities"] });

  const created = (await request("session/new", {
    cwd: TARGET,
    mcpServers: [],
    ...(AGENT === "claude" ? { _meta: { claudeCode: { options: { model: "haiku" } } } } : {}),
  })) as Record<string, unknown>;
  const sessionId = created["sessionId"] as string;
  log("session", { sessionId, modes: created["modes"], models: created["models"] });

  // Force prompts for the spike: the user's own settings may default to a mode that never asks.
  try {
    await request("session/set_mode", { sessionId, modeId: AGENT === "codex" ? "read-only" : "default" });
  } catch (e) {
    log("set_mode failed", String(e));
  }
  if (AGENT === "codex") {
    const models = (created["models"] as { availableModels?: { modelId: string; name?: string }[] } | undefined)?.availableModels ?? [];
    const cheap = models.find((m) => /luna/i.test(m.modelId)) ?? models.find((m) => /mini|nano|lite/i.test(m.modelId));
    log("codex models", { count: models.length, ids: models.map((m) => m.modelId).slice(0, 20), cheap: cheap?.modelId });
    if (cheap) {
      try {
        await request("session/set_model", { sessionId, modelId: cheap.modelId });
      } catch (e) {
        log("set_model failed", String(e));
      }
    }
  }

  // 1. A prompt that needs a permission: writing a file.
  const marker = Date.now().toString(36);
  const file = `hello-${marker}.txt`;
  // --outside: write into the system temp directory, outside the workspace, which Codex must ask about.
  const where = values.outside ? join(process.env["TEMP"] ?? "C:\Windows\Temp", file) : file;
  const wherePath = values.outside ? where : join(TARGET, file);
  const permissions: unknown[] = [];
  permissionAnswer = (params) => {
    permissions.push(params);
    const p = params as { options?: { optionId: string; kind: string; name: string }[] };
    const allow = p.options?.find((o) => o.kind === "allow_once") ?? p.options?.find((o) => o.kind.startsWith("allow"));
    return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } };
  };
  const t0 = Date.now();
  const r1 = await request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: values.outside ? `Create a file at the absolute path ${where} containing exactly the word hello, using a shell command. Do not ask me anything, then reply with the single word DONE.` : `Create a file named ${file} in the current directory containing exactly the word hello. Use a file write tool or a shell command, do not ask me anything, then reply with the single word DONE.` }],
  });
  log("prompt 1 done", { ms: Date.now() - t0, result: r1, permissions: permissions.length, fileExists: existsSync(wherePath) });

  // 2. A slow prompt, cancelled mid-turn.
  const t1 = Date.now();
  const p2 = request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Count from 1 to 200 slowly, one number per line, explaining each number in a sentence. Do not use tools." }],
  });
  await sleep(6000);
  notify("session/cancel", { sessionId });
  const r2 = await p2.catch((e) => ({ error: String(e) }));
  log("prompt 2 (cancelled) done", { ms: Date.now() - t1, result: r2 });

  // 3. One more short turn after the cancel, to see the session is still usable and usage is reported.
  const t2 = Date.now();
  const r3 = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Reply with the single word PONG." }] });
  log("prompt 3 done", { ms: Date.now() - t2, result: r3 });

  await sleep(1500);

  // --- summary ---
  const kinds = new Map<string, number>();
  for (const u of updates) kinds.set(u.kind, (kinds.get(u.kind) ?? 0) + 1);
  const usage = updates.filter((u) => u.kind === "usage_update").map((u) => u.update);
  const summary = {
    agent: AGENT,
    runtime: RUNTIME,
    sessionId,
    updateKinds: Object.fromEntries(kinds),
    permissionOptions: permissions.map((p) => (p as { options?: unknown }).options),
    permissionToolCall: permissions.map((p) => (p as { toolCall?: unknown }).toolCall),
    usage,
    hooks: hooksSeen.map((h) => ({ event: h.event, session_id: h.session_id, sameId: h.session_id === sessionId, via: h.via })),
    fileWritten: existsSync(wherePath),
  };
  log("summary", summary);
  writeFileSync(join(OUT, `${AGENT}-${RUNTIME}.summary.json`), JSON.stringify(summary, null, 2));

  // Does the -p session show up in the Claude session registry?
  if (AGENT === "claude") {
    const reg = join(CLAUDE_CONFIG_DIR, "sessions");
    const files = existsSync(reg) ? [...new Bun.Glob("*.json").scanSync({ cwd: reg })] : [];
    const hits: string[] = [];
    for (const f of files) {
      try {
        const j = JSON.parse(await Bun.file(join(reg, f)).text()) as { sessionId?: string };
        if (j.sessionId === sessionId) hits.push(f);
      } catch {
        // ignore
      }
    }
    log("registry", { dir: reg, files: files.length, entriesForThisSession: hits });
  }

  if (!values.keep) rmSync(wherePath, { force: true });
}

main()
  .catch((e) => log("failed", String(e instanceof Error ? e.stack : e)))
  .finally(async () => {
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    await sleep(1000);
    try {
      child.kill();
    } catch {
      // ignore
    }
    await stub.stop(true);
    await sleep(300);
    process.exit(0);
  });
