// A stand-in for the Muse binary: `serve` speaks MSP (newline-delimited JSON-RPC on stdio) the
// way cophylad's adapter uses it, and `plugins <verb> … --json` answers the plugin commands. State
// lives in files under `<XDG_DATA_HOME>/muse` (the host's `museHome`), so a test can seed
// sessions and views and read back what was called:
//   list.json          session/list rows, filtered by updatedAfter; a row `open` (a TUI has the
//                      session) is left out, as Muse leaves it out
//   views/<id>.json    a session's view events, `{method, params}` with `viewCursor` `v:<id>:<n>`
//   usage.json         what usage/read answers under `usage`
//   calls.jsonl        every request cophylad made, one `{method, params}` a line
//   plugin.json        the installed plugin: source, cache path, enabled, trusted
// A headless session's turn (turn/start) plays out as notifications, appended to its view too:
// a prompt with "approve" in it asks approval/request first, one with "ask" asks
// userInput/request, and each waits for cophylad's decide, answer or cancel.
// Run as `bun muse-serve.ts serve` or `bun muse-serve.ts plugins <verb> …`.

import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const data = join(process.env["XDG_DATA_HOME"] ?? process.cwd(), "muse");
mkdirSync(join(data, "views"), { recursive: true });
const file = (name: string) => join(data, name);
const readJson = <T>(name: string, fallback: T): T => (existsSync(file(name)) ? (JSON.parse(readFileSync(file(name), "utf8")) as T) : fallback);
const writeJson = (name: string, value: unknown) => writeFileSync(file(name), JSON.stringify(value, null, 2) + "\n");

type Ev = { method: string; params: Record<string, unknown> };

const [verb, ...rest] = process.argv.slice(2);

// --- plugins ------------------------------------------------------------------------------------

if (verb === "plugins") {
  const [cmd, arg] = rest;
  const out = (v: unknown, code = 0) => {
    process.stdout.write(JSON.stringify(v, null, 2) + "\n");
    process.exit(code);
  };
  appendFileSync(file("calls.jsonl"), JSON.stringify({ method: `plugins ${cmd}`, params: { arg } }) + "\n");
  const state = readJson<{ source?: string; cache?: string; enabled?: boolean; trusted?: boolean } | undefined>("plugin.json", undefined);
  if (process.env["FAKE_REFUSE_PLUGIN"] && cmd !== "inspect") out({ error: { code: "refused", message: "plugins are off for this account" } }, 1);
  switch (cmd) {
    case "install": {
      const cache = join(data, "plugins", "cache", "cophylad", String(Date.now()), "package");
      rmSync(join(data, "plugins", "cache"), { recursive: true, force: true });
      mkdirSync(cache, { recursive: true });
      cpSync(arg!, cache, { recursive: true });
      writeJson("plugin.json", { source: `\\\\?\\${arg}`, cache, enabled: true, trusted: false });
      out({ installed: { id: "cophylad" } });
      break;
    }
    case "approve":
      if (!state) out({ error: { code: "not-installed", message: "no plugin cophylad" } }, 1);
      if (!process.env["FAKE_REFUSE_APPROVE"]) writeJson("plugin.json", { ...state, trusted: true });
      out({ decision: "approve" });
      break;
    case "inspect": {
      if (!state) out({ error: { code: "not-installed", message: "no plugin cophylad" } }, 1);
      const status = state!.trusted ? "trusted_enabled" : "untrusted";
      const hooks = existsSync(join(state!.cache!, "hooks")) ? ["sessionstart", "userpromptsubmit", "permissionrequest", "posttooluse", "posttoolusefailure", "notification", "stop", "sessionend"] : [];
      out({
        record: { id: "cophylad", enabled: state!.enabled !== false, source: { path: state!.source }, cache_path: state!.cache },
        runtime_capabilities: hooks.map((h) => ({ candidate: { stable_id: `plugin:cophylad:hook:${h}` }, status })),
      });
      break;
    }
    default:
      out({ error: { code: "unknown", message: `unknown plugins command ${cmd}` } }, 2);
  }
}

// --- serve --------------------------------------------------------------------------------------

const send = (m: unknown) => writeSync(1, JSON.stringify(m) + "\n");
const notify = (method: string, params: unknown) => send({ jsonrpc: "2.0", method, params });
let nextRequest = 1;
const waiting = new Map<number, (result: unknown) => void>();
/** Waiters for cophylad's commands on an approval or a question, by its id. */
const decisions = new Map<string, (params: Record<string, unknown>) => void>();

