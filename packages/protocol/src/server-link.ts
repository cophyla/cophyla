// The server link: one outbound WebSocket from each daemon, multiplexed after
// authentication. JSON-RPC, like the other two. Releases never travel on it. The hosted
// capabilities (the model, transcription, speech) are requests on it too, so the daemon
// holds one socket to the server and nothing else. The relay, the registry and push ride
// it as well: the relay carries ciphertext the server routes by `peer` and reads nothing
// else, the registry arbitrates the primary role across networks with a lease, and push
// hands an ask to a phone that has nothing open. The backup carries ciphertext too: the
// server keeps objects it cannot read under names it cannot resolve. See architecture.md,
// "Server link".

import { z } from "zod";
import { LlmComplete, LlmResult, capabilityNotices, capabilityRequests } from "./capability.ts";
import { DirectReport, IceServer, Node, PushPlatform, Usage } from "./entities.ts";
import { ControllerId, GrantRef, NodeId, Timestamp } from "./ids.ts";
import { RpcId } from "./rpc.ts";

const Empty = z.object({});

/**
 * What a backup holds: the replica set, one kind per store table or editable directory, so
 * a restore is a backup node's snapshot applied to a fresh install. `chat` is the threads
 * and their messages; `state` is the brain's kv minus the node-local namespaces.
 */
export const BackupKind = z.enum(["memory", "prompts", "chat", "tasks", "workspaces", "state", "tools", "hooks", "views"]);
export type BackupKind = z.infer<typeof BackupKind>;

/**
 * The public part of a backup's key: how the passphrase becomes the key, and the key's id,
 * which a fresh install derives again and compares before it pulls anything. The server
 * keeps it beside the objects and reads nothing of it but `node`, the owner.
 */
export const BackupHeader = z.object({
  v: z.literal(1),
  kdf: z.object({
    name: z.literal("scrypt"),
    salt: z.string().describe("16 bytes, base64"),
    n: z.number().int().positive(),
    r: z.number().int().positive(),
    p: z.number().int().positive(),
  }),
  keyId: z.string().describe("8 bytes, base64url"),
  node: NodeId,
});
export type BackupHeader = z.infer<typeof BackupHeader>;

/** One backed-up object as the server lists it: a name and a size, nothing it can read. */
export const BackupEntry = z.object({ kind: BackupKind, key: z.string(), version: z.number().int(), size: z.number().int() });
export type BackupEntry = z.infer<typeof BackupEntry>;

/** The key-agreement curve of a relay tunnel; X25519 unless a platform lacks it. */
export const RelayCurve = z.enum(["x25519", "p256"]);
export type RelayCurve = z.infer<typeof RelayCurve>;

/** Which kind of peer a relay tunnel joins to a node: a paired phone, a node linking to its primary, or a phone pairing through the account. */
export const RelayPeerKind = z.enum(["controller", "node", "pair"]);
export type RelayPeerKind = z.infer<typeof RelayPeerKind>;

/** An ask as it travels in a push: the parts the phone shows and the buttons it offers. */
export const PushAsk = z.object({
  id: z.string(),
  node: NodeId,
  title: z.string(),
  detail: z.string().optional(),
  options: z.array(z.object({ id: z.string(), label: z.string() })),
  multiple: z.boolean().optional(),
  expiresAt: Timestamp.optional(),
});
export type PushAsk = z.infer<typeof PushAsk>;

