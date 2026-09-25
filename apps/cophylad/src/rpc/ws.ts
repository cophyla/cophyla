// An `RpcPeer` over a WebSocket, either end: Bun's `ServerWebSocket` on the listener, the
// global `WebSocket` on the connecting side. The owner still routes the socket's `message`
// to `peer.onText` and its `close` to `peer.close`; this only binds the write.

import type { Logger } from "../log.ts";
import { RpcPeer } from "./peer.ts";
import type { RpcPeerOptions } from "./peer.ts";

export interface SocketLike {
  send(data: string): unknown;
  readyState?: number;
}

const OPEN = 1;

export function wsPeer(ws: SocketLike, opts: Omit<RpcPeerOptions, "write"> & { log: Logger }): RpcPeer {
  return new RpcPeer({
    ...opts,
    write: (text) => {
      if (ws.readyState !== undefined && ws.readyState !== OPEN) return false;
      ws.send(text);
      return true;
    },
  });
}
