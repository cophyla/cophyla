// The stream listener: the web viewer's page as a browser on this network frames it, on a
// port of its own, so it never shares an origin with the app (a page's storage and its
// sockets are its origin's, and the app keeps its credential there). It serves `/remote`
// alone, the same proxy the controller listener and the loopback serve, over TLS with the
// controller listener's certificates and behind a guard of the same rules: peers on this
// network, this machine's names, and a socket only from the page it served itself. Only
// sessions minted for this door are served here, and they are served nowhere else.
// `/remote/ready` is a page that says the address is open: a browser keeps a certificate it
// was asked to accept per port, and a frame cannot ask.

import { STREAM_READY_PATH } from "@cophyla/protocol";
import { refusalResponse } from "../api/guard.ts";
import type { Guard } from "../api/guard.ts";
import { tlsOption } from "../api/server.ts";
import type { ListenerTls } from "../api/server.ts";
import type { Logger } from "../log.ts";
import { RemoteProxy } from "./proxy.ts";
import type { Bridge } from "./proxy.ts";

const MAX_PAYLOAD = 16 * 1024 * 1024;

export interface StreamListenerDeps {
  proxy: RemoteProxy;
  guard: Guard;
  tls: ListenerTls;
  host: string;
  port: number;
  /** Whether devices are served now; off, nothing here is answered. */
  serving: () => boolean;
  /** A test's stand-in for the address a peer comes from. */
  peer?: (address: string) => string;
  log: Logger;
}

export interface StreamListener {
  port: number;
  stop(): Promise<void>;
}

const PLAIN = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };

const READY_PAGE =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cophyla</title></head>` +
  `<body><p>This address is open in this browser now. Go back to Cophyla and connect again; this tab can be closed.</p></body></html>`;

function readyPage(): Response {
  return new Response(READY_PAGE, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

/** Starts it; throws when its port cannot be bound. */
export function startStreamListener(deps: StreamListenerDeps): StreamListener {
  const { proxy, guard } = deps;
  const server = Bun.serve<{ bridge: Bridge }>({
    hostname: deps.host,
    port: deps.port,
    tls: tlsOption(deps.tls),
    fetch(req, srv) {
      const url = new URL(req.url);
      const from = srv.requestIP(req)?.address ?? "?";
      const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
      const verdict = guard.check({ address: deps.peer ? deps.peer(from) : from, host: req.headers.get("host"), origin: req.headers.get("origin"), upgrade, path: url.pathname });
      if (!verdict.ok) return refusalResponse(verdict);
      if (!deps.serving()) return new Response("this node serves no devices on its network", { status: 403, headers: PLAIN });
      if (!RemoteProxy.owns(url.pathname)) return new Response("not found", { status: 404, headers: PLAIN });
      if (url.pathname === STREAM_READY_PATH) return readyPage();
      // A socket here is the stream page's own: one that names no page is nobody's.
      if (upgrade && verdict.origin !== "own") return new Response("not this page's socket", { status: 403, headers: PLAIN });
      return proxy.handle(req, (bridge) => srv.upgrade(req, { data: { bridge } }), "stream");
    },
    websocket: {
      maxPayloadLength: MAX_PAYLOAD,
      idleTimeout: 960,
      open(ws) {
        proxy.ws.open(ws.data.bridge, (data) => void ws.send(data), () => ws.close(1000, "session ended"));
      },
      message(ws, raw) {
        proxy.ws.message(ws.data.bridge, raw);
      },
      close(ws) {
        proxy.ws.close(ws.data.bridge);
      },
    },
  });
  const port = server.port ?? 0;
  deps.log.info("stream listener up", { port });
  return {
    port,
    async stop() {
      await Promise.race([server.stop(true), Bun.sleep(200)]);
    },
  };
}