/** Requests the daemon sends to the server. */
export const serverLinkRequests = {
  auth: {
    params: z.object({ token: z.string(), node: NodeId }),
    result: z.object({ subject: z.string(), expiresAt: Timestamp }),
  },
  /** A fresh entitlement token; `usage` is the account's meter for the period, when the plan has one. */
  "entitlement.refresh": { params: Empty, result: z.object({ token: z.string(), usage: Usage.optional() }) },
  /** The hosted model: the same request the brain makes of the daemon, tier resolved by the server. Chunks arrive as `llm.delta` frames. */
  "llm.complete": { params: LlmComplete, result: LlmResult },
  /** Hosted transcription of one utterance: int16 samples at 16 kHz, mono, base64. */
  "stt.transcribe": {
    params: z.object({ audio: z.string().describe("int16 16 kHz mono, base64"), language: z.string().optional() }),
    result: z.object({ text: z.string() }),
  },
  /** Hosted speech: the audio arrives as `tts.delta` frames carrying this request's id; the result closes the stream. */
  "tts.speak": { params: z.object({ text: z.string(), voice: z.string().optional() }), result: Empty },
  /** Abort an `llm.complete` or `tts.speak` in flight by its request id. */
  cancel: { params: z.object({ id: RpcId }), result: Empty },
  /**
   * Every signed-in daemon at each link-up, with itself at its current role and epoch. A
   * primary's register is arbitrated like a claim: the answer names the holder when it is
   * another node, and the daemon steps down to it.
   */
  "registry.register": {
    params: z.object({ node: Node, epoch: z.number().int().nonnegative().optional() }),
    result: z.object({ primary: NodeId.optional(), epoch: z.number().int().nonnegative().optional() }),
  },
  /** The primary's lease renewal; an answer naming another node means the lease went elsewhere. */
  "registry.heartbeat": {
    params: z.object({ node: NodeId }),
    result: z.object({ primary: NodeId.optional(), epoch: z.number().int().nonnegative().optional() }),
  },
  /** A node asking for the primary role at `epoch`; refused, the answer names the holder. */
  "registry.claim": {
    params: z.object({ node: NodeId, epoch: z.number().int().nonnegative().optional() }),
    result: z.object({ granted: z.boolean(), primary: NodeId.optional(), epoch: z.number().int().nonnegative().optional() }),
  },
  /**
   * The node that keeps a grant mints its relay token; the peer presents it at `/ws/relay`. A
   * phone's (`controller`) tunnels to the node that granted it; a node's (`node`) to the
   * account's primary, wherever that is now. `expiresAt` ends the token with the grant.
   */
  "relay.grant": {
    params: z.object({ peer: GrantRef, kind: z.enum(["controller", "node"]).optional(), name: z.string().optional(), expiresAt: Timestamp.optional() }),
    result: z.object({ token: z.string() }),
  },
  "relay.revoke": { params: z.object({ peer: GrantRef }), result: Empty },
  /** The account's backup, if it has one: its header and what it holds. */
  "backup.status": {
    params: Empty,
    result: z.object({
      header: BackupHeader.optional(),
      objects: z.number().int().nonnegative().optional(),
      bytes: z.number().int().nonnegative().optional(),
      updatedAt: Timestamp.optional(),
    }),
  },
  /**
   * This node takes the backup: a header the server has none for, or the same `keyId` as
   * the one it keeps (a reinstall or a promoted node carrying on). A different `keyId` is
   * `conflict` unless `replace`, which drops every object first.
   */
  "backup.begin": { params: z.object({ header: BackupHeader, replace: z.boolean().optional() }), result: Empty },
  /**
   * One object. `version` counts up per key; the server keeps a put at or above the stored
   * version (a retry) and refuses a lower one, or one from a node other than the owner, with
   * `conflict`; past the plan's bytes it is `quota_exceeded`.
   */
  "backup.put": {
    params: z.object({ kind: BackupKind, key: z.string(), ciphertext: z.string().describe("base64"), version: z.number().int() }),
    result: Empty,
  },
  "backup.delete": { params: z.object({ kind: BackupKind, key: z.string() }), result: Empty },
  "backup.list": {
    params: z.object({ kind: BackupKind.optional() }),
    result: z.object({ entries: z.array(BackupEntry) }),
  },
  "backup.get": {
    params: z.object({ kind: BackupKind, key: z.string() }),
    result: z.object({ ciphertext: z.string(), version: z.number().int() }),
  },
  /** A kind's objects in pages: keys after `after`, at most `limit` and about a megabyte; `next` is the last key of a page that is not the end. */
  "backup.pull": {
    params: z.object({ kind: BackupKind, after: z.string().optional(), limit: z.number().int().positive().optional() }),
    result: z.object({
      entries: z.array(z.object({ key: z.string(), version: z.number().int(), ciphertext: z.string() })),
      next: z.string().optional(),
    }),
  },
  /** The account's backup, header and objects, gone. */
  "backup.clear": { params: Empty, result: Empty },
  /** Hosted embeddings for the recall index: the capability protocol's own request, with `dim` so the daemon can size its index. */
  "compute.embed": {
    params: capabilityRequests["compute.embed"].params,
    result: capabilityRequests["compute.embed"].result.extend({ dim: z.number().int().positive().optional() }),
  },
  /**
   * TURN credentials for direct connections, from the TURN service the server holds the key
   * to: the servers with a username and credential good for `ttl` seconds (the server's
   * default and cap without it). Needs a plan with direct connections; counted as
   * `turn_credentials`, and revoked when the plan, the sign-in or the token goes.
   */
  "turn.credentials": {
    params: z.object({ ttl: z.number().int().positive().max(172_800).optional() }),
    result: z.object({ iceServers: z.array(IceServer), expiresAt: Timestamp }),
  },
  /** A day's anonymous path counts for direct connections: how often each path won, nothing that names a peer. */
  "direct.report": { params: z.object({ report: DirectReport }), result: Empty },
  /** A phone registered a push device with the node; the server keeps the token by peer. */
  "push.register": { params: z.object({ peer: ControllerId, platform: PushPlatform, token: z.string() }), result: Empty },
  "push.unregister": { params: z.object({ peer: ControllerId }), result: Empty },
  /**
   * A push to a peer's device. `kind: ask` carries the ask for the phone to show with its
   * buttons; `dismiss` withdraws it once answered elsewhere. `title` and `body` are the
   * plain notification for a phone that cannot build one.
   */
  "push.send": {
    params: z.object({
      title: z.string(),
      body: z.string(),
      device: z.string().optional(),
      peer: ControllerId.optional(),
      kind: z.enum(["ask", "dismiss"]).optional(),
      ask: PushAsk.optional(),
    }),
    result: Empty,
  },
} as const;