function view(id: string): Ev[] {
  return readJson<Ev[]>(join("views", `${id}.json`), []);
}

function seqOf(cursor: string): number {
  return Number(cursor.split(":").pop());
}

/** Appends to a session's view with the next cursor, and pushes it to cophylad. */
function emit(id: string, method: string, params: Record<string, unknown>): void {
  const events = view(id);
  const ev: Ev = { method, params: { sessionId: id, ...params, viewCursor: `v:${id}:${events.length + 1}` } };
  events.push(ev);
  writeJson(join("views", `${id}.json`), events);
  notify(method, ev.params);
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextRequest++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

const error = (code: number, kind: string, message: string) => ({ code, message, data: { kind } });

async function playTurn(sessionId: string, turnId: string, text: string): Promise<void> {
  const now = new Date().toISOString();
  emit(sessionId, "turn/started", { turnId, commandId: turnId });
  emit(sessionId, "item/completed", { item: { itemId: `u-${turnId}`, kind: "userMessage", turnId, commandId: turnId, revision: 1, status: "completed", recordedAt: now, text } });
  if (text.includes("approve")) {
    const approvalId = `ap-${turnId}`;
    const decided = new Promise<Record<string, unknown>>((r) => decisions.set(approvalId, r));
    await request("approval/request", {
      sessionId,
      approvalId,
      turnId,
      itemId: approvalId,
      taskId: approvalId,
      toolCallId: "call_1",
      toolName: "powershell",
      rawArgs: JSON.stringify({ command: "echo hi", description: "Say hi" }),
      currentRequirementId: { approvalId, sourceIndex: 0 },
      judgeEscalated: false,
      protectedWrite: false,
      subject: { kind: "shell", command: "echo hi" },
      availableChoices: [
        { choiceId: "allow_once", label: "Allow once", decision: "approved", scope: "once" },
        { choiceId: "allow_local_prefix", label: "Always allow in this workspace: echo ...", decision: "approvedPolicyAmendment", scope: "localPersistent", rulePreview: "Always allow in this workspace: echo ..." },
        { choiceId: "abort", label: "Reject", decision: "abort", scope: "once", acceptsFeedback: true },
      ],
      viewCursor: `v:${sessionId}:0`,
    });
    const d = await decided;
    const approved = d["choiceId"] !== "abort";
    emit(sessionId, "approval/resolved", { approvalId, decision: approved ? "approved" : "abort" });
    emit(sessionId, "item/completed", {
      item: { itemId: `tool-${turnId}`, kind: "toolCall", turnId, revision: 2, status: approved ? "completed" : "rejected", recordedAt: now, tool: "powershell", callId: "call_1", args: JSON.stringify({ command: "echo hi" }), ...(approved ? { visibleOutput: "hi\r\n" } : { failureReason: "rejected by the user" }) },
    });
  }
  if (text.includes("ask")) {
    const userInputId = `ui-${turnId}`;
    const answered = new Promise<Record<string, unknown>>((r) => decisions.set(userInputId, r));
    await request("userInput/request", {
      sessionId,
      userInputId,
      turnId,
      itemId: userInputId,
      toolCallId: "call_2",
      toolName: "ask_user",
      questions: [
        { id: "q1", header: "Colour", question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }], selection: { mode: "single" } },
        { id: "q2", header: "Sizes", question: "Which sizes?", options: [{ label: "S" }, { label: "M" }, { label: "L" }], selection: { mode: "multiple" } },
      ],
      viewCursor: `v:${sessionId}:0`,
    });
    const a = await answered;
    emit(sessionId, "userInput/settled", { userInputId, outcome: a["answers"] ? "answered" : "cancelled", answers: a["answers"] ?? [] });
  }
  emit(sessionId, "item/completed", { item: { itemId: `a-${turnId}`, kind: "agentMessage", turnId, revision: 2, status: "completed", recordedAt: now, text: `echo: ${text}` } });
  emit(sessionId, "session/tokenUsage", { turnId, modelId: "muse-spark-1.3", usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 0, reasoningTokens: 0 }, promptTokens: 100, totalTokens: 110, cumulative: { promptTokens: 100 * view(sessionId).filter((e) => e.method === "turn/started").length, outputTokens: 10, totalTokens: 110 } });
  emit(sessionId, "session/contextUsage", { usedTokens: 110, windowTokens: 1000000, pressure: "normal" });
  emit(sessionId, "turn/completed", { turnId, terminal: "completed", durationMs: 5 });
}

