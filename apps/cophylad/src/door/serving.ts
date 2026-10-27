// What the sign-in door runs while it holds the machine's desktop, made afresh for every
// period it serves (a stopped `Remote` stays stopped): the desktop module on the host's own
// service with the kit's credentials, never installing or starting anything, its web viewer
// the fixed copy in the program folder (which the firewall rule names) paired under the
// machine's name and " sign-in", the stream sized to the screen the kit says, no LAN route to
// anything; and the direct connections' helper, the fixed copy beside it, on the primary's
// account: its TURN servers come over the link. Screenshots are refused: the brain has no
// business at a sign-in screen. Then the link to the primary, over which the streams come.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { FREE_ENTITLEMENT, RpcError } from "@cophyla/protocol";
import type { DoorState } from "@cophyla/protocol";
import { lanEndpoints } from "../api/tls.ts";
import type { Bus } from "../bus.ts";
import type { RemoteConfig } from "../config/schema.ts";
import { Direct } from "../direct/index.ts";
import { helperEnv } from "../direct/helper.ts";
import type { Gate } from "../gate/index.ts";
import type { Logger } from "../log.ts";
import { DOOR_VIEWER_SUFFIX, Remote } from "../remote/index.ts";
import type { RemoteDeps } from "../remote/index.ts";
import { Sidecars } from "../sidecars/index.ts";
import type { Store } from "../store/index.ts";
import type { ConsoleState } from "./constants.ts";
import { programPaths } from "./constants.ts";
import type { Kit } from "./kit.ts";
import { DoorLink } from "./link.ts";

/** The desktop module's settings at the sign-in screen: the kit's, held to what a door may do. */
export function doorRemoteConfig(kit: Kit, program: string): RemoteConfig {
  if (!kit.host) throw new RpcError("unavailable", "the desktop host's credentials are not known");
  return {
    ...kit.remote,
    enabled: true,
    install: false,
    host: kit.host.kind,
    host_user: kit.host.username,
    host_password: kit.host.password,
    web: true,
    web_server: programPaths(program).webServer,
    lan_route: false,
  };
}

export interface DesktopDeps {
  kit: Kit;
  program: string;
  /** The door's `data/`: the desktop module's own folder and the web viewer's under it. */
  dataDir: string;
  store: Store;
  bus: Bus;
  log: Logger;
  doorState: () => DoorState;
  /** The direct connections' helper's state of the link, and its TURN servers. */
  link: () => DoorLink | undefined;
  /** The seams, for the tests. */
  remote?: Partial<RemoteDeps>;
  netCommand?: () => string | undefined;
  spawnNet?: ConstructorParameters<typeof Direct>[0]["spawn"];
}

/** The desktop module and the direct connections a door runs, built for one period. */
export function doorDesktop(deps: DesktopDeps): { remote: Remote; direct: Direct; sidecars: Sidecars } {
  const { kit } = deps;
  const self = kit.node.id;
  const remoteDir = join(deps.dataDir, "remote");
  mkdirSync(remoteDir, { recursive: true });
  const sidecars = new Sidecars({ dir: join(deps.dataDir, "sidecars"), log: deps.log.child("sidecars") });
  const direct = new Direct({
    config: { ...kit.direct.config },
    nodeId: self,
    store: deps.store,
    bus: deps.bus,
    log: deps.log.child("direct"),
    // the primary's account: while linked, its plan's word and its TURN credentials, over the link
    cloud: {
      get signedIn() {
        return deps.link()?.linked() ?? false;
      },
      entitlement: () => ({ ...FREE_ENTITLEMENT, hosted: { ...FREE_ENTITLEMENT.hosted, direct: true } }),
      turnCredentials: () => {
        const link = deps.link();
        if (!link?.linked()) return Promise.reject(new RpcError("unavailable", "not linked to the primary"));
        return link.turn();
      },
      directReport: () => Promise.resolve(),
      onUp: () => () => undefined,
    },
    command:
      deps.netCommand ??
      (() => {
        const net = programPaths(deps.program).net;
        return existsSync(net) ? net : undefined;
      }),
    env: helperEnv(process.env),
    remoteDir,
    ...(deps.spawnNet ? { spawn: deps.spawnNet } : {}),
  });
  // the door runs the direct connections whenever the machine's owner has them on
  deps.store.meta.set("direct_enabled", kit.direct.enabled ? "1" : "0");
  let remote: Remote;
  remote = new Remote({
    config: doorRemoteConfig(kit, deps.program),
    store: deps.store,
    nodeId: self,
    nodeName: kit.node.name,
    nodeNamed: (name) => (name === kit.node.name ? self : undefined),
    dir: remoteDir,
    sidecarsDir: join(deps.dataDir, "sidecars"),
    bus: deps.bus,
    log: deps.log.child("remote"),
    sidecars,
    // the door's own viewer pairs with this machine's host, and nothing pairs with another's
    pairOn: async (target, pin) => {
      if (target !== self) throw new RpcError("denied", "a sign-in door pairs nothing with another machine");
      await remote.pair(pin.pin, pin.name);
    },
    addressOf: (target) => (target === self ? "127.0.0.1" : undefined),
    lanRoute: () => false,
    lanIps: () => lanEndpoints().ips,
    direct: {
      get ready() {
        return direct.ready;
      },
      iceServers: () => direct.iceServers(),
      request: (method, params) => direct.request(method, params),
    },
    viewerName: () => `${kit.node.name}${DOOR_VIEWER_SUFFIX}`,
    ...(kit.display ? { display: () => kit.display } : {}),
    doorState: deps.doorState,
    startsService: false,
    screenshot: () => Promise.reject(new RpcError("denied", "no screenshots at the sign-in screen")),
    ...(deps.remote ?? {}),
  });
  return { remote, direct, sidecars };
}

