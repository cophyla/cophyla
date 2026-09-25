// A chat client on stdin for a running cophylad: what you type goes out as `chat.send`; the
// orchestrator's replies stream in as `chat.delta` and land as `chat.message` (or vanish on a
// `chat.retract`); prompts, tasks and sessions are printed as they change. For the end-to-end
// run without the desktop app.
//   bun run apps/cophylad/scripts/talk.ts [--home <dir>] [--port <n>]
//   /quick <text>              a quick-mode message
//   /answer <ask> <option>     answer a prompt (the ask id may be its last few characters)
//   /tasks  /sessions  /asks   list what is open
//   /quit
// The token is read from <home>/data/client.token; the port from <home>/config.toml unless given.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { request } from "@cophyla/protocol";
import type { Ask, ContentBlock, Message, RpcMessage, Session, Task } from "@cophyla/protocol";
import { loadConfig, paths, resolveHome } from "../src/config/load.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { home: { type: "string" }, port: { type: "string" } },
  strict: true,
});

const p = paths(resolveHome(values.home));
const config = loadConfig(p, { writeDefault: false });
const port = values.port !== undefined ? Number(values.port) : config.api.port;
const token = readFileSync(p.clientToken, "utf8").trim();
const url = `ws://${config.api.host}:${port}/ws/client`;

const asks = new Map<string, Ask>();
const tasks = new Map<string, Task>();
const sessions = new Map<string, Session>();
let streamingId: string | undefined;
let streamed = "";

const short = (id: string) => id.slice(-6);
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false });

function blockText(b: ContentBlock): string {
  switch (b.type) {
    case "text":
      return b.text;
    case "quote": {
      const src = b.source ? (b.source.kind === "session" ? `session ${short(b.source.session)}${b.source.seq ? ` #${b.source.seq[0]}-${b.source.seq[1]}` : ""}` : b.source.kind === "file" ? `${b.source.path}${b.source.lines ? `:${b.source.lines[0]}-${b.source.lines[1]}` : ""}` : b.source.kind === "memory" ? `memory ${b.source.name}` : `thread ${short(b.source.thread)}`) : b.unresolved ? "unresolved" : "";
      return `\n  > ${b.text.split("\n").join("\n  > ")}\n  — ${src}`;
    }
    case "ref":
      return `[${b.session ? `session ${short(b.session)}` : b.task ? `task ${short(b.task)}` : b.thread ? `thread ${short(b.thread)}` : b.ask ? `ask ${short(b.ask)}` : b.audit ? `audit ${short(b.audit)}` : b.file ? `${b.file.path}${b.file.line ? `:${b.file.line}` : ""}` : "ref"}]`;
    case "audio":
      return "[audio]";
  }
}

function printMessage(m: Message): void {
  if (streamingId === m.id) {
    process.stdout.write("\r\x1b[K");
    streamingId = undefined;
    streamed = "";
  }
  const who = m.role === "user" ? "you" : m.role === "orchestrator" ? "orchestrator" : "system";
  console.log(`${clock(m.at)} ${who}: ${m.content.map(blockText).join(" ")}`);
}

function printAsk(a: Ask): void {
  asks.set(a.id, a);
  if (a.status === "open") {
    const from = a.source.kind === "harness" ? `session ${short(a.source.session)}` : a.source.kind === "gate" ? `gate on ${a.source.action}` : "the orchestrator";
    console.log(`${clock(a.createdAt)} ask ${short(a.id)} (${from}): ${a.title}${a.detail ? `\n  ${a.detail.split("\n").join("\n  ")}` : ""}\n  options: ${a.options.map((o) => `${o.id} (${o.label})`).join(", ")}  → /answer ${short(a.id)} <option>`);
  } else console.log(`${clock(Date.now())} ask ${short(a.id)} ${a.status}${a.answer ? `: ${a.answer.option}` : ""}`);
}

function printTask(t: Task): void {
  if (t.status === "done" || t.status === "cancelled") tasks.delete(t.id);
  else tasks.set(t.id, t);
  const blocker = t.blocker ? ` on ${t.blocker.kind === "ask" ? `ask ${short(t.blocker.ask)}` : t.blocker.kind === "session" ? `session ${short(t.blocker.session)}` : t.blocker.kind === "task" ? `task ${short(t.blocker.task)}` : "you"}` : "";
  console.log(`${clock(t.updatedAt)} task ${short(t.id)} ${t.status}${blocker}: ${t.title}${t.result ? ` — ${t.result.summary}` : ""}`);
}

function printSession(s: Session): void {
  const before = sessions.get(s.id);
  if (s.status === "ended") sessions.delete(s.id);
  else sessions.set(s.id, s);
  if (before?.status === s.status) return;
  console.log(`${clock(s.lastActivity)} session ${short(s.id)} ${s.harness} ${s.origin === "orchestrator" ? "(spawned)" : "(yours)"} ${s.status}${s.intent ? `: ${s.intent}` : ""}`);
}

const ws = new WebSocket(url);
let seq = 0;
const pending = new Map<number, (m: RpcMessage) => void>();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(String(ev.data)) as RpcMessage;
  if ("id" in m && m.id !== null && !("method" in m)) {
    pending.get(m.id as number)?.(m);
    return;
  }
  if (!("method" in m)) return;
  const params = m.params as Record<string, unknown>;
  switch (m.method) {
    case "chat.message":
      printMessage((params as { message: Message }).message);
      return;
    case "chat.delta": {
      const d = params as { message: string; delta: ContentBlock };
      if (streamingId !== d.message) {
        streamingId = d.message;
        streamed = "";
      }
      if (d.delta.type === "text") streamed += d.delta.text;
      process.stdout.write(`\r\x1b[K… ${streamed.slice(-100).replace(/\n/g, " ")}`);
      return;
    }
    case "chat.retract": {
      if (streamingId !== (params as { message: string }).message) return;
      streamingId = undefined;
      streamed = "";
      process.stdout.write("\r\x1b[K");
      return;
    }
    case "ask.state":
      printAsk(params as unknown as Ask);
      return;
    case "task.state":
      printTask(params as unknown as Task);
      return;
    case "session.state":
      printSession(params as unknown as Session);
      return;
    default:
      return;
  }
});
let quitting = false;
ws.addEventListener("close", () => {
  if (!quitting) console.log("cophylad closed the connection");
  process.exit(0);
});
const call = (method: string, params: unknown = {}) =>
  new Promise<unknown>((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => ("error" in m ? reject(new Error(`${method}: ${m.error.data?.code ?? ""} ${m.error.message}`)) : resolve((m as { result: unknown }).result)));
    ws.send(JSON.stringify(request(id, method, params)));
  });

