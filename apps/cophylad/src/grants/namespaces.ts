// The kv namespaces the grants live in. `grants` is minted on the primary and replicated with
// the rest of its kv, so a backup that takes over knows every phone and node; `grants.local`
// is minted on any other node (a phone paired on a secondary) and never leaves it; `cluster`
// holds the cluster's id. They are the daemon's own: the brain's store methods refuse them,
// and so they refuse `controllers`, where the paired phones lived before grants.

export const GRANTS_NS = "grants";
export const LOCAL_GRANTS_NS = "grants.local";
export const CLUSTER_NS = "cluster";
/** Where the paired phones lived before grants; migrated in place. */
export const LEGACY_CONTROLLERS_NS = "controllers";

/** The namespaces no store request of the brain may read or write. */
export const RESERVED_KV_NS: readonly string[] = [GRANTS_NS, LOCAL_GRANTS_NS, CLUSTER_NS, LEGACY_CONTROLLERS_NS];
