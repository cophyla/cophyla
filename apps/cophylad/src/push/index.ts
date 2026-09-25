// Push: an open ask reaches a paired phone that has nothing open, as a notification whose
// buttons answer it. The module watches the bus for `ask.state`: an ask that opens and a
// user may answer goes once to every controller that registered a push device and holds
// no connection here (a phone with the app open hears the ask on its socket already); an
// ask that leaves `open` is withdrawn from the phones it went to. A phone whose grant cannot
// answer asks, or cannot see this one, is not sent it. The sends ride the
// server link (`push.send`), serialized per ask so a dismiss never overtakes its ask, and
// are never queued: with the link down or a plan without push, an ask is simply not
// pushed, and the phone sees it when it next connects. A registration is forwarded on the
// link too (`push.register`) and, when that fails, marked pending on the controller's row
// and replayed when the link comes up.

import { allowsNotification } from "@cophyla/protocol";
import type { Ask, PushAsk } from "@cophyla/protocol";
import type { Grants, PushDevice } from "../grants/store.ts";
import type { ClientRegistry } from "../api/clients.ts";
import type { Bus } from "../bus.ts";
import type { Cloud } from "../cloud/index.ts";
import type { PushConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";

/** Buttons a notification carries at most; the phone shows the rest on tap. */
export const MAX_PUSH_BUTTONS = 3;
const MAX_LABEL = 40;
const MAX_TITLE = 80;
const MAX_DETAIL = 200;
/** A peer's failures are logged once per this long. */
const FAILURE_LOG_MS = 600_000;

export interface PushDeps {
  config: PushConfig;
  bus: Bus;
  log: Logger;
  grants: Grants;
  clients: ClientRegistry;
  cloud: Pick<Cloud, "pushRequest" | "onUp" | "hostedAllowed">;
  nodeId: string;
  now?: () => number;
}

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The ask as a push carries it: trimmed to what a notification can show. */
export function trimAsk(ask: Ask): PushAsk {
  const out: PushAsk = {
    id: ask.id,
    node: ask.node,
    title: oneLine(ask.title, MAX_TITLE),
    options: ask.options.slice(0, MAX_PUSH_BUTTONS).map((o) => ({ id: o.id, label: oneLine(o.label, MAX_LABEL) })),
  };
  if (ask.detail) out.detail = oneLine(ask.detail, MAX_DETAIL);
  if (ask.multiple) out.multiple = true;
  if (ask.expiresAt !== undefined) out.expiresAt = ask.expiresAt;
  return out;
}

export class Push {
  private deps: PushDeps;
  private log: Logger;
  /** Ask id → the peers it was pushed to, while open. */
  private pushed = new Map<string, Set<string>>();
  /** Per ask, the chain the sends ride so a dismiss follows its ask. */
  private chains = new Map<string, Promise<void>>();
  private failedAt = new Map<string, number>();
  private skippedAt = 0;
  private offs: (() => void)[] = [];

  constructor(deps: PushDeps) {
    this.deps = deps;
    this.log = deps.log;
    if (!deps.config.enabled) {
      this.log.info("push off in config");
      return;
    }
    this.offs.push(deps.bus.on("ask.state", (ask) => this.onAsk(ask)));
    this.offs.push(deps.cloud.onUp(() => this.replayPending()));
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  get enabled(): boolean {
    return this.deps.config.enabled;
  }

  // --- asks --------------------------------------------------------------------------------

  private onAsk(ask: Ask): void {
    if (ask.status === "open") {
      if (this.pushed.has(ask.id) || !ask.answerableBy.includes("user")) return;
      const targets = this.targets(ask);
      this.pushed.set(ask.id, new Set());
      if (targets.length === 0) return;
      const why = this.deps.cloud.hostedAllowed("push");
      if (why) {
        this.skipped(why.message);
        return;
      }
      const trimmed = trimAsk(ask);
      for (const t of targets) this.enqueue(ask.id, () => this.send(t.id, "ask", trimmed));
      return;
    }
    const peers = this.pushed.get(ask.id);
    if (!peers) return;
    this.pushed.delete(ask.id);
    if (peers.size === 0) {
      this.chains.delete(ask.id);
      return;
    }
    const trimmed = trimAsk(ask);
    for (const peer of peers) this.enqueue(ask.id, () => this.send(peer, "dismiss", trimmed));
    this.enqueue(ask.id, async () => {
      this.chains.delete(ask.id);
    });
  }

  /** The controllers to push an ask to: a registered device, no connection here right now, and access that reaches the ask. */
  private targets(ask: Ask): { id: string; name: string }[] {
    return this.deps.grants
      .withPush()
      .filter((c) => this.deps.clients.byController(c.id).length === 0)
      .filter((c) => c.access.scopes.includes("asks:answer") && allowsNotification(c.access, "ask.state", ask, this.deps.clients.look))
      .map((c) => ({ id: c.id, name: c.name }));
  }

  private enqueue(askId: string, work: () => Promise<void>): void {
    const prev = this.chains.get(askId) ?? Promise.resolve();
    const next = prev.then(work).catch(() => undefined);
    this.chains.set(askId, next);
  }

  private async send(peer: string, kind: "ask" | "dismiss", ask: PushAsk): Promise<void> {
    const body = ask.detail ?? ask.title;
    try {
      await this.deps.cloud.pushRequest("push.send", { title: ask.title, body, peer, kind, ask });
      if (kind === "ask") this.pushed.get(ask.id)?.add(peer);
      this.log.info("push sent", { peer, kind, ask: ask.id });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: string }).code;
      if (code === "not_found") {
        // the device is gone at its platform: the row goes with it
        this.deps.grants.setPush(peer, undefined);
        this.log.info("push device gone; registration forgotten", { peer });
        return;
      }
      const last = this.failedAt.get(peer) ?? 0;
      if (this.now() - last >= FAILURE_LOG_MS) {
        this.failedAt.set(peer, this.now());
        this.log.warn("push failed", { peer, kind, ask: ask.id, error: message });
      }
    }
  }

  private skipped(reason: string): void {
    if (this.now() - this.skippedAt < FAILURE_LOG_MS) return;
    this.skippedAt = this.now();
    this.log.debug("ask not pushed", { reason });
  }

  // --- registrations ----------------------------------------------------------------------

  /** A phone registered its device: forwarded on the link now, or left pending for the next link-up. */
  register(controller: string, device: PushDevice): void {
    if (!this.deps.config.enabled) return;
    void this.forwardRegister(controller, device);
  }

  private async forwardRegister(controller: string, device: PushDevice): Promise<void> {
    try {
      await this.deps.cloud.pushRequest("push.register", { peer: controller, platform: device.platform, token: device.token });
      this.deps.grants.setPush(controller, { platform: device.platform, token: device.token, registeredAt: device.registeredAt });
      this.log.info("push device registered with the server", { controller, platform: device.platform });
    } catch (e) {
      this.log.info("push registration pending: the server did not take it now", { controller, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** A phone forgot its device, or the controller was revoked: the server forgets it too, best effort. */
  unregister(controller: string): void {
    if (!this.deps.config.enabled) return;
    void this.deps.cloud.pushRequest("push.unregister", { peer: controller }).catch((e: unknown) => {
      this.log.debug("push unregister not delivered", { controller, error: e instanceof Error ? e.message : String(e) });
    });
  }

  /** The link came up: every registration the server has not acknowledged goes again. */
  private replayPending(): void {
    for (const c of this.deps.grants.withPush()) {
      if (c.push.pending) void this.forwardRegister(c.id, c.push);
    }
  }

  /** For the tests: the peers an ask was pushed to. */
  pushedTo(askId: string): string[] {
    return [...(this.pushed.get(askId) ?? [])];
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }
}
