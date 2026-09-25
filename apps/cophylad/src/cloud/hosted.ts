// What the hosted capabilities share: the check that the account may use them (signed
// in, on a plan that includes the kind, the link up), the link they speak over and the local
// counters they add to.

import type { RpcError } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import type { ServerLink } from "./link.ts";
import type { UsageCounters } from "./usage.ts";

export type HostedKind = "llm" | "voice" | "compute" | "relay" | "push" | "backup" | "direct";

export interface HostedDeps {
  /** The reason the kind cannot be served now, as the error to raise; undefined when it can. */
  allowed: (kind: HostedKind) => RpcError | undefined;
  link: ServerLink;
  usage: UsageCounters;
  log: Logger;
}
