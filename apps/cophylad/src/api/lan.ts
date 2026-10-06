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
//
// The listener's certificate is the node's own, self-signed, kept while it names the address
// the node is reached at. A certificate the user brings (`[controller] cert_file`, `key_file`)
// is served beside it for the names it carries: read and checked first, and again whenever
// its files change, when the listener is started again with it. One that does not pass leaves
// what is being served as it is, and `lan.info` says why. The native phone app pins the node's
// own key and connects by address, so what it is told stays an address.

import { X509Certificate } from "node:crypto";
import type { LanState, PairedLan } from "@cophyla/protocol";
import type { Config } from "../config/schema.ts";
import { onThisMachine } from "../grants/methods.ts";
import type { Logger } from "../log.ts";
import { Guard, PairLimiter, parseNetworks } from "./guard.ts";
import type { LimiterOptions } from "./guard.ts";
import type { MethodTable } from "./methods.ts";
import type { ApiServer } from "./server.ts";
import type { ListenerTls } from "./server.ts";
import { certificateNames, ensureCertificate, fileStamp, lanAddress, lanEndpoints, loadOwnCertificate, machineNames, reachableAddresses, spkiHash } from "./tls.ts";
import type { OwnCertificate } from "./tls.ts";
import { parseAddress } from "./guard.ts";

/** The store's key for the switch: "1" or "0", over `[controller] enabled` once set. */
export const LAN_ENABLED_KEY = "lan_enabled";
/** What a device's socket is closed with when the switch goes off: not served here any more, which is no refusal of its credential. */
export const CLOSE_NOT_SERVING = 4410;
/** How long the devices' sockets are left open after the switch went off: long enough for its answer to leave. */
const CLOSE_AFTER_MS = 100;
/** How often the user's own certificate's files are looked at for a change. */
const OWN_CERTIFICATE_POLL_MS = 30_000;

/** What the listener is started with, beside the daemon's own methods. */
export interface LanListener {
  tls: ListenerTls;
  guard: Guard;
  limiter: PairLimiter;
  /** Whether devices are served now; off, only `/ws/node` is answered. */
  serving: () => boolean;
  /** The port it was on before, when it is started again: what is paired with it knows that one. Absent, the configured port. */
  port?: number;
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
  /** How often the user's own certificate is looked at again; 0 never, for a test that looks itself. */
  ownCertificatePollMs?: number;
}

export class Lan {
  private deps: LanDeps;
  private log: Logger;
  private api?: ApiServer;
  private certPem?: string;
  private failed?: string;
  /** The port the listener was last on: where it comes back, whatever the configured port left to the system. */
  private port?: number;
  /** What a switch-off still has to do: close the devices, and stop the listener where no node needs it. */
  private settling: Promise<void> = Promise.resolve();
  /** The user's own certificate as it is served, why the one on disk is not, and what its files looked like when last read. */
  private own?: OwnCertificate;
  private ownError?: string;
  private ownStamp?: string;
  private ownTimer?: ReturnType<typeof setInterval>;
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
        return [...machineNames(), ...(named?.dns ?? []), ...(named?.ips ?? []), ...(address !== undefined ? [address] : []), ...(this.own?.names ?? [])];
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

  /** Brings the listener up when it has a reason to be, and starts watching the user's own certificate for a change. */
  start(): void {
    if (this.wanted()) this.up();
    const every = this.deps.ownCertificatePollMs ?? OWN_CERTIFICATE_POLL_MS;
    if (this.ownFiles() && every > 0 && !this.ownTimer) {
      this.ownTimer = setInterval(() => void this.checkOwn(), every);
      this.ownTimer.unref?.();
    }
  }

  /** The user's own certificate's files, when both are configured. */
  private ownFiles(): { cert: string; key: string } | undefined {
    const { cert_file, key_file } = this.deps.config.controller;
    return cert_file !== undefined && key_file !== undefined ? { cert: cert_file, key: key_file } : undefined;
  }

  /** Reads the user's own certificate anew: the checked pair is what is served from the next start of the listener, and one that fails is said and never served. */
  private readOwn(): boolean {
    const files = this.ownFiles();
    if (!files) return false;
    this.ownStamp = fileStamp(files.cert, files.key);
    try {
      this.own = loadOwnCertificate(files.cert, files.key);
      this.ownError = undefined;
      this.log.info("own certificate checked", { names: this.own.names, validTo: new Date(this.own.validTo).toISOString() });
      return true;
    } catch (e) {
      this.ownError = e instanceof Error ? e.message : String(e);
      this.log.warn("own certificate not used", { reason: this.ownError, cert: files.cert });
      return false;
    }
  }

