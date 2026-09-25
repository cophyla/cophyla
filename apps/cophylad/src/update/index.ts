// The update module: keeps the node current with no account. On a schedule it reads one
// file from the public feed, `<feed>/<channel>/<os>-<arch>.json`, whose path is everything
// the request says about this node; keeps the entries signed by a release key, for this OS,
// architecture and channel, and inside our protocol version; downloads the newest platform
// and brain above what runs, checks size and hash, and stages them. Voice models are the
// third component: they carry a name instead of an OS, are wanted only while a stage that
// needs one is on, and are unpacked under `data/models/<name>/` where the engines load them. A staged brain is
// applied by restarting brain-link, which promotes it before the spawn and verifies it; a
// staged platform is applied by stopping the daemon when nothing waits on it (and, on the
// automatic path, no desktop app is attached), because the launcher rotates the pointers at
// the next start. A daemon whose `current` pointer names another version is stale and stops
// the same way. Every drop and refusal is logged with its reason.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, releaseFileName, RpcError } from "@cophyla/protocol";
import type { ClientNotificationParams, Release } from "@cophyla/protocol";
import type { BrainLink } from "../brain-link/link.ts";
import type { BrainLocation } from "../brain-link/locate.ts";
import type { Bus } from "../bus.ts";
import type { UpdateConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";
import { BrainStore, readBrainRelease, verifyBrainDir } from "./brain.ts";
import { download } from "./download.ts";
import { feedUrl, hostTarget, newest, selectReleases, urlAllowed } from "./feed.ts";
import { ModelStore } from "./models.ts";
import { PlatformStore } from "./platform.ts";
import type { Install } from "./platform.ts";

type UpdateState = ClientNotificationParams<"update.state">;
type Component = "platform" | "brain";
/** What a state row is kept under: one per component, one per model by name. */
type ComponentKey = "platform" | "brain" | `model:${string}`;

const modelKey = (name: string): ComponentKey => `model:${name}`;

export interface UpdateDeps {
  config: UpdateConfig;
  /** `<home>/data`: brain releases and downloads live under it. */
  dataDir: string;
  nodeId: string;
  platformVersion: string;
  /** The release keys' public halves; a release must check against one. */
  keys: string[];
  /** The installed platform, when the daemon runs from one; a checkout takes no platform updates. */
  install?: Install;
  /** The brain link, once the daemon has one. */
  brain: () => BrainLink | undefined;
  /** Where the brain would be found now, the same rule brain-link spawns by. */
  locate: () => BrainLocation | undefined;
  /** Why the daemon is not idle: open asks, held hooks, agent prompts, brain requests. Empty means idle. */
  busy: () => string[];
  /** A desktop app is attached: a staged platform then waits for the user or the tray. */
  uiConnected: () => boolean;
  /** Stops the daemon so the launcher can rotate; `process.exit` in production. */
  exit: (code: number) => void;
  store: Store;
  bus: Bus;
  log: Logger;
  /** A model became current: the voice module loads it from this directory. */
  onModel?: (name: string, dir: string) => void;
  /** Whether a staged model may replace the one in use: no conversation is running. */
  voiceIdle?: () => boolean;
  /** The beta feed and the bearer that reads it, from the account; absent when the account has no beta channel. */
  beta?: () => { feed: string; headers: Record<string, string> } | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  /** This node as the feed names it; the host's by default. */
  target?: { os: string; arch: string };
  /** How long a staged release waits between attempts to apply itself while the daemon is busy. */
  applyRetryMs?: number;
  /** Between the last `update.state` and the exit, so the answer and the state reach clients. */
  exitDelayMs?: number;
  tar?: string;
}

interface ComponentState {
  available?: string;
  staged?: string;
  progress?: number;
}

export interface Trigger {
  /** The feed was read and `available` published; rejects when it could not be read. */
  evaluated: Promise<void>;
  /** Staging finished too, one way or the other. */
  done: Promise<void>;
}

const KV_NS = "update";
const KV_BROKEN = "broken";
const APPLY_RETRY_MS = 30_000;
const EXIT_DELAY_MS = 200;
const UPDATABLE_ORIGINS = new Set<BrainLocation["origin"]>(["installed", "bundled"]);

export class Update {
  private deps: UpdateDeps;
  private log: Logger;
  private config: UpdateConfig;
  private platform?: PlatformStore;
  private brains: BrainStore;
  private models: ModelStore;
  private states = new Map<ComponentKey, ComponentState>();
  /** The models a stage asked for; only these are looked for in the feed. */
  private wanted = new Set<string>();
  /** A model being fetched: a second ask joins the first. */
  private fetching = new Map<string, Promise<string | undefined>>();
  private target: { os: string; arch: string };
  private timer?: ReturnType<typeof setTimeout>;
  private applyTimer?: ReturnType<typeof setTimeout>;
  private running?: Trigger;
  private abort = new AbortController();
  private downloading = false;
  /** The beta feed's origin while the account serves it: the only origin the bearer goes to. */
  private betaOrigin: string | undefined;
  private disposed = false;
  private exiting = false;
  private checks = 0;

  constructor(deps: UpdateDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.config = deps.config;
    this.target = deps.target ?? hostTarget();
    this.platform = deps.install ? new PlatformStore(deps.install, deps.tar ? { tar: deps.tar } : {}) : undefined;
    this.brains = new BrainStore(deps.dataDir);
    this.models = new ModelStore(deps.dataDir, deps.tar ? { tar: deps.tar } : {});
  }

  private stateOf(key: ComponentKey): ComponentState {
    let s = this.states.get(key);
    if (!s) {
      s = {};
      this.states.set(key, s);
    }
    return s;
  }

  /** How many feed reads ran. */
  get checkCount(): number {
    return this.checks;
  }

  get installed(): boolean {
    return this.platform !== undefined;
  }

  // --- lifecycle ------------------------------------------------------------------------

  /** Reconciles what is on disk, then schedules the checks when they are on. */
  start(): void {
    if (this.platform) {
      const broken = new Set(this.brokenVersions());
      for (const v of this.platform.brokenVersions()) broken.add(v);
      if (broken.size > 0) this.deps.store.kv.put(KV_NS, KV_BROKEN, [...broken]);
      const keep = [this.platform.pointer("current"), this.platform.pointer("previous"), this.platform.pointer("staged"), this.deps.install!.version].filter((v): v is string => v !== undefined);
      const removed = this.platform.prune(keep);
      if (removed.length > 0) this.log.info("platform versions pruned", { removed, kept: keep });
      const staged = this.platform.staged();
      if (staged) this.stateOf("platform").staged = staged;
      if (this.isStale()) this.log.warn("platform stale: the current pointer names another version; stopping when idle", { running: this.deps.platformVersion, current: this.platform.pointer("current") });
    } else {
      this.log.info("platform updates off: not installed", { running: this.deps.platformVersion });
    }
    const stagedBrain = this.brains.stagedVersion();
    if (stagedBrain) this.stateOf("brain").staged = stagedBrain;
    for (const name of this.models.known()) {
      const staged = this.models.stagedVersion(name);
      if (staged) this.stateOf(modelKey(name)).staged = staged;
    }
    if (this.config.allow_insecure_feed) this.log.warn("INSECURE FEED ALLOWED: http off loopback is accepted for the feed and its artifacts; for testing only", { feed: this.config.feed });
    if (!this.config.enabled) {
      this.log.info("update checks off; update.check still works");
      return;
    }
    this.timer = setTimeout(() => void this.tick(), this.config.first_check_delay_ms);
    this.timer.unref?.();
    if (this.somethingWaits()) this.scheduleApply();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.applyTimer) clearTimeout(this.applyTimer);
    this.timer = undefined;
    this.applyTimer = undefined;
    this.abort.abort();
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    await this.trigger("schedule").done;
    if (this.disposed) return;
    this.timer = setTimeout(() => void this.tick(), this.config.check_interval_ms);
    this.timer.unref?.();
  }

  // --- state ------------------------------------------------------------------------------

  /** One `update.state` per component, models included, for the post-hello snapshot. */
  snapshot(): UpdateState[] {
    const names = new Set([...this.wanted, ...this.models.known()]);
    return [this.state("platform"), this.state("brain"), ...[...names].sort().map((n) => this.state(modelKey(n)))];
  }

  private state(key: ComponentKey): UpdateState {
    const s = this.stateOf(key);
    const name = key.startsWith("model:") ? key.slice("model:".length) : undefined;
    const current = name !== undefined ? (this.models.currentVersion(name) ?? "none") : key === "platform" ? this.deps.platformVersion : (this.brainCurrent() ?? "none");
    return {
      node: this.deps.nodeId,
      component: name !== undefined ? "model" : (key as Component),
      ...(name !== undefined ? { name } : {}),
      current,
      ...(s.available !== undefined ? { available: s.available } : {}),
      ...(s.staged !== undefined ? { staged: s.staged } : {}),
      ...(s.progress !== undefined ? { progress: s.progress } : {}),
    };
  }

  private publish(key: ComponentKey): void {
    this.deps.bus.emit("update.state", this.state(key));
  }

  /** The version of the brain that runs, else of the one that would run. */
  private brainCurrent(): string | undefined {
    const link = this.deps.brain();
    if (link?.brainVersion) return link.brainVersion;
    const loc = link?.location ?? this.deps.locate();
    if (loc && UPDATABLE_ORIGINS.has(loc.origin)) return readBrainRelease(loc.cwd)?.version;
    return undefined;
  }

  /** The brain comes from the store or the bundled seed, or there is none: a release from the feed may replace it. */
  private brainUpdatable(): boolean {
    if (!this.deps.brain()) return false;
    const loc = this.deps.locate();
    return loc === undefined || UPDATABLE_ORIGINS.has(loc.origin);
  }

  private brokenVersions(): string[] {
    const v = this.deps.store.kv.get(KV_NS, KV_BROKEN);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  }

  /** The `current` pointer names another version: the launcher rotated while this daemon ran. */
  isStale(): boolean {
    if (!this.platform) return false;
    const current = this.platform.pointer("current");
    return current !== undefined && current !== this.deps.platformVersion;
  }

  busyReasons(): string[] {
    const reasons = this.deps.busy();
    if (this.downloading) reasons.push("a download is running");
    return reasons;
  }

  private somethingWaits(): boolean {
    if (this.brains.stagedVersion() !== undefined || this.platform?.staged() !== undefined || this.isStale()) return true;
    return [...this.wanted].some((name) => this.models.stagedVersion(name) !== undefined);
  }

  // --- models ----------------------------------------------------------------------------------

  /** The models a voice stage asked for, so a check looks for them. */
  get wantedModels(): string[] {
    return [...this.wanted];
  }

  /** The directory of a model in use, when there is one. */
  modelDir(name: string): string | undefined {
    return this.models.currentDir(name);
  }

  /**
   * The directory of `name`, fetched and promoted if it is not there yet. A model already
   * current answers at once; a first install promotes what it staged, since nothing is
   * loaded that a promotion could pull from under an engine.
   */
  async ensureModel(name: string): Promise<string | undefined> {
    this.wanted.add(name);
    const current = this.models.currentDir(name);
    if (current) return current;
    const inflight = this.fetching.get(name);
    if (inflight) return inflight;
    const run = (async (): Promise<string | undefined> => {
      // A staged copy from an earlier run is a first install: nothing holds the old one.
      let staged = this.models.stagedVersion(name);
      if (!staged) {
        try {
          await this.trigger(`model ${name}`).done;
        } catch {
          // the reason is logged by the check
        }
        // The check ends in `maybeApply`, which promotes a staged model when voice is idle.
        const promoted = this.models.currentDir(name);
        if (promoted) return promoted;
        staged = this.models.stagedVersion(name);
      }
      if (!staged) return undefined;
      return this.promoteModel(name, staged) ? this.models.currentDir(name) : undefined;
    })().finally(() => this.fetching.delete(name));
    this.fetching.set(name, run);
    return run;
  }

  private promoteModel(name: string, version: string): boolean {
    try {
      this.models.promote(name, version);
    } catch (e) {
      this.log.warn("model not promoted", { model: name, version, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
    const s = this.stateOf(modelKey(name));
    s.staged = undefined;
    this.log.info("model release promoted", { model: name, version });
    this.publish(modelKey(name));
    const dir = this.models.currentDir(name);
    if (dir) this.deps.onModel?.(name, dir);
    return true;
  }

  private async stageModel(name: string, release: Release): Promise<void> {
    const key = modelKey(name);
    const v = release.version;
    if (this.models.stagedVersion(name) === v || this.models.currentVersion(name) === v) {
      this.stateOf(key).staged = this.models.stagedVersion(name);
      this.publish(key);
      return;
    }
    const file = await this.fetchArtifact(release, key);
    if (!file) {
      this.publish(key);
      return;
    }
    try {
      const dir = await this.models.stage(file, release);
      this.stateOf(key).staged = v;
      this.log.info("model staged", { model: name, version: v, dir });
    } catch (e) {
      this.log.warn("model staging failed", { model: name, version: v, error: e instanceof Error ? e.message : String(e) });
    } finally {
      rmSync(file, { force: true });
      this.publish(key);
    }
  }

  // --- checking -----------------------------------------------------------------------------

  /** Starts a check, or joins the one running. */
  trigger(reason: string): Trigger {
    if (this.running) return this.running;
    let evaluated!: () => void;
    let failed!: (e: unknown) => void;
    const evaluatedPromise = new Promise<void>((resolve, reject) => {
      evaluated = resolve;
      failed = reject;
    });
    evaluatedPromise.catch(() => {});
    const done = this.check(reason, { evaluated, failed })
      .catch((e) => {
        this.log.warn("update check failed", { error: e instanceof Error ? e.message : String(e) });
        failed(e);
      })
      .finally(() => {
        this.running = undefined;
      });
    this.running = { evaluated: evaluatedPromise, done };
    return this.running;
  }

  private async check(reason: string, cb: { evaluated: () => void; failed: (e: unknown) => void }): Promise<void> {
    if (this.disposed || this.exiting) {
      cb.failed(new RpcError("unavailable", "the daemon is stopping"));
      return;
    }
    this.checks++;
    const { os, arch } = this.target;
    // The beta channel lives on the account's server behind its bearer; without an account
    // on a plan that has it, the stable feed is read instead and the config's wish is noted.
    let channel = this.config.channel;
    let headers: Record<string, string> = {};
    let feed = this.config.feed;
    if (channel === "beta") {
      const beta = this.deps.beta?.();
      if (beta) {
        feed = beta.feed;
        headers = beta.headers;
        this.betaOrigin = new URL(beta.feed).origin;
      } else {
        this.log.warn("the beta channel needs an account on a plan that has it; reading stable");
        channel = "stable";
        this.betaOrigin = undefined;
      }
    } else this.betaOrigin = undefined;
    const url = feedUrl(feed, channel, os, arch);
    if (!urlAllowed(url, this.config.allow_insecure_feed)) {
      this.log.warn("feed refused: not https and not loopback", { url });
      cb.failed(new RpcError("denied", `feed ${url} is not https; set [update] allow_insecure_feed for a LAN feed`));
      return;
    }
    if (url.startsWith("http:")) this.log.warn("INSECURE FEED in use", { url });
    this.log.info("update check", { reason, url });
    let body: unknown;
    try {
      // Nothing but the path says who asks: no query, and no header of ours but the account's bearer on its own server.
      const res = await (this.deps.fetch ?? fetch)(url, { signal: this.abort.signal, redirect: "follow", ...(Object.keys(headers).length > 0 ? { headers } : {}) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.warn("feed not read", { url, error: message });
      cb.failed(new RpcError("unavailable", `feed not read: ${message}`));
      return;
    }
    const { accepted, dropped } = selectReleases(body, { os, arch, channel, protocolVersion: PROTOCOL_VERSION }, this.deps.keys);
    for (const d of dropped) this.log.warn("release dropped", { reason: d.reason, component: d.release["component"], version: d.release["version"] });
    // A model is named as well as versioned: four `model@1.0.0` lines say nothing.
    this.log.info("feed read", { accepted: accepted.map((r) => (r.component === "model" ? `model/${r.name}@${r.version}` : `${r.component}@${r.version}`)), dropped: dropped.length });

    let platformNext: Release | undefined;
    if (this.platform) {
      // Markers the launcher wrote since this daemon started count too, and are remembered.
      const skip = new Set([...this.brokenVersions(), ...this.platform.brokenVersions()]);
      if (skip.size > this.brokenVersions().length) this.deps.store.kv.put(KV_NS, KV_BROKEN, [...skip]);
      platformNext = newest(accepted, "platform", this.deps.platformVersion, skip);
    }
    const brainNext = this.brainUpdatable() ? newest(accepted, "brain", this.brainCurrent() ?? "0.0.0") : undefined;
    if (this.deps.brain() && !this.brainUpdatable()) this.log.info("brain updates off: the brain comes from the operator", { origin: this.deps.locate()?.origin });

    // A model is wanted only while a stage that needs it is on; the newest above what is current.
    const modelNext = new Map<string, Release>();
    for (const name of this.wanted) {
      const mine = accepted.filter((r) => r.component === "model" && r.name === name);
      const next = newest(mine, "model", this.models.currentVersion(name) ?? "0.0.0");
      if (next) modelNext.set(name, next);
      this.stateOf(modelKey(name)).available = next?.version ?? this.models.currentVersion(name);
    }

    this.stateOf("platform").available = platformNext?.version;
    this.stateOf("brain").available = brainNext?.version;
    this.publish("platform");
    this.publish("brain");
    for (const name of this.wanted) this.publish(modelKey(name));
    cb.evaluated();

    if (platformNext) await this.stagePlatform(platformNext);
    if (brainNext) await this.stageBrain(brainNext);
    for (const [name, release] of modelNext) await this.stageModel(name, release);
    this.maybeApply();
  }

  private downloadDir(): string {
    const dir = join(this.deps.dataDir, "downloads");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async fetchArtifact(release: Release, component: ComponentKey): Promise<string | undefined> {
    if (!urlAllowed(release.url, this.config.allow_insecure_feed)) {
      this.log.warn("release dropped", { reason: "artifact url not https", component, version: release.version, url: release.url });
      return undefined;
    }
    const dest = join(this.downloadDir(), releaseFileName(release));
    this.downloading = true;
    this.stateOf(component).progress = 0;
    this.publish(component);
    try {
      // The bearer goes only to the beta feed's own origin, never to a mirror an entry may point at.
      const beta = this.betaOrigin ? this.deps.beta?.() : undefined;
      const headers = beta && this.betaOrigin && new URL(release.url).origin === this.betaOrigin ? beta.headers : undefined;
      await download(release.url, dest, {
        size: release.size,
        sha256: release.sha256,
        signal: this.abort.signal,
        ...(headers ? { headers } : {}),
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
        onProgress: (f) => {
          this.stateOf(component).progress = f;
          this.publish(component);
        },
      });
      return dest;
    } catch (e) {
      this.log.warn(`${component} download failed`, { version: release.version, url: release.url, error: e instanceof Error ? e.message : String(e) });
      return undefined;
    } finally {
      this.downloading = false;
      this.stateOf(component).progress = undefined;
    }
  }

  private async stagePlatform(release: Release): Promise<void> {
    const platform = this.platform!;
    const v = release.version;
    if (platform.staged() === v || platform.pointer("current") === v) {
      this.stateOf("platform").staged = platform.staged();
      this.publish("platform");
      return;
    }
    const file = await this.fetchArtifact(release, "platform");
    if (!file) {
      this.publish("platform");
      return;
    }
    try {
      await platform.stage(file, release);
      this.stateOf("platform").staged = v;
      this.log.info("platform staged", { version: v, dir: platform.versionDir(v) });
    } catch (e) {
      this.log.warn("platform staging failed", { version: v, error: e instanceof Error ? e.message : String(e) });
    } finally {
      rmSync(file, { force: true });
      this.publish("platform");
    }
  }

  private async stageBrain(release: Release): Promise<void> {
    const v = release.version;
    if (this.brains.stagedVersion() === v) {
      this.stateOf("brain").staged = v;
      this.publish("brain");
      return;
    }
    const file = await this.fetchArtifact(release, "brain");
    if (!file) {
      this.publish("brain");
      return;
    }
    try {
      const dir = this.brains.stage(file, release);
      const check = await verifyBrainDir(dir, this.deps.keys);
      if (!check.ok) {
        rmSync(dir, { recursive: true, force: true });
        this.log.warn("brain staging failed", { version: v, reason: check.reason });
        return;
      }
      this.stateOf("brain").staged = v;
      this.log.info("brain staged", { version: v, dir });
    } catch (e) {
      rmSync(file, { force: true });
      this.log.warn("brain staging failed", { version: v, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.publish("brain");
    }
  }

  // --- applying -----------------------------------------------------------------------------

  private scheduleApply(): void {
    if (this.disposed || this.applyTimer || !this.config.auto_apply) return;
    this.applyTimer = setTimeout(() => {
      this.applyTimer = undefined;
      this.maybeApply();
    }, this.deps.applyRetryMs ?? APPLY_RETRY_MS);
    this.applyTimer.unref?.();
  }

  /** The automatic path: a staged brain when idle; a staged or rotated platform when idle and no desktop app is attached. */
  private maybeApply(): void {
    if (this.disposed || this.exiting || !this.config.auto_apply || !this.somethingWaits()) return;
    const reasons = this.busyReasons();
    if (reasons.length > 0) {
      this.log.info("staged release waits: daemon busy", { reasons });
      this.scheduleApply();
      return;
    }
    const link = this.deps.brain();
    const stagedBrain = this.brains.stagedVersion();
    if (link && stagedBrain && this.brainUpdatable()) {
      this.log.info("applying brain release", { version: stagedBrain, by: "auto" });
      void link.restart();
    }
    // A model in use is replaced only between conversations: an engine holds its files open.
    if (this.deps.voiceIdle?.() ?? true) {
      for (const name of this.wanted) {
        const staged = this.models.stagedVersion(name);
        if (staged) this.promoteModel(name, staged);
      }
    } else if ([...this.wanted].some((n) => this.models.stagedVersion(n))) {
      this.log.info("staged model waits: a voice conversation is running");
      this.scheduleApply();
    }
    if (this.platform && (this.platform.staged() || this.isStale())) {
      if (this.deps.uiConnected()) {
        this.log.info("staged platform waits: a desktop app is attached; apply from the tray or at the next start", { staged: this.platform.staged(), stale: this.isStale() });
        this.scheduleApply();
        return;
      }
      this.exitForPlatform("auto");
    }
  }

  /** `update.apply`: the explicit path needs only an idle daemon. */
  async apply(component?: "platform" | "brain" | "model", name?: string): Promise<void> {
    if (component === "model") {
      if (!name) throw new RpcError("invalid", "a model release needs its name");
      const staged = this.models.stagedVersion(name);
      if (!staged) throw new RpcError("not_found", `no ${name} release is staged`);
      if (!(this.deps.voiceIdle?.() ?? true)) throw new RpcError("conflict", "busy: a voice conversation is running", { reasons: ["a voice conversation is running"] });
      this.log.info("applying model release", { model: name, version: staged, by: "request" });
      if (!this.promoteModel(name, staged)) throw new RpcError("unavailable", `${name} ${staged} could not be promoted`);
      return;
    }
    const which: Component = component ?? (this.platform && (this.platform.staged() || this.isStale()) ? "platform" : "brain");
    if (which === "brain") {
      const link = this.deps.brain();
      if (!link) throw new RpcError("unsupported", "this node runs no brain");
      const staged = this.brains.stagedVersion();
      if (!staged) throw new RpcError("not_found", "no brain release is staged");
      if (!this.brainUpdatable()) throw new RpcError("conflict", `the brain comes from ${this.deps.locate()?.origin}; a staged release cannot replace it`);
      const reasons = this.busyReasons();
      if (reasons.length > 0) throw new RpcError("conflict", `busy: ${reasons.join("; ")}`, { reasons });
      this.log.info("applying brain release", { version: staged, by: "request" });
      await link.restart();
      return;
    }
    if (!this.platform) throw new RpcError("unsupported", "the platform is not installed; a checkout updates with git");
    const staged = this.platform.staged();
    const stale = this.isStale();
    if (!staged && !stale) throw new RpcError("not_found", "no platform release is staged");
    const reasons = this.busyReasons();
    if (reasons.length > 0) throw new RpcError("conflict", `busy: ${reasons.join("; ")}`, { reasons });
    this.exitForPlatform("request");
  }

  /** The final `update.state`, then the exit: the shell relaunches through the launcher, which rotates the pointers. */
  private exitForPlatform(by: "auto" | "request"): void {
    if (this.exiting) return;
    this.exiting = true;
    const platform = this.platform!;
    const staged = platform.staged();
    const current = platform.pointer("current");
    this.log.info("platform release applies at the next start; stopping", { staged, current, running: this.deps.platformVersion, by });
    this.publish("platform");
    const t = setTimeout(() => this.deps.exit(0), this.deps.exitDelayMs ?? EXIT_DELAY_MS);
    t.unref?.();
  }

  // --- brain-link hooks ---------------------------------------------------------------------

  /** Before every brain spawn: a staged release becomes `current` when the brain is ours to replace. */
  async beforeBrainSpawn(): Promise<void> {
    const staged = this.brains.stagedVersion();
    if (!staged) return;
    const loc = this.deps.locate();
    if (loc && !UPDATABLE_ORIGINS.has(loc.origin)) {
      this.log.info("staged brain not applied: the brain comes from the operator", { staged, origin: loc.origin });
      return;
    }
    const previous = this.brains.currentRelease()?.version;
    this.brains.promote(staged);
    this.stateOf("brain").staged = undefined;
    this.log.info("brain release promoted", { version: staged, previous: previous ?? "none" });
    this.publish("brain");
  }

  /** An installed or bundled brain must carry a signed entry and hash to it; the operator's own is theirs. */
  async verifyBrain(loc: BrainLocation): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!UPDATABLE_ORIGINS.has(loc.origin)) return { ok: true };
    const check = await verifyBrainDir(loc.cwd, this.deps.keys);
    if (!check.ok) return { ok: false, reason: check.reason };
    this.log.info("brain verified", { origin: loc.origin, version: check.release.version });
    return { ok: true };
  }

  /** A refused installed brain is removed and the previous one put back; true when another spawn makes sense. */
  async onBrainRefused(loc: BrainLocation, reason: string): Promise<boolean> {
    if (loc.origin !== "installed") return false;
    const back = this.brains.rollback();
    this.log.warn("brain release rolled back", { refused: loc.cwd, reason, now: back ?? (existsSync(join(this.deps.install?.dir ?? "", "brain")) ? "bundled" : "none") });
    this.publish("brain");
    return true;
  }
}
