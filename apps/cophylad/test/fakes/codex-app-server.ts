// A stand-in for `codex app-server --stdio`: newline-delimited JSON-RPC on stdio, answering
// what cophylad's adapter calls. State lives in files under CODEX_HOME so a test can seed
// threads and read back what was queued or trusted:
//   threads.json   Thread rows served by thread/list, newest updatedAt first
//   queue.json     every thread/queue/add and thread/queue/delete, appended
//   trust.json     trusted_hash per hook key, written by config/batchWrite
//   requests.json  answers to the server→client request sent when FAKE_SERVER_REQUEST is set
// Run as `bun codex-app-server.ts app-server --stdio ...`; the arguments are ignored.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const home = process.env["CODEX_HOME"] ?? process.cwd();
const file = (name: string) => join(home, name);
const readJson = <T>(name: string, fallback: T): T => (existsSync(file(name)) ? (JSON.parse(readFileSync(file(name), "utf8")) as T) : fallback);
const writeJson = (name: string, value: unknown) => writeFileSync(file(name), JSON.stringify(value, null, 2) + "\n");
/** Set FAKE_TRACE to a file path to log every line in and out. */
const trace = process.env["FAKE_TRACE"];
// A synchronous write: Bun's async stdout writer has been seen to hold a small line back after
// large ones, which a real app-server (a Rust binary) never does.
const send = (m: unknown) => {
  const text = JSON.stringify(m) + "\n";
  if (trace) appendFileSync(trace, `OUT ${text}`);
  writeSync(1, text);
};

let experimental = false;
let queueSeq = 0;

const SNAKE: Record<string, string> = {
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "user_prompt_submit",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  Stop: "stop",
  PreToolUse: "pre_tool_use",
};
const CAMEL: Record<string, string> = {
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  UserPromptSubmit: "userPromptSubmit",
  PermissionRequest: "permissionRequest",
  PostToolUse: "postToolUse",
  Stop: "stop",
  PreToolUse: "preToolUse",
};

function hooksList(): unknown {
  const hooksPath = file("hooks.json");
  const doc = readJson<{ hooks?: Record<string, { hooks?: Record<string, unknown>[] }[]> }>("hooks.json", {});
  const trust = readJson<Record<string, string>>("trust.json", {});
  const entries: unknown[] = [];
  let order = 0;
  for (const [event, groups] of Object.entries(doc.hooks ?? {})) {
    groups.forEach((group, g) => {
      (group.hooks ?? []).forEach((hook, h) => {
        const key = `${hooksPath}:${SNAKE[event] ?? event.toLowerCase()}:${g}:${h}`;
        const currentHash = "sha256:" + createHash("sha256").update(JSON.stringify(hook)).digest("hex");
        const trusted = trust[key];
        entries.push({
          key,
          eventName: CAMEL[event] ?? event,
          handlerType: "command",
          // the real binary reports the form it would run: `commandWindows` on Windows, `command` elsewhere
          command: (process.platform === "win32" ? hook["commandWindows"] : undefined) ?? hook["command"],
          async: hook["async"] ?? false,
          matcher: null,
          timeoutSec: hook["timeout"] ?? 600,
          statusMessage: hook["statusMessage"] ?? null,
          sourcePath: hooksPath,
          source: "user",
          pluginId: null,
          displayOrder: order++,
          enabled: true,
          isManaged: false,
          currentHash,
          trustStatus: trusted === undefined ? "untrusted" : trusted === currentHash ? "trusted" : "modified",
        });
      });
    });
  }
  return { data: [{ cwd: home, hooks: entries }] };
}

