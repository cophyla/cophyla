// What the brain hears: every event on the daemon's event stream, stamped with an `eventId`,
// the correlation of the requests it provokes. The mapping from bus events to capability
// events lives in the stream, which the hooks and the task scheduler share; the feed only
// listens. At a handshake `reset` marks the live sessions known, so the brain is not told of
// them twice; the brain asks for the lists it wants.

import { ulid } from "@cophyla/protocol";
import type { CapabilityEventName, CapabilityEventParams, Session } from "@cophyla/protocol";
import type { EventStream } from "../events/stream.ts";

/** Every event carries an `eventId` beside its params: the correlation of the requests it provokes. */
export type FeedEvent = { [N in CapabilityEventName]: { name: N; params: CapabilityEventParams<N> & { eventId: string } } }[CapabilityEventName];

export interface FeedDeps {
  stream: EventStream;
  sessions: { list(): Session[] };
  send: (event: FeedEvent) => void;
  now?: () => number;
}

export class Feed {
  private deps: FeedDeps;
  private unsubscribe?: () => void;

  constructor(deps: FeedDeps) {
    this.deps = deps;
    this.unsubscribe = deps.stream.on((e) => {
      deps.send({ name: e.name, params: { ...e.params, eventId: `evt_${ulid(this.now())}` } } as FeedEvent);
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** At each handshake: the live sessions are known, so the brain is not told of them twice. */
  reset(): void {
    this.deps.stream.prime(this.deps.sessions.list());
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
