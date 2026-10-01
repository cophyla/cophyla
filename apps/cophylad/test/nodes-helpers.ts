// Two daemons on one machine: a primary accepting links on its LAN listener, and a
// secondary that joins it the way a user would, with an invite the primary mints and the
// secondary redeems. The fake brain runs on the primary when asked; the fake ACP agent on
// whichever node a test spawns in.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FULL, inviteText, newId, parseInvite, PROTOCOL_VERSION } from "@cophyla/protocol";
import type { Ask, GrantRole, Node, Session, Workspace } from "@cophyla/protocol";
import { pskFromHex } from "@cophyla/relay";
import type { Daemon, DaemonOptions } from "../src/daemon.ts";
import { silentLogger } from "../src/log.ts";
import type { DiscoveryTransport } from "../src/nodes/discovery.ts";
import { openDirect } from "../src/nodes/outbound.ts";
import { sealLan } from "../src/nodes/sealed-link.ts";
import { RpcPeer } from "../src/rpc/peer.ts";
import { removeHome, stopDaemon, tempHome, TestClient, tomlString, waitFor } from "./helpers.ts";

export const FAKE_BRAIN = join(import.meta.dir, "fakes", "brain.ts");
export const FAKE_AGENT = join(import.meta.dir, "fakes", "acp-agent.ts");

export type Started = Daemon & { home: string };

export interface PrimaryOptions {
  brain?: { script: object; rules?: Record<string, string> };
  toml?: string;
  /** More keys for the `[nodes]` table, which TOML allows once: `toml` may not open it again. */
  nodes?: string;
  discovery?: DiscoveryTransport;
  daemon?: Partial<DaemonOptions>;
  /** Milliseconds; the tests keep the link fast. */
  heartbeatMs?: number;
  /** How long this node's own clients' hellos wait for a lost link, once it is a secondary; short in the tests. */
  relinkGraceMs?: number;
  home?: string;
  /** No LAN listener at all: other nodes reach this primary through the server relay only. */
  noLan?: boolean;
}

export interface Primary {
  d: Started;
  /** The LAN listener's endpoint other nodes link to. */
  endpoint: string;
  brainLog?: string;
  scriptPath?: string;
  scratch: string;
}

/** A primary with its LAN listener on a free port and `[nodes] accept` on. */
export async function startPrimary(opts: PrimaryOptions = {}): Promise<Primary> {
  const scratch = tempHome();
  const brainLog = join(scratch, "brain.log");
  const scriptPath = join(scratch, "brain-script.json");
  const configDir = join(scratch, "claude-home");
  mkdirSync(configDir, { recursive: true });
  let brainToml = "";
  if (opts.brain) {
    writeFileSync(scriptPath, JSON.stringify(opts.brain.script));
    const rules = { "brain:session.spawn": "allow", "brain:session.send": "allow", "brain:ui.say": "allow", "brain:task.create": "allow", "brain:task.update": "allow", ...opts.brain.rules };
    brainToml = `[brain]\ncommand = ${tomlString(FAKE_BRAIN)}\nrestart_backoff_ms = 100\nhello_timeout_ms = 5000\n\n[gate.rules]\n${Object.entries(rules)
      .map(([k, v]) => `"${k}" = "${v}"`)
      .join("\n")}\n\n`;
  }
  const toml =
    `[sessions]\ndiscover = false\ninstall_hooks = false\nlaunch = "acp"\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(configDir)}\n\n[acp.claude]\ncommand = ${tomlString(FAKE_AGENT)}\n\n` +
    `[controller]\nenabled = false\nport = 0\n\n[nodes]\naccept = ${opts.noLan ? "false" : "true"}\ndiscovery = ${opts.discovery ? "true" : "false"}\nheartbeat_ms = ${opts.heartbeatMs ?? 200}\nclaim_wait_ms = 300\nrelink_grace_ms = ${opts.relinkGraceMs ?? 200}\n${opts.nodes ?? ""}\n` +
    brainToml +
    (opts.toml ?? "");
  const home = opts.home ?? scratch;
  if (opts.home) mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), toml);
  const { startDaemon } = await import("../src/daemon.ts");
  const { silentLogger } = await import("../src/log.ts");
  const d = Object.assign(
    await startDaemon({
      home,
      port: 0,
      log: silentLogger,
      brain: opts.brain !== undefined,
      embedder: null,
      env: { ...process.env, FAKE_BRAIN_SCRIPT: scriptPath, FAKE_BRAIN_LOG: brainLog, GEMINI_API_KEY: undefined },
      ...(opts.discovery ? { nodes: { discovery: opts.discovery } } : {}),
      ...opts.daemon,
    }),
    { home },
  );
  if (!d.controller && !opts.noLan) throw new Error("the primary has no LAN listener");
  return { d, endpoint: d.controller ? `127.0.0.1:${d.controller.port}` : "none", ...(opts.brain ? { brainLog, scriptPath } : {}), scratch };
}

