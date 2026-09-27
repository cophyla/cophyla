// A stand-in for the brain: answers brain-link's `hello` with a protocol range taken from
// FAKE_BRAIN_RANGE ("1-1" by default), then runs the script in FAKE_BRAIN_SCRIPT, a JSON file:
//
//   { "on": [{ "event": "user.message", "match": { "text": "quote" }, "requests": [ {method, params}, … ] }, …],
//     "crashAfterHello": false, "crashAfter": 3, "cancelOnUserMessage": false }
//
// A handler runs when an event of that name arrives and every `match` field is a substring of
// the event's; `hello` is an event too. Its requests go out one at a time, each waiting for
// the previous result. Inside params, "$last" is the previous result, "$last.<path>" a field
// of it, "$event.<path>" a field of the event, "$text[n]" the nth word of the event's text,
// "$req[n]" the id of the handler's nth request (0-based), "$res[n].<path>" a field of its
// result, and "$prev" the id of the previous one, so a `cite` can name the request whose
// result it quotes. `once` runs a handler at most
// once; `nth: n` runs it only on the nth matching event, so two handlers can share an event
// name. A request with `notify: true` goes out as a signal, with no id and nothing to wait
// for. `crashAfter: n` exits after n responses; `cancelOnUserMessage` sends `cancel` for
// every request in flight when a user message arrives. Every frame in and out
// is appended to FAKE_BRAIN_LOG as `{dir, frame}` JSONL when set. The script file is read
// again at every event, so a test can rewrite it once the daemon is up. Run from a release
// directory (a `release.json` beside it), it reports that entry's version as its own, so an
// installed or staged fake reads back as the release it stands for; `fake-0.1` otherwise.

