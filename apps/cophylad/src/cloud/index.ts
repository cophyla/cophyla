// The cloud module: the account this node is signed in to, the entitlement it holds, the
// outbound link to the server and the hosted capabilities that ride on it. Signed out,
// nothing here contacts the server and every limit is the free one; signed in, the link
// authenticates with the account token, refreshes the entitlement (a signed JWT the node
// verifies itself, so a forged or long-expired row shows as free) and carries the hosted
// model and speech. The brain hears every verified token as `entitlement.updated`, and
// clients hear `account.state`. Built for every role: a secondary signs in on its own.
// Since milestone 12 the module is the daemon's hub for everything server-facing: the
// tunnels of the relay (a phone's or a node's, decrypted here and nowhere else), the
// registry client the nodes module arbitrates the role through, the relay grants a phone
// or a node gets, and the push registrations and sends the push module forwards. Since
// milestone 13 the cloud backup's sender hangs here too, and the recall index's hosted
// embedder, which is settled at the first link-up that knows the plan.

import { FREE_ENTITLEMENT, RpcError } from "@cophyla/protocol";
import type { ClientNotificationParams, DirectReport, Entitlement, GrantKind, IceServer, RelayAccess, Usage } from "@cophyla/protocol";
import type { NodeSocket, NodeSocketHandler } from "../api/server.ts";
import type { Bus } from "../bus.ts";
import type { Paths } from "../config/load.ts";
import type { CloudConfig } from "../config/schema.ts";
import type { Provider } from "../llm/index.ts";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";
import type { Embedder } from "../store/index/embed.ts";
import type { SttEngine, TtsEngine } from "../voice/engines.ts";
import { AccountFile, revokeToken } from "./account.ts";
import type { BackupSync } from "./backup.ts";
import { verifyEntitlement } from "./entitlement.ts";
import type { EntitlementStatus } from "./entitlement.ts";
import { probeServerEmbedder } from "./hosted-embed.ts";
import { ServerProvider } from "./hosted-llm.ts";
import { ServerSttEngine } from "./hosted-stt.ts";
import { ServerTtsEngine } from "./hosted-tts.ts";
import type { HostedDeps, HostedKind } from "./hosted.ts";
import type { EntitlementKey } from "./keys.ts";
import { ServerLink, serverUrlAllowed } from "./link.ts";
import type { LinkRequestOptions } from "./link.ts";
import { startDeviceFlow } from "./login.ts";
import { RegistryClient } from "./registry.ts";
import type { Arbiter } from "./registry.ts";
import { Tunnels } from "./tunnels.ts";
import type { InviteTunnel, NodeTunnel } from "./tunnels.ts";
import type { DeviceOffer } from "./login.ts";
import { systemOpener } from "./opener.ts";
import type { Opener } from "./opener.ts";
import { UsageCounters } from "./usage.ts";

export type AccountState = ClientNotificationParams<"account.state">;

export interface CloudDeps {
  config: CloudConfig;
  paths: Pick<Paths, "accountToken">;
  store: Store;
  bus: Bus;
  log: Logger;
  nodeId: string;
  nodeName: string;
  /** The entitlement keys' public halves; a token must check against one. */
  keys: EntitlementKey[];
  fetch?: typeof fetch;
  openBrowser?: Opener;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** `[nodes] relay`: whether the registry and a relayed node link may be used at all. */
  nodesRelay?: boolean;
  /** One of this node's grants: its kind, the key its relay tunnels are keyed from, and when it ends. */
  grantOf?: (peer: string) => { kind: GrantKind; key?: string; expiresAt?: number } | undefined;
  /** The api's acceptor for a relayed phone, once the api is up (a thunk: the api is built after the cloud). */
  acceptClient?: () => ((sock: NodeSocket) => NodeSocketHandler) | undefined;
  /** The nodes module's relayed node link for a peer, a grant's or an invite's; throws `denied` when it takes none for it. */
  acceptNode?: (peer: string) => NodeTunnel;
  /** The api's acceptor for a phone pairing through the account; absent while that is off. */
  acceptPairing?: () => ((sock: NodeSocket, pairing: { login: string }) => NodeSocketHandler) | undefined;
  /** A phone redeeming its invite on the invite's throwaway peer: how the tunnel is keyed and who serves it. */
  acceptInvite?: (peer: string) => InviteTunnel | undefined;
}

