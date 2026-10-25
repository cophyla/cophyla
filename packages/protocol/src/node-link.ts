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
import { Access, AgentListing, AgentMode, AgentRef, AudioCapabilities, Ask, ClientKind, ConnectionListing, Focus, GrantRole, GroupPhotoType, IceServer, MachineListing, Node, NodeRole, Session, TeammateListing, Terminal, Transfer, TransferReason, Workspace } from "./entities.ts";
import { AgentMessageId, AskId, ClientId, ConnectionId, GrantId, GrantRef, GroupId, GroupPhotoId, NodeId, SessionId, TeammateId, Timestamp } from "./ids.ts";
import { clientNotifications, clientRequests, clientSignals, DisplaySize, IceCandidate, PipeId, StreamTransport } from "./client.ts";
import { Secret } from "./invite.ts";
import { FilePiece, FileTreePage, GroupPhotoRef, PeerSource, PhotoPiece, TreeEntry } from "./peer-files.ts";

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
      /** The transfers the node receives, running and ended, so the primary's clients see them. */
      transfers: z.array(Transfer).optional(),
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
      /** When that grant ends, and whether it is a shared computer's session: what the client mints on the primary outlives neither, and a session mints nothing. */
      ends: Timestamp.optional(),
      session: z.boolean().optional(),
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
  /**
   * Either way, carried on by the primary: what `path` on `node` holds, for a transfer to
   * pull. A file is one entry (`rel` ""); a folder is its folders and files under it, each
   * before what is in it, by its path there (`/` between the names), a link never followed
   * (`skipped` counts them, and anything that is neither). `total` is the bytes of its files,
   * `files` how many, `count` how many entries in all; a long listing comes a page at a time,
   * `next` the entry the next page starts `from`. A path outside the folders a confined node
   * shares is refused.
   */
  "files.tree": {
    params: z.object({ node: NodeId, path: z.string().min(1).max(4096), from: z.number().int().nonnegative().optional() }),
    result: z.object({
      kind: z.enum(["file", "folder"]),
      name: z.string().min(1),
      entries: z.array(TreeEntry),
      total: z.number().int().nonnegative(),
      files: z.number().int().nonnegative(),
      count: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      next: z.number().int().positive().optional(),
    }),
  },
  /**
   * Either way, carried on by the primary as `remote.pipe.open` is: a pipe of a file's bytes
   * from `node`, read from `path` (or `rel` under it, for a file of a folder) from `at` bytes
   * in. The answer is the window and the file as it is now, its size and when it last changed,
   * so a resumed transfer can tell it changed. Its bytes from `at` to `size` follow, and the
   * pipe stays open until the receiver closes it.
   */
  "files.pipe.open": {
    params: z.object({ node: NodeId, pipe: PipeId, path: z.string().min(1).max(4096), rel: z.string().max(4096).optional(), at: z.number().int().nonnegative() }),
    result: z.object({ window: z.number().int().positive(), size: z.number().int().nonnegative(), mtimeMs: z.number().int().nonnegative() }),
  },
  /**
   * Either way, carried on by the primary as `files.tree` is: a piece of a file on `node`
   * (`path`, or `rel` under it), its bytes from `at`, and the file as it is now. The primary
   * reads one of its machines' files this way for another person's Cophyla, which reads only a
   * file this user let it read. Gated and confined as `files.pipe.open`.
   */
  "files.read": {
    params: z.object({ node: NodeId, path: z.string().min(1).max(4096), rel: z.string().max(4096).optional(), at: z.number().int().nonnegative() }),
    result: FilePiece,
  },
  /**
   * Either way, carried on by the primary: the image at `path` on `node` as a photo of a group
   * chat's post, a piece at a time from `at`. JPEG, PNG, WebP or GIF within the photo's limits
   * goes as it is; anything else, or bigger, is scaled down to a JPEG by the computer's own
   * codecs, or refused saying why when it has none. The first piece makes it, the rest read
   * what was made.
   */
  "files.photo": {
    params: z.object({ node: NodeId, path: z.string().min(1).max(4096), at: z.number().int().nonnegative().optional() }),
    result: PhotoPiece.extend({ width: z.number().int().positive(), height: z.number().int().positive(), name: z.string().min(1).max(255) }),
  },
  /**
   * Secondary → primary: what a file of another person's holds, a page at a time, for a
   * transfer the primary started on the secondary (`transfer.start` with `peer`). Refused for
   * any other file.
   */
  "peer.file.tree": { params: z.object({ peer: PeerSource, from: z.number().int().nonnegative().optional() }), result: FileTreePage },
  /** Secondary → primary: a piece of a file of another person's, for such a transfer. */
  "peer.file.read": { params: z.object({ peer: PeerSource, rel: z.string().max(4096).optional(), at: z.number().int().nonnegative() }), result: FilePiece },
  /**
   * Secondary → primary: a photo of a group `caller`, a live session of the secondary's, is
   * in, a piece at a time, for `read_group`'s answer.
   */
  "group.photo": { params: GroupPhotoRef.extend({ caller: SessionId }), result: PhotoPiece },
  /**
   * Secondary → primary: `caller`, a live session of the secondary's, sends `path` (on its own
   * machine) to `to`, an agent or a machine, with the `send_file` tool. Transfers start where
   * they land, from the primary; the answer is the text the model reads. `reason` is the
   * tool's, as the secondary kept it.
   */
  "file.send": {
    params: z.object({ caller: SessionId, mode: AgentMode, path: z.string().min(1).max(4096), to: z.string().min(1).max(200), dir: z.string().min(1).max(4096).optional(), reason: TransferReason.optional() }),
    result: z.object({ text: z.string(), isError: z.boolean().optional() }),
  },
  /**
   * Secondary → primary, agent messaging: the agent sessions `caller`, a live session of the
   * secondary's, may message, every node's, with the aliases the primary gives them. Refused
   * for a session the primary does not hold as the secondary's.
   */
  "agent.list": {
    params: z.object({ caller: SessionId }),
    result: z.object({ agents: z.array(AgentListing), connections: z.array(ConnectionListing).optional(), machines: z.array(MachineListing).optional(), teammates: z.array(TeammateListing).optional() }),
  },
  /**
   * Secondary → primary, agent messaging: `caller`'s message to the agent `to` names (an
   * alias, `alias@machine` or a session id), `mode` its permission class as the secondary
   * read it. Answered at once, never held: `sent`, `held` in the receiving session's own
   * terminal, or `pending` on the user's approval (`ask`), and delivered once it is given. A
   * refusal is an error that says why.
   */
  "agent.send": {
    /** `pastFocus`: the caller leads the session, and its words go in at once even while the session is in focus; an older primary holds them. */
    params: z.object({ caller: SessionId, mode: AgentMode, to: z.string().min(1).max(200), text: z.string().min(1), replyTo: AgentMessageId.optional(), pastFocus: z.boolean().optional() }),
    result: z.object({
      /**
       * `queued`: kept until the other user's Cophyla is reached; `waiting`: there, kept until an
       * agent runs in its terminal; `focus`: held until the receiving agent comes out of focus.
       */
      status: z.enum(["sent", "held", "pending", "queued", "waiting", "focus"]),
      id: AgentMessageId,
      /** One of the user's sessions; or, for a message to another user's agent, `peer`: a connection's or a teammate's. */
      to: AgentRef.optional(),
      peer: z.object({ connection: ConnectionId.optional(), teammate: TeammateId.optional(), alias: z.string() }).optional(),
      ask: AskId.optional(),
      /** The receiving agent's focus, while it holds the message. */
      focus: Focus.optional(),
      /** It went as the user's own words: the caller leads the session. */
      asUser: z.literal(true).optional(),
      /** The caller leads the session, but it went as another agent's: why. */
      fallback: z.string().optional(),
    }),
  },
  /**
   * Secondary → primary: `caller`, a live session of the secondary's, answers an ask as the
   * user (`answer_ask`). The primary refuses it unless the caller leads the ask's session and
   * the ask is that session's own, open, and one the user answers; the answer is the text the
   * model reads.
   */
  "agent.answer": {
    params: z.object({ caller: SessionId, ask: AskId, option: z.string().min(1).max(200), options: z.array(z.string().min(1).max(200)).max(32).optional(), text: z.string().max(16_000).optional() }),
    result: z.object({ text: z.string(), isError: z.boolean().optional() }),
  },
  /**
   * Secondary → primary: one of the connection tools (`create_invite`, `accept_invite`,
   * `end_connection`) called by `caller`, a live session of the secondary's. Connections live
   * on the primary; the answer is the text the model reads.
   */
  "connection.tool": {
    params: z.object({ caller: SessionId, mode: AgentMode, tool: z.enum(["create_invite", "accept_invite", "end_connection"]), args: z.record(z.string(), z.unknown()) }),
    result: z.object({ text: z.string(), isError: z.boolean().optional() }),
  },
  /**
   * Secondary → primary: one of the group chat tools (`read_group`, `post_group`, `ack_post`,
   * `get_file`) or `focus`, called by `caller`, a live session of the secondary's. Groups and
   * focus live on the primary; the answer is the text the model reads, and the photos it is
   * shown, which the secondary reads with `group.photo`.
   */
  "group.tool": {
    params: z.object({ caller: SessionId, mode: AgentMode, tool: z.enum(["read_group", "post_group", "ack_post", "get_file", "focus"]), args: z.record(z.string(), z.unknown()) }),
    result: z.object({ text: z.string(), isError: z.boolean().optional(), photos: z.array(z.object({ group: GroupId, photo: GroupPhotoId, type: GroupPhotoType })).max(8).optional() }),
  },
  /**
   * What a secondary's session has not read in its group chats and was not told yet, for the
   * prompt it is given or a tool's answer: one line, said once per batch of posts (asking marks
   * it told). None when there is nothing new, the session is in focus or told of every post.
   */
  "group.note": {
    params: z.object({ caller: SessionId }),
    result: z.object({ text: z.string().max(4000).optional() }),
  },
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
  /** A pipe's bytes (base64), window and end, either way: a stream's 48 KiB at a time, a file's 128 KiB. */
  "pipe.data": z.object({ pipe: PipeId, data: z.string().max(180_000) }),
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
