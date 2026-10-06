// The node on its own network: the LAN listener, and the one switch for the devices it serves
// there. The switch is `[controller] enabled` until the app sets it (`lan.enable`,
// `lan.disable`), and the store's from then on. The listener is up while the switch is on, and
// also while other nodes may link here (`[nodes] accept`) or this node is a backup, which must
// be reachable to take the role. Up for nodes alone it answers `/ws/node` and refuses
// everything else at HTTP, before any socket: a phone turned away there falls back to the
// relay with its credential intact, where a refused `hello` would have made it forget it.
// Turning the switch off closes the devices connected on the listener, and stops it where no
// node needs it; turning it on brings it up where it was down. The closing waits a moment, so
// the answer reaches a client that asked from one of those devices; nothing is served in
// between. Nothing here brings back a listener someone stopped: only the switch does.
//
// What a node link pins, the key's hash, is never withheld while the listener is up. What a
// phone is told of the listener (the pin it gets at pairing, an invite's LAN part, the address
// a browser's key is typed at) is told only while devices are served.

import { X509Certificate } from "node:crypto";
import type { LanState, PairedLan } from "@cophyla/protocol";
import type { Config } from "../config/schema.ts";
import { onThisMachine } from "../grants/methods.ts";
import type { Logger } from "../log.ts";
import { Guard, PairLimiter, parseNetworks } from "./guard.ts";
import type { LimiterOptions } from "./guard.ts";
import type { MethodTable } from "./methods.ts";
import type { ApiServer } from "./server.ts";
import { certificateNames, ensureCertificate, lanAddress, lanEndpoints, machineNames, spkiHash } from "./tls.ts";

/** The store's key for the switch: "1" or "0", over `[controller] enabled` once set. */
export const LAN_ENABLED_KEY = "lan_enabled";
/** What a device's socket is closed with when the switch goes off: not served here any more, which is no refusal of its credential. */
export const CLOSE_NOT_SERVING = 4410;
/** How long the devices' sockets are left open after the switch went off: long enough for its answer to leave. */
const CLOSE_AFTER_MS = 100;

/** What the listener is started with, beside the daemon's own methods. */
export interface LanListener {
  tls: { key: string; cert: string };
  guard: Guard;
  limiter: PairLimiter;
  /** Whether devices are served now; off, only `/ws/node` is answered. */
  serving: () => boolean;
}

export interface LanDeps {
  config: Pick<Config, "controller" | "nodes" | "node">;
  /** Where the switch is kept once the app has set it. */
  store: { meta: { get(key: string): string | undefined; set(key: string, value: string): void } };
  /** `<home>/data/tls`: the node's own key and certificate. */
  tlsDir: string;
  log: Logger;
  /** Starts the listener, the daemon's methods behind it; throws when its port cannot be bound. */
  serve: (listener: LanListener) => ApiServer;
  /** The browser keys minted and not yet typed. */
  openKeys?: () => number;
  /** The switch moved, or the listener came up or went. */
  onChange?: () => void;
  limiter?: LimiterOptions;
}

export class Lan {
  private deps: LanDeps;
  private log: Logger;
  private api?: ApiServer;
  private certPem?: string;
  private failed?: string;
  /** What a switch-off still has to do: close the devices, and stop the listener where no node needs it. */
  private settling: Promise<void> = Promise.resolve();
  readonly guard: Guard;
  readonly limiter: PairLimiter;

  constructor(deps: LanDeps) {
    this.deps = deps;
    this.log = deps.log;
    const address = deps.config.controller.address;
    this.guard = new Guard({
      networks: parseNetworks(deps.config.controller.networks),
      // This machine's names: its addresses and hostname now, its certificate's, and the one the config gives it.
      names: () => {
        const named = this.certPem !== undefined ? certificateNames(this.certPem) : undefined;
        return [...machineNames(), ...(named?.dns ?? []), ...(named?.ips ?? []), ...(address !== undefined ? [address] : [])];
      },
      scheme: "https",
      forwarder: true,
      log: this.log,
    });
    this.limiter = new PairLimiter(deps.limiter);
  }

  // --- the switch -------------------------------------------------------------------------------

  /** Whether this node serves devices on its network: the app's switch once set, `[controller] enabled` before. */
  get enabled(): boolean {
    const kept = this.deps.store.meta.get(LAN_ENABLED_KEY);
    return kept === undefined ? this.deps.config.controller.enabled : kept === "1";
  }

  /** Whether the listener has a reason to be up: devices, other nodes' links, or a backup's reachability. */
  private wanted(): boolean {
    return this.enabled || this.deps.config.nodes.accept || this.deps.config.node.backup;
  }

  /** The listener, while it is up. */
  get server(): ApiServer | undefined {
    return this.api;
  }

  /** Whether devices are served now. */
  get serving(): boolean {
    return this.api !== undefined && this.enabled;
  }

  /** Brings the listener up when it has a reason to be. */
  start(): void {
    if (this.wanted()) this.up();
  }

  private up(): void {
    if (this.api) return;
    try {
      const endpoints = lanEndpoints();
      const cert = ensureCertificate(this.deps.tlsDir, { dnsNames: endpoints.dnsNames, ips: endpoints.ips }, this.log);
      this.certPem = cert.certPem;
      this.api = this.deps.serve({ tls: { key: cert.keyPem, cert: cert.certPem }, guard: this.guard, limiter: this.limiter, serving: () => this.enabled });
      this.failed = undefined;
      this.log.info("controller listener up", { origin: this.api.origin, devices: this.enabled ? "served" : "off", nodes: "/ws/node" });
    } catch (e) {
      this.failed = e instanceof Error ? e.message : String(e);
      this.log.error("controller listener off", { error: this.failed });
    }
  }

