// The tracker's client methods: the asks it follows listed, dismissed or set by hand
// (`tracked.*`), and its settings read and changed (`tracker.*`): `sessions:read` to read,
// `sessions:write` to change, the changes refused to limited access by the filter tables. The
// tracker is the primary's: a client of a secondary is the primary's client, and its requests
// are answered there. Clients alone: the brain neither reads nor changes it.

import { RpcError } from "@cophyla/protocol";
import type { MethodTable } from "../api/methods.ts";
import type { Tracker } from "./index.ts";

export function trackerMethods(deps: { tracker: () => Tracker | undefined }): MethodTable {
  const get = (): Tracker => {
    const t = deps.tracker();
    if (!t) throw new RpcError("unavailable", "the tracker is kept by the primary");
    return t;
  };
  return {
    "tracked.list": { handler: (p) => ({ tracked: get().list(p.session) }) },
    "tracked.dismiss": {
      handler: (p) => {
        get().dismiss(p.ids);
        return {};
      },
    },
    "tracked.mark": {
      target: (p) => p.id,
      handler: (p) => ({ tracked: get().mark(p.id, p.status) }),
    },
    "tracker.get": { handler: () => get().state() },
    "tracker.set": {
      handler: (p) => get().set({ ...(p.on !== undefined ? { on: p.on } : {}), ...(p.session ? { session: p.session } : {}), ...(p.profile !== undefined ? { profile: p.profile } : {}) }),
    },
  };
}
