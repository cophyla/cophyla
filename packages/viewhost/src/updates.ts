// Checking for a new Cophyla by hand: the tray's Check for updates and the Updates page in the
// settings. The node reads the feed every hour by itself; this asks it now (`update.check`,
// answered once the feed is read and weighed, the download going on behind it). The node says
// what it found as `update.state` for its platform before it answers, so once the answer is in,
// the state kept here says which it was: nothing newer, a release on its way (with how much of
// it came), or one ready to restart into. A release found by hand and still downloading is
// watched until it is ready, so the one who asked hears that too. DOM-free.

import type { ClientNotificationParams, RpcNotification } from "@cophyla/protocol";

export type PlatformUpdate = ClientNotificationParams<"update.state">;

/** What a check found. */
export type CheckOutcome =
  | { kind: "latest"; current: string }
  | { kind: "found"; version: string; current: string; ready: boolean; progress?: number }
  | { kind: "failed"; message: string };

export interface UpdateCheckerDeps {
  request: <T>(method: string, params: unknown) => Promise<T>;
  /** The node this host's connection talks to: whose platform a check is about. */
  node: () => string | undefined;
  /** The platform version the node said in its hello, for a node that has said no `update.state` yet. */
  version?: () => string | undefined;
  /** A release found by a check here is now ready to restart into. */
  onReady?: (version: string) => void;
}

/** Words for an outcome: a toast's title and line, or the settings' status line. */
export function checkWords(o: CheckOutcome): { title: string; detail: string } {
  switch (o.kind) {
    case "latest":
      return { title: "Cophyla is up to date", detail: `${o.current} is the newest version.` };
    case "found":
      return o.ready
        ? { title: `Cophyla ${o.version} is ready`, detail: "Restart to update in the tray menu, or Update in the app, starts it." }
        : { title: `Cophyla ${o.version} is on its way`, detail: `It is downloading${o.progress !== undefined ? ` (${Math.round(o.progress * 100)}%)` : ""}; you are told when it is ready.` };
    case "failed":
      return { title: "Could not check for updates", detail: o.message };
  }
}

/** What the platform's state says now: nothing newer, or a release on its way or ready. */
export function outcomeOf(s: PlatformUpdate | undefined, fallbackCurrent?: string): CheckOutcome {
  const current = s?.current ?? fallbackCurrent ?? "this version";
  if (s?.staged !== undefined && s.staged !== s.current) return { kind: "found", version: s.staged, current, ready: true };
  if (s?.available !== undefined && s.available !== s.current) return { kind: "found", version: s.available, current, ready: false, ...(s.progress !== undefined ? { progress: s.progress } : {}) };
  return { kind: "latest", current };
}

export class UpdateChecker {
  private deps: UpdateCheckerDeps;
  private states = new Map<string, PlatformUpdate>();
  private listeners = new Set<() => void>();
  /** A check is under way. */
  checking = false;
  /** What the last check here found, kept for the settings until the next. */
  last?: CheckOutcome;
  /** Update now was pressed, and why it could not go if it could not. */
  applying = false;
  applyNote = "";
  /** A release found by hand while it downloads: its readiness is told. */
  private awaiting?: string;

  constructor(deps: UpdateCheckerDeps) {
    this.deps = deps;
  }

  /** Every notification the host hears: the platform's `update.state` is kept, by node. */
  onNotification(n: RpcNotification): void {
    if (n.method !== "update.state") return;
    const s = n.params as PlatformUpdate;
    if (s.component !== "platform") return;
    this.states.set(s.node, s);
    if (s.node === this.deps.node()) {
      if (this.last?.kind === "found") this.last = outcomeOf(s, this.last.current);
      if (this.awaiting !== undefined && s.staged === this.awaiting) {
        const v = this.awaiting;
        this.awaiting = undefined;
        this.deps.onReady?.(v);
      }
    }
    this.changed();
  }

  /** The platform's state on the node this host talks to, as last said. */
  platform(): PlatformUpdate | undefined {
    const node = this.deps.node();
    return node === undefined ? undefined : this.states.get(node);
  }

  /** The version that runs on the node this host talks to. */
  current(): string | undefined {
    return this.platform()?.current ?? this.deps.version?.();
  }

  /** Asks the node to read the feed now; answered with what it found. */
  async check(): Promise<CheckOutcome> {
    if (this.checking) return this.last ?? { kind: "failed", message: "a check is under way" };
    this.checking = true;
    this.changed();
    try {
      await this.deps.request("update.check", {});
      const out = outcomeOf(this.platform(), this.deps.version?.());
      this.awaiting = out.kind === "found" && !out.ready ? out.version : undefined;
      this.last = out;
      return out;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.last = { kind: "failed", message: /unknown method|unsupported/i.test(message) ? "this Cophyla is too old to check by hand: it checks by itself" : message };
      return this.last;
    } finally {
      this.checking = false;
      this.changed();
    }
  }

  /** Restarts into the ready release as soon as nothing waits on the node (an open question, a turn under way). */
  async apply(): Promise<void> {
    this.applying = true;
    this.applyNote = "";
    this.changed();
    try {
      const r = await this.deps.request<{ waiting?: string[] }>("update.apply", { component: "platform", whenIdle: true });
      if (r?.waiting && r.waiting.length > 0) this.applyNote = `It restarts once these finish: ${r.waiting.join(", ")}.`;
    } catch (e) {
      this.applying = false;
      this.applyNote = e instanceof Error ? e.message : String(e);
    }
    this.changed();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}