export interface SecondaryOptions {
  backup?: boolean;
  rank?: number;
  /** More keys for the `[node]` table, which `toml` may not open again. */
  node?: string;
  toml?: string;
  /** More keys for the `[nodes]` table, which TOML allows once: `toml` may not open it again. */
  nodes?: string;
  discovery?: DiscoveryTransport;
  daemon?: Partial<DaemonOptions>;
  heartbeatMs?: number;
  /** How long this node's own clients' hellos wait for a lost link; short in the tests. */
  relinkGraceMs?: number;
  /** Leave `[nodes] primary` out: the node finds the primary by discovery or the registry. */
  noEndpoint?: boolean;
  /** The invite without its LAN part: the node redeems it, and links, through the server relay. */
  relayOnly?: boolean;
  /** Joined as hands only. */
  hands?: boolean;
  /** Start the node and leave it in no cluster: the test joins it itself. */
  unjoined?: boolean;
  /** What the join passes on. */
  paths?: string[];
  answerHere?: boolean;
  home?: string;
  /** An ACP agent on this node, so the primary can spawn here. */
  agent?: boolean;
  gateRules?: Record<string, string>;
  /** Serve the controller app on the LAN listener too. */
  controller?: boolean;
}

/** A node invite minted on the primary, as text; without its LAN part when the node must come through the relay. */
export async function inviteOn(primary: Pick<Primary, "d">, opts: { name?: string; role?: GrantRole; relayOnly?: boolean; expiresIn?: number; inviteExpiresIn?: number } = {}): Promise<string> {
  const { invite } = await primary.d.nodes.invite({
    name: opts.name ?? "test node",
    role: opts.role ?? "full",
    ...(opts.expiresIn !== undefined ? { expiresIn: opts.expiresIn } : {}),
    ...(opts.inviteExpiresIn !== undefined ? { inviteExpiresIn: opts.inviteExpiresIn } : {}),
  });
  if (!opts.relayOnly) return invite.text;
  const { lan: _lan, ...body } = parseInvite(invite.text);
  if (!body.relay) throw new Error("the primary minted no relay part: is it signed in?");
  return inviteText(body);
}

/** A secondary that joins `primary` with an invite; told where the primary is unless `noEndpoint`. */
export async function startSecondary(primary: Pick<Primary, "d" | "endpoint">, opts: SecondaryOptions = {}): Promise<Started> {
  const scratch = tempHome();
  const configDir = join(scratch, "claude-home");
  mkdirSync(configDir, { recursive: true });
  const rules = opts.gateRules ? `[gate.rules]\n${Object.entries(opts.gateRules).map(([k, v]) => `"${k}" = "${v}"`).join("\n")}\n\n` : "";
  const toml =
    `[sessions]\ndiscover = false\ninstall_hooks = false\nlaunch = "acp"\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(configDir)}\n\n` +
    (opts.agent ? `[acp.claude]\ncommand = ${tomlString(FAKE_AGENT)}\n\n` : "") +
    `[node]\nrole = "secondary"\nbackup = ${opts.backup ? "true" : "false"}\nbackup_rank = ${opts.rank ?? 1}\n${opts.node ?? ""}\n[controller]\nenabled = ${opts.controller ? "true" : "false"}\nport = 0\n\n` +
    `[nodes]\n${opts.noEndpoint ? "" : `primary = "${primary.endpoint}"\n`}discovery = ${opts.discovery ? "true" : "false"}\nheartbeat_ms = ${opts.heartbeatMs ?? 200}\nreconnect_ms = 100\nreconnect_max_ms = 400\nclaim_wait_ms = 300\nrelink_grace_ms = ${opts.relinkGraceMs ?? 200}\n${opts.nodes ?? ""}\n` +
    rules +
    (opts.toml ?? "");
  const home = opts.home ?? scratch;
  if (opts.home) mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), toml);
  const { startDaemon } = await import("../src/daemon.ts");
  const { silentLogger } = await import("../src/log.ts");
  const d = await startDaemon({
    home,
    port: 0,
    log: silentLogger,
    brain: false,
    embedder: null,
    env: { ...process.env, GEMINI_API_KEY: undefined },
    ...(opts.discovery ? { nodes: { discovery: opts.discovery } } : {}),
    ...opts.daemon,
  });
  const started = Object.assign(d, { home });
  if (opts.unjoined) return started;
  try {
    const invite = await inviteOn(primary, { role: opts.hands ? "hands" : "full", ...(opts.relayOnly ? { relayOnly: true } : {}) });
    await started.nodes.join(invite, { ...(opts.paths ? { paths: opts.paths } : {}), ...(opts.answerHere ? { answerHere: true } : {}) });
  } catch (e) {
    await stopAll(started);
    throw e;
  }
  return started;
}