export type ServerLinkRequestName = keyof typeof serverLinkRequests;

/** Requests the server sends to a daemon: the far end of a relay tunnel being opened. */
export const serverLinkInbound = {
  /**
   * A peer wants a tunnel to this node; the daemon derives the keys from `epk` and answers its
   * own. For `kind: pair`, `subject` and `login` name the account the phone signed in as.
   */
  "relay.open": {
    params: z.object({ peer: z.string().min(1), kind: RelayPeerKind, epk: z.string(), curve: RelayCurve.optional(), subject: z.string().optional(), login: z.string().optional() }),
    result: z.object({ epk: z.string() }),
  },
} as const;

export type ServerLinkInboundName = keyof typeof serverLinkInbound;

/** Frames that flow in both directions as notifications. */
export const serverLinkFrames = {
  /** A peer's frame, encrypted end to end; the server routes by `peer` and reads nothing else. */
  relay: z.object({ peer: z.string(), frame: z.string().describe("ciphertext, base64") }),
  /** The tunnel to `peer` is over: the far end left, was revoked, or the server had to drop it. */
  "relay.close": z.object({ peer: z.string(), reason: z.string().optional() }),
  "registry.primary": z.object({ primary: NodeId, epoch: z.number().int().nonnegative().optional() }),
  "entitlement.updated": z.object({ token: z.string() }),
  /** A chunk of a hosted `llm.complete` in flight: the capability protocol's own notice. */
  "llm.delta": capabilityNotices["llm.delta"],
  /** A chunk of a hosted `tts.speak` in flight: int16 samples at 24 kHz, mono, base64. */
  "tts.delta": z.object({ id: RpcId, chunk: z.string().describe("int16 24 kHz mono, base64") }),
} as const;

export type ServerLinkFrameName = keyof typeof serverLinkFrames;

/**
 * The device-code login, over plain HTTP because it happens before there is a link. The
 * daemon asks for a code, the user types it on the server's page and signs in there, the
 * daemon polls until the code is granted. Status codes carry the poll's answer: 200 with the
 * token, 202 while pending, 410 once the code expired or was denied. Our own daemon is the
 * only client, so the shapes are ours rather than RFC 8628's.
 */
export const serverAuthHttp = {
  /** `POST /auth/device`. `node` names the daemon on the account page. */
  "auth.device": {
    params: z.object({ node: z.string().optional() }),
    result: z.object({
      deviceCode: z.string(),
      userCode: z.string(),
      verificationUrl: z.string(),
      expiresAt: Timestamp,
      /** Milliseconds between polls of `auth.token`. */
      intervalMs: z.number().int().positive(),
    }),
  },
  /** `POST /auth/token`, polled. Granted once: the account token, its subject and when it expires. */
  "auth.token": {
    params: z.object({ deviceCode: z.string() }),
    result: z.object({ token: z.string(), subject: z.string(), expiresAt: Timestamp }),
  },
  /** `POST /auth/revoke` with the account token as bearer: the token is dead and its links closed. */
  "auth.revoke": { params: Empty, result: Empty },
} as const;

export type ServerAuthHttpName = keyof typeof serverAuthHttp;
