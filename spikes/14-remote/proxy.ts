// Spike 14: the ticket + cookie reverse proxy cophylad will put in front of moonlight-web, as a
// standalone Bun TLS server so a desktop browser (Playwright) can open the stream page.
//
//   bun run spikes/14-remote/web.ts serve      # moonlight-web on 127.0.0.1:47800 (another shell)
//   bun run spikes/14-remote/proxy.ts          # https://127.0.0.1:47801/remote/?t=<ticket>
//
// Prints the ticket URL. GET /remote/?t=<ticket> sets the session cookie and redirects to
// /remote/; everything under /remote/ with the cookie is proxied to moonlight-web with the
// x-cophyla-user header; the stream WebSocket is bridged frame by frame; HTML gets
// frame-ancestors 'self'. GET /frame?hostId=&appId= is a page that frames the stream, the
// way the controller view will.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UPSTREAM = process.env.WEB_UPSTREAM ?? "http://127.0.0.1:47800";
const PORT = Number(process.env.PROXY_PORT ?? 47801);
const USER_HEADER = "x-cophyla-user";
const OUT = join(import.meta.dir, "out");

const ticket = crypto.randomUUID().replace(/-/g, "");
let session: string | undefined;
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "cookie", USER_HEADER]);

function cookieOf(req: Request): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  const m = /(?:^|;\s*)cophyla_remote=([^;]+)/.exec(raw);
  return m?.[1];
}

type Bridge = { upstream: WebSocket; pending: (string | ArrayBuffer | Uint8Array)[]; open: boolean; frames: { up: number; down: number; bytesDown: number } };

const server = Bun.serve<Bridge>({
  port: PORT,
  hostname: "0.0.0.0",
  tls: { cert: readFileSync(join(OUT, "cert.pem")), key: readFileSync(join(OUT, "key.pem")) },
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/frame") {
      const q = url.search;
      return new Response(
        `<!doctype html><title>controller frame</title><style>html,body{margin:0;height:100%;background:#222}iframe{border:0;width:100%;height:100%}</style>` +
          `<div style="color:#eee;font:12px system-ui;padding:4px">framed stream (the controller's fullscreen layer)</div>` +
          `<iframe id="f" src="/remote/stream.html${q}" allow="fullscreen; gamepad; keyboard-map"></iframe>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    if (!url.pathname.startsWith("/remote/") && url.pathname !== "/remote") return new Response("not here", { status: 404 });

    const t = url.searchParams.get("t");
    if (t !== null) {
      // TICKET_REUSE=1 lets browser.ts run several times against one proxy (spike only).
      if (t !== ticket || (session && !process.env.TICKET_REUSE)) return new Response("bad or used ticket", { status: 403 });
      session = crypto.randomUUID().replace(/-/g, "");
      return new Response(null, {
        status: 302,
        headers: { location: "/remote/", "set-cookie": `cophyla_remote=${session}; Path=/remote; Secure; HttpOnly; SameSite=Strict` },
      });
    }
    if (!session || cookieOf(req) !== session) return new Response("no session", { status: 403 });

    const headers = new Headers();
    for (const [k, v] of req.headers) if (!HOP.has(k)) headers.set(k, v);
    headers.set(USER_HEADER, "cophyla");

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const target = UPSTREAM.replace(/^http/, "ws") + url.pathname + url.search;
      const upstream = new WebSocket(target, { headers: { [USER_HEADER]: "cophyla" } } as any);
      upstream.binaryType = "arraybuffer";
      const data: Bridge = { upstream, pending: [], open: false, frames: { up: 0, down: 0, bytesDown: 0 } };
      if (srv.upgrade(req, { data })) return undefined as any;
      upstream.close();
      return new Response("upgrade failed", { status: 500 });
    }

    const res = await fetch(UPSTREAM + url.pathname + url.search, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
    });
    const out = new Headers();
    for (const [k, v] of res.headers) if (!HOP.has(k) && k !== "content-length") out.set(k, v);
    if ((res.headers.get("content-type") ?? "").includes("text/html")) out.set("content-security-policy", "frame-ancestors 'self'");
    return new Response(res.body, { status: res.status, headers: out });
  },
  websocket: {
    open(ws) {
      const d = ws.data;
      d.upstream.onopen = () => {
        d.open = true;
        for (const m of d.pending) d.upstream.send(m as any);
        d.pending = [];
      };
      d.upstream.onmessage = (ev) => {
        d.frames.down++;
        if (typeof ev.data === "string") ws.send(ev.data);
        else { d.frames.bytesDown += (ev.data as ArrayBuffer).byteLength; ws.send(new Uint8Array(ev.data as ArrayBuffer)); }
      };
      d.upstream.onclose = (ev) => { console.log(`upstream closed ${ev.code}; frames up=${d.frames.up} down=${d.frames.down} bytesDown=${d.frames.bytesDown}`); ws.close(); };
      d.upstream.onerror = (ev) => console.log("upstream error", (ev as any).message ?? ev);
    },
    message(ws, msg) {
      const d = ws.data;
      d.frames.up++;
      if (d.open) d.upstream.send(msg as any);
      else d.pending.push(typeof msg === "string" ? msg : new Uint8Array(msg as ArrayBuffer));
    },
    close(ws) {
      console.log(`client closed; frames up=${ws.data.frames.up} down=${ws.data.frames.down} bytesDown=${ws.data.frames.bytesDown}`);
      ws.data.upstream.close();
    },
    maxPayloadLength: 16 * 1024 * 1024,
  },
});

console.log(`proxy on https://127.0.0.1:${server.port}`);
console.log(`ticket URL: https://127.0.0.1:${server.port}/remote/?t=${ticket}`);
await Bun.write(join(OUT, "ticket.txt"), `https://127.0.0.1:${server.port}/remote/?t=${ticket}\n`);
