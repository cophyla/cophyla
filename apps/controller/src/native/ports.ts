// A port of one of the user's machines, opened on the phone: the view asked the node for it
// (`port.open`), and the node answered the share this phone's pipes may reach it by; `host.open`
// hands that here. The Kotlin plugin shows the machine's page in a dialog of its own, through
// a forwarder on the phone's loopback whose every connection becomes a pipe to the share, and
// `Ports` keeps the page's lifetime: one page at a time, another closing the first, and the
// node told (`port.close`) whenever one closes, however that came about, so the machine stops
// sharing it.

import type { CophylaStreamPlugin, PipeBridge, PortClosed, PortPlan } from "./stream.ts";

export interface PortsDeps {
  plugin: CophylaStreamPlugin;
  /** A request over the link, for `port.close`. */
  request: (method: string, params: unknown) => Promise<unknown>;
  /** The pipes of the page's connections: a bridge of its own (`kind: port`). */
  pipes: PipeBridge;
  log?: (message: string) => void;
}

/** The port's page on the screen, if any: opened from a plan, closed by the user, the app, or its failure. */
export class Ports {
  private deps: PortsDeps;
  private current?: { id: string };
  private listening?: Promise<unknown>;

  constructor(deps: PortsDeps) {
    this.deps = deps;
  }

  /** The id of the port whose page shows, if one does. */
  get open(): string | undefined {
    return this.current?.id;
  }

  /** Shows a port's page; one already up is closed first. Resolves with the port it is reached at on the phone. */
  async show(plan: PortPlan): Promise<{ local: number }> {
    this.listening ??= this.deps.plugin.addListener("portClosed", (e) => this.closed(e));
    await this.listening;
    if (this.current) await this.close();
    const entry = { id: plan.id };
    this.current = entry;
    try {
      await this.deps.pipes.start(plan.node, { share: plan.share, key: plan.id });
      return await this.deps.plugin.openPort({ id: plan.id, node: plan.node, share: plan.share, port: plan.port, name: plan.name });
    } catch (e) {
      if (this.current === entry) this.ended(entry);
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  /** Closes the page on the screen: another one opens, or the app closes it. */
  async close(): Promise<void> {
    const entry = this.current;
    if (!entry) return;
    await this.deps.plugin.closePort({ id: entry.id }).catch(() => undefined);
    // the plugin says `portClosed` too; whichever comes first ends it
    if (this.current === entry) this.ended(entry);
  }

  private closed(e: PortClosed): void {
    const entry = this.current;
    if (!entry || e.id !== entry.id) return;
    if (e.reason && e.reason !== "closed" && e.reason !== "replaced") this.deps.log?.(`the page closed: ${e.reason}`);
    this.ended(entry);
  }

  private ended(entry: { id: string }): void {
    this.current = undefined;
    this.deps.pipes.stop();
    void this.deps.request("port.close", { id: entry.id }).catch(() => undefined);
  }
}