export interface LoginOptions {
  /** Open the verification page in the system browser: the desktop app's login. */
  openBrowser?: boolean;
}

export class Cloud {
  private deps: CloudDeps;
  private log: Logger;
  private file: AccountFile;
  private link: ServerLink;
  private usage: UsageCounters;
  private token: string | undefined;
  private subject: string | undefined;
  /** The stored entitlement token and what it verified as when it arrived; re-judged for expiry on every read. */
  private stored: { token: string; claims: Entitlement; status: EntitlementStatus } | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private login_: { offer: DeviceOffer; abort: AbortController } | undefined;
  private stopped = false;
  private hosted: HostedDeps;
  private tunnels: Tunnels;
  private registry: RegistryClient;
  private ups = new Set<() => void>();
  private backup?: BackupSync;
  /** The hosted embedder, wanted by a store on the `server` route and settled by the first link-up that knows the plan. */
  private embedderWanted = false;
  private embedderSettled = false;
  /** The link is up and the refresh has applied: the plan the probe needs is known. */
  private planKnown = false;
  private embedderResolve!: (e: Embedder | undefined) => void;
  private embedderPromise: Promise<Embedder | undefined>;

  constructor(deps: CloudDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.file = new AccountFile(deps.paths.accountToken);
    this.usage = new UsageCounters(deps.store, () => this.now());
    this.embedderPromise = new Promise<Embedder | undefined>((resolve) => {
      this.embedderResolve = resolve;
    });
    this.link = new ServerLink({
      url: deps.config.url.replace(/\/$/, ""),
      token: () => this.token,
      node: deps.nodeId,
      log: deps.log.child("link"),
      reconnectMs: deps.config.reconnect_ms,
      reconnectMaxMs: deps.config.reconnect_max_ms,
      requestTimeoutMs: deps.config.request_timeout_ms,
      helloTimeoutMs: deps.config.hello_timeout_ms,
      allowInsecure: deps.config.allow_insecure,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      onUp: (auth) => {
        this.subject = auth.subject;
        this.broadcast();
        // the registry and push listeners hear the link once the plan is known
        void this.refresh().finally(() => {
          if (!this.link.connected) return;
          this.planKnown = true;
          this.registry.emitUp();
          void this.settleEmbedder();
          this.backup?.onUp();
          for (const fn of [...this.ups]) fn();
        });
        this.startRefreshTimer();
      },
      onDown: (reason) => {
        this.planKnown = false;
        this.stopRefreshTimer();
        this.registry.linkDown();
        this.tunnels.closeAll(`server link down: ${reason}`);
        // a logout closes the link on its way out and broadcasts the free state itself
        if (this.token !== undefined) this.broadcast();
      },
      onAuthRefused: (message) => this.log.warn("the server refused the account token; keeping it and retrying", { message }),
      onFrame: (method, params) => this.onFrame(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
    });
    this.hosted = { allowed: (kind) => this.hostedAllowed(kind), link: this.link, usage: this.usage, log: deps.log.child("hosted") };
    this.tunnels = new Tunnels({
      log: deps.log.child("tunnels"),
      link: { notify: (m, p) => this.link.notify(m, p), request: (m, p, o) => this.link.request(m, p, o) },
      controllerKey: (peer) => {
        const grant = deps.grantOf?.(peer);
        return grant?.kind === "controller" ? grant.key : undefined;
      },
      acceptClient: () => deps.acceptClient?.(),
      acceptNode: (peer) => {
        if (!deps.acceptNode) throw new RpcError("denied", "this node takes no node links");
        return deps.acceptNode(peer);
      },
      acceptPairing: () => deps.acceptPairing?.(),
      acceptInvite: (peer) => deps.acceptInvite?.(peer),
      subject: () => this.subject,
    });
    this.registry = new RegistryClient({
      log: deps.log.child("registry"),
      nodeId: deps.nodeId,
      active: () => (deps.nodesRelay ?? true) && this.hostedAllowed("relay") === undefined,
      request: (m, p, o) => this.link.request(m, p, o),
    });
  }

  /** A frame not about a request in flight: the entitlement push, the registry's grant, the relay's records. */
  private onFrame(method: string, params: unknown): void {
    if (method === "entitlement.updated") {
      const token = (params as { token?: unknown })?.token;
      if (typeof token === "string") {
        this.log.info("entitlement pushed by the server");
        this.apply(token);
      }
      return;
    }
    if (method === "registry.primary") {
      this.registry.emitPrimary(params);
      return;
    }
    const p = (params ?? {}) as { peer?: unknown; frame?: unknown; reason?: unknown };
    if (method === "relay" && typeof p.peer === "string" && typeof p.frame === "string") {
      this.tunnels.frame(p.peer, p.frame);
      return;
    }
    if (method === "relay.close" && typeof p.peer === "string") {
      this.tunnels.close(p.peer, typeof p.reason === "string" ? p.reason : "closed");
      return;
    }
    this.log.debug("frame from the server ignored", { method });
  }

  /** The one request the server makes: a tunnel ending here. */
  private onRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== "relay.open") return Promise.reject(new RpcError("unsupported", `unsupported: ${method}`));
    const relay = this.hostedAllowed("relay");
    if (relay) return Promise.reject(relay);
    return this.tunnels.accept(params);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private fetch(): typeof fetch {
    return this.deps.fetch ?? fetch;
  }