function handle(method: string, p: Record<string, unknown>): unknown {
  switch (method) {
    case "initialize":
      return { museHome: data, serverInfo: { name: "muse", version: "0.0.0-fake" }, platformOs: process.platform, grantedCapabilities: [], experimentalApi: false, platformFamily: "fake", schema: { version: 1 }, userAgent: "fake" };
    case "session/list": {
      const after = typeof p["updatedAfter"] === "string" ? Date.parse(p["updatedAfter"]) : 0;
      const rows = readJson<{ updatedAt: string; open?: boolean }[]>("list.json", []).filter((r) => Date.parse(r.updatedAt) > after && !r.open);
      return { sessions: rows, nextCursor: null };
    }
    case "view/page": {
      const id = String(p["sessionId"]);
      if (!existsSync(file(join("views", `${id}.json`)))) throw error(-32020, "sessionNotFound", `no session ${id}`);
      const events = view(id);
      const limit = Number(p["limit"] ?? 50);
      const cursor = typeof p["cursor"] === "string" ? seqOf(p["cursor"]) : undefined;
      if (p["direction"] === "backward") {
        const end = cursor !== undefined ? cursor - 1 : events.length;
        const start = Math.max(0, end - limit);
        const page = events.slice(start, end);
        return { events: page, nextCursor: start > 0 ? page[0]!.params["viewCursor"] : null };
      }
      const start = cursor ?? 0;
      const page = events.slice(start, start + limit);
      return { events: page, nextCursor: start + limit < events.length ? page.at(-1)!.params["viewCursor"] : null };
    }
    case "usage/read":
      return existsSync(file("usage.json")) ? { usage: readJson("usage.json", {}) } : {};
    case "session/start": {
      const id = String(p["sessionId"]);
      writeJson(join("views", `${id}.json`), []);
      const session = { sessionId: id, path: join(data, "sessions", id, "session.jsonl"), status: "idle", workspaceRoot: p["workspaceRoot"], modelId: p["modelId"] ?? "muse-spark-1.3", turnCount: 0 };
      return { session, viewCursor: `v:${id}:0` };
    }
    case "session/resume":
      return { session: { sessionId: p["sessionId"] } };
    case "turn/start": {
      const id = String(p["sessionId"]);
      if (!existsSync(file(join("views", `${id}.json`)))) throw error(-32024, "sessionNotLoaded", `session ${id} is not loaded`);
      const turnId = String(p["commandId"]);
      const text = ((p["input"] as { text?: string }[] | undefined) ?? []).map((i) => i.text ?? "").join("\n");
      setTimeout(() => void playTurn(id, turnId, text), 10);
      return { commandId: turnId, status: "accepted", turnId, startedNewTurn: true, disposition: "started" };
    }
    case "turn/interrupt": {
      const open = view(String(p["sessionId"])).filter((e) => e.method === "turn/started").length > view(String(p["sessionId"])).filter((e) => e.method === "turn/completed").length;
      if (!open) throw error(-32030, "commandRejected", "missing_run");
      return { commandId: p["commandId"], status: "accepted", turnId: "t" };
    }
    case "approval/decide":
    case "userInput/answer":
    case "userInput/cancel": {
      const key = String(p["approvalId"] ?? p["userInputId"]);
      const done = decisions.get(key);
      decisions.delete(key);
      done?.(p);
      return { commandId: p["commandId"], status: "accepted", terminal: true };
    }
    default:
      throw error(-32601, "methodNotFound", `unknown method ${method}`);
  }
}

if (verb === "serve") {
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    const m = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
    if (m.method === undefined && m.id !== undefined) {
      // cophylad's answer to one of our requests: the presentation receipt.
      waiting.get(m.id)?.(m.result);
      waiting.delete(m.id);
      return;
    }
    if (!m.method) return;
    if (m.id === undefined) return; // `initialized`
    appendFileSync(file("calls.jsonl"), JSON.stringify({ method: m.method, params: m.params ?? {} }) + "\n");
    try {
      send({ jsonrpc: "2.0", id: m.id, result: handle(m.method, m.params ?? {}) });
    } catch (e) {
      send({ jsonrpc: "2.0", id: m.id, error: e && typeof e === "object" && "code" in e ? e : { code: -32603, message: String(e) } });
    }
  });
}
