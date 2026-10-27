// The sign-in door itself, the child the shim supervises. It keeps the kit the user's daemon
// handed it (in its own home, behind the protected folder), hears from the shim where the
// console is and whether the machine is on mains power, serves the daemon over the pipe
// (`door.attach`, `door.kit`, `door.forget`, `door.status`, `door.update`), and decides by
// `serveVerdict` when it holds the machine's desktop: a `Serving` for each period, joined to
// the primary as the machine. When the daemon attaches, a serving door stands down before it
// answers, so the daemon's own join never meets it; the answer carries what it held for the
// node: a new key for the grant, the grant's end, the viewers that were watching. The key and
// the end are kept on disk until the daemon has them, since a restart of the door must not
// lose a key the primary already uses.
//
// While the daemon is attached and the door has a kit that opens a door, it readies itself:
// the web viewer staged in the program folder and paired with the host (`prepare.ts`). It
// looks at the feed when the daemon asks (after a platform update) and when the primary
// refused its protocol, and exits EXIT_UPDATED once it staged a new version.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { DoorState } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { Gate } from "../gate/index.ts";
import type { Logger } from "../log.ts";
import { RpcPeer } from "../rpc/peer.ts";
import type { Store } from "../store/index.ts";
import type { ConsoleState } from "./constants.ts";
import { DOOR_PROTOCOL, EXIT_UPDATED, GRACE_MS, REOPEN_MS } from "./constants.ts";
import { Kit, kitRefusal } from "./kit.ts";
import type { Kit as KitType } from "./kit.ts";
import { pairDoorViewer, stageWeb, webStaged } from "./prepare.ts";
import type { UpdateWant } from "./program.ts";
import { serveVerdict } from "./serve.ts";
import { doorDesktop, Serving } from "./serving.ts";
import type { ServingDeps } from "./serving.ts";
import type { Shim } from "./shim.ts";
import { WEB_VERSION } from "../remote/manifest.ts";

/** What a serving period looks like from here: the tests make their own. */
export interface ServingLike {
  start(): void;
  stop(): Promise<string[]>;
  streaming(): boolean;
  linked(): boolean;
  /** The console changed: the primary hears where it is. */
  announce(): void;
}

export interface DoorDeps {
  home: string;
  program: string;
  shim: Shim;
  store: Store;
  bus: Bus;
  /** A gate that stamps the machine's id on what it audits, for a period it serves. */
  gateFor: (node: string) => Gate;
  log: Logger;
  platformVersion: string;
  /** A serving period; `Serving` without it. */
  serving?: (deps: ServingDeps) => ServingLike;
  /** Readies the door (stages the web viewer, pairs it); the real one without it. */
  prepare?: (kit: KitType) => Promise<void>;
  /** Looks at the feed; resolves with a staged version, or undefined. */
  update?: (want: UpdateWant, kit: KitType) => Promise<string | undefined>;
  /** Leaves the process for the shim to start the next version. */
  exit?: (code: number) => void;
  /** GONE_DEBOUNCE_MS and GRACE_MS, shorter in the tests. */
  timing?: { goneMs?: number; graceMs?: number };
  now?: () => number;
}

/** What the door holds for the node until the daemon takes it, kept on disk. */
interface Held {
  rekeyed?: string;
  revoked?: true;
}

const HELD_KEY = "door_held";
const PREPARED_KEY = "door_prepared";
/** How long after a failed readying the door tries again. */
const PREPARE_RETRY_MS = 10 * 60_000;

export class Door {
  private deps: DoorDeps;
  private log: Logger;
  private kit?: KitType;
  private held: Held;
  private console: ConsoleState = "active";
  private ac = true;
  private activeSince?: number;
  /** The connection the daemon attached on, while it is attached. */
  private daemon?: number;
  private goneSince: number;
  private conns = new Map<number, RpcPeer>();
  private serving?: ServingLike;
  private standingDown?: Promise<void>;
  /** Viewers the stand-downs ended, and when, for the daemon's next attach. */
  private viewers: { key: string; at: number }[] = [];
  private preparing?: Promise<void>;
  private prepareFailed?: { reason: string; at: number };
  private timer?: ReturnType<typeof setTimeout>;
  private lastState?: string;
  private lastPower?: string;
  private stopped = false;