import { appendFileSync, existsSync, readFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";

interface Handler {
  event: string;
  match?: Record<string, string>;
  requests: { method: string; params?: unknown; notify?: boolean }[];
  /** Run at most once. */
  once?: boolean;
  /** Run only on the nth matching event (1-based), so two handlers can share an event name. */
  nth?: number;
}

interface Script {
  on: Handler[];
  crashAfterHello?: boolean;
  crashAfter?: number;
  cancelOnUserMessage?: boolean;
}

const range = (process.env["FAKE_BRAIN_RANGE"] ?? "1-1").split("-").map(Number);
/** The version this fake stands for: its release entry's when it runs from a release directory. */
function brainVersion(): string {
  try {
    if (existsSync("release.json")) {
      const entry = JSON.parse(readFileSync("release.json", "utf8")) as { version?: unknown };
      if (typeof entry.version === "string") return entry.version;
    }
  } catch {
    // not a release directory
  }
  return "fake-0.1";
}
const ran = new Set<Handler>();
/** Matching events seen per handler index, for `nth`. */
let seen: number[] = [];
const scriptPath = process.env["FAKE_BRAIN_SCRIPT"];
let script: Script = { on: [] };
/** The script is read again on every event, so a test can change it after the daemon is up. */
function reload(): void {
  if (!scriptPath) return;
  try {
    const next = JSON.parse(readFileSync(scriptPath, "utf8")) as Script;
    if (JSON.stringify(next) !== JSON.stringify(script)) {
      script = next;
      ran.clear();
      seen = [];
    }
  } catch {
    // mid-write; keep the last script
  }
}
const logPath = process.env["FAKE_BRAIN_LOG"];

const log = (dir: "in" | "out", frame: unknown) => {
  if (logPath) appendFileSync(logPath, JSON.stringify({ dir, frame }) + "\n");
};
const send = (m: unknown) => {
  log("out", m);
  writeSync(1, JSON.stringify(m) + "\n");
};

let n = 0;
let responses = 0;
const pending = new Map<string, (v: { ok: boolean; result?: unknown; error?: unknown }) => void>();
const inflight = new Set<string>();

const cancels = new Set<string>();

function request(method: string, params: unknown): { id: string; done: Promise<{ ok: boolean; result?: unknown; error?: unknown }> } {
  const id = `r${++n}`;
  inflight.add(id);
  if (method === "cancel") cancels.add(id);
  const done = new Promise<{ ok: boolean; result?: unknown; error?: unknown }>((resolve) => pending.set(id, resolve));
  send(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
  return { id, done };
}

function get(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (!part) continue;
    const m = /^(\w+)\[(\d+)\]$/.exec(part);
    if (m) {
      cur = (cur as Record<string, unknown> | undefined)?.[m[1]!];
      cur = (cur as unknown[] | undefined)?.[Number(m[2])];
    } else cur = (cur as Record<string, unknown> | undefined)?.[part];
  }
  return cur;
}

const TOKEN = /\$(last|event)((?:\.[A-Za-z0-9_]+(?:\[\d+\])?)*)|\$prev|\$text\[(\d+)\]|\$req\[(\d+)\]|\$res\[(\d+)\]((?:\.[A-Za-z0-9_]+(?:\[\d+\])?)*)/g;

interface Ctx {
  event: unknown;
  last: unknown;
  ids: string[];
  results: unknown[];
}

/** One token's value. */
function token(m: RegExpExecArray, ctx: Ctx): unknown {
  const [whole, root, path, textIdx, reqIdx, resIdx, resPath] = m;
  if (root === "last") return path ? get(ctx.last, path.slice(1)) : ctx.last;
  if (root === "event") return path ? get(ctx.event, path.slice(1)) : ctx.event;
  if (whole === "$prev") return ctx.ids[ctx.ids.length - 1];
  if (textIdx !== undefined) return String(get(ctx.event, "text") ?? "").split(/\s+/)[Number(textIdx)];
  if (reqIdx !== undefined) return ctx.ids[Number(reqIdx)];
  if (resIdx !== undefined) {
    const r = ctx.results[Number(resIdx)];
    return resPath ? get(r, resPath.slice(1)) : r;
  }
  return whole;
}

function substitute(value: unknown, ctx: Ctx): unknown {
  if (typeof value === "string") {
    // A string that is one token keeps the value's type; tokens inside text are interpolated.
    const whole = new RegExp(`^(?:${TOKEN.source})$`).exec(value);
    if (whole) return token(whole, ctx);
    return value.replace(new RegExp(TOKEN.source, "g"), (...args) => {
      const m = args.slice(0, 7) as unknown as RegExpExecArray;
      const v = token(m, ctx);
      return v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, ctx));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substitute(v, ctx);
    return out;
  }
  return value;
}

async function run(handler: Handler, event: unknown): Promise<void> {
  const ctx: Ctx = { event, last: undefined, ids: [], results: [] };
  for (const step of handler.requests) {
    const params = substitute(step.params, ctx);
    if (step.notify) {
      send({ jsonrpc: "2.0", method: step.method, params });
      continue;
    }
    const { id, done } = request(step.method, params);
    ctx.ids.push(id);
    const outcome = await done;
    ctx.last = outcome.ok ? outcome.result : { error: outcome.error };
    ctx.results.push(ctx.last);
  }
}

function matches(handler: Handler, name: string, params: unknown): boolean {
  if (handler.event !== name) return false;
  if (handler.once && ran.has(handler)) return false;
  for (const [field, needle] of Object.entries(handler.match ?? {})) {
    const v = get(params, field);
    if (typeof v !== "string" || !v.includes(needle)) return false;
  }
  return true;
}

function onEvent(name: string, params: unknown): void {
  reload();
  if (name === "user.message" && script.cancelOnUserMessage) {
    for (const id of [...inflight]) if (!cancels.has(id)) request("cancel", { id });
  }
  script.on.forEach((h, i) => {
    if (!matches(h, name, params)) return;
    seen[i] = (seen[i] ?? 0) + 1;
    if (h.nth !== undefined && seen[i] !== h.nth) return;
    ran.add(h);
    void run(h, params);
  });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  log("in", m);
  const id = m["id"];
  const method = m["method"];
  if (typeof method === "string" && id !== undefined && id !== null) {
    if (method === "hello") {
      const p = m["params"] as { platformVersion: string; nodeId: string };
      send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, protocolRange: { min: range[0], max: range[1] }, brainVersion: brainVersion(), platformVersion: p.platformVersion, nodeId: p.nodeId, role: "brain" } });
      if (script.crashAfterHello) setTimeout(() => process.exit(3), 20);
      else onEvent("hello", p);
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported: ${method}`, data: { code: "unsupported", message: `unsupported: ${method}`, retryable: false } } });
    return;
  }
  if (typeof method === "string") {
    if (method === "pending" || method === "llm.delta") return;
    onEvent(method, m["params"]);
    return;
  }
  const key = String(id);
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  inflight.delete(key);
  responses++;
  p(m["error"] !== undefined && m["error"] !== null ? { ok: false, error: m["error"] } : { ok: true, result: m["result"] });
  if (script.crashAfter !== undefined && responses >= script.crashAfter) setTimeout(() => process.exit(4), 20);
});
