// A fake node for working on the controller page: the built app on `http://127.0.0.1:4819`,
// a socket that answers `pair.claim`, `hello` and the handful of methods the page uses, and
// a stub view served under the same frame policy the real listener uses, the page itself
// under the policy the real listener sends it (the one builder makes both). `localhost` is a
// secure context, so the microphone works with no certificate and no phone. The phone is
// told to hear the wake word itself; when it says it did, the utterance runs two seconds
// and the turn ends as a released button's does. The audio frames it sends are counted.
//
//   bun run apps/controller/scripts/build.ts && bun run apps/controller/scripts/dev-serve.ts
//   … --say out/reply.wav     speak that clip back when the button is released
//
// The pairing code is 123456. Nothing here is the daemon: it exists so the page can be
// driven by hand and by Playwright.

import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { controllerCsp } from "@cophyla/protocol";
import { appHeaders } from "../../cophylad/src/api/guard.ts";
import { viewHeaders } from "../../cophylad/src/api/tickets.ts";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { port: { type: "string", default: "4819" }, say: { type: "string" }, dist: { type: "string" } }, strict: true });

const root = resolve(import.meta.dir, "..");
const dist = values.dist ?? join(root, "dist");
const stub = join(root, "test", "fixtures", "stub-view");
const port = Number(values.port);
const CODE = "123456";
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".map": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png" };

if (!existsSync(join(dist, "index.html"))) {
  console.error(`no build at ${dist}: run apps/controller/scripts/build.ts first`);
  process.exit(1);
}

/** A clip to speak back, as 24 kHz int16, or a ramp when none was given. */
function reply(): Int16Array {
  if (values.say && existsSync(values.say)) {
    const bytes = new Uint8Array(readFileSync(values.say));
    const dv = new DataView(bytes.buffer);
    let pos = 12;
    while (pos + 8 <= bytes.length) {
      const id = String.fromCharCode(...bytes.subarray(pos, pos + 4));
      const size = dv.getUint32(pos + 4, true);
      if (id === "data") {
        const count = Math.floor(Math.min(size, bytes.length - pos - 8) / 2);
        const out = new Int16Array(count);
        for (let i = 0; i < count; i++) out[i] = dv.getInt16(pos + 8 + i * 2, true);
        return out;
      }
      pos += 8 + size + (size & 1);
    }
  }
  // Half a second of a falling tone, so the speaker is obviously working.
  const out = new Int16Array(12000);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(8000 * Math.sin((2 * Math.PI * (600 - i / 40) * i) / 24000));
  return out;
}

interface Conn {
  paired: boolean;
  said: boolean;
  frames: number;
  ticker?: ReturnType<typeof setInterval>;
}

/** The turn after the utterance: the words, then the reply spoken back. */
function endTurn(ws: Bun.ServerWebSocket<Conn>): void {
  notify(ws, "voice.state", { state: "thinking", client: CLIENT.id });
  setTimeout(() => {
    notify(ws, "chat.message", {
      message: { id: `msg_${Date.now()}`, thread: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB3", at: Date.now(), role: "user", source: "voice", content: [{ type: "text", text: "what time is the meeting tomorrow afternoon" }] },
    });
    speak(ws);
  }, 300);
}

const send = (ws: Bun.ServerWebSocket<Conn>, frame: unknown): void => {
  ws.send(JSON.stringify(frame));
};
const notify = (ws: Bun.ServerWebSocket<Conn>, method: string, params: unknown): void => send(ws, { jsonrpc: "2.0", method, params });
const ok = (ws: Bun.ServerWebSocket<Conn>, id: unknown, result: unknown): void => send(ws, { jsonrpc: "2.0", id, result });
const fail = (ws: Bun.ServerWebSocket<Conn>, id: unknown, code: string, message: string): void =>
  send(ws, { jsonrpc: "2.0", id, error: { code: -32000, message, data: { code, message, retryable: false } } });

const CLIENT = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind: "controller", name: "dev phone", scopes: ["chat", "voice", "views", "sessions:read", "asks:answer", "tasks:read"], via: "direct", audio: { in: true, out: true }, connectedAt: Date.now() };
const VIEW = { id: "stub", name: "Stub", entry: "index.html", default: true, source: "builtin", version: "1", scopes: ["chat", "voice", "views", "sessions:read", "asks:answer", "tasks:read"] };