  constructor(deps: DoorDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.goneSince = this.now();
    this.held = this.readHeld();
    this.kit = this.readKit();
    // the stream's state comes up the bus: a stream that starts or ends moves the rule and the power
    deps.bus.on("remote.state", () => this.evaluate());
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // --- the kit and what is held, on disk ------------------------------------------------------

  private get kitFile(): string {
    return join(this.deps.home, "data", "kit.json");
  }

  private readKit(): KitType | undefined {
    if (!existsSync(this.kitFile)) return undefined;
    try {
      const parsed = Kit.safeParse(JSON.parse(readFileSync(this.kitFile, "utf8")));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private setKit(kit: KitType | undefined): void {
    this.kit = kit;
    if (kit) {
      mkdirSync(join(this.deps.home, "data"), { recursive: true });
      writeFileSync(this.kitFile, JSON.stringify(kit), { encoding: "utf8", mode: 0o600 });
      // a key the daemon has now is no longer held for it
      if (this.held.rekeyed === kit.link.key) this.setHeld({ ...this.held, rekeyed: undefined });
    } else rmSync(this.kitFile, { force: true });
  }

  private readHeld(): Held {
    try {
      const v = JSON.parse(this.deps.store.meta.get(HELD_KEY) ?? "{}") as { rekeyed?: unknown; revoked?: unknown };
      return { ...(typeof v.rekeyed === "string" ? { rekeyed: v.rekeyed } : {}), ...(v.revoked === true ? { revoked: true as const } : {}) };
    } catch {
      return {};
    }
  }

  private setHeld(h: Held): void {
    this.held = { ...(h.rekeyed ? { rekeyed: h.rekeyed } : {}), ...(h.revoked ? { revoked: true as const } : {}) };
    this.deps.store.meta.set(HELD_KEY, JSON.stringify(this.held));
  }

  /** The grant's key now: one the primary handed while the door held the link, else the kit's. */
  private key(): string {
    return this.held.rekeyed ?? this.kit?.link.key ?? "";
  }

  /** Readied for the web viewer this platform pins: its marker, kept once a readying went through. */
  private prepared(): boolean {
    return this.deps.store.meta.get(PREPARED_KEY) === WEB_VERSION;
  }

  // --- the shim -------------------------------------------------------------------------------

  /** Starts with the shim's hello: where the console is now, and the power. */
  start(): void {
    const { shim } = this.deps;
    shim.on({
      console: (c) => this.setConsole(c),
      power: (ac) => {
        this.ac = ac;
        this.evaluate();
      },
      open: (conn) => this.open(conn),
      line: (conn, line) => this.conns.get(conn)?.onText(line),
      close: (conn) => this.closed(conn),
      stop: () => void this.stop().then(() => (this.deps.exit ?? process.exit)(0)),
      end: () => void this.stop().then(() => (this.deps.exit ?? process.exit)(0)),
    });
    void shim.ready().then((h) => {
      this.setConsole(h.console);
      this.ac = h.ac;
      this.log.info("the sign-in door is up", { version: this.deps.platformVersion, console: h.console, ac: h.ac, kit: this.kit !== undefined, shim: h.version });
      this.evaluate();
    });
  }

  private setConsole(c: ConsoleState): void {
    if (c === this.console) return;
    const was = this.console;
    this.console = c;
    if (c === "active") this.activeSince = this.now();
    else this.activeSince = undefined;
    this.log.info("the console changed", { from: was, to: c });
    this.serving?.announce();
    this.evaluate();
  }

  // --- the pipe's clients ----------------------------------------------------------------------

  private open(conn: number): void {
    const rpc = new RpcPeer({
      write: (text) => {
        this.deps.shim.send(conn, text);
        return true;
      },
      log: this.log,
      label: `pipe ${conn}`,
      onRequest: (method, params) => this.onRequest(conn, method, params as Record<string, unknown>),
    });
    this.conns.set(conn, rpc);
  }

  private closed(conn: number): void {
    this.conns.get(conn)?.close("the client went");
    this.conns.delete(conn);
    if (this.daemon !== conn) return;
    this.daemon = undefined;
    this.goneSince = this.now();
    this.log.info("Cophyla went from this machine; the door looks again in a moment");
    this.evaluate();
  }

  private async onRequest(conn: number, method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "door.attach": {
        // whatever it speaks, a daemon that attaches is here: the door does not serve beside it
        this.daemon = conn;
        await this.standDown("Cophyla started here");
        const viewers = this.takeViewers();
        if (p["protocol"] !== DOOR_PROTOCOL) {
          this.log.warn("the daemon speaks another door protocol; its kit is not taken", { theirs: p["protocol"], mine: DOOR_PROTOCOL });
          return this.ack(viewers);
        }
        // a grant the primary ended is not taken back from a daemon that has not heard it yet
        if (p["kit"] === undefined || this.held.revoked) this.setKit(undefined);
        else this.takeKit(p["kit"]);
        const ack = this.ack(viewers);
        // what the daemon is handed now is its own
        if (this.held.revoked) this.setHeld({ ...this.held, revoked: undefined });
        this.evaluate();
        // a state told while the answer was on its way would be overtaken by the answer's: told again after it
        setTimeout(() => {
          this.lastState = undefined;
          this.publish();
        }, 0);
        return ack;
      }
      case "door.kit": {
        if (conn !== this.daemon) throw new RpcError("conflict", "attach first");
        this.takeKit(p["kit"]);
        this.evaluate();
        return {};
      }
      case "door.forget": {
        if (conn !== this.daemon) throw new RpcError("conflict", "attach first");
        this.setKit(undefined);
        await this.standDown("switched off");
        this.log.info("the sign-in door was switched off");
        this.evaluate();
        return {};
      }
      case "door.status":
        return this.state();
      case "door.update": {
        if (conn !== this.daemon) throw new RpcError("conflict", "attach first");
        const kit = this.kit;
        if (kit) void this.update({ version: kit.platform.version }).catch((e: unknown) => this.log.warn("the sign-in door did not update", { error: e instanceof Error ? e.message : String(e) }));
        return {};
      }
      default:
        throw new RpcError("unsupported", `${method} is not the door's`);
    }
  }

  private takeKit(raw: unknown): void {
    const parsed = Kit.safeParse(raw);
    if (!parsed.success) throw new RpcError("invalid", "that is not a kit the door reads", parsed.error.issues);
    this.setKit(parsed.data);
  }

  private ack(viewers: string[]): Record<string, unknown> {
    return {
      doorVersion: this.deps.platformVersion,
      state: this.state(),
      ...(this.held.rekeyed ? { rekeyed: this.held.rekeyed } : {}),
      ...(this.held.revoked ? { revoked: true } : {}),
      ...(viewers.length > 0 ? { viewers } : {}),
    };
  }

  // --- the rule ---------------------------------------------------------------------------------

  /** Where the door stands, as the daemon tells it in the machine's `remote.state`. */
  state(): DoorState {
    const version = { version: this.deps.platformVersion };
    if (!this.kit) return { state: "off", ...version };
    const refusal = kitRefusal(this.kit, this.now());
    if (refusal) return { state: "unavailable", reason: refusal, ...version };
    if (this.serving) return { state: "serving", ...version };
    if (this.preparing) return { state: "preparing", ...version };
    if (this.prepared()) return { state: "ready", ...version };
    if (this.prepareFailed) return { state: "unavailable", reason: this.prepareFailed.reason, ...version };
    return { state: this.daemon !== undefined ? "preparing" : "unavailable", ...(this.daemon === undefined ? { reason: "it readies itself while Cophyla runs here" } : {}), ...version };
  }

  /** Looks at the rule now: serves, stands down or waits, readies itself, tells its state and what the power rule needs. */
  evaluate(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const now = this.now();
    const verdict = serveVerdict({
      now,
      refusal: kitRefusal(this.kit, now),
      attached: this.daemon !== undefined,
      goneSince: this.goneSince,
      console: this.console,
      ...(this.activeSince !== undefined ? { activeSince: this.activeSince } : {}),
      serving: this.serving !== undefined,
      streaming: this.serving?.streaming() ?? false,
      ...(this.deps.timing ?? {}),
    });
    if (verdict.serve && !this.serving && !this.standingDown) this.serve(verdict.why);
    else if (!verdict.serve && this.serving) void this.standDown(verdict.why);
    let next = verdict.serve ? undefined : verdict.after;
    // a grace that ends is looked at again when it does
    if (verdict.serve && this.console === "active" && this.activeSince !== undefined) next = this.activeSince + (this.deps.timing?.graceMs ?? GRACE_MS);
    if (next !== undefined) {
      this.timer = setTimeout(() => this.evaluate(), Math.max(0, next - now) + 10);
      if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
    }
    if (!verdict.serve && this.daemon !== undefined) this.maybePrepare();
    this.publish();
  }

  private serve(why: string): void {
    const kit = this.kit;
    if (!kit) return;
    this.log.info("the sign-in door holds this machine's desktop", { why, console: this.console });
    const make = this.deps.serving ?? ((d: ServingDeps) => new Serving(d));
    const serving = make({
      kit,
      program: this.deps.program,
      dataDir: join(this.deps.home, "data"),
      store: this.deps.store,
      bus: this.deps.bus,
      log: this.log.child("serving"),
      doorState: () => this.state(),
      key: () => this.key(),
      gate: this.deps.gateFor(kit.node.id),
      platformVersion: this.deps.platformVersion,
      console: () => this.console,
      onRekey: (key) => {
        this.log.info("the primary handed this machine's grant a new key; kept for Cophyla");
        this.setHeld({ ...this.held, rekeyed: key });
      },
      onRevoked: () => {
        this.setHeld({ ...this.held, revoked: true });
        this.setKit(undefined);
        void this.standDown("the primary ended this machine's grant");
      },
      onChange: () => this.evaluate(),
      onProtocol: (theirs) => void this.update({ protocol: theirs }).catch((e: unknown) => this.log.warn("the sign-in door did not update to the primary's protocol", { error: e instanceof Error ? e.message : String(e) })),
    });
    this.serving = serving;
    serving.start();
  }

  /** Ends the period it serves, in order; the viewers that were watching are kept for the daemon's next attach. */
  private standDown(why: string): Promise<void> {
    if (this.standingDown) return this.standingDown;
    const serving = this.serving;
    if (!serving) return Promise.resolve();
    this.log.info("the sign-in door stands down", { why });
    this.standingDown = serving
      .stop()
      .catch((e: unknown) => {
        this.log.warn("the sign-in door did not stand down cleanly", { error: e instanceof Error ? e.message : String(e) });
        return [] as string[];
      })
      .then((viewers) => {
        const at = this.now();
        this.viewers = [...this.viewers.filter((v) => at - v.at < GRACE_MS + REOPEN_MS), ...viewers.map((key) => ({ key, at }))];
        this.serving = undefined;
        this.standingDown = undefined;
        this.evaluate();
      });
    return this.standingDown;
  }

  /** The viewers the door ended for the daemon's coming, fresh ones alone, handed over once. */
  private takeViewers(): string[] {
    const now = this.now();
    const keys = this.viewers.filter((v) => now - v.at < GRACE_MS + REOPEN_MS).map((v) => v.key);
    this.viewers = [];
    return [...new Set(keys)];
  }

  /** Readies the door while the daemon is here and the kit opens a door: once, and again later after a failure. */
  private maybePrepare(): void {
    const kit = this.kit;
    // the web viewer gone from the program folder since: readied again
    if (!this.deps.prepare && this.prepared() && !webStaged(this.deps.program)) this.deps.store.meta.set(PREPARED_KEY, "");
    if (!kit || this.preparing || this.serving || this.prepared() || kitRefusal(kit, this.now())) return;
    if (this.prepareFailed && this.now() - this.prepareFailed.at < PREPARE_RETRY_MS) return;
    const prepare = this.deps.prepare ?? ((k: KitType) => this.prepare(k));
    this.preparing = prepare(kit)
      .then(() => {
        this.deps.store.meta.set(PREPARED_KEY, WEB_VERSION);
        this.prepareFailed = undefined;
        this.log.info("the sign-in door is ready");
      })
      .catch((e: unknown) => {
        const reason = e instanceof Error ? e.message : String(e);
        this.prepareFailed = { reason, at: this.now() };
        this.log.warn("the sign-in door could not ready itself", { reason });
      })
      .finally(() => {
        this.preparing = undefined;
        this.evaluate();
      });
    this.publish();
  }

  /** The web viewer staged and paired, the desktop module brought up for that alone. */
  private async prepare(kit: KitType): Promise<void> {
    await stageWeb(this.deps.program, join(this.deps.home, "tmp"), this.log.child("prepare"));
    const desktop = doorDesktop({ kit, program: this.deps.program, dataDir: join(this.deps.home, "data"), store: this.deps.store, bus: this.deps.bus, log: this.log.child("prepare"), doorState: () => this.state(), link: () => undefined });
    await pairDoorViewer(desktop.remote, async () => {
      await desktop.remote.stop().catch(() => undefined);
      await desktop.sidecars.stopAll().catch(() => undefined);
    });
  }

  /** Tells the daemon where the door stands, and the shim what the power rule needs, when either changed. */
  private publish(): void {
    // stopped: its store may be closed already
    if (this.stopped) return;
    const s = this.state();
    const text = JSON.stringify(s);
    if (text !== this.lastState) {
      this.lastState = text;
      const daemon = this.daemon !== undefined ? this.conns.get(this.daemon) : undefined;
      daemon?.notify("door.state", s);
    }
    const ready = s.state === "ready" || s.state === "serving";
    const streaming = this.serving?.streaming() ?? false;
    const power = `${ready} ${streaming}`;
    if (power !== this.lastPower) {
      this.lastPower = power;
      this.deps.shim.want(ready, streaming);
    }
  }

  // --- updates and the end ---------------------------------------------------------------------

  /** Looks at the feed; a version staged means standing down and exiting for the shim to start it. */
  private async update(want: UpdateWant): Promise<void> {
    const kit = this.kit;
    const run = this.deps.update;
    if (!kit || !run) return;
    const staged = await run(want, kit);
    if (!staged) return;
    this.log.info("the sign-in door moves to a new version", { from: this.deps.platformVersion, to: staged });
    await this.stop();
    (this.deps.exit ?? process.exit)(EXIT_UPDATED);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.standDown("the door is stopping");
    for (const rpc of this.conns.values()) rpc.close("the door is stopping");
    this.conns.clear();
  }

  /** For the tests: whether it serves now, and the viewers it would hand over. */
  get servingNow(): boolean {
    return this.serving !== undefined;
  }
}