  /** Serves devices on this network from now on: the listener comes up where it was down. */
  async enable(): Promise<LanState> {
    if (!this.enabled) this.log.info("access on this network switched on");
    this.deps.store.meta.set(LAN_ENABLED_KEY, "1");
    // a listener on its way down has let go of its port by then
    await this.settling;
    if (!this.api) this.up();
    this.deps.onChange?.();
    return this.state();
  }

  /**
   * Serves no device on this network from now on: nothing more is answered there at once, the
   * devices connected are closed a moment later (the one that asked has its answer by then),
   * and the listener stops where no node needs it.
   */
  disable(): LanState {
    if (this.enabled) this.log.info("access on this network switched off");
    this.deps.store.meta.set(LAN_ENABLED_KEY, "0");
    this.failed = undefined;
    const api = this.api;
    if (api) {
      const down = !this.wanted();
      if (down) this.api = undefined;
      this.settling = this.settling
        .then(() => Bun.sleep(CLOSE_AFTER_MS))
        .then(async () => {
          // switched back on meanwhile: the devices stay
          if (!down && this.enabled) return;
          const closed = api.closeClients(CLOSE_NOT_SERVING, "access on this network was turned off");
          if (closed > 0) this.log.info("devices on this network disconnected", { count: closed });
          if (!down) return;
          await api.stop();
          this.log.info("controller listener down");
        })
        .catch((e: unknown) => this.log.warn("the listener did not go down cleanly", { error: e instanceof Error ? e.message : String(e) }));
    }
    this.deps.onChange?.();
    return this.state();
  }

  // --- what it tells --------------------------------------------------------------------------------

  /** The SHA-256 of the listener's key, whatever address it is on: what a node invite and an enrollment carry. */
  get spki(): string | undefined {
    return this.api && this.certPem !== undefined ? spkiHash(this.certPem) : undefined;
  }

  /** The host a device on this network reaches the node at: the configured address, else the one the listener is bound to, else the node's own pick among its addresses. */
  private host(): string | undefined {
    const configured = this.deps.config.controller.address;
    if (configured !== undefined) return configured;
    const bound = this.deps.config.controller.host;
    return bound === "0.0.0.0" || bound === "::" ? lanAddress() : bound;
  }

  /** The listener as a native app pins it, while devices are served and it has an address off this machine. */
  pin(): PairedLan | undefined {
    const host = this.host();
    const spki = this.spki;
    if (!this.serving || host === undefined || spki === undefined || host === "127.0.0.1" || host === "localhost") return undefined;
    return { host, port: this.api!.port, spki };
  }

  /** The listener as an address a person types into a browser, while devices are served. */
  address(): string | undefined {
    return this.serving ? this.origin() : undefined;
  }

  /** The listener's origin as something on this network reaches it, up or not: for the URL a code is typed at. */
  origin(): string {
    return `https://${this.host() ?? "127.0.0.1"}:${this.api?.port ?? this.deps.config.controller.port}`;
  }

  /** Every address a person may type, best first. */
  private addresses(): string[] {
    if (!this.serving) return [];
    const port = this.api!.port;
    const hosts = [this.host(), ...lanEndpoints().ips.filter((ip) => ip !== "127.0.0.1")].filter((h): h is string => h !== undefined);
    return [...new Set(hosts)].map((h) => `https://${h}:${port}`);
  }

  state(): LanState {
    const enabled = this.enabled;
    const state: LanState["state"] = this.api ? (enabled ? "on" : "nodes") : this.failed !== undefined && this.wanted() ? "failed" : "off";
    let fingerprints: LanState["fingerprints"];
    if (this.api && this.certPem !== undefined) {
      try {
        fingerprints = { certificate: new X509Certificate(this.certPem).fingerprint256, key: spkiHash(this.certPem) };
      } catch {
        fingerprints = undefined;
      }
    }
    const refused = this.guard.last;
    return {
      enabled,
      state,
      ...(state === "failed" && this.failed !== undefined ? { reason: this.failed } : {}),
      ...(this.api ? { port: this.api.port } : {}),
      addresses: this.addresses(),
      ...(fingerprints ? { fingerprints } : {}),
      keys: this.deps.openKeys?.() ?? 0,
      ...(refused ? { refused: { at: refused.at, address: refused.address, why: refused.why, detail: refused.detail } } : {}),
    };
  }

  async stop(): Promise<void> {
    await this.settling;
    const api = this.api;
    this.api = undefined;
    if (api) await api.stop();
  }
}

/**
 * The switch as the app sets it. Turning it on opens this machine to its network, so it is
 * asked on the machine itself alone; reading it and turning it off are any client's that may
 * manage devices.
 */
export function lanMethods(deps: { lan: () => Lan }): MethodTable {
  return {
    "lan.info": { handler: () => deps.lan().state() },
    "lan.enable": {
      handler: (_p, ctx) => {
        onThisMachine(ctx, "turning on access on this network");
        return deps.lan().enable();
      },
    },
    "lan.disable": { handler: () => deps.lan().disable() },
  };
}
