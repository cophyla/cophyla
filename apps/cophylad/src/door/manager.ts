// The sign-in door as the user's daemon sees it (Windows): the switch the app sets
// (`remote.door`), the pipe to the door's service, and what the door says of itself in this
// node's `remote.state`. Switched on the first time, the door's service is installed with one
// administrator's prompt on this machine's screen (`cophyla-door.exe install`, from this
// platform version); off, the door is told to forget this machine and the service stays; Remove
// takes the service off, with the prompt again.
//
// The daemon attaches as it starts, before its links: if the door was serving, it stands down
// first and answers what it held for the node (a new key for its grant, the grant's end, and
// the viewers that were watching), which is taken as the node would have taken it itself; the
// viewers may open this desktop again unasked for REOPEN_MS. The pipe is held from then on;
// when it drops (the service restarted, or updated), the daemon attaches again. The kit goes
// with the attach and again whenever any of it changes (`kitChanged`), a moment after.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { DoorState } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import type { Exec } from "../sidecars/tts-py.ts";
import type { HostOs } from "../update/platform.ts";
import type { DoorAck, DoorClientDeps } from "./client.ts";
import { DoorClient, verifyDoorPipe } from "./client.ts";
import { ATTACH_TIMEOUT_MS, DOOR_EXE, DOOR_PIPE, doorFolders, REOPEN_MS } from "./constants.ts";
import { currentUserSid, elevationError, runElevated } from "./elevate.ts";
import type { Elevator } from "./elevate.ts";
import { sameKit } from "./kit.ts";
import type { Kit } from "./kit.ts";

/** The store's key for the switch: "1" or "0". */
export const DOOR_ENABLED_KEY = "door_enabled";

export interface DoorManagerDeps {
  os: HostOs;
  meta: { get(key: string): string | undefined; set(key: string, value: string): void };
  log: Logger;
  /** The kit as it stands now; undefined while the node is in no cluster. */
  kit: () => Kit | undefined;
  /** What the door held for the node while the daemon was away, taken as the node would have. */
  nodes: { adoptKey(key: string): void; revokedAway(): void };
  /** Why this machine can have no door now (the primary, a hands or a confined node), or undefined. */
  refusal: () => string | undefined;
  /** The installed platform this daemon runs from: its version folder, with the shim in its `bin/`; none from a checkout. */
  install: () => { versionDir: string; version: string } | undefined;
  exec: Exec;
  /** A folder for the elevated run's outcome file. */
  tmpDir: string;
  /** The pipe, over the door's own: a kit's console door. Its server is then not checked. */
  pipe?: string;
  elevate?: Elevator;
  /** The pipe's opener and its server's check, for the tests. */
  client?: Pick<DoorClientDeps, "open" | "verify">;
  /** This node's state changed: what it tells of the door. */
  onChange: () => void;
  now?: () => number;
}

/** How long the pipe is waited for after an install, while the service starts. */
const PIPE_WAIT_MS = 20_000;
/** How long an elevated install or removal may take, the prompt included. */
const ELEVATED_MS = 10 * 60_000;
const RECONNECT_MS = { first: 2000, max: 30_000 };
const KIT_DEBOUNCE_MS = 500;

export class DoorManager {
  private deps: DoorManagerDeps;
  private log: Logger;
  private client: DoorClient;
  private door?: DoorState;
  private installing = false;
  private failed?: string;
  private reopen = new Map<string, number>();
  private stopped = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectMs = RECONNECT_MS.first;
  private kitTimer?: ReturnType<typeof setTimeout>;
  /** The kit the door was last handed. */
  private sent?: Kit;
  /** How many states the door has told: an answer read after a newer one does not overwrite it. */
  private told = 0;
  private attachedOnce = false;
  /** The door's version, as its last answer said. */
  version?: string;