  /**
   * Looks at the user's own certificate's files: changed, they are read and checked, and a
   * pair that passes is put in service by starting the listener again; one that does not
   * leaves the listener as it is. Returns whether the listener was started again.
   */
  async checkOwn(): Promise<boolean> {
    const files = this.ownFiles();
    if (!files || fileStamp(files.cert, files.key) === this.ownStamp) return false;
    const before = this.own?.certPem;
    if (!this.readOwn() || this.own?.certPem === before || !this.api) return false;
    this.log.info("own certificate changed: the listener starts again with it");
    await this.settling;
    const api = this.api;
    if (!api) return false;
    this.api = undefined;
    await api.stop();
    this.up(false);
    this.deps.onChange?.();
    return true;
  }

  /** The address the node's own certificate must name: the one configured, else the node's pick among its adapters. */
  private required(): { dnsNames: string[]; ips: string[] } {
    const address = this.deps.config.controller.address ?? lanAddress();
    if (address === undefined) return { dnsNames: [], ips: [] };
    return parseAddress(address) ? { dnsNames: [], ips: [address] } : { dnsNames: [address.toLowerCase()], ips: [] };
  }

  private up(read = true): void {
    if (this.api) return;
    try {
      const endpoints = lanEndpoints();
      const cert = ensureCertificate(this.deps.tlsDir, { dnsNames: endpoints.dnsNames, ips: endpoints.ips, required: this.required() }, this.log);
      this.certPem = cert.certPem;
      if (read) this.readOwn();
      const named = (this.own?.names ?? []).map((serverName) => ({ key: this.own!.keyPem, cert: this.own!.certPem, serverName }));
      const listener: LanListener = { tls: { key: cert.keyPem, cert: cert.certPem, ...(named.length > 0 ? { named } : {}) }, guard: this.guard, limiter: this.limiter, serving: () => this.enabled };
      try {
        this.api = this.deps.serve(this.port !== undefined ? { ...listener, port: this.port } : listener);
      } catch (e) {
        // the port it had is taken: any the configuration allows is better than none
        if (this.port === undefined || this.port === this.deps.config.controller.port) throw e;
        this.api = this.deps.serve(listener);
      }
      this.port = this.api.port;
      this.failed = undefined;
      this.log.info("controller listener up", { origin: this.api.origin, devices: this.enabled ? "served" : "off", nodes: "/ws/node", ...(this.own ? { ownCertificate: this.own.names } : {}) });
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

  /** The address a device on this network reaches the node at: the configured one, else the one the listener is bound to, else the node's own pick among its adapters. */
  private host(): string | undefined {
    const configured = this.deps.config.controller.address;
    if (configured !== undefined) return configured;
    const bound = this.deps.config.controller.host;
    return bound === "0.0.0.0" || bound === "::" ? lanAddress() : bound;
  }

  /** The name a browser opens the node under: one the user's own certificate carries, when there is one, so the page opens with no warning; else its address. */
  private browserHost(): string | undefined {
    return this.own?.names.find((n) => !n.includes("*")) ?? this.host();
  }

  /**
   * The listener as a native app pins it, while devices are served and it has an address off
   * this machine. An address, never a name: the app pins the node's own key, and a connection
   * that names a host of the user's certificate would be shown that one.
   */
  pin(): PairedLan | undefined {
    const configured = this.host();
    const host = configured !== undefined && parseAddress(configured) ? configured : lanAddress();
    const spki = this.spki;
    if (!this.serving || host === undefined || spki === undefined || host === "127.0.0.1") return undefined;
    return { host, port: this.api!.port, spki };
  }

  /** The listener as an address a person types into a browser, while devices are served. */
  address(): string | undefined {
    return this.serving ? this.origin() : undefined;
  }

  /** The listener's origin as something on this network reaches it, up or not: for the URL a code is typed at. */
  origin(): string {
    return `https://${this.browserHost() ?? "127.0.0.1"}:${this.api?.port ?? this.deps.config.controller.port}`;
  }

  /** Every address a person may type, best first: a name of the user's own certificate, the address the node is reached at, then its others on real adapters (a hypervisor's switch is on no network another computer is on). */
  private addresses(): string[] {
    if (!this.serving) return [];
    const port = this.api!.port;
    const hosts = [...(this.own?.names.filter((n) => !n.includes("*")) ?? []), this.host(), ...reachableAddresses()].filter((h): h is string => h !== undefined);
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
      ...(this.ownFiles() ? { certificate: { names: this.own?.names ?? [], ...(this.own ? { validTo: this.own.validTo } : {}), ...(this.ownError !== undefined ? { error: this.ownError } : {}) } } : {}),
      keys: this.deps.openKeys?.() ?? 0,
      ...(refused ? { refused: { at: refused.at, address: refused.address, why: refused.why, detail: refused.detail } } : {}),
    };
  }

  async stop(): Promise<void> {
    if (this.ownTimer) clearInterval(this.ownTimer);
    this.ownTimer = undefined;
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
