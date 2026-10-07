// This node: its id, made once and kept in the store, and the Node entity it presents. The
// role is the runtime one (a backup that promoted is a primary; a primary that stepped
// down is a secondary), so `capabilities.brain` and `role` say what the node is doing now.
// Its name is the one the user gave it in the app (`node.rename`, or the invite it joined
// with), kept in the store; else `[node] name`; else the machine's: on a Mac the Computer
// Name the user sees in Sharing settings ("Ada's MacBook Pro"), not the Bonjour host name
// `Adas-MacBook-Pro.local`. A rename changes `name` in place, so every reader sees it.

import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { newId, PROTOCOL_VERSION } from "@cophyla/protocol";
import type { HarnessKind, Node, NodeId, NodeRole, Platform, Via } from "@cophyla/protocol";
import type { Config } from "../config/schema.ts";
import type { Store } from "../store/index.ts";

export interface NodeIdentity {
  id: NodeId;
  name: string;
}

export function loadNodeIdentity(store: Store, config: Config): NodeIdentity {
  let id = store.meta.get("node_id");
  if (!id) {
    id = newId("node");
    store.meta.set("node_id", id);
  }
  return { id, name: store.meta.get("node_name") ?? config.node.name ?? machineName() };
}

/** The machine's name as its user knows it: macOS's Computer Name, else the host name without `.local`. */
export function machineName(
  platform: NodeJS.Platform = process.platform,
  computerName: () => string | undefined = () => {
    const r = spawnSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 3000 });
    return r.status === 0 ? r.stdout.trim() : undefined;
  },
  host: () => string = hostname,
): string {
  if (platform !== "darwin") return host();
  return computerName() || host().replace(/\.local$/i, "");
}

export function platformName(p: NodeJS.Platform = process.platform): Platform {
  if (p === "win32") return "windows";
  if (p === "darwin") return "macos";
  return "linux";
}

/**
 * `harnesses` are the kinds with a profile in status `ok`; the sessions module supplies
 * them, `voice` the voice module's loaded stages, `role` the nodes module's current role
 * (the configured one when absent), `remote` whether the desktop host serves, `via` how
 * this node reaches its primary (`relay` through the server's tunnel), and `terminals`
 * whether it starts terminals for the cluster's clients. A backup stays marked `backup` in
 * either role.
 */
export function selfNode(
  identity: NodeIdentity,
  config: Config,
  platformVersion: string,
  now = Date.now(),
  harnesses: HarnessKind[] = [],
  voice: { wake: boolean; stt: boolean; tts: boolean } = { wake: false, stt: false, tts: false },
  role: NodeRole = config.node.role,
  brainVersion?: string,
  remote = false,
  via: Via = "direct",
  terminals = false,
  agents?: { acceptInBypass: boolean },
): Node {
  const node: Node = {
    id: identity.id,
    name: identity.name,
    role,
    status: "online",
    via,
    platform: platformName(),
    scope: config.node.scope,
    capabilities: {
      harnesses: [...harnesses],
      voice: { ...voice },
      remote,
      brain: role === "primary",
      terminals,
      ...(agents ? { agents: { ...agents } } : {}),
    },
    versions: { platform: platformVersion, protocol: PROTOCOL_VERSION, ...(brainVersion !== undefined ? { brain: brainVersion } : {}) },
    lastSeen: now,
  };
  if (config.node.backup || (config.node.role === "primary" && role === "secondary")) node.backup = true;
  return node;
}
