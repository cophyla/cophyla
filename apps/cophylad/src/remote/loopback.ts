// The stream proxy on this machine's loopback, for pages that reach it through pipes: a
// phone off the LAN, or a desktop app on a node that has no route to this one. It serves
// `/remote` alone, the same proxy the controller listener serves, over plain HTTP on
// `127.0.0.1` (a pipe's far end is a forwarder on the viewer's own loopback, so the page is
// a loopback page there too and its cookie cannot be `Secure`). It starts on the first
// pipe and is never reachable from off this machine.

import type { Server } from "bun";
import type { Logger } from "../log.ts";
import { RemoteProxy } from "./proxy.ts";
import type { Bridge } from "./proxy.ts";

const MAX_PAYLOAD = 16 * 1024 * 1024;

export class LoopbackProxy {
  private proxy: RemoteProxy;
  private log: Logger;
  private server?: Server<{ bridge: Bridge }>;

  constructor(deps: { proxy: RemoteProxy; log: Logger }) {
    this.proxy = deps.proxy;
    this.log = deps.log;
  }

  /** Its port, started on the first ask. */
  port(): number {
    if (!this.server) {
      const proxy = this.proxy;
      this.server = Bun.serve<{ bridge: Bridge }>({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req, srv) {
          const url = new URL(req.url);
          if (!RemoteProxy.owns(url.pathname)) return new Response("not found", { status: 404 });
          return proxy.handle(req, (bridge) => srv.upgrade(req, { data: { bridge } }), "loopback");
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
      this.log.info("stream proxy on loopback", { port: this.server.port });
    }
    return this.server.port ?? 0;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (s) await Promise.race([s.stop(true), Bun.sleep(200)]);
  }
}
