// A stand-in for `codex app-server proxy` and the managed daemon behind it: a WebSocket
// server on stdio, JSON-RPC in text frames, answering `initialize` and `turn/steer`. What the
// daemon runs comes from CODEX_HOME, and what was steered is written back there:
//   daemon.json   { "<thread id>": "<running turn id>" | null } for each thread it has loaded;
//                 without the file no daemon listens, and the proxy fails as the real one does
//   steer.json    every turn/steer that went into a turn, appended
// Run by codex-app-server.ts when its arguments hold `proxy`.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const home = process.env["CODEX_HOME"] ?? process.cwd();
const file = (name: string) => join(home, name);
const readJson = <T>(name: string, fallback: T): T => (existsSync(file(name)) ? (JSON.parse(readFileSync(file(name), "utf8")) as T) : fallback);

if (!existsSync(file("daemon.json"))) {
  process.stderr.write(`Error: failed to connect to socket at ${join(home, "app-server-control", "app-server-control.sock")}\n`);
  process.exit(1);
}

const frame = (text: string) => {
  const payload = Buffer.from(text, "utf8");
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), Buffer.alloc(8)]);
  if (n >= 65536) head.writeBigUInt64BE(BigInt(n), 2);
  writeSync(1, Buffer.concat([head, payload]));
};

function handle(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case "initialize":
      return { userAgent: "fake-codex-daemon/0.0.0", codexHome: home, platformOs: process.platform === "win32" ? "windows" : process.platform, platformFamily: "fake" };
    case "turn/steer": {
      const threadId = String(params["threadId"]);
      const loaded = readJson<Record<string, string | null>>("daemon.json", {});
      if (!(threadId in loaded)) throw Object.assign(new Error(`thread not found: ${threadId}`), { code: -32600 });
      const active = loaded[threadId];
      if (!active) throw Object.assign(new Error("no active turn to steer"), { code: -32600 });
      if (params["expectedTurnId"] !== active) throw Object.assign(new Error(`expected active turn id \`${String(params["expectedTurnId"])}\` but found \`${active}\``), { code: -32600 });
      const log = readJson<unknown[]>("steer.json", []);
      log.push({ threadId, expectedTurnId: params["expectedTurnId"], clientUserMessageId: params["clientUserMessageId"], input: params["input"] });
      writeFileSync(file("steer.json"), JSON.stringify(log, null, 2) + "\n");
      return { turnId: active };
    }
    default:
      throw Object.assign(new Error(`unknown method ${method}`), { code: -32601 });
  }
}

function onText(text: string): void {
  let m: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    m = JSON.parse(text) as typeof m;
  } catch {
    return;
  }
  if (m.method === undefined || m.id === undefined) return;
  try {
    frame(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: handle(m.method, m.params ?? {}) }));
  } catch (e) {
    frame(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: (e as { code?: number }).code ?? -32000, message: e instanceof Error ? e.message : String(e) } }));
  }
}

let buf = Buffer.alloc(0);
let upgraded = false;
process.stdin.on("data", (d: Buffer) => {
  buf = Buffer.concat([buf, d]);
  if (!upgraded) {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    const key = /^sec-websocket-key:\s*(\S+)/im.exec(buf.subarray(0, end).toString("latin1"))?.[1] ?? "";
    buf = buf.subarray(end + 4);
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    writeSync(1, `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    upgraded = true;
  }
  for (;;) {
    if (buf.length < 2) return;
    const opcode = buf[0]! & 0x0f;
    let n = buf[1]! & 0x7f;
    let at = 2;
    if (n === 126) {
      if (buf.length < 4) return;
      n = buf.readUInt16BE(2);
      at = 4;
    } else if (n === 127) {
      if (buf.length < 10) return;
      n = Number(buf.readBigUInt64BE(2));
      at = 10;
    }
    // a client's frames are masked
    if (buf.length < at + 4 + n) return;
    const mask = buf.subarray(at, at + 4);
    const payload = Buffer.from(buf.subarray(at + 4, at + 4 + n));
    for (let i = 0; i < n; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
    buf = buf.subarray(at + 4 + n);
    if (opcode === 0x8) process.exit(0);
    if (opcode === 0x1) onText(payload.toString("utf8"));
  }
});
process.stdin.on("end", () => process.exit(0));
