// The client requests of agent messaging: the bypass switch, `agents.accept`, which a node's
// own apps call here and a primary's forward to the node it names.

import type { MethodTable } from "../api/methods.ts";
import type { AgentMessages } from "./index.ts";

export function agentMethods(deps: { agents: () => Pick<AgentMessages, "setAccept"> | undefined }): MethodTable {
  return {
    "agents.accept": {
      target: (p) => p.node,
      handler: (p) => {
        const agents = deps.agents();
        if (!agents) return Promise.reject(new Error("agent messaging is off on this node"));
        agents.setAccept(p.on);
        return {};
      },
    },
  };
}
