// The switch, as the clients reach it: `direct.enable` and `direct.disable` name a node (this
// one without it); on the primary the forwarder sends one naming another node there, where
// the nodes link serves it. A phone's signalling (`direct.info`, `direct.offer`, and its
// candidates as a signal) is answered by the node its relay connection ends on, where the
// helper is; its scope is no view's.

import type { MethodTable, SignalTable } from "../api/methods.ts";
import type { DirectClients } from "./clients.ts";
import type { Direct } from "./index.ts";

export function directMethods(deps: { direct: Direct; clients: DirectClients }): MethodTable {
  return {
    "direct.info": {
      handler: (_p, ctx) => deps.clients.info(ctx.client, ctx.listener) as never,
    },
    "direct.offer": {
      handler: (p, ctx) => deps.clients.offer(ctx.client, ctx.listener, p),
    },
    "direct.enable": {
      target: (p) => p.node,
      handler: async () => {
        await deps.direct.enable();
        return {};
      },
    },
    "direct.disable": {
      target: (p) => p.node,
      handler: async () => {
        await deps.direct.disable();
        return {};
      },
    },
  };
}

export function directSignals(deps: { clients: DirectClients }): SignalTable {
  return {
    "direct.candidate": (client, p) => deps.clients.candidate(client, p),
  };
}