  // --- lifecycle ------------------------------------------------------------------------

  /** Reads the token file and the stored entitlement, tells the clients, and links when signed in. */
  start(): void {
    if (!this.deps.config.enabled) {
      this.log.info("cloud off in config");
      this.settleEmbedderWith(undefined, "the cloud is off");
      this.broadcast();
      return;
    }
    if (!serverUrlAllowed(this.deps.config.url, this.deps.config.allow_insecure)) {
      this.log.error("cloud url refused: not https and not loopback; set [cloud] allow_insecure for a fake server", { url: this.deps.config.url });
      this.broadcast();
      return;
    }
    if (this.deps.config.url.startsWith("http:")) this.log.warn("INSECURE CLOUD URL in use", { url: this.deps.config.url });
    this.token = this.file.read();
    const row = this.deps.store.entitlement.get();
    if (row) {
      const v = verifyEntitlement(row.token, this.deps.keys, this.now());
      this.stored = { token: row.token, claims: v.claims, status: v.status };
      if (v.status === "invalid") this.log.warn("the stored entitlement does not verify; the free plan applies until a refresh");
      else if (v.status === "expired") this.log.warn("the stored entitlement is past its grace; the free plan applies until a refresh");
      this.subject = v.claims.subject || undefined;
    }
    this.log.info("cloud", { signedIn: this.token !== undefined, plan: this.entitlement().plan, entitlement: this.stored?.status ?? "none" });
    this.broadcast();
    if (this.token) this.link.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.settleEmbedderWith(undefined, "stopping");
    this.backup?.stop();
    this.stopRefreshTimer();
    this.login_?.abort.abort();
    this.login_ = undefined;
    this.tunnels.closeAll("daemon stopping");
    await this.link.close("daemon stopping");
  }