  constructor(deps: DoorManagerDeps) {
    this.deps = deps;
    this.log = deps.log;
    const pipe = deps.pipe ?? DOOR_PIPE;
    this.client = new DoorClient({
      pipe,
      log: deps.log.child("pipe"),
      // a kit's console door holds another pipe, and is no service
      ...(deps.client?.verify ? { verify: deps.client.verify } : deps.pipe === undefined ? { verify: verifyDoorPipe } : {}),
      ...(deps.client?.open ? { open: deps.client.open } : {}),
      onState: (s) => {
        this.door = s;
        this.told++;
        if (s.version) this.version = s.version;
        this.deps.onChange();
      },
      onClose: (reason) => {
        this.log.info("the sign-in door's pipe closed", { reason });
        this.door = undefined;
        this.deps.onChange();
        this.scheduleReconnect();
      },
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  get enabled(): boolean {
    return this.deps.meta.get(DOOR_ENABLED_KEY) === "1";
  }

  /** What the door is now, for this node's `remote.state`; nothing off Windows. */
  state(): DoorState | undefined {
    // stopped with the daemon: its store may be closed already
    if (this.deps.os !== "windows" || this.stopped) return undefined;
    if (this.installing) return { state: "installing" };
    const version = this.version !== undefined ? { version: this.version } : {};
    if (!this.enabled) return { state: "off", ...version };
    if (this.failed) return { state: "unavailable", reason: this.failed, ...version };
    if (!this.client.connected) return { state: "unavailable", reason: "the door's service is not running", ...version };
    return this.door ?? { state: "preparing", ...version };
  }

  // --- attaching -----------------------------------------------------------------------------

  /** At the daemon's start, before its links: attaches if there is a door, which stands down first. Never throws. */
  async start(): Promise<void> {
    if (this.deps.os !== "windows") return;
    await this.attach().catch((e: unknown) => this.log.warn("the sign-in door was not attached", { error: e instanceof Error ? e.message : String(e) }));
    if (!this.client.connected) this.scheduleReconnect();
  }

  /** Connects and attaches, with the kit when the switch is on; applies what the door held. */
  private async attach(): Promise<boolean> {
    if (this.stopped) return false;
    if (!(await this.client.connect())) return false;
    const kit = this.enabled ? this.deps.kit() : undefined;
    const told = this.told;
    const ack = await this.client.attach(kit, ATTACH_TIMEOUT_MS);
    this.sent = kit;
    this.reconnectMs = RECONNECT_MS.first;
    // a state the door told after it answered, read in the same chunk as the answer, is the newer one
    this.apply(ack, this.told === told);
    this.log.info("the sign-in door attached", { version: ack.doorVersion, state: ack.state.state, kit: kit !== undefined, viewers: ack.viewers?.length ?? 0, rekeyed: ack.rekeyed !== undefined, revoked: ack.revoked === true });
    // a door older than this platform looks at the feed now
    const mine = this.deps.install()?.version;
    if (mine !== undefined && ack.doorVersion !== mine && this.enabled) void this.client.update().catch(() => undefined);
    this.deps.onChange();
    return true;
  }

  private apply(ack: DoorAck, takeState: boolean): void {
    if (takeState) this.door = ack.state;
    this.version = ack.doorVersion;
    this.failed = undefined;
    if (ack.rekeyed) this.deps.nodes.adoptKey(ack.rekeyed);
    if (ack.revoked) this.deps.nodes.revokedAway();
    const until = this.now() + REOPEN_MS;
    for (const v of ack.viewers ?? []) this.reopen.set(v, until);
    this.attachedOnce = true;
  }

  /** The pipe is sought again while the switch is on; off, the one attach at start told the door to forget this machine. */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.deps.os !== "windows" || !this.enabled) return;
    const wait = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MS.max);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.attach()
        .catch((e: unknown) => {
          this.log.debug("the sign-in door was not attached again", { error: e instanceof Error ? e.message : String(e) });
          return false;
        })
        .then((ok) => {
          if (!ok) this.scheduleReconnect();
        });
    }, wait);
    if (typeof this.reconnectTimer === "object" && "unref" in this.reconnectTimer) this.reconnectTimer.unref();
  }

  /** Whether a viewer the door held may open this desktop again unasked: once, within REOPEN_MS of the attach. */
  allowsReopen(viewerKey: string): boolean {
    const until = this.reopen.get(viewerKey);
    if (until === undefined) return false;
    this.reopen.delete(viewerKey);
    return until >= this.now();
  }

  /** Something the kit carries changed: it goes to the door a moment later, while the switch is on, unless it is the same. */
  kitChanged(): void {
    if (this.stopped || this.deps.os !== "windows" || !this.enabled) return;
    if (this.kitTimer) clearTimeout(this.kitTimer);
    this.kitTimer = setTimeout(() => {
      this.kitTimer = undefined;
      const kit = this.deps.kit();
      if (!this.client.connected) return;
      // in no cluster now (left, or its grant ended): the door holds nothing for the machine
      if (!kit) {
        if (this.sent) void this.client.forget().catch(() => undefined);
        this.sent = undefined;
        return;
      }
      if (sameKit(kit, this.sent)) return;
      this.sent = kit;
      void this.client.kit(kit).catch((e: unknown) => {
        this.sent = undefined;
        this.log.warn("the sign-in door did not take the kit", { error: e instanceof Error ? e.message : String(e) });
      });
    }, KIT_DEBOUNCE_MS);
    if (typeof this.kitTimer === "object" && "unref" in this.kitTimer) this.kitTimer.unref();
  }

  /** The platform was updated: the door looks at the feed for the version that matches. */
  updated(): void {
    if (this.client.connected) void this.client.update().catch(() => undefined);
  }

  // --- the switch -------------------------------------------------------------------------------

  /** `remote.door`: on (the service installed the first time), off, or off and removed. */
  async set(on: boolean, opts: { remove?: boolean } = {}): Promise<void> {
    if (this.deps.os !== "windows") throw new RpcError("unsupported", "this machine has no sign-in door: Windows machines alone have one");
    if (this.installing) throw new RpcError("conflict", "the sign-in door is being installed or removed");
    if (!on) {
      this.deps.meta.set(DOOR_ENABLED_KEY, "0");
      this.failed = undefined;
      if (this.client.connected) await this.client.forget().catch((e: unknown) => this.log.warn("the sign-in door did not forget this machine", { error: e instanceof Error ? e.message : String(e) }));
      this.log.info("sign-in door switched off", { remove: opts.remove === true });
      this.deps.onChange();
      if (opts.remove) await this.elevated("uninstall");
      return;
    }
    const refused = this.deps.refusal();
    if (refused) throw new RpcError("conflict", refused);
    if (!this.deps.kit()) throw new RpcError("conflict", "this machine is in no cluster: it has no one to open its door to");
    this.deps.meta.set(DOOR_ENABLED_KEY, "1");
    this.failed = undefined;
    this.log.info("sign-in door switched on");
    this.deps.onChange();
    if (await this.attach().catch(() => false)) return;
    // no door here yet, or its service stopped: installed (or put right) with the administrator's prompt
    await this.elevated("install");
    const end = this.now() + PIPE_WAIT_MS;
    while (this.now() < end) {
      if (await this.attach().catch(() => false)) return;
      await Bun.sleep(500);
    }
    this.failed = "the door's service did not start";
    this.deps.onChange();
    throw new RpcError("unavailable", this.failed);
  }

  /** Runs the shim elevated: the install from this platform version, or the removal from where it is installed. */
  private async elevated(what: "install" | "uninstall"): Promise<void> {
    const elevate = this.deps.elevate ?? runElevated;
    mkdirSync(this.deps.tmpDir, { recursive: true });
    const resultFile = join(this.deps.tmpDir, `door-${what}-${process.pid}-${this.now()}.json`);
    let exe: string;
    let args: string[];
    if (what === "install") {
      const install = this.deps.install();
      if (!install) {
        this.failed = "the sign-in door is installed from an installed Cophyla, not from a source checkout";
        this.deps.onChange();
        throw new RpcError("unavailable", this.failed);
      }
      exe = join(install.versionDir, "bin", DOOR_EXE);
      args = ["install", "--from", install.versionDir, "--user-sid", await currentUserSid(this.deps.exec), "--result", resultFile];
    } else {
      exe = join(doorFolders().root, DOOR_EXE);
      args = ["uninstall", "--result", resultFile];
    }
    this.installing = true;
    this.deps.onChange();
    let failure: string | undefined;
    try {
      const r = await elevate(exe, args, { resultFile, timeoutMs: ELEVATED_MS });
      failure = elevationError(r);
      this.log.info(what === "install" ? "the sign-in door's install ran" : "the sign-in door's removal ran", { code: r.code, ...(failure ? { error: failure } : {}), ...(r.result?.version ? { version: r.result.version } : {}) });
    } finally {
      this.installing = false;
    }
    if (what === "uninstall" && !failure) {
      this.client.close();
      this.version = undefined;
      this.door = undefined;
    }
    if (failure) this.failed = what === "install" ? failure : undefined;
    this.deps.onChange();
    if (failure) throw new RpcError(failure.includes("declined") ? "cancelled" : "unavailable", failure);
  }

  /** The kit as it stands now, whether or not the switch is on: what a test hands a door. */
  kitNow(): Kit | undefined {
    return this.deps.kit();
  }

  /** Whether the daemon has attached since it started: what a test waits for. */
  get attached(): boolean {
    return this.attachedOnce && this.client.connected;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.kitTimer) clearTimeout(this.kitTimer);
    this.client.close();
  }
}
