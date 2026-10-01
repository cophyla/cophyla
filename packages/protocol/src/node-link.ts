// The node link: the capability protocol over /ws/node between a secondary and the primary,
// plus the messages that belong to the link itself. Every frame of it travels sealed
// (@cophyla/relay's `SealedSocket`), keyed from the linking node's own grant: on the LAN two
// frames in the clear name the grant and exchange ephemeral keys, through the server the
// relay's `relay.open` does; a machine redeeming an invite keys its first link from the
// invite's secret and gets its grant's key inside it (`node.enroll`). A secondary's clients
// are relayed to the primary frame for frame; the primary streams its writes to a backup.
// Capability requests, `cancel` and `pending` ride the same socket unchanged, primary to
// secondary; client notifications and capability events ride it upward, and a terminal of a
// node's that a client of the primary opened streams over it both ways. See
// architecture.md, "nodes" and "Topology".

import { z } from "zod";
import { Access, AudioCapabilities, Ask, ClientKind, DirectPathType, GrantRole, IceServer, Node, NodeRole, Session, Terminal, Workspace } from "./entities.ts";
import { ClientId, GrantId, GrantRef, NodeId, Timestamp } from "./ids.ts";
import { clientNotifications, clientRequests, clientSignals, DisplaySize, IceCandidate, PipeId, StreamTransport } from "./client.ts";
import { Secret } from "./invite.ts";

const Empty = z.object({});

/** A cluster's id: 16 hex characters, random. */
export const ClusterId = z.string().regex(/^[0-9a-f]{16}$/, { message: "expected 16 hex characters" });

/** A `host:port` a node can be reached at. */
export const Endpoint = z.string().regex(/^.+:\d{1,5}$/, { message: "expected host:port" });

/** The registry row as it travels: the node and how to reach it, the epoch it last saw, its backup rank. */
export const NodeRecord = Node.extend({
  endpoints: z.array(Endpoint),
  epoch: z.number().int().nonnegative().optional(),
  rank: z.number().int().positive().optional(),
  /** A relayed node's link running on a data channel: its path, round trip, and since when. */
  p2p: z.object({ path: DirectPathType, rttMs: z.number().nonnegative().optional(), since: Timestamp }).optional(),
});
export type NodeRecord = z.infer<typeof NodeRecord>;

/**
 * Why a side of a link goes: stopping, stepping down, or, from a node, leaving the cluster for
 * good (its grant goes with it); from the primary, `revoked`: the node's grant ended, and the
 * node forgets its membership. Sealed like every frame, so no one between can say it.
 */
export const LinkLeaveReason = z.enum(["stopping", "stepdown", "left", "revoked"]);
export type LinkLeaveReason = z.infer<typeof LinkLeaveReason>;

export const ReplicaTable = z.enum(["threads", "messages", "tasks", "workspaces", "kv"]);
export type ReplicaTable = z.infer<typeof ReplicaTable>;

/** One replicated write: a row of a primary-only table, as the store keeps it. */
export const ReplicaWrite = z.object({
  epoch: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  table: ReplicaTable,
  op: z.enum(["upsert", "delete"]),
  row: z.unknown(),
});
export type ReplicaWrite = z.infer<typeof ReplicaWrite>;

/** A file of the editable layer, relative to the home; absent content means it was removed. */
export const ReplicaFile = z.object({
  path: z.string().min(1),
  text: z.string().optional(),
  base64: z.string().optional(),
});
export type ReplicaFile = z.infer<typeof ReplicaFile>;

export const ReplicaSnapshot = z.object({
  epoch: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  tables: z.object({
    threads: z.array(z.unknown()),
    messages: z.array(z.unknown()),
    tasks: z.array(z.unknown()),
    workspaces: z.array(z.unknown()),
    kv: z.array(z.object({ ns: z.string(), key: z.string(), value: z.unknown(), updatedAt: z.number().int() })),
  }),
  files: z.array(ReplicaFile),
});
export type ReplicaSnapshot = z.infer<typeof ReplicaSnapshot>;

