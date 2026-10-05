// The kv namespaces the grants live in. `grants` is minted on the primary and replicated with
// the rest of its kv, so a backup the user makes the primary knows every phone and node;
// `grants.local` is minted on any other node (a phone paired on a secondary) and never leaves
// it; `cluster` holds the cluster's id. They are the daemon's own: the brain's store methods refuse them,
// and so they refuse `controllers`, where the paired phones lived before grants,
// `listeners`, whose fires the platform counts (the brain goes through `listener.*`),
// `voice.origins`, the device each user message came from, which no backup carries, and
// `assistant`, the user's choice of what the chat runs on.

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

/** The namespaces no store request of the brain may read or write. */
export const RESERVED_KV_NS: readonly string[] = [GRANTS_NS, LOCAL_GRANTS_NS, CLUSTER_NS, LEGACY_CONTROLLERS_NS, LISTENERS_NS, VOICE_ORIGINS_NS, ASSISTANT_NS];