function batchWrite(params: { edits?: { keyPath: string; value: unknown }[] }): unknown {
  if (process.env["FAKE_REFUSE_TRUST"]) throw Object.assign(new Error("config writes are disabled"), { code: -32000 });
  const trust = readJson<Record<string, string>>("trust.json", {});
  const servers = readJson<Record<string, Record<string, unknown>>>("mcp-servers.json", {});
  let serversChanged = false;
  for (const edit of params.edits ?? []) {
    const m = /^hooks\.state\."((?:[^"\\]|\\.)*)"\.trusted_hash$/.exec(edit.keyPath);
    if (m) trust[m[1]!.replace(/\\(.)/g, "$1")] = String(edit.value);
    // an MCP server's leaves, or the whole table taken out with null, as the real app-server writes them
    const s = /^mcp_servers\.([A-Za-z0-9_-]+)(?:\.([a-z_]+))?$/.exec(edit.keyPath);
    if (s) {
      serversChanged = true;
      if (s[2] === undefined && edit.value === null) delete servers[s[1]!];
      else if (s[2] !== undefined) servers[s[1]!] = { ...servers[s[1]!], [s[2]]: edit.value };
    }
  }
  writeJson("trust.json", trust);
  if (serversChanged) {
    writeJson("mcp-servers.json", servers);
    // what Codex keeps in config.toml, as far as these tables go
    writeFileSync(file("config.toml"), Object.entries(servers).map(([name, t]) => `[mcp_servers.${name}]\n${Object.entries(t).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n")}\n`).join("\n"));
  }
  return { status: "ok", version: "sha256:" + createHash("sha256").update(JSON.stringify(trust)).digest("hex"), filePath: file("config.toml") };
}

function threadList(params: { limit?: number; cursor?: string | null }): unknown {
  const threads = readJson<{ updatedAt?: number }[]>("threads.json", []).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const limit = params.limit ?? 25;
  const start = params.cursor ? Number(params.cursor) : 0;
  const page = threads.slice(start, start + limit);
  const next = start + limit < threads.length ? String(start + limit) : null;
  return { data: page, nextCursor: next, backwardsCursor: null };
}

function handle(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case "initialize":
      experimental = Boolean((params["capabilities"] as { experimentalApi?: boolean } | undefined)?.experimentalApi);
      return { userAgent: "fake-codex/0.0.0", codexHome: home, platformOs: process.platform === "win32" ? "windows" : process.platform, platformFamily: "fake" };
    case "thread/list":
      return threadList(params as { limit?: number; cursor?: string | null });
    case "thread/queue/add": {
      if (!experimental) throw Object.assign(new Error("thread/queue/add requires experimentalApi capability"), { code: -32600 });
      const id = `q-${++queueSeq}`;
      const log = readJson<unknown[]>("queue.json", []);
      log.push({ op: "add", threadId: params["threadId"], clientUserMessageId: params["clientUserMessageId"], input: params["input"], id });
      writeJson("queue.json", log);
      return { queuedSubmission: { id, clientUserMessageId: params["clientUserMessageId"], input: params["input"] } };
    }
    case "thread/queue/delete": {
      const log = readJson<unknown[]>("queue.json", []);
      log.push({ op: "delete", threadId: params["threadId"], queuedSubmissionId: params["queuedSubmissionId"] });
      writeJson("queue.json", log);
      return { deleted: true };
    }
    case "hooks/list":
      return hooksList();
    case "config/batchWrite":
      return batchWrite(params as { edits?: { keyPath: string; value: unknown }[] });
    default:
      throw Object.assign(new Error(`unknown method ${method}`), { code: -32601 });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (trace) appendFileSync(trace, `IN  ${line}\n`);
  let m: { id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
  try {
    m = JSON.parse(line) as typeof m;
  } catch {
    return;
  }
  if (m.method === undefined) {
    // A response to our own request.
    if (m.id === 100) {
      const log = readJson<unknown[]>("requests.json", []);
      log.push({ result: m.result, error: m.error });
      writeJson("requests.json", log);
    }
    return;
  }
  if (m.id === undefined) {
    if (m.method === "initialized" && process.env["FAKE_SERVER_REQUEST"]) {
      send({ jsonrpc: "2.0", id: 100, method: "item/commandExecution/requestApproval", params: { threadId: "t", turnId: "u", itemId: "i", command: "rm -rf /" } });
    }
    return;
  }
  try {
    send({ jsonrpc: "2.0", id: m.id, result: handle(m.method, m.params ?? {}) });
  } catch (e) {
    send({ jsonrpc: "2.0", id: m.id, error: { code: (e as { code?: number }).code ?? -32000, message: e instanceof Error ? e.message : String(e) } });
  }
});
rl.on("close", () => process.exit(0));