/** A client on a daemon's loopback listener, said hello. */
export async function client(d: Started, name = "test"): Promise<TestClient> {
  const c = await TestClient.connect(d.api.url);
  await c.hello(d.token, { name });
  return c;
}

export async function linked(secondary: Started, timeoutMs = 5000): Promise<void> {
  await waitFor(() => secondary.nodes.linked(), timeoutMs);
}

/** Stops daemons in the order given, ignoring one that is gone. */
export async function stopAll(...ds: (Started | undefined)[]): Promise<void> {
  for (const d of ds) {
    if (!d) continue;
    try {
      await stopDaemon(d);
    } catch {
      removeHome(d.home);
    }
  }
}

/** A node row as a hand-made link presents it. */
export function rogueNode(id: string, name = "rogue"): Node {
  return {
    id,
    name,
    role: "secondary",
    status: "online",
    via: "direct",
    platform: "linux",
    scope: { kind: "machine" },
    capabilities: { harnesses: [], voice: { wake: false, stt: false, tts: false }, remote: false, brain: false },
    versions: { platform: "0.0.0", protocol: PROTOCOL_VERSION },
    lastSeen: Date.now(),
  };
}

export interface Rogue {
  id: string;
  rpc: RpcPeer;
  /** What the primary sent down the link. */
  frames: { method: string; params: unknown }[];
  notify(method: string, params: unknown): void;
  close(): void;
}

export interface RogueOptions {
  id?: string;
  /** The grant it links with; one minted and bound to `id` on the primary when absent. */
  grant?: { grant: string; key: string };
  /** The grant minted for it is hands only. */
  hands?: boolean;
  backup?: boolean;
  sessions?: Session[];
  workspaces?: Workspace[];
  asks?: Ask[];
}

/** A node grant minted and redeemed on the primary in-process, bound to `node`: what an invite would have given it. */
export function grantFor(d: Started, node: string, role: GrantRole = "full"): { grant: string; key: string } {
  const { row } = d.grants.mint({ kind: "node", name: `grant for ${node}`, access: FULL, role, inviteExpiresAt: Date.now() + 60_000 });
  const { key } = d.grants.enrollNode(row.id, node, d.identity.id);
  return { grant: row.id, key };
}

/** A LAN link to the primary sealed with a grant, and an RPC peer on it that records what comes down. */
export async function sealedLink(primary: Pick<Primary, "endpoint">, grant: { grant: string; key: string }, label = "rogue"): Promise<{ rpc: RpcPeer; frames: { method: string; params: unknown }[]; close(): void }> {
  const sock = await sealLan(await openDirect(primary.endpoint, 5000), { grant: grant.grant, kind: "node", psk: pskFromHex(grant.key), timeoutMs: 5000 });
  const frames: { method: string; params: unknown }[] = [];
  const rpc = new RpcPeer({ write: (text) => sock.send(text), log: silentLogger, label, onNotification: (method, params) => void frames.push({ method, params }), onRequest: () => ({}) });
  sock.onMessage((text) => rpc.onText(text));
  sock.onClose(() => rpc.close("closed"));
  return { rpc, frames, close: () => sock.close(1000, "done") };
}

/**
 * A node link made by hand: the handshake a real secondary makes, with a grant of its own,
 * then whatever the test sends. What a node that holds a grant but not the daemon's
 * scruples can put on the wire.
 */
export async function rogueLink(primary: Pick<Primary, "d" | "endpoint">, opts: RogueOptions = {}): Promise<Rogue> {
  const id = opts.id ?? newId("node");
  const grant = opts.grant ?? grantFor(primary.d, id, opts.hands ? "hands" : "full");
  const { rpc, frames, close } = await sealedLink(primary, grant);
  await rpc.request("node.hello", { protocolVersion: PROTOCOL_VERSION, platformVersion: "0.0.0", nodeId: id, cluster: primary.d.nodes.member()!.cluster });
  await rpc.request("node.join", {
    node: rogueNode(id),
    endpoints: [],
    epoch: 1,
    backup: opts.backup ?? false,
    sessions: opts.sessions ?? [],
    workspaces: opts.workspaces ?? [],
    asks: opts.asks ?? [],
  });
  return { id, rpc, frames, notify: (method, params) => void rpc.notify(method, params), close };
}