/** Requests over the link: the handshake and heartbeat upward, takeover downward, relay and replication. */
export const nodeLinkRequests = {
  /**
   * The secondary's first request on its sealed link: who it is, and the cluster it thinks it
   * is in. The answer says who is at the other end and whether it is the primary.
   */
  "node.hello": {
    params: z.object({
      protocolVersion: z.number().int().positive(),
      platformVersion: z.string(),
      nodeId: NodeId,
      /** The cluster's id, random, minted by its first primary; it names the cluster in beacons too. */
      cluster: ClusterId,
    }),
    result: z.object({
      nodeId: NodeId,
      cluster: ClusterId,
      role: NodeRole,
      epoch: z.number().int().nonnegative(),
      /** Where the primary is, when the answerer is not it. */
      primary: Endpoint.optional(),
      /** The answerer is the primary because the user chose it at `epoch`: only such a primary's higher epoch makes another step down. */
      chosen: z.boolean().optional(),
    }),
  },
  /** What the secondary holds; the primary answers with the registry and a link id. */
  "node.join": {
    params: z.object({
      node: Node,
      endpoints: z.array(Endpoint),
      /** The last epoch this node saw. */
      epoch: z.number().int().nonnegative(),
      backup: z.boolean(),
      rank: z.number().int().positive().optional(),
      sessions: z.array(Session),
      workspaces: z.array(Workspace),
      /** The node's open asks, so the primary's clients can answer them. */
      asks: z.array(Ask),
      /** The node's terminals, so the primary's clients see and open them; none from a node that keeps them its own. */
      terminals: z.array(Terminal).optional(),
    }),
    result: z.object({
      registry: z.array(NodeRecord),
      tz: z.string(),
      epoch: z.number().int().nonnegative(),
      primary: NodeId,
      /** Names this link: the gate's session key for the secondary's requests on the primary. */
      linkId: z.string().min(1),
    }),
  },
  "node.heartbeat": { params: z.object({ epoch: z.number().int().nonnegative() }), result: z.object({ epoch: z.number().int().nonnegative() }) },
  /** Primary → backup: take the primary role at this epoch; the sender steps down on success. */
  "node.takeover": { params: z.object({ epoch: z.number().int().nonnegative() }), result: Empty },
  /**
   * The first request on a link keyed from an invite's secret: the machine redeeming it says
   * which node it is, and the primary binds the grant to that id and answers the key every
   * link of it is keyed from after, the cluster, and how to reach the primary again.
   */
  "node.enroll": {
    params: z.object({
      node: z.object({ id: NodeId, name: z.string() }),
      /** The account the redeeming machine is signed in to, if any: a machine on the primary's own account joins as a full node. */
      account: z.string().optional(),
    }),
    result: z.object({
      grant: GrantId,
      key: Secret,
      cluster: ClusterId,
      primary: z.object({ id: NodeId, name: z.string() }),
      role: GrantRole,
      /** What the user called the machine in the invite: its name from here on, unless the user gave it one already. */
      name: z.string().min(1).optional(),
      expiresAt: Timestamp.optional(),
      /** The primary's LAN listener: the endpoints to try and the SHA-256 of its key. */
      lan: z.object({ endpoints: z.array(Endpoint), spki: z.string().min(1) }).optional(),
      /** The server relay, when the primary could grant it: its origin and this node's relay token. */
      relay: z.object({ url: z.string().min(1), token: z.string().min(1) }).optional(),
    }),
  },
  /** Primary → node: the grant's key changes to this one, from the next link on; the live link carries on. */
  "grant.rekey": { params: z.object({ key: Secret }), result: Empty },
  /** Secondary → primary: a client of the secondary said hello; the primary registers it and answers as it would on its own socket. */
  "relay.open": {
    params: z.object({
      peer: z.string().min(1),
      client: z.object({ kind: ClientKind, name: z.string().optional(), node: NodeId.optional(), audio: AudioCapabilities }),
      /** The grant the client said hello with, when it has one: the primary's own row of it decides its access. */
      grant: GrantRef.optional(),
      /** The client's access as the secondary holds it, for a grant the primary does not keep (a phone paired there). */
      access: Access.optional(),
      /** The origin the client reached the secondary on, for URLs it must be able to fetch. */
      origin: z.string(),
    }),
    result: clientRequests.hello.result,
  },
  /** Backup → primary: everything the replica needs, at the primary's current epoch and sequence. */
  "replicate.snapshot": { params: Empty, result: ReplicaSnapshot },
  /**
   * Secondary → primary: have `node`'s host accept a viewer's PIN — the secondary's own
   * viewer pairing with a desktop it cannot reach directly. Gated on the primary as the
   * secondary node, then forwarded to `node` (or served there when it is the primary).
   */
  "remote.pair": { params: z.object({ node: NodeId, pin: z.string(), name: z.string().optional() }), result: Empty },
  /**
   * Secondary → primary, on a relayed link: a data channel for the link itself, with the
   * fresh ephemeral key its records are sealed under (keyed from the node token). `attempt`
   * names this try in `direct.candidate`. `unsupported` from a primary without direct
   * connections: the link stays on the relay.
   */
  "direct.offer": {
    params: z.object({ attempt: z.string().min(1).max(64), sdp: z.string().min(1).max(65536), epk: z.string().min(1).max(256), curve: z.enum(["x25519", "p256"]).optional() }),
    result: z.object({ sdp: z.string(), epk: z.string() }),
  },
  /**
   * Secondary → primary: TURN credentials for the secondary's direct connections, minted on the
   * primary's account; what a node with no account of its own (a guest) opens data channels
   * with. `unavailable` when the primary's plan has none.
   */
  "direct.turn": { params: Empty, result: z.object({ iceServers: z.array(IceServer), expiresAt: Timestamp }) },
  /**
   * Either way: a ticket to `node`'s stream page for a viewer on another node, which fetches
   * the page through pipes. Gated on the host as the node that asked, with the viewer's
   * `name` in the ask. `stream` names the viewer's session there. `lowLatency` seeds the page
   * with the settings that keep the video a few frames behind, `sized` with the host's screen
   * size and the bitrate a path across the internet carries, which comes back as `video`, and
   * `hideCursor` hides the viewer's own pointer over the picture, which shows the desktop's
   * (an older host ignores all three).
   */
  "remote.ticket": {
    params: z.object({ node: NodeId, viewer: z.string().min(1), name: z.string().optional(), transport: StreamTransport, lowLatency: z.boolean().optional(), sized: z.boolean().optional(), hideCursor: z.boolean().optional() }),
    result: z.object({ path: z.string(), stream: z.string(), video: DisplaySize.optional() }),
  },
  /**
   * Either way: a pipe to `node`'s stream proxy, named `pipe` by the side that opens it; the
   * primary joins a pipe from one link to one on another under ids of its own. The answer is
   * the window the opener may send before an ack.
   */
  "remote.pipe.open": { params: z.object({ node: NodeId, pipe: PipeId }), result: z.object({ window: z.number().int().positive() }) },
  /** Either way: a stream `remote.ticket` opened on `node` for `viewer` ended (its window closed, or its client went), and its session goes. */
  "remote.close": { params: z.object({ node: NodeId, stream: z.string().min(1).max(64), viewer: z.string().min(1).max(128) }), result: Empty },
} as const;

