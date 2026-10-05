// @cophyla/protocol: the entities and the protocols, defined once and shared by every
// process. Schemas are Zod; JSON Schema is emitted by scripts/emit-json-schema.ts.

export * from "./ids.ts";
export * from "./rpc.ts";
export * from "./entities.ts";
export * from "./capability.ts";
export * from "./client.ts";
export * from "./hooks.ts";
export * from "./server-link.ts";
export * from "./relay.ts";
export * from "./node-link.ts";
export * from "./actions.ts";
export * from "./scopes.ts";
export * from "./access.ts";
export * from "./invite.ts";
export * from "./quotes.ts";
export * from "./release.ts";
export * from "./audio.ts";
export * from "./docframe.ts";

import { entities } from "./entities.ts";
import { brainRequests, CapabilityHello, capabilityEvents, capabilityNotices, capabilityRequests, capabilitySignals } from "./capability.ts";
import { clientNotifications, clientRequests, clientSignals } from "./client.ts";
import { hooks } from "./hooks.ts";
import { serverAuthHttp, serverLinkFrames, serverLinkInbound, serverLinkRequests } from "./server-link.ts";
import { relayPeerFrames, relayPeerRequests } from "./relay.ts";
import { nodeLinkFrames, nodeLinkRequests } from "./node-link.ts";
import { InviteBody } from "./invite.ts";
import { RpcFailure, RpcNotification, RpcRequest, RpcSuccess } from "./rpc.ts";

/** Everything with a schema, grouped the way the fixtures are. */
export const registry = {
  rpc: { request: RpcRequest, notification: RpcNotification, success: RpcSuccess, failure: RpcFailure },
  entities,
  capability: {
    hello: CapabilityHello,
    events: capabilityEvents,
    requests: capabilityRequests,
    notices: capabilityNotices,
    signals: capabilitySignals,
    /** What the platform asks of the brain, for the session the chat runs in. */
    brain: brainRequests,
  },
  client: {
    requests: clientRequests,
    signals: clientSignals,
    notifications: clientNotifications,
  },
  hooks,
  serverLink: { requests: serverLinkRequests, inbound: serverLinkInbound, frames: serverLinkFrames, auth: serverAuthHttp },
  relayPeer: { requests: relayPeerRequests, frames: relayPeerFrames },
  nodeLink: { requests: nodeLinkRequests, frames: nodeLinkFrames },
  /** What an invite's text and link carry; its codec has its own tests. */
  invite: { body: InviteBody },
} as const;
