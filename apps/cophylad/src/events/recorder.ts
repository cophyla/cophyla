// Custom events into the store's `events` table, for `event.history`, and `node.pressure`
// with them: the other built-in events already live in the tables they describe (sessions,
// tasks, threads, the chat), a threshold crossing lives nowhere else. The table is pruned to
// the newest `keep` rows now and then.

import type { Store } from "../store/index.ts";
import type { EventStream } from "./stream.ts";

export const EVENT_HISTORY_KEEP = 10000;
const PRUNE_EVERY = 100;

export function recordCustomEvents(stream: EventStream, store: Store, node: string, opts: { keep?: number } = {}): () => void {
  const keep = opts.keep ?? EVENT_HISTORY_KEEP;
  let inserted = 0;
  return stream.on((e) => {
    if (e.name === "node.pressure") store.events.insert({ node: e.params.node, name: e.name, at: e.params.at, payload: { resource: e.params.resource, level: e.params.level } });
    else if (e.name === "event.custom") store.events.insert({ node, name: e.params.name, at: e.params.at, payload: e.params.payload });
    else return;
    if (++inserted % PRUNE_EVERY === 0) store.events.prune(keep);
  });
}