export type NodeLinkRequestName = keyof typeof nodeLinkRequests;

/** Frames that flow as notifications on the link. */
export const nodeLinkFrames = {
  /** A relayed client's frame, verbatim, in either direction. */
  relay: z.object({ peer: z.string().min(1), frame: z.string() }),
  "relay.close": z.object({ peer: z.string().min(1) }),
  "registry.update": z.object({ nodes: z.array(NodeRecord) }),
  /** The sender is leaving: stopping, stepping down in favour of `primary`, or (a node) leaving the cluster, its grant given up. */
  "node.leave": z.object({ reason: LinkLeaveReason, primary: NodeId.optional() }),
  "replicate.write": ReplicaWrite,
  "replicate.file": ReplicaFile,
  /** A candidate of the link's data channel attempt `attempt`, either way; `null` ends one side's. */
  "direct.candidate": z.object({ attempt: z.string().min(1).max(64), candidate: IceCandidate.nullable() }),
  /** A pipe's bytes (base64), window and end, either way. */
  "pipe.data": z.object({ pipe: PipeId, data: z.string().max(90_000) }),
  "pipe.ack": z.object({ pipe: PipeId, bytes: z.number().int().positive() }),
  "pipe.close": z.object({ pipe: PipeId, reason: z.string().max(200).optional() }),
  /** Node → primary: output of a terminal of the node's that `client`, a client of the primary's, opened. */
  "terminal.output": clientNotifications["terminal.output"].extend({ client: ClientId }),
  /** Primary → node: keys `client` typed into a terminal of the node's it opened to type into. */
  "terminal.input": clientSignals["terminal.input"].extend({ client: ClientId }),
  /** Primary → node: the size `client`, driving a terminal of the node's, now has. */
  "terminal.resize": clientSignals["terminal.resize"].extend({ client: ClientId }),
  /** Primary → node: `client` went, and every terminal of the node's it had open goes with it. */
  "terminal.drop": z.object({ client: ClientId }),
  // Below the JSON-RPC of the link, between the two ends of a link whose transport can move
  // from the relay to a data channel and back; never seen by the link's methods.
  /** The sender's last frame on the relay: its next ones come over the data channel. */
  "link.switch": z.object({}),
  /** The data channel failed: the sender goes back to the relay, having taken `received` of the other side's frames. */
  "link.fallback": z.object({ received: z.number().int().nonnegative() }),
  /** A frame sent on the data channel and not acknowledged, sent again on the relay: `n` its number, `f` the frame. */
  "link.replay": z.object({ n: z.number().int().positive(), f: z.string() }),
  /** Frames up to `n` of the other side's arrived over the data channel; also the channel's heartbeat. */
  "link.ack": z.object({ n: z.number().int().nonnegative() }),
} as const;

export type NodeLinkFrameName = keyof typeof nodeLinkFrames;

/**
 * The client notifications a secondary sends up, as the primary reads them: a session's and
 * a workspace's row whole, with the summary and tags a client never gets, since the brain
 * reads the rows the primary mirrors.
 */
export const nodeLinkUpward = { ...clientNotifications, "session.state": Session, "workspace.state": Workspace } as const;

/**
 * The close code a link gets for a grant that is unknown, pending, ended or not this
 * node's, a foreign cluster or a protocol it cannot speak; with the reason `revoked`, its
 * grant is gone and the node forgets the cluster.
 */
export const NODE_LINK_REFUSED = 4401;
/** The reason a link closes with when its grant was revoked or ended: the node forgets its membership. */
export const NODE_LINK_REVOKED = "revoked";