function speak(ws: Bun.ServerWebSocket<Conn>): void {
  const pcm = reply();
  notify(ws, "voice.state", { state: "speaking", client: CLIENT.id });
  const FRAME = 4800;
  let off = 0;
  const pump = setInterval(() => {
    if (off >= pcm.length) {
      clearInterval(pump);
      setTimeout(() => notify(ws, "voice.state", { state: "idle", client: CLIENT.id }), 400);
      return;
    }
    const slice = pcm.subarray(off, Math.min(off + FRAME, pcm.length));
    notify(ws, "voice.audio", { chunk: Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString("base64") });
    off += FRAME;
  }, 120);
}

const server = Bun.serve<Conn>({
  hostname: "127.0.0.1",
  port,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws/client") {
      return srv.upgrade(req, { data: { paired: false, said: false, frames: 0 } }) ? undefined : new Response("expected a websocket", { status: 426 });
    }
    // The stub view, under the same policy the real listener serves one with.
    const view = /^\/view\/dev\/(.+)$/.exec(url.pathname);
    if (view) {
      const path = join(stub, view[1]!);
      if (!path.startsWith(stub) || !existsSync(path)) return new Response("not found", { status: 404 });
      return new Response(readFileSync(path), { headers: viewHeaders(url.origin, MIME[extname(path)] ?? "text/plain") });
    }
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const file = join(dist, rel);
    if (!file.startsWith(dist) || !existsSync(file)) return new Response("not found", { status: 404 });
    return new Response(readFileSync(file), { headers: appHeaders(MIME[extname(file)] ?? "application/octet-stream", controllerCsp()) });
  },
  websocket: {
    open(ws) {
      console.log("phone connected");
      ws.data.ticker = setInterval(() => {
        if (ws.data.frames > 0) console.log(`  ${ws.data.frames} audio frames/s`);
        ws.data.frames = 0;
      }, 1000);
    },
    message(ws, raw) {
      const msg = JSON.parse(String(raw)) as { id?: unknown; method?: string; params?: Record<string, unknown> };
      const { id, method, params } = msg;
      if (method === "voice.audio") {
        ws.data.frames++;
        return;
      }
      if (method === "chat.typing") return;
      switch (method) {
        case "pair.claim":
          if (params?.["code"] !== CODE) return fail(ws, id, "denied", `that code is not open (this server's is ${CODE})`);
          ws.data.paired = true;
          return ok(ws, id, { token: "dev-token", client: { id: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1", name: String(params?.["name"] ?? "dev phone"), pairedAt: Date.now(), connected: false } });
        case "hello":
          console.log("hello", JSON.stringify(params));
          ok(ws, id, { client: CLIENT, node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV", protocolVersion: 1, platformVersion: "0.2.0-dev" });
          notify(ws, "voice.state", { state: "idle", client: CLIENT.id });
          return;
        case "view.list":
          return ok(ws, id, { views: [VIEW] });
        case "view.stage":
          return ok(ws, id, { base: `http://127.0.0.1:${port}/view/dev/`, version: VIEW.version });
        case "voice.ptt": {
          const active = params?.["active"] === true;
          ok(ws, id, {});
          if (active) notify(ws, "voice.state", { state: "listening", client: CLIENT.id });
          else endTurn(ws);
          return;
        }
        case "voice.wakeword":
          console.log("wakeword", JSON.stringify(params));
          return ok(ws, id, { mode: "phone", head: "cophyla_v0.1.onnx", threshold: 0.7, scale: "int16" });
        case "voice.wake":
          console.log("wake heard on the phone", JSON.stringify(params));
          ok(ws, id, {});
          notify(ws, "voice.state", { state: "listening", client: CLIENT.id });
          setTimeout(() => endTurn(ws), 2000);
          return;
        case "chat.load":
          return ok(ws, id, { threads: [], messages: [] });
        case "controller.revoke":
          return ok(ws, id, {});
        default:
          if (id !== undefined) return fail(ws, id, "unsupported", `the dev server does not serve ${method}`);
      }
    },
    close(ws) {
      if (ws.data.ticker) clearInterval(ws.data.ticker);
      console.log("phone gone");
    },
  },
});

console.log(`\n  controller dev server: http://127.0.0.1:${server.port}/\n  pairing code: ${CODE}\n  speaking back: ${values.say ?? "a test tone"}\n`);