await new Promise<void>((resolve, reject) => {
  ws.addEventListener("open", () => resolve());
  ws.addEventListener("error", () => reject(new Error(`cannot reach ${url}`)));
});
await call("hello", { token, kind: "ui", name: "talk", audio: { in: false, out: false } });
const loaded = (await call("chat.load", { limit: 1 })) as { threads: { topic?: string }[]; messages: Message[] };
if (loaded.messages.length > 0) {
  console.log(`— ${loaded.threads[0]?.topic ?? "the latest thread"} —`);
  for (const m of loaded.messages) printMessage(m);
}
console.log(`connected to ${url}; type a message, /quick <text>, /answer <ask> <option>, /tasks, /sessions, /asks, /quit`);

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
rl.prompt();
rl.on("line", (line) => {
  void (async () => {
    const text = line.trim();
    try {
      if (!text) return;
      if (text === "/quit") {
        quitting = true;
        ws.close();
        process.exit(0);
      } else if (text === "/tasks") {
        for (const t of tasks.values()) printTask(t);
        if (tasks.size === 0) console.log("(no open task)");
      } else if (text === "/sessions") {
        for (const s of sessions.values()) console.log(`session ${s.id} ${s.harness} ${s.origin} ${s.status} ${s.cwd}`);
        if (sessions.size === 0) console.log("(no live session)");
      } else if (text === "/asks") {
        for (const a of asks.values()) if (a.status === "open") printAsk(a);
      } else if (text.startsWith("/answer ")) {
        const [, askRef, option, ...rest] = text.split(/\s+/);
        const ask = [...asks.values()].find((a) => a.id === askRef || a.id.endsWith(askRef ?? ""));
        if (!ask || !option) console.log("usage: /answer <ask> <option> [note]");
        else await call("ask.answer", { id: ask.id, option, ...(rest.length ? { text: rest.join(" ") } : {}) });
      } else if (text.startsWith("/quick ")) {
        await call("chat.send", { text: text.slice("/quick ".length), mode: "quick" });
      } else if (text.startsWith("/")) {
        console.log("unknown command");
      } else {
        await call("chat.send", { text });
      }
    } catch (e) {
      console.log(e instanceof Error ? e.message : String(e));
    } finally {
      rl.prompt();
    }
  })();
});
rl.on("close", () => {
  quitting = true;
  ws.close();
  process.exit(0);
});