  private startRefreshTimer(): void {
    this.stopRefreshTimer();
    this.refreshTimer = setInterval(() => void this.refresh(), this.deps.config.refresh_interval_ms);
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  // --- the entitlement ------------------------------------------------------------------

  /** The entitlement in force now: the stored claims while valid or in grace, the free one otherwise. */
  entitlement(): Entitlement {
    const s = this.stored;
    if (!s || s.status === "invalid" || s.status === "expired") return FREE_ENTITLEMENT;
    const now = this.now();
    if (now >= s.claims.expiresAt + s.claims.graceSeconds * 1000) return FREE_ENTITLEMENT;
    return s.claims;
  }

  /** The raw token for the brain, whatever it verifies as: the brain judges it itself. */
  entitlementToken(): string | undefined {
    return this.stored?.token;
  }

  /** A token from a refresh or a push: verified, stored, announced to the brain and the clients. */
  private apply(token: string, usage?: Usage): void {
    const at = this.now();
    const v = verifyEntitlement(token, this.deps.keys, at);
    if (v.status === "invalid") this.log.warn("the server's entitlement does not verify against the keys this platform ships; the free plan applies");
    this.stored = { token, claims: v.claims, status: v.status };
    this.deps.store.entitlement.put(token, v.claims, at);
    if (v.claims.subject) this.subject = v.claims.subject;
    if (usage) this.usage.reported(usage);
    this.log.info("entitlement applied", { plan: v.claims.plan, status: v.status, expiresAt: v.claims.expiresAt });
    this.deps.bus.emit("entitlement.updated", { at, token });
    this.backup?.onPlan();
    this.broadcast();
  }

  /** `entitlement.refresh` over the link; a failure is logged, the stored entitlement stands. */
  async refresh(): Promise<void> {
    if (!this.link.connected) return;
    try {
      const r = (await this.link.request("entitlement.refresh", {}, { timeoutMs: 15_000 })) as { token?: unknown; usage?: unknown };
      if (typeof r?.token !== "string") throw new Error("no token in the answer");
      this.apply(r.token, r.usage !== undefined && r.usage !== null ? (r.usage as Usage) : undefined);
    } catch (e) {
      this.log.warn("entitlement refresh failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // --- the account ----------------------------------------------------------------------

  state(): AccountState {
    const e = this.entitlement();
    const out: AccountState = {
      plan: e.plan,
      limits: { ...e.limits, hosted: e.hosted, brainChannel: e.brainChannel },
    };
    if (this.token) {
      if (this.subject) out.subject = this.subject;
      out.connected = this.link.connected;
      out.usage = this.usage.snapshot();
    }
    if (this.backup && this.deps.config.enabled) out.backup = this.backup.state();
    return out;
  }

  private broadcast(): void {
    this.deps.bus.emit("account.state", this.state());
  }

  get signedIn(): boolean {
    return this.token !== undefined;
  }

  /** The account this node is signed in to, once known. */
  get account(): string | undefined {
    return this.token ? this.subject : undefined;
  }

  /** Hears the link come up with the plan known; for the push module's replay. */
  onUp(fn: () => void): () => void {
    this.ups.add(fn);
    return () => this.ups.delete(fn);
  }

  /** The device-code login: the code and URL answered at once; the token arrives in the background. */
  async login(opts: LoginOptions = {}): Promise<{ verificationUrl: string; userCode: string; expiresAt: number }> {
    if (!this.deps.config.enabled) throw new RpcError("unavailable", "the cloud is off in this node's config", { provider: "server" });
    if (this.token) throw new RpcError("conflict", "already signed in; sign out first");
    if (this.login_) throw new RpcError("conflict", "a login is already open: enter its code, or wait for it to expire", { userCode: this.login_.offer.userCode, expiresAt: this.login_.offer.expiresAt });
    const abort = new AbortController();
    const flow = await startDeviceFlow({
      url: this.deps.config.url.replace(/\/$/, ""),
      node: this.deps.nodeName,
      fetch: this.fetch(),
      log: this.log.child("login"),
      signal: abort.signal,
      ...(this.deps.now ? { now: this.deps.now } : {}),
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
    });
    this.login_ = { offer: flow.offer, abort };
    this.log.info("login started", { expiresAt: flow.offer.expiresAt });
    void flow.granted
      .then((g) => {
        if (this.stopped || this.login_?.offer !== flow.offer) return;
        this.login_ = undefined;
        this.file.write(g.token);
        this.token = g.token;
        this.subject = g.subject;
        this.log.info("signed in", { subject: g.subject, tokenExpiresAt: g.expiresAt });
        this.broadcast();
        this.link.connect();
        this.link.retryNow();
      })
      .catch((e: unknown) => {
        if (this.login_?.offer === flow.offer) this.login_ = undefined;
        this.log.info("login ended without a token", { reason: e instanceof Error ? e.message : String(e) });
        this.broadcast();
      });
    if (opts.openBrowser) {
      try {
        await (this.deps.openBrowser ?? systemOpener())(flow.offer.verificationUrl);
      } catch (e) {
        this.log.warn("could not open the browser; the user must open the URL by hand", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { verificationUrl: flow.offer.verificationUrl, userCode: flow.offer.userCode, expiresAt: flow.offer.expiresAt };
  }

  /** Revokes the token (best effort), forgets everything, and tells the clients the free plan. */
  async logout(): Promise<void> {
    this.login_?.abort.abort();
    this.login_ = undefined;
    const token = this.token;
    this.token = undefined;
    this.subject = undefined;
    this.stopRefreshTimer();
    this.tunnels.closeAll("signed out");
    await this.link.close("signed out");
    if (token) {
      try {
        await revokeToken(this.deps.config.url.replace(/\/$/, ""), token, this.fetch());
      } catch (e) {
        this.log.warn("revoke failed; the token is forgotten here anyway", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    this.file.delete();
    this.deps.store.entitlement.clear();
    this.usage.clear();
    this.stored = undefined;
    this.log.info("signed out");
    this.backup?.onPlan();
    this.broadcast();
    // the brain's plan falls back with the next refresh it never gets: tell it the free state now
    this.deps.bus.emit("entitlement.updated", { at: this.now(), token: "" });
  }

  // --- the hosted capabilities --------------------------------------------------------------

  /** Why a hosted kind cannot be served now, as the error to raise; undefined when it can. */
  hostedAllowed(kind: HostedKind): RpcError | undefined {
    const data = { provider: "server" };
    if (!this.deps.config.enabled) return new RpcError("unavailable", "the cloud is off in this node's config", data);
    if (!this.token) return new RpcError("unavailable", `hosted ${kind}: not signed in`, data);
    const e = this.entitlement();
    if (!e.hosted[kind]) return new RpcError("unavailable", `the plan has no hosted ${kind}`, data);
    if (!this.link.connected) return new RpcError("unavailable", `hosted ${kind}: the server link is down`, data);
    return undefined;
  }

  llmProvider(): Provider {
    return new ServerProvider(this.hosted);
  }

  sttEngine(language?: string): SttEngine {
    return new ServerSttEngine(this.hosted, language);
  }

  ttsEngine(voice?: string): TtsEngine {
    return new ServerTtsEngine(this.hosted, voice);
  }

  /** The `server` route of the online engines: one utterance or one line, a refusal thrown so the next route can take it. */
  speechRoute(): { transcribe(pcm: Int16Array, language: string | undefined): Promise<string>; speak(text: string, voice: string, signal?: AbortSignal): AsyncIterable<Int16Array> } {
    return {
      transcribe: (pcm, language) => new ServerSttEngine(this.hosted, language).transcribe(pcm),
      speak: (text, voice, signal) => new ServerTtsEngine(this.hosted, voice).synth(text, signal ? { signal } : {}),
    };
  }

  /**
   * The recall index's embedder on the `server` route: settled by the first link-up that
   * knows the plan (with the hosted model's name and width, probed then), at once with
   * nothing when the cloud is off, and with nothing when the plan has no compute (recall
   * stays full-text only until a restart on a plan that has it) or the daemon stops.
   */
  embedder(): Promise<Embedder | undefined> {
    this.embedderWanted = true;
    if (!this.deps.config.enabled) this.settleEmbedderWith(undefined, "the cloud is off");
    // asked after the link came up: the probe runs now rather than at the next link-up
    else if (this.planKnown) void this.settleEmbedder();
    return this.embedderPromise;
  }

  private settleEmbedderWith(e: Embedder | undefined, why: string): void {
    if (this.embedderSettled) return;
    this.embedderSettled = true;
    if (this.embedderWanted && !e) this.log.info("hosted embeddings off; recall is full-text only", { why });
    this.embedderResolve(e);
  }

  /** At a link-up with the plan known: the probe, when a store wants the hosted embedder. */
  private embedderProbing = false;

  private async settleEmbedder(): Promise<void> {
    if (this.embedderSettled || !this.embedderWanted || this.embedderProbing) return;
    if (!this.entitlement().hosted.compute) {
      this.settleEmbedderWith(undefined, "the plan has no hosted compute");
      return;
    }
    this.embedderProbing = true;
    try {
      const e = await probeServerEmbedder(this.hosted, () => this.now());
      this.log.info("hosted embedder ready", { model: e.model, dim: e.dim });
      this.settleEmbedderWith(e, "probed");
    } catch (err) {
      // a probe that failed on this link-up is tried again on the next
      this.log.warn("hosted embedder probe failed; recall is full-text only until the next link-up", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.embedderProbing = false;
    }
  }

  // --- the backup ----------------------------------------------------------------------------

  /** The backup's sender, built by the daemon once the modules it drives exist. */
  attachBackup(sync: BackupSync): void {
    this.backup = sync;
  }

  get backupSync(): BackupSync | undefined {
    return this.backup;
  }

  /** For the backup's sender: the link it puts on, and the reasons it may not. */
  get serverLink(): ServerLink {
    return this.link;
  }

  // --- the relay ----------------------------------------------------------------------------

  /** The registry client the nodes module arbitrates through. */
  get arbiter(): Arbiter {
    return this.registry;
  }

  /** The tunnels open here, for the status line and the tests. */
  get tunnelPeers() {
    return this.tunnels.peers();
  }

  /** What a paired phone needs to reach this node through the relay: its relay token (`relayGrant`), and the key its tunnel is keyed from. */
  async relayAccess(peer: string, name: string | undefined): Promise<RelayAccess> {
    const why = this.hostedAllowed("relay");
    if (why) throw why;
    const grant = this.deps.grantOf?.(peer);
    if (!grant || grant.kind !== "controller" || grant.key === undefined) throw new RpcError("not_found", `no controller ${peer}`);
    const { url, token } = await this.relayGrant(peer, { kind: "controller", ...(name !== undefined ? { name } : {}), ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}) });
    return { url, peer, token, key: grant.key };
  }

  /**
   * The server relay for any of this node's grants: the server mints the token
   * (`relay.grant`), bound to the grant's kind and its end; this node adds the server's
   * origin. Nothing while signed out, on a plan without the relay, or with the link down.
   */
  async relayGrant(peer: string, opts: { kind: GrantKind; name?: string; expiresAt?: number }): Promise<{ url: string; token: string }> {
    const why = this.hostedAllowed("relay");
    if (why) throw why;
    const params = { peer, kind: opts.kind, ...(opts.name !== undefined ? { name: opts.name } : {}), ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}) };
    const r = (await this.link.request("relay.grant", params, { timeoutMs: 15_000 })) as { token?: unknown };
    if (typeof r?.token !== "string") throw new RpcError("unavailable", "the server granted no relay token", { provider: "server" });
    return { url: this.deps.config.url.replace(/\/$/, ""), token: r.token };
  }

  /** Tells the server a controller's relay grant is over; best effort. */
  async revokeRelay(peer: string): Promise<boolean> {
    if (!this.link.connected) return false;
    try {
      await this.link.request("relay.revoke", { peer }, { timeoutMs: 10_000 });
      return true;
    } catch (e) {
      this.log.warn("relay revoke failed", { peer, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  // --- direct connections ----------------------------------------------------------------------

  /** TURN servers and a credential for this node's direct connections, minted by the server and counted there. */
  async turnCredentials(): Promise<{ iceServers: IceServer[]; expiresAt: number }> {
    const why = this.hostedAllowed("direct");
    if (why) throw why;
    const r = (await this.link.request("turn.credentials", {}, { timeoutMs: 20_000 })) as { iceServers?: unknown; expiresAt?: unknown };
    if (!Array.isArray(r?.iceServers) || typeof r.expiresAt !== "number") throw new RpcError("unavailable", "the server sent no TURN credentials", { provider: "server" });
    this.usage.add("turn_credentials", 1);
    return { iceServers: r.iceServers as IceServer[], expiresAt: r.expiresAt };
  }

  /** A finished day's path counts; throws when the link cannot take it now. */
  async directReport(report: DirectReport): Promise<void> {
    if (!this.link.connected) throw new RpcError("unavailable", "the server link is down", { provider: "server" });
    await this.link.request("direct.report", { report }, { timeoutMs: 15_000 });
  }

  // --- push --------------------------------------------------------------------------------

  /** A request on the link for the push module; `unavailable` when the link is down or the plan lacks push. */
  async pushRequest(method: "push.register" | "push.unregister" | "push.send", params: unknown, opts: LinkRequestOptions = {}): Promise<unknown> {
    if (method === "push.send") {
      const why = this.hostedAllowed("push");
      if (why) throw why;
    } else if (!this.link.connected) throw new RpcError("unavailable", `${method}: the server link is down`, { provider: "server" });
    return this.link.request(method, params, { timeoutMs: 15_000, ...opts });
  }

  /** The beta feed and the bearer that reads it, when the account's plan has the beta channel. */
  betaFeed(): { feed: string; headers: Record<string, string> } | undefined {
    if (!this.token || this.entitlement().brainChannel !== "beta") return undefined;
    return { feed: `${this.deps.config.url.replace(/\/$/, "")}/releases`, headers: { authorization: `Bearer ${this.token}` } };
  }

  /** For the tests: the link's state. */
  get linkState() {
    return this.link.state;
  }
}
