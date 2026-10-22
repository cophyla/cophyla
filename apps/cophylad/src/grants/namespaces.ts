// The kv namespaces the grants live in. `grants` is minted on the primary and replicated with
// the rest of its kv, so a backup the user makes the primary knows every phone and node;
// `grants.local` is minted on any other node (a phone paired on a secondary) and never leaves
// it; `cluster` holds the cluster's id. They are the daemon's own: the brain's store methods refuse them,
// and so they refuse `controllers`, where the paired phones lived before grants,
// `listeners`, whose fires the platform counts (the brain goes through `listener.*`),
// `voice.origins`, the device each user message came from, which no backup carries,
// `assistant`, the user's choice of what the chat runs on, and `sessions.scope`, which of the
// user's sessions the node connects to.

export const GRANTS_NS = "grants";
export const LOCAL_GRANTS_NS = "grants.local";
export const CLUSTER_NS = "cluster";
/** Where the paired phones lived before grants; migrated in place. */
export const LEGACY_CONTROLLERS_NS = "controllers";
/** The brain's listeners, one key each (see `listeners/`). */
export const LISTENERS_NS = "listeners";

/** Where each user message was made, and whether what it brings back was hushed (see `voice/delivery.ts`). */
export const VOICE_ORIGINS_NS = "voice.origins";

/** Which harness and account the chat's own session runs on, as the user chose (see `assistant/`). */
export const ASSISTANT_NS = "assistant";

/**
 * The connections to other users' terminals (see `connections/`): their keys, relay tokens and
 * the messages waiting either way. Replicated to the backups; never the brain's, never in the
 * cloud backup.
 */
export const CONNECTIONS_KV_NS = "connections";

/** Which of the user's own sessions the node connects to (see `sessions/scope.ts`): the user's word alone. */
export const SESSION_SCOPE_NS = "sessions.scope";

/**
 * The group chats (see `groups/`): each group's row, and its posts under `groups.posts`, one key
 * per post. Replicated to the backups; never the brain's, never in the cloud backup, since a
 * group holds other people's words once teammates are in it.
 */
export const GROUPS_KV_NS = "groups";
export const GROUP_POSTS_KV_NS = "groups.posts";
/** Each group's log of what this side's people and agents did, which teammates catch up from. */
export const GROUP_LOG_KV_NS = "groups.log";

/** The agents in focus and what waits for each (see `agentmsg/focus.ts`). */
export const FOCUS_KV_NS = "focus";

/** The teammates (see `teammates/`): their keys, relay tokens, what each side shares, and messages waiting. */
export const TEAMMATES_KV_NS = "teammates";

/** The namespaces no store request of the brain may read or write. */
export const RESERVED_KV_NS: readonly string[] = [
  GRANTS_NS,
  LOCAL_GRANTS_NS,
  CLUSTER_NS,
  LEGACY_CONTROLLERS_NS,
  LISTENERS_NS,
  VOICE_ORIGINS_NS,
  ASSISTANT_NS,
  CONNECTIONS_KV_NS,
  SESSION_SCOPE_NS,
  GROUPS_KV_NS,
  GROUP_POSTS_KV_NS,
  GROUP_LOG_KV_NS,
  FOCUS_KV_NS,
  TEAMMATES_KV_NS,
];