export interface ServingDeps extends Omit<DesktopDeps, "link"> {
  /** Waits for the streamer to exit after a stand-down; the tests have none. */
  streamerGone?: (path: string, log: Logger) => Promise<void>;
  key: () => string;
  gate: Gate;
  platformVersion: string;
  console: () => ConsoleState;
  onRekey: (key: string) => void;
  onRevoked: () => void;
  onChange: () => void;
  /** The primary refused the door's protocol: it speaks `theirs`. */
  onProtocol?: (theirs: number) => void;
}

/** One period the door holds the desktop: the desktop module, the direct connections and the link, up together and down in order. */
export class Serving {
  private deps: ServingDeps;
  private log: Logger;
  readonly remote: Remote;
  readonly direct: Direct;
  private sidecars: Sidecars;
  readonly link: DoorLink;
  private stopped = false;

  constructor(deps: ServingDeps) {
    this.deps = deps;
    this.log = deps.log;
    let link: DoorLink | undefined;
    const desktop = doorDesktop({ ...deps, link: () => link });
    this.remote = desktop.remote;
    this.direct = desktop.direct;
    this.sidecars = desktop.sidecars;
    link = new DoorLink({
      kit: deps.kit,
      key: deps.key,
      store: deps.store,
      bus: deps.bus,
      gate: deps.gate,
      remote: this.remote,
      direct: this.direct,
      platformVersion: deps.platformVersion,
      console: deps.console,
      log: deps.log.child("link"),
      onRekey: deps.onRekey,
      onRevoked: deps.onRevoked,
      ...(deps.onProtocol ? { onProtocol: deps.onProtocol } : {}),
      onLink: () => {
        // the helper runs on the primary's plan while linked
        void this.direct.evaluate();
        deps.onChange();
      },
    });
    this.link = link;
  }

  start(): void {
    this.remote.start();
    this.direct.start();
    this.link.start();
  }

  /** The viewers whose streams the door holds now, as the node files them. */
  viewers(): string[] {
    return this.remote.tickets.liveClients();
  }

  /** Whether a stream it holds is live. */
  streaming(): boolean {
    return this.remote.state().streaming || this.viewers().length > 0;
  }

  linked(): boolean {
    return this.link.linked();
  }

  /** The console changed: the primary hears where it is. */
  announce(): void {
    this.link.announce();
  }

  /**
   * Stands down, in order: the streams end, the link is left (so the node's own join never
   * meets it), the sidecars stop, and the host's streamer is waited for; resolves with the
   * viewers that were watching.
   */
  async stop(): Promise<string[]> {
    if (this.stopped) return [];
    this.stopped = true;
    const viewers = this.viewers();
    this.remote.tickets.forgetWhere(() => true);
    this.link.stop();
    await this.remote.stop().catch((e: unknown) => this.log.warn("the door's desktop did not stop cleanly", { error: e instanceof Error ? e.message : String(e) }));
    await this.direct.stop().catch(() => undefined);
    await this.sidecars.stopAll().catch(() => undefined);
    this.deps.store.meta.set("direct_enabled", "0");
    // the web viewer's streamer outlives it a moment and holds the stream's ports, which the node's own needs next
    await (this.deps.streamerGone ?? streamerGone)(programPaths(this.deps.program).streamer, this.log).catch(() => undefined);
    return viewers;
  }
}

/**
 * Waits for the web viewer's streamer at `path` to exit, a few seconds, and ends it after
 * that: it holds the stream's UDP ports, and the node's own web viewer needs them next.
 */
export async function streamerGone(path: string, log: Logger, waitMs = 5000): Promise<void> {
  if (process.platform !== "win32") return;
  const pids = async (): Promise<number[]> => {
    const filter = `Name='streamer.exe'`;
    const script = `Get-CimInstance Win32_Process -Filter "${filter}" | Where-Object { $_.ExecutablePath -eq '${path.replace(/'/g, "''")}' } | ForEach-Object { $_.ProcessId }`;
    const proc = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "ignore", windowsHide: true });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out
      .split(/\s+/)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0);
  };
  const end = Date.now() + waitMs;
  let left = await pids();
  while (left.length > 0 && Date.now() < end) {
    await Bun.sleep(250);
    left = await pids();
  }
  for (const pid of left) {
    log.warn("the web viewer's streamer did not exit; ending it", { pid });
    try {
      process.kill(pid);
    } catch {
      // gone meanwhile
    }
  }
}
