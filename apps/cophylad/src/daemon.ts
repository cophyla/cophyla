// Composes the daemon: paths, config, store, gate, node identity, profiles, workspaces,
// sessions, views, chat, tasks and their scheduler, tools, the event stream and catalogue,
// the editable layer, the llm router, the update module, the sidecars, the voice pipeline,
// the metrics sampler, the remote desktop and the cloud account, the api and, when the
// controller is on or other nodes may link here, a second listener on the LAN, the nodes
// module that settles the role, and, on the primary, the brain-link last. `main.ts` runs it
// for real; the tests run it against a temporary home.

import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { Node, PairedLan, RelayAccess } from "@cophyla/protocol";
import { pskFromHex } from "@cophyla/relay";
import pkg from "../package.json" with { type: "json" };
import { accountMethods, attachMethods, backupMethods, chatMethods, chatSignals, eventMethods, fileMethods, foundationMethods, listenerMethods, metricsMethods, pairAsk, pairingMethods, pipeSignals, remoteMethods, taskMethods, terminalMethods, terminalSignals, updateMethods, viewMethods, viewStageMethods, voiceMethods, voiceSignals } from "./api/methods.ts";
import { ClientRegistry } from "./api/clients.ts";
import { GRANTS_NS, LOCAL_GRANTS_NS } from "./grants/namespaces.ts";
import { GrantClock } from "./grants/clock.ts";
import { grantMethods } from "./grants/methods.ts";
import { PhoneInvites } from "./grants/phones.ts";
import { Grants } from "./grants/store.ts";
import { Pairing } from "./api/pairing.ts";
import { startApi } from "./api/server.ts";
import type { AccountPaired, ApiServer } from "./api/server.ts";
import { ViewTickets } from "./api/tickets.ts";
import { ensureCertificate, lanAddress, lanEndpoints, spkiHash } from "./api/tls.ts";
import { BrainLink } from "./brain-link/link.ts";
import { locateBrain, repoRootFromHere } from "./brain-link/locate.ts";
import { Bus } from "./bus.ts";
import { Activity } from "./chat/activity.ts";
import { Chat } from "./chat/index.ts";
import { BackupSync } from "./cloud/backup.ts";
import { Cloud } from "./cloud/index.ts";
import { ENTITLEMENT_KEYS } from "./cloud/keys.ts";
import type { EntitlementKey } from "./cloud/keys.ts";
import type { Opener } from "./cloud/opener.ts";
import { Hooks } from "./editable/hooks.ts";
import { Editable } from "./editable/index.ts";
import { MemoryFiles } from "./editable/memory.ts";
import { Prompts } from "./editable/prompts.ts";
import { ensureReadme } from "./editable/readme.ts";
import { ensureDirs, loadConfig, loadOrCreateToken, paths, resolveHome } from "./config/load.ts";
import type { BrainLinkDeps } from "./brain-link/link.ts";
import type { Paths } from "./config/load.ts";
import type { Config } from "./config/schema.ts";
import { EventCatalogue } from "./events/catalogue.ts";
import { recordCustomEvents } from "./events/recorder.ts";
import { EventStream } from "./events/stream.ts";
import { Listeners } from "./listeners/index.ts";
import { Asks } from "./gate/asks.ts";
import { Audit } from "./gate/audit.ts";
import { Gate } from "./gate/index.ts";
import { Policy } from "./gate/policy.ts";
import { GeminiProvider } from "./llm/gemini.ts";
import { Llm } from "./llm/index.ts";
import type { Provider } from "./llm/index.ts";
import { createLogger } from "./log.ts";
import type { Logger } from "./log.ts";
import { hostEngine } from "./metrics/engine.ts";
import type { MetricsEngine } from "./metrics/engine.ts";
import { Metrics } from "./metrics/index.ts";
import { PlanLimits } from "./metrics/limits.ts";
import { Pricer, priceTable } from "./metrics/prices.ts";
import type { DiscoveryTransport } from "./nodes/discovery.ts";
import { withForwarding } from "./nodes/forward.ts";
import { Nodes } from "./nodes/index.ts";
import { loadNodeIdentity, selfNode } from "./nodes/self.ts";
import type { NodeIdentity } from "./nodes/self.ts";
import { nodeServedTable } from "./nodes/served.ts";
import { Remote } from "./remote/index.ts";
import type { RemoteDeps } from "./remote/index.ts";
import { checkSuccessor, Restart, spawnSuccessor } from "./restart.ts";
import { ClaudeAdapter } from "./sessions/claude/adapter.ts";
import { isAlive } from "./sessions/claude/registry.ts";
import { CodexAdapter } from "./sessions/codex/adapter.ts";
import { MuseAdapter } from "./sessions/muse/adapter.ts";
import { EditorTerminalOpener } from "./sessions/editors.ts";
import { scrub } from "./sessions/env.ts";
import { Direct } from "./direct/index.ts";
import type { DirectDeps } from "./direct/index.ts";
import { helperEnv } from "./direct/helper.ts";
import { locateNet, stageNet } from "./direct/locate.ts";
import { DirectClients } from "./direct/clients.ts";
import { directMethods, directSignals } from "./direct/methods.ts";
import { PipeHub } from "./remote/pipes.ts";
import type { LinkDirectTiming } from "./nodes/direct.ts";
import { defaultRaiser, withProcessTable } from "./sessions/focus.ts";
import type { WindowRaiser } from "./sessions/focus.ts";
import { SessionFiles } from "./sessions/files.ts";
import { Sessions } from "./sessions/index.ts";
import type { HarnessAdapter, SessionHost } from "./sessions/model.ts";
import { Profiles } from "./sessions/profiles.ts";
import { OsTerminalOpener } from "./sessions/terminals.ts";
import type { TerminalOpener } from "./sessions/terminals.ts";
import { Tether } from "./sessions/tether/index.ts";
import { putCommandOnPath } from "./sessions/tether/command.ts";
import { writeEntryPoints } from "./sessions/tether/entry.ts";
import { TerminalRows, TerminalStreams } from "./sessions/tether/streams.ts";
import { Push } from "./push/index.ts";
import { Sidecars } from "./sidecars/index.ts";
import { TtsPy } from "./sidecars/tts-py.ts";
import { Store } from "./store/index.ts";
import { loadEmbedder } from "./store/index/embed.ts";
import type { Embedder } from "./store/index/embed.ts";
import { Tasks } from "./tasks/index.ts";
import { TaskScheduler } from "./tasks/scheduler.ts";
import { nodeTz } from "./tasks/triggers.ts";
import { Tools } from "./tools/index.ts";
import { Update } from "./update/index.ts";
import { RELEASE_KEYS } from "./update/keys.ts";
import { detectInstall } from "./update/platform.ts";
import { BUILTIN_VIEWS_DIR, Views } from "./views/index.ts";
import { resolveAffinity } from "./voice/affinity.ts";
import type { SpeechNames } from "./voice/compose.ts";
import type { EngineFactory } from "./voice/engines.ts";
import { AUDIO_CODECS, Voice } from "./voice/index.ts";
import { localEngines } from "./voice/local.ts";
import { modelResolver } from "./voice/models.ts";
import { onlineStt, onlineTts } from "./voice/online.ts";
import type { OnlineDeps } from "./voice/online.ts";
import { storePrefs } from "./voice/prefs.ts";
import { Workspaces } from "./workspaces/index.ts";

export const PLATFORM_VERSION: string = pkg.version;

/** The embedding model the platform ships: `apps/cophylad/models/<name>`, beside `src/` in a checkout and in the staged tree alike. */
export const DEFAULT_MODEL_DIR: string = resolve(dirname(import.meta.dir), "models", "bge-small-en-v1.5");

/** The built controller app: `apps/controller/dist`, in a checkout and in a staged tree alike. */
export const CONTROLLER_DIST: string = resolve(dirname(import.meta.dir), "..", "controller", "dist");

/** The speech sidecar's sources and locks, shipped with the platform and built on demand. */
export const TTS_PY_DIR: string = resolve(dirname(import.meta.dir), "..", "..", "sidecars", "tts-py");

export interface DaemonOptions {
  home?: string;
  /** Overrides config.api.port; 0 picks a free one. */
  port?: number;
  log?: Logger;
  /** Replaces the harness adapters, for tests that drive `Sessions` with a fake. */
  adapters?: (host: SessionHost, log: Logger) => HarnessAdapter[];
  raiser?: WindowRaiser;
  /** Replaces where a session cophylad starts is shown; `[]` opens no terminal, which is what a test wants. */
  terminals?: TerminalOpener[];
  /** Replaces tether; a test run has none unless it gives one, because a real one reaches the user's own hosts. */
  tether?: Tether;
  /** Replaces the daemon's own `views/` directory, for tests. */
  builtinViews?: string;
  /** Replaces the vendor providers behind `llm.complete`, for tests. */
  providers?: Provider[];
  /** The environment the daemon reads keys and the brain's location from. */
  env?: Record<string, string | undefined>;
  /** Overrides `[brain].enabled`, for tests that want no brain. */
  brain?: boolean;
  /** Replaces the embedding model behind recall: a fake for tests, `null` for full-text only. */
  embedder?: Embedder | null;
  /** The voice module's seams: the engines and the CPU mask, both faked in the tests. */
  voice?: {
    engines?: EngineFactory;
    /** Overrides `[voice] cpu_affinity`; `null` pins nothing. */
    affinity?: bigint | null;
  };
  /** The metrics module's seams: a scripted engine, a clock and no timer, for tests; and the plan limits' fetch, which a test must give for them to be read. */
  metrics?: {
    engine?: MetricsEngine;
    now?: () => number;
    manual?: boolean;
    limitsFetch?: typeof fetch;
  };
  /** The nodes module's seams: the discovery transport (a LAN in memory for tests) and a clock. */
  nodes?: {
    discovery?: DiscoveryTransport;
    now?: () => number;
  };
  /** The remote module's seams: the command runner, the host API, the viewer, the web sidecar's command, the capture. */
  remote?: Pick<RemoteDeps, "exec" | "fetch" | "hostApi" | "moonlight" | "web" | "screenshot" | "os" | "env">;
  /** The direct connections' seams: the helper's command and spawner (a test has no helper unless it gives one, since a real one binds the machine's addresses), a clock. */
  direct?: Pick<DirectDeps, "command" | "spawn" | "now"> & { openTimeoutMs?: number; link?: LinkDirectTiming };
  /** The cloud module's seams: the fetch for the login and the revoke, the entitlement keys, the browser opener, a clock. */
  cloud?: {
    fetch?: typeof fetch;
    keys?: EntitlementKey[];
    openBrowser?: Opener;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  };
  /** The push module's clock. */
  push?: { now?: () => number };
  /** The cloud backup's timings, shorter in the tests. */
  backup?: { debounceMs?: number; workspaceDebounceMs?: number };
  /** The update module's seams: the release keys, an install tree, the fetch, the exit, the timings. */
  update?: {
    keys?: string[];
    /** An install directory to run as if installed there, at this daemon's own version. */
    installDir?: string;
    fetch?: typeof fetch;
    exit?: (code: number) => void;
    target?: { os: string; arch: string };
    applyRetryMs?: number;
    exitDelayMs?: number;
  };
  /** `node.restart`'s seams: the successor's check and start, the exit, the delay before the stop. */
  restart?: {
    preflight?: () => void;
    respawn?: () => number;
    exit?: (code: number) => void;
    delayMs?: number;
  };
}

export interface Daemon {
  paths: Paths;
  config: Config;
  store: Store;
  identity: NodeIdentity;
  node: () => Node;
  token: string;
  hookToken: string;
  bus: Bus;
  policy: Policy;
  asks: Asks;
  audit: Audit;
  gate: Gate;
  profiles: Profiles;
  workspaces: Workspaces;
  sessions: Sessions;
  views: Views;
  chat: Chat;
  activity: Activity;
  tasks: Tasks;
  scheduler: TaskScheduler;
  listeners: Listeners;
  tools: Tools;
  prompts: Prompts;
  memory: MemoryFiles;
  events: EventStream;
  catalogue: EventCatalogue;
  hooks: Hooks;
  editable: Editable;
  /** The zone schedules run in and the brain tells the time in. */
  tz: string;
  cloud: Cloud;
  backup: BackupSync;
  llm: Llm;
  update: Update;
  /** Present while this node is the primary and a brain is located; absent otherwise. */
  readonly brain: BrainLink | undefined;
  api: ApiServer;
  /** Every client of the node, on either listener. */
  clients: ClientRegistry;
  grants: Grants;
  pairing: Pairing;
  tickets: ViewTickets;
  sidecars: Sidecars;
  voice: Voice;
  metrics: Metrics;
  remote: Remote;
  /** The pipes stream pages ride where there is no route to their desktop. */
  pipes: PipeHub;
  direct: Direct;
  nodes: Nodes;
  push: Push;
  /** The LAN listener, when `[controller]` is on, other nodes may link here or this node is a backup, and its certificate could be made. */
  controller?: ApiServer;
  stop(): Promise<void>;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const p = paths(resolveHome(opts.home));
  ensureDirs(p);
  ensureReadme(p.readme);
  const config = loadConfig(p);
  const log = opts.log ?? createLogger(config.log.level);
  const tz = config.node.tz ?? nodeTz();

  const store = new Store(p.db);
  const version = store.migrate();
  log.info("store open", { path: p.db, schema: version });

  const identity = loadNodeIdentity(store, config);
  const token = loadOrCreateToken(p.clientToken);
  const hookToken = loadOrCreateToken(p.hookToken);
  // Before grants every node of a cluster shared data/node.token. It opens nothing now: each
  // node holds a grant of its own, and one that had only the token is invited again.
  if (existsSync(p.legacyNodeToken)) {
    rmSync(p.legacyNodeToken, { force: true });
    log.warn("the shared node token is gone: each node holds a grant of its own now, and every other node of this cluster must be invited again (cophylad invite on the primary, cophylad join on the node)", { path: p.legacyNodeToken });
  }
  if (config.nodes.token !== undefined) log.warn("[nodes] token is ignored: each node holds a grant of its own now; it can be removed from config.toml");

  const bus = new Bus();
  const policy = new Policy(config.gate, store);
  const asks = new Asks(store, identity.id, bus);
  const stale = asks.closeStale();
  if (stale > 0) log.info("closed asks left open by the previous run", { count: stale });
  const audit = new Audit(store, identity.id, config.gate.audit_result_cap, bus);
  const gate = new Gate({ config: config.gate, policy, asks, audit, log: log.child("gate") });

  const profiles = new Profiles({ store, nodeId: identity.id, config, log: log.child("profiles") });
  // `voice`, `nodes` and `remote` are built further down and consulted here, so a stage coming up, a role change or the desktop host changes the node's row.
  let voice: Voice | undefined;
  let nodes: Nodes | undefined;
  let brain: BrainLink | undefined;
  let remote: Remote | undefined;
  let backup: BackupSync | undefined;
  const node = () => selfNode(identity, config, PLATFORM_VERSION, Date.now(), profiles.harnessesOk(), voice?.capabilities(), nodes?.roleOf() ?? config.node.role, brain?.brainVersion, remote?.capable() ?? false, nodes?.via() ?? "direct");
  const workspaces = new Workspaces({ store, nodeId: identity.id, bus });
  workspaces.fromScope(config.node.scope);
  workspaces.home(p.home);
  const views = new Views({
    store,
    log: log.child("views"),
    bus,
    dirs: [
      { dir: opts.builtinViews ?? BUILTIN_VIEWS_DIR, source: "builtin" },
      { dir: p.views, source: "editable" },
    ],
  });
  const chat = new Chat({ store, bus, asks });
  const activity = new Activity({ bus });
  const tasks = new Tasks({ store, bus, tz });
  const tools = new Tools({ nodeId: identity.id, config: config.tools, workspaces, log: log.child("tools"), home: p.home });
  const prompts = new Prompts(p.prompts);
  const memory = new MemoryFiles(p.memory);
  memory.onChange = (name, m) => store.index.reindexMemory(name, m);
  const env = opts.env ?? process.env;
  // The account before the llm router, the update module and the voice pipeline, which each take a seam from it.
  const cloud = new Cloud({
    config: config.cloud,
    paths: p,
    store,
    bus,
    log: log.child("cloud"),
    nodeId: identity.id,
    nodeName: identity.name,
    keys: opts.cloud?.keys ?? ENTITLEMENT_KEYS,
    ...(opts.cloud?.fetch ? { fetch: opts.cloud.fetch } : {}),
    ...(opts.cloud?.openBrowser ? { openBrowser: opts.cloud.openBrowser } : {}),
    ...(opts.cloud?.now ? { now: opts.cloud.now } : {}),
    ...(opts.cloud?.sleep ? { sleep: opts.cloud.sleep } : {}),
    // the relay's seams are thunks: the grants, the api and the nodes module are built below
    nodesRelay: config.nodes.relay,
    grantOf: (peer) => {
      const row = grants.get(peer);
      // a pending grant has no tunnel yet, and one that ran out has none any more
      if (!row || grants.status(row) === "pending" || grants.expired(row)) return undefined;
      const key = grants.key(peer);
      return { kind: row.kind, ...(key !== undefined ? { key } : {}), ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}) };
    },
    acceptClient: () => (api ? (sock) => api!.acceptTunnel(sock) : undefined),
    acceptPairing: () => (api && config.controller.account_pairing ? (sock, pairing) => api!.acceptTunnel(sock, { pairing }) : undefined),
    acceptNode: (peer) => {
      if (!nodes) throw new RpcError("unavailable", "the nodes module is not up", { provider: "node" });
      return nodes.relayedLink(peer);
    },
    acceptInvite: (peer) => {
      const row = grants.byInvitePeer(peer);
      if (!row?.invite || row.kind !== "controller" || !api) return undefined;
      const invite = { grant: row.id, peer };
      return { psk: pskFromHex(row.invite.secretHash), accept: (sock) => api!.acceptTunnel(sock, { invite }) };
    },
  });
  const llm = new Llm({ config: config.providers, log: log.child("llm"), env, providers: [...(opts.providers ?? [new GeminiProvider({ apiKey: () => config.providers.gemini.api_key ?? env["GEMINI_API_KEY"], baseUrl: config.providers.gemini.base_url, timeoutMs: config.providers.timeout_ms, log: log.child("gemini") })]), cloud.llmProvider()] });

  const sessionsLog = log.child("sessions");
  // The process table the agent CLI in a terminal is found in, and a hook's ancestors: an engine
  // of its own, so it reads with [metrics] off too, built at the first look. One that cannot
  // read marks no terminal, and the raiser walks the tree its own way.
  let processEngine: MetricsEngine | undefined;
  const processes = async () => {
    processEngine ??= hostEngine({ gpu: false, log: sessionsLog.child("processes") });
    return (await processEngine.sample()).processes;
  };
  const raiser = opts.raiser ?? withProcessTable(defaultRaiser(process.platform, { env, log: sessionsLog.child("focus") }), processes);
  // Where this daemon is installed, if it is: the update module's, and where tether ships.
  const install = opts.update?.installDir
    ? detectInstall({ COPHYLA_INSTALL_DIR: opts.update.installDir, COPHYLA_PLATFORM_DIR: join(opts.update.installDir, "versions", PLATFORM_VERSION) })
    : detectInstall(env);
  // tether, which the sessions cophylad starts run in, so what the user sends them is typed as theirs.
  const tether =
    opts.tether ??
    (env["NODE_ENV"] === "test"
      ? undefined
      : new Tether({ config: config.tether, env: scrub(env), dataDir: p.data, nodeId: identity.id, log: sessionsLog.child("tether"), ...(install ? { versionDir: install.versionDir } : { repoRoot: repoRootFromHere() }) }));
  // Muse's adapter also reads each login's plan usage off its host, for the limits below.
  let muse: MuseAdapter | undefined;
  const adapters = (host: SessionHost): HarnessAdapter[] => {
    if (opts.adapters) return opts.adapters(host, sessionsLog);
    muse = new MuseAdapter({ host, log: sessionsLog.child("muse"), version: PLATFORM_VERSION, dataDir: p.data, raiser, isAlive, asks, askTimeoutS: config.sessions.hook_timeout_s, env });
    return [
      new ClaudeAdapter({ host, log: sessionsLog.child("claude"), raiser }),
      // A Codex session known by its hooks and its process ends when the process does, SessionEnd or not.
      new CodexAdapter({ host, log: sessionsLog.child("codex"), version: PLATFORM_VERSION, raiser, isAlive }),
      muse,
    ];
  };
  // The price table prices a harness session's tokens where the harness states no cost, and the brain's calls in the samples.
  const pricer = new Pricer(priceTable(config.metrics.prices), log.child("metrics"));
  const sessions = new Sessions({
    store,
    bus,
    asks,
    config: config.sessions,
    nodeId: identity.id,
    log: sessionsLog,
    profiles,
    workspaces,
    adapters,
    raiser,
    hookToken,
    dataDir: p.data,
    acp: { config: config.acp, env },
    // Where a session cophylad starts is shown: the editor's panel first, a terminal of the
    // platform's otherwise, and on a node with neither the session is headless. A test run
    // opens neither whatever its configuration says — both of these reach the real desktop,
    // and a suite that leaves windows behind, or opens one in the editor being worked in, is
    // a suite nobody can run.
    terminals: opts.terminals ?? (env["NODE_ENV"] === "test" ? [] : [
      new EditorTerminalOpener({ dir: join(p.home, "editors"), log: sessionsLog.child("terminal") }),
      new OsTerminalOpener({ platform: process.platform, dataDir: p.data, log: sessionsLog.child("terminal"), env: scrub(env) }),
    ]),
    ...(tether ? { tether, env: scrub(env), processes } : {}),
    pricer: (model, tokens) => pricer.cost(model, tokens),
  });
  // What an explorer shows of a session: the folders under its directory, and its repository.
  const files = new SessionFiles({ session: (id) => sessions.get(id) });

  // The event stream every listener shares, the catalogue, the hooks and the editable layer
  // over them. The stream knows this node's sessions only: a session on another node is
  // announced by that node's stream, and its events arrive here up the link, injected once.
  const events = new EventStream({ bus, sessions, log: log.child("events") });
  const catalogue = new EventCatalogue({ node: identity.id, bus });
  const hooks = new Hooks({ stream: events, catalogue, log: log.child("hooks"), home: p.home, node: identity.id });
  const editable = new Editable({
    paths: p,
    tools,
    hooks,
    catalogue,
    views,
    memory,
    onMemory: (name, m) => store.index.reindexMemory(name, m),
    bus,
    log: log.child("editable"),
    pollMs: config.editable.poll_ms,
    hooksActive: () => (nodes?.roleOf() ?? config.node.role) === "primary",
    onFile: (rel, kind) => {
      nodes?.onFile(rel, kind);
      backup?.onFile(rel, kind);
    },
  });
  const scheduler = new TaskScheduler({ tasks, bus, stream: events, tz, log: log.child("tasks") });

  // The update module before the api, whose methods call it; its checks start after the brain.
  let api: ApiServer | undefined;
  let stopper: (() => Promise<void>) | undefined;
  const locate = () => locateBrain({ config: config.brain, env, home: p.home, ...(install ? { installDir: install.dir } : {}) });
  const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  /** What a stop now would cut off, for an update and a restart alike. Empty means idle. */
  const busyReasons = (): string[] => {
    const reasons: string[] = [];
    const open = asks.listOpen().length;
    if (open > 0) reasons.push(plural(open, "open ask"));
    const held = sessions.heldCount();
    if (held > 0) reasons.push(plural(held, "held hook response"));
    const prompts = sessions.acpInFlight();
    if (prompts > 0) reasons.push(`${plural(prompts, "agent prompt")} in flight`);
    if (brain?.state === "starting") reasons.push("brain starting");
    const inflight = brain?.inflightCount ?? 0;
    if (inflight > 0) reasons.push(`${plural(inflight, "brain request")} in flight`);
    return reasons;
  };
  const update = new Update({
    config: config.update,
    dataDir: p.data,
    nodeId: identity.id,
    platformVersion: PLATFORM_VERSION,
    keys: opts.update?.keys ?? RELEASE_KEYS,
    ...(install ? { install } : {}),
    brain: () => brain,
    locate,
    busy: busyReasons,
    uiConnected: () => api?.clients().some((c) => c.kind === "ui") ?? false,
    exit:
      opts.update?.exit ??
      ((code) => {
        void (stopper ? stopper() : Promise.resolve()).finally(() => process.exit(code));
      }),
    store,
    bus,
    log: log.child("update"),
    onModel: (name, dir) => voice?.onModel(name, dir),
    voiceIdle: () => voice?.idle() ?? true,
    beta: () => cloud.betaFeed(),
    ...(opts.update?.fetch ? { fetch: opts.update.fetch } : {}),
    ...(opts.update?.target ? { target: opts.update.target } : {}),
    ...(opts.update?.applyRetryMs !== undefined ? { applyRetryMs: opts.update.applyRetryMs } : {}),
    ...(opts.update?.exitDelayMs !== undefined ? { exitDelayMs: opts.update.exitDelayMs } : {}),
  });

  // The clients of both listeners, the grants they authenticate with, and the pairing
  // window that makes one. The registry is shared: a notification reaches a phone and a
  // desktop alike, and speech reaches exactly one client. What this node mints while it is
  // not the primary is its own alone. The phones paired before grants move in place: into
  // the primary's grants on a node whose rows were the primary's (a primary, a backup), into
  // its own on any other.
  const clients = new ClientRegistry();
  const grants = new Grants({ store, registry: clients, local: () => (nodes?.roleOf() ?? config.node.role) !== "primary" });
  const migrated = grants.migrate(config.node.role === "primary" || config.node.backup ? GRANTS_NS : LOCAL_GRANTS_NS);
  if (migrated > 0) log.info("paired phones moved to grants, with full access", { count: migrated });
  // `node.restart`: a desktop app on this machine starts the next daemon, else this one does.
  const restart = new Restart({
    busy: busyReasons,
    desktopAttached: () => clients.desktopAttached(),
    preflight: opts.restart?.preflight ?? (() => checkSuccessor(join(p.data, "cophylad.log"))),
    respawn: opts.restart?.respawn ?? (() => spawnSuccessor(join(p.data, "cophylad.log"))),
    stop: () => (stopper ? stopper() : Promise.resolve()),
    exit: opts.restart?.exit ?? ((code) => process.exit(code)),
    log: log.child("restart"),
    ...(opts.restart?.delayMs !== undefined ? { delayMs: opts.restart.delayMs } : {}),
  });
  const pairing = new Pairing({ grants });
  const tickets = new ViewTickets();
  const sidecars = new Sidecars({ dir: p.sidecars, log: log.child("sidecars") });

  // The sampler: this machine through the OS engine, owned by session, delivered to the clients that subscribed.
  const metricsLog = log.child("metrics");
  // Each login's plan limits: on every sample while someone watches, and read now for `profile.limits`.
  // Under test a login's limits are read only through a fetch the test hands in: never the network.
  const limits =
    config.metrics.limits && (opts.metrics?.limitsFetch || env["NODE_ENV"] !== "test")
      ? new PlanLimits({
          profiles: () => profiles.list(identity.id),
          log: metricsLog.child("limits"),
          muse: (id) => muse?.limits(id) ?? Promise.resolve(undefined),
          ...(opts.metrics?.limitsFetch ? { fetch: opts.metrics.limitsFetch } : {}),
          ...(opts.metrics?.now ? { now: opts.metrics.now } : {}),
        })
      : undefined;
  const metrics = new Metrics({
    config: config.metrics,
    nodeId: identity.id,
    store,
    bus,
    log: metricsLog,
    engine: opts.metrics?.engine ?? (config.metrics.enabled ? hostEngine({ gpu: config.metrics.gpu, log: metricsLog }) : { name: "off", sample: () => ({ at: Date.now(), monoNs: 0n, cores: 1, cpu: { busyNs: 0, totalNs: 0 }, memory: { used: 0, total: 0 }, processes: [] }) }),
    sessions: { pids: () => sessions.pids(), list: () => sessions.list() },
    brainPid: () => brain?.pid,
    // tether's hosts count as sidecars: what a session's own tree does not claim of them (a terminal's console host) is theirs.
    sidecarPids: () => new Map([...sidecars.list().flatMap((s) => (s.pid !== undefined ? [[s.pid, s.name] as [number, string]] : [])), ...(tether?.hostPids() ?? []).map((pid) => [pid, "tether"] as [number, string]), ...(direct.pid !== undefined ? [[direct.pid, "cophyla-net"] as [number, string]] : [])]),
    // A subscriber named `link:…` is the primary watching this node: its samples go up the node link.
    deliver: (id, sample) => (id.startsWith("link:") ? (nodes?.deliverSample(sample) ?? false) : clients.send(id, "metrics.sample", sample)),
    ...(limits ? { limits } : {}),
    ...(opts.metrics?.now ? { now: opts.metrics.now } : {}),
    ...(opts.metrics?.manual ? { manual: true } : {}),
  });
  // The brain's listeners: on the primary, beside the scheduler; a metric one watches its node's samples.
  const listeners = new Listeners({
    store,
    bus,
    stream: events,
    nodeId: identity.id,
    knownEvent: (name) => catalogue.ownerOf(name) !== undefined,
    knownNode: (id) => nodes?.forwardHost.registryList().some((n) => n.id === id) ?? false,
    session: (id) => sessions.get(id) ?? nodes?.forwardHost.mirrorSessions().find((s) => s.id === id),
    task: (id) => tasks.get(id),
    metrics,
    remote: {
      watch: (client, node, intervalMs) => nodes!.forwardHost.remoteMetrics.subscribe(client, node, intervalMs, "owners"),
      unwatch: (client) => nodes!.forwardHost.remoteMetrics.unsubscribe(client),
    },
    log: log.child("listeners"),
  });
  /** What runs on the primary alone beside the brain, started and stopped with the role. */
  const automation = {
    start: () => {
      scheduler.start();
      listeners.start();
    },
    stop: () => {
      scheduler.stop();
      listeners.stop();
    },
  };

  const affinity = opts.voice?.affinity === null ? undefined : (opts.voice?.affinity ?? (config.voice.enabled ? resolveAffinity(config.voice.cpu_affinity, log.child("voice")) : undefined));
  const voiceLog = log.child("voice");
  const ttsPy = new TtsPy({
    root: join(p.sidecars, "tts-py"),
    shipped: TTS_PY_DIR,
    config: config.voice,
    log: voiceLog.child("tts-py"),
    sidecars,
    progress: (event) => voice?.setup(event),
    ...(affinity !== undefined ? { affinity } : {}),
  });
  /** What a reply's references are called when they are read out. */
  const names: SpeechNames = {
    session: (id) => {
      const s = sessions.get(id);
      if (!s) return undefined;
      const ws = s.workspace ? workspaces.get(s.workspace) : undefined;
      return ws?.name ?? s.title ?? s.intent;
    },
    task: (id) => tasks.get(id)?.title,
    thread: (id) => chat.get(id)?.topic,
    ask: (id) => asks.get(id)?.title,
  };
  /** Transcription and speech over the network, routed as the model is. */
  const online: OnlineDeps = {
    sttRoutes: config.providers.stt,
    ttsRoutes: config.providers.tts,
    server: cloud.speechRoute(),
    gemini: { apiKey: () => config.providers.gemini.api_key ?? env["GEMINI_API_KEY"], baseUrl: config.providers.gemini.base_url, model: config.providers.gemini.stt_model },
    deepinfra: { apiKey: () => config.providers.deepinfra.api_key ?? env["DEEPINFRA_API_KEY"], baseUrl: config.providers.deepinfra.base_url, model: config.providers.deepinfra.tts_model },
    ...(config.voice.stt_language ? { language: config.voice.stt_language } : {}),
    log: voiceLog.child("online"),
  };
  voice = new Voice({
    config: config.voice,
    dataDir: p.data,
    bus,
    log: voiceLog,
    clients,
    chat,
    activity,
    models: modelResolver({ ...(config.voice.models_dir ? { override: config.voice.models_dir } : {}), dataDir: p.data, update, log: voiceLog }),
    sidecars,
    engines:
      opts.voice?.engines ??
      localEngines({ dataDir: p.data, log: voiceLog, ...(affinity !== undefined ? { affinity } : {}), ttsPy, ...(config.voice.models_dir ? { modelsDir: config.voice.models_dir } : {}) }),
    hosted: { stt: () => onlineStt(online), tts: () => onlineTts(online) },
    names,
    onStageChange: () => bus.emit("node.state", node()),
    prefs: storePrefs(store),
  });

  let controller: ApiServer | undefined;
  const controllerOrigin = () => controller?.origin ?? `https://${lanAddress() ?? "127.0.0.1"}:${config.controller.port}`;

  // The pipes a stream page's connections ride where there is no route to its desktop: from a
  // phone's forwarder or a window's forwarder here, over the links, to the host's loopback proxy.
  const pipes = new PipeHub({
    selfId: () => identity.id,
    loopbackPort: () => remote!.loopback.port(),
    clientWire: (client) => ({
      data: (pipe, data) => clients.sendLocal(client, "remote.pipe.data", { pipe, data }),
      ack: (pipe, bytes) => void clients.sendLocal(client, "remote.pipe.ack", { pipe, bytes }),
      close: (pipe, reason) => void clients.sendLocal(client, "remote.pipe.close", { pipe, reason: reason.slice(0, 200) }),
    }),
    linkWire: (target) => nodes?.linkWire(target),
    nextHop: (target) => nodes?.nextHop(target),
    openOnLink: (hop, params) => nodes!.openPipeOn(hop, params),
    log: log.child("pipes"),
  });

  // The remote desktop: this node's host, the viewers it runs for its clients, the brain's
  // screenshot. A viewer's PIN reaches the desktop's owner through the nodes module; a
  // stream with no route to its desktop gets its ticket there over the links, and its pipes.
  remote = new Remote({
    config: config.remote,
    nodeId: identity.id,
    nodeName: identity.name,
    dir: join(p.data, "remote"),
    sidecarsDir: p.sidecars,
    bus,
    log: log.child("remote"),
    sidecars,
    // This node's own host is asked through the gate as the client that opened the desktop, so the
    // pairing is audited here like any other; another node's is carried there and gated by its owner.
    pairOn: async (target, pin, via) => {
      if (target !== identity.id) return nodes!.pairOn(target, pin);
      const principal = { kind: "user", client: via } as const;
      await gate.run({ principal, via, action: "remote.pair", target: pin.name, args: { node: target, ...pin }, sessionKey: via, ask: pairAsk(pin.name) }, () => remote!.pair(pin.pin, pin.name));
    },
    addressOf: (target) => nodes!.addressOf(target),
    lanRoute: (target) => nodes!.lanRoute(target),
    lanIps: () => lanEndpoints().ips,
    onStateChange: () => bus.emit("node.state", node()),
    links: { request: (target, method, params, o) => nodes!.linkRequest(target, method, params, o) },
    pipes,
    direct: {
      get ready() {
        return direct.ready;
      },
      iceServers: () => direct.iceServers(),
      request: (method, params) => direct.request(method, params),
    },
    ...(opts.remote ?? {}),
  });

  // Direct connections: the helper, run while the owner has them switched on, signed in, on a
  // plan that has them. It runs from a copy in a folder that never moves, which a firewall rule can name.
  const direct = new Direct({
    config: config.direct,
    nodeId: identity.id,
    store,
    bus,
    log: log.child("direct"),
    // A node with no account of its own (a guest) runs its direct connections on its
    // primary's while it is linked: the plan's word and the TURN credentials come over the link.
    cloud: {
      get signedIn() {
        return cloud.signedIn || (nodes?.linked() ?? false);
      },
      entitlement: () => {
        const e = cloud.entitlement();
        return cloud.signedIn || !nodes?.linked() ? e : { ...e, hosted: { ...e.hosted, direct: true } };
      },
      turnCredentials: () => (cloud.signedIn ? cloud.turnCredentials() : nodes!.turnFromPrimary()),
      directReport: (report) => (cloud.signedIn ? cloud.directReport(report) : Promise.resolve()),
      onUp: (fn) => cloud.onUp(fn),
    },
    command:
      env["NODE_ENV"] === "test"
        ? () => undefined
        : () => {
            const found = locateNet({ config: config.direct, env, ...(install ? { versionDir: install.versionDir } : { repoRoot: repoRootFromHere() }) });
            return found ? stageNet(found.path, install ? join(install.dir, "bin") : join(p.data, "net")) : undefined;
          },
    env: helperEnv(env),
    remoteDir: join(p.data, "remote"),
    ...(opts.direct?.command ? { command: opts.direct.command } : {}),
    ...(opts.direct?.spawn ? { spawn: opts.direct.spawn } : {}),
    ...(opts.direct?.now ? { now: opts.direct.now } : {}),
  });
  // a guest's direct connections follow its link: they may run while it is linked, on the primary's plan
  bus.on("node.state", (row) => {
    if (row.id === identity.id && !cloud.signedIn) void direct.evaluate();
  });
  // Phones on data channels: offered over the relay, served by the api once open.
  const directClients = new DirectClients({
    direct,
    log: log.child("direct"),
    // a phone's data channel is keyed from its grant's key, as its relay tunnels are: a grant that ended opens none
    controllerKey: (controller) => {
      const row = grants.get(controller);
      return row?.kind === "controller" && !grants.expired(row) ? grants.key(controller) : undefined;
    },
    accept: () => (api ? (sock, o) => api!.acceptTunnel(sock, o) : undefined),
    sendTo: (client, method, params) => clients.sendLocal(client, method, params),
    ...(opts.direct?.openTimeoutMs !== undefined ? { openTimeoutMs: opts.direct.openTimeoutMs } : {}),
  });

  // The nodes module: the role, the links, the mirrors. The brain is started and stopped
  // through it, since a promotion or a step-down moves the brain with the role.
  const capDeps = { node, asks, profiles, sessions, workspaces, chat, tasks, prompts, memory, tools, catalogue, llm, store, voice, metrics, remote, listeners, ...(limits ? { limits } : {}) };
  // The link is built before anything can raise an event, so a hook's first emit or a
  // trigger missed while the daemon was down waits in its outbox for the handshake; the
  // brain itself is spawned once everything it can ask for is there.
  const buildBrain = (): BrainLink | undefined => {
    if (brain) return brain;
    if (!(opts.brain ?? config.brain.enabled ?? true)) return undefined;
    if (!locate()) {
      log.info("brain off: nothing to run", { home: p.home });
      return undefined;
    }
    brain = new BrainLink({
      config: config.brain,
      locate,
      beforeSpawn: () => update.beforeBrainSpawn(),
      verify: (loc) => update.verifyBrain(loc),
      onRefused: (loc, reason) => update.onBrainRefused(loc, reason),
      nodeId: identity.id,
      role: "primary",
      platformVersion: PLATFORM_VERSION,
      tz,
      log: log.child("brain-link"),
      bus,
      stream: events,
      gate,
      policy,
      chat,
      store,
      env,
      methods: capDeps,
      wrapMethods: (table) => withForwarding(table, nodes!.forwardHost),
      entitlement: () => cloud.entitlementToken(),
    } satisfies BrainLinkDeps);
    return brain;
  };
  let brainSpawned = false;
  const startBrain = async () => {
    const b = buildBrain();
    if (!b || brainSpawned) return;
    brainSpawned = true;
    events.prime(sessions.list());
    await b.start();
  };
  const stopBrain = async () => {
    const b = brain;
    brain = undefined;
    brainSpawned = false;
    if (b) await b.stop();
  };
  nodes = new Nodes({
    config,
    paths: p,
    store,
    bus,
    gate,
    policy,
    clients,
    samples: (client, sample) => (client.startsWith("listener:") ? listeners.sample(client, sample) : undefined),
    events,
    editable,
    scheduler: automation,
    tasks,
    asks,
    chat,
    sessions,
    workspaces,
    served: (primaryId) =>
      nodeServedTable({ ...capDeps, quotes: { entry: () => undefined }, stream: { take: () => undefined, push: () => undefined, reset: () => undefined } as never }, primaryId, {
        confine: () => (nodes?.confinement()?.active ? nodes.confinement() : undefined),
      }),
    startBrain,
    stopBrain,
    self: node,
    identity,
    metrics,
    remote: () => remote,
    profiles,
    files,
    direct: () => direct,
    pipes: () => pipes,
    ...(opts.direct?.link ? { directTiming: opts.direct.link } : {}),
    log: log.child("nodes"),
    platformVersion: PLATFORM_VERSION,
    tz,
    grants,
    relayGrant: (peer, o) => cloud.relayGrant(peer, o),
    revokeRelay: (peer) => cloud.revokeRelay(peer),
    lanSpki: () => lanSpki,
    account: () => cloud.account,
    turn: () => direct.turn.get(),
    tools: { source: (name) => tools.source(name), risk: (name) => tools.risk(name) },
    onGrantsChanged: () => sweepGrants(),
    ...(opts.nodes?.discovery ? { discovery: opts.nodes.discovery } : {}),
    relayHost: () => api?.relayHost,
    lanPort: () => controller?.port,
    lanIps: () => lanEndpoints().ips,
    arbiter: () => cloud.arbiter,
    signedIn: () => cloud.signedIn,
    onRole: (primary) => {
      backup?.onRole(primary);
      // what this node ends by itself follows the role
      grantClock?.arm(true);
    },
    ...(opts.nodes?.now ? { now: opts.nodes.now } : {}),
  });
  const forwardHost = nodes.forwardHost;
  // On a node that shares some folders alone, a session's workspace is recorded inside them.
  workspaces.clampRoot = (root, cwd) => nodes?.confinement()?.clamp(root, cwd) ?? root;
  // What a limited client's requests and rows are about is looked up the way the forwarder routes them.
  clients.look = nodes.lookup;
  // The cloud backup's sender: hears the store and the editable layer, sends on the primary, restores onto a fresh install.
  backup = new BackupSync({
    store,
    paths: p,
    log: log.child("backup"),
    nodeId: identity.id,
    link: cloud.serverLink,
    allowed: () => cloud.hostedAllowed("backup"),
    planHasBackup: () => cloud.entitlement().hosted.backup === true,
    planBytes: () => cloud.entitlement().limits.backupBytes,
    isPrimary: () => nodes!.roleOf() === "primary",
    linkedBackups: () => nodes!.attachedBackups(),
    stopBrain,
    startBrain,
    scheduler: automation,
    tasks,
    asks,
    editable,
    clients,
    onChange: () => bus.emit("account.state", cloud.state()),
    ...(opts.cloud?.now ? { now: opts.cloud.now } : {}),
    ...(opts.backup ?? {}),
  });
  cloud.attachBackup(backup);
  // The push module: an open ask reaches a paired phone with nothing open, through the server.
  const push = new Push({
    config: config.push,
    bus,
    log: log.child("push"),
    grants,
    clients,
    cloud,
    nodeId: identity.id,
    ...(opts.push?.now ? { now: opts.push.now } : {}),
  });
  /** The relay access a freshly paired phone gets with its token, when the cloud can mint it now. */
  let relayAccessWarned = false;
  const relayAccess = async (id: string, name: string): Promise<RelayAccess | undefined> => {
    try {
      const access = await cloud.relayAccess(id, name);
      grants.setRelay(id, true);
      return access;
    } catch (e) {
      if (!relayAccessWarned) {
        relayAccessWarned = true;
        log.info("a paired phone got no relay access; it can ask relay.info later", { reason: e instanceof Error ? e.message : String(e) });
      }
      return undefined;
    }
  };
  /** The LAN listener as a phone paired through the account pins it, once that listener is up. */
  let lanPin: PairedLan | undefined;
  let grantClock: GrantClock | undefined;
  /** A grant that went, or ran out, closes what it authenticated here: on a backup the primary's grants change under the replica. */
  const sweepGrants = (): void => {
    const at = Date.now();
    for (const entry of clients.withGrants()) {
      const row = grants.get(entry.client.controller!);
      if (!row || grants.expired(row, at)) clients.close(entry.client.id, 4401, "grant ended");
    }
  };
  /** The SHA-256 of the LAN listener's key, whatever address it is on: what a node invite and enrollment carry. */
  let lanSpki: string | undefined;
  /**
   * A phone that signed in with the account, on its pairing tunnel: a controller of its own
   * and the relay access it needs to come back (without it the pairing fails and leaves no
   * row), and the LAN listener's address and key for when it is home.
   */
  const accountPairing = async (name: string, login: string): Promise<AccountPaired> => {
    const { controller: row, token } = grants.createController(name, { account: login });
    let relay: RelayAccess;
    try {
      relay = await cloud.relayAccess(row.id, row.name);
    } catch (e) {
      grants.revoke(row.id);
      if (e instanceof RpcError) throw e;
      throw new RpcError("unavailable", `the relay could not be granted: ${e instanceof Error ? e.message : String(e)}`, { provider: "server" });
    }
    grants.setRelay(row.id, true);
    return { token, client: { ...row, relay: true }, relay, ...(lanPin ? { lan: lanPin } : {}) };
  };
  // The node's terminals as clients see them: a row each, and the screens a client opens.
  const terminalRows = tether ? new TerminalRows({ tether, bus, nodeId: identity.id, workspaces, env: scrub(env), sessionOf: (ref) => sessions.sessionOfTerminal(ref), agentsOf: (ref) => sessions.agentsOf(ref), onAgents: (fn) => sessions.onAgents(fn), cliOf: (ref) => sessions.cliOf(ref), log: sessionsLog.child("terminals") }) : undefined;
  const terminalStreams = tether && terminalRows ? new TerminalStreams({ tether, registry: clients, rows: terminalRows, log: sessionsLog.child("terminals") }) : undefined;
  /** A phone's grant ended: its sockets close, the server forgets its relay peer (and a pending invite's), its push device goes. */
  const revokeController = (id: string): void => {
    const row = grants.revoke(id);
    if (row?.invite?.peer) void cloud.revokeRelay(row.invite.peer);
    for (const entry of clients.byController(id)) clients.close(entry.client.id, 4401, "controller revoked");
    void cloud.revokeRelay(id);
    push.unregister(id);
  };
  // The one timer to the nearest end among the grants this node owns: the primary's on the
  // primary, and everywhere the ones minted here alone. What runs out ends as a revoke does.
  grantClock = new GrantClock({
    grants,
    owns: (row) => grants.isLocal(row.id) || nodes?.roleOf() === "primary",
    end: (row, why) => {
      if (row.kind === "controller") revokeController(row.id);
      else void nodes!.revoke(row.id, why).catch((e: unknown) => log.warn("a node grant that ran out could not be ended", { grant: row.id, error: e instanceof Error ? e.message : String(e) }));
    },
    log: log.child("grants"),
  });
  grantClock.start();
  // A phone's invite: the LAN listener it names when the controller app is served there, and the relay when the cloud can grant one.
  const phones = new PhoneInvites({
    grants,
    identity,
    lan: () => {
      const port = controller?.port;
      if (!config.controller.enabled || port === undefined || lanSpki === undefined) return undefined;
      const ips = lanEndpoints().ips;
      const hosts = [...ips.filter((ip) => ip !== "127.0.0.1"), ...ips.filter((ip) => ip === "127.0.0.1")];
      return hosts.length > 0 ? { hosts, port, spki: lanSpki } : undefined;
    },
    lanPin: () => lanPin,
    relayGrant: (peer, o) => cloud.relayGrant(peer, o),
    relayAccess,
    revokeRelay: (peer) => void cloud.revokeRelay(peer),
    log: log.child("grants"),
  });
  const methods = withForwarding({
    ...foundationMethods({ asks, node, promote: (id) => nodes!.promote(id), restart: (force, by) => restart.request({ force, by }) }),
    ...attachMethods({ sessions, workspaces, profiles, clients, nodeId: identity.id, ...(limits ? { limits } : {}) }),
    ...fileMethods({ files }),
    ...viewMethods({ views }),
    ...viewStageMethods({ views, tickets }),
    ...chatMethods({ chat }),
    ...taskMethods({ tasks }),
    ...eventMethods({ catalogue }),
    ...listenerMethods({ listeners }),
    ...updateMethods({ update }),
    ...pairingMethods({
      pairing,
      grants,
      registry: clients,
      url: (code) => `${controllerOrigin()}/?code=${code}`,
      relayAccess: (id, name) => cloud.relayAccess(id, name),
      onRevoke: (id) => {
        void cloud.revokeRelay(id);
        push.unregister(id);
      },
      push: { register: (id, device) => push.register(id, device), unregister: (id) => push.unregister(id) },
    }),
    ...voiceMethods({ voice }),
    ...metricsMethods({ metrics }),
    ...remoteMethods({ remote, pipes }),
    ...accountMethods({ cloud }),
    ...backupMethods({ sync: backup }),
    ...grantMethods({
      grants,
      nodes: {
        invite: (o) => nodes!.invite(o),
        join: (invite, o) => nodes!.join(invite, o),
        leave: () => nodes!.leave(),
        revoke: (id) => nodes!.revoke(id),
      },
      revokeController,
      phones,
    }),
    ...directMethods({ direct, clients: directClients }),
    ...(terminalRows && terminalStreams ? terminalMethods({ rows: terminalRows, streams: terminalStreams }) : {}),
  }, forwardHost);
  const signals = { ...chatSignals({ activity }), ...voiceSignals({ voice }), ...(terminalStreams ? terminalSignals({ streams: terminalStreams }) : {}), ...directSignals({ clients: directClients }), ...pipeSignals({ pipes }) };
  const remoteModule = remote;
  const initial = () => {
    const v = voice!.snapshot();
    const remote = nodes!.initial();
    return {
      sessions: [...sessions.list(), ...remote.sessions],
      terminals: terminalRows?.list() ?? [],
      workspaces: [...workspaces.list({ node: identity.id }), ...remote.workspaces],
      tasks: tasks.open(),
      updates: [...update.snapshot(), ...remote.updates],
      voice: { states: v.states, setup: v.setup },
      asks: remote.asks,
      nodes: remote.nodes,
      remote: remoteModule.states(),
      account: cloud.state(),
      direct: direct.states(),
    };
  };
  const onDisconnect = (client: Node extends never ? never : { id: string }) => {
    activity.forget(client.id);
    voice?.onDisconnect(client.id);
    tickets.forget(client.id);
    metrics.onDisconnect(client.id);
    nodes?.onDisconnect(client.id);
    remoteModule.onDisconnect(client.id);
    pipes.gone(`client:${client.id}`);
    directClients.clientGone(client.id);
    terminalStreams?.dropClient(client.id);
  };

  api = startApi(
    {
      config,
      log,
      gate,
      policy,
      asks,
      bus,
      registry: clients,
      auth: { shared: token, grants },
      tickets,
      node,
      methods,
      signals,
      platformVersion: PLATFORM_VERSION,
      audio: { codecs: AUDIO_CODECS },
      hooks: { token: hookToken, onHook: (harness, event, meta) => sessions.onHook(harness, event, meta) },
      initial,
      onDisconnect,
      nodes: { relay: nodes.seams.relay },
      accountPairing,
      abandonPairing: (id) => {
        grants.revoke(id);
        void cloud.revokeRelay(id);
      },
      redeemInvite: (p, via) => phones.redeem(p, via),
    },
    { listener: "loopback", ...(opts.port !== undefined ? { port: opts.port } : {}) },
  );

  // The LAN listener: the same methods, a certificate this node made for itself, the
  // controller app's files, the pairing window as the only way in for a phone, and
  // `/ws/node` for other nodes. It comes up for the controller, for `[nodes] accept`, and
  // on a backup, which must be reachable to take the role.
  if (config.controller.enabled || config.nodes.accept || config.node.backup) {
    const app = config.controller.app_dir ?? CONTROLLER_DIST;
    try {
      const endpoints = lanEndpoints();
      const cert = ensureCertificate(p.tls, { dnsNames: endpoints.dnsNames, ips: endpoints.ips }, log.child("controller"));
      controller = startApi(
        {
          config,
          log,
          gate,
          policy,
          asks,
          bus,
          registry: clients,
          auth: { grants },
          pairing,
          tickets,
          static: app,
          node,
          methods,
          signals,
          platformVersion: PLATFORM_VERSION,
          audio: { codecs: AUDIO_CODECS },
          initial,
          onDisconnect,
          nodes: nodes.seams,
          remote: remote.proxy,
          relayAccess,
          redeemInvite: (p, via) => phones.redeem(p, via),
        },
        { host: config.controller.host, port: config.controller.port, tls: { key: cert.keyPem, cert: cert.certPem }, listener: "controller" },
      );
      const lanHost = new URL(controller.origin).hostname;
      lanSpki = spkiHash(cert.certPem);
      if (lanHost !== "127.0.0.1" && lanHost !== "localhost") lanPin = { host: lanHost, port: controller.port, spki: lanSpki };
      log.info("controller listener up", { origin: controller.origin, app: config.controller.enabled ? app : "off", nodes: "/ws/node" });
    } catch (e) {
      log.error("controller listener off", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // tether's hosts before the first discovery pass, so a session in one is met with its terminal.
  if (tether) {
    await tether.start().catch((e: unknown) => sessionsLog.warn("tether did not start", { error: e instanceof Error ? e.message : String(e) }));
  }
  await sessions.start({ port: api.port });
  if (tether?.available && config.tether.profiles) {
    void writeEntryPoints({ tether, profiles, dataDir: p.data, editorsDir: join(p.home, "editors"), log: sessionsLog.child("tether") });
  }
  // A harness signed in or out since: the node's row says what it runs now, and the entry points are written again.
  let harnessesOk = profiles.harnessesOk().join(",");
  const offProfiles = profiles.onChange(() => {
    const now = profiles.harnessesOk().join(",");
    if (now === harnessesOk) return;
    harnessesOk = now;
    bus.emit("node.state", node());
    if (tether?.available && config.tether.profiles) void writeEntryPoints({ tether, profiles, dataDir: p.data, editorsDir: join(p.home, "editors"), log: sessionsLog.child("tether") });
  });
  // The `tether` command in the user's own shells: an installed platform's, never a checkout's or a test's (whose tether is given).
  if (tether?.exe && !opts.tether && install && config.tether.on_path) {
    void putCommandOnPath({ exe: tether.exe, root: install.dir, env, log: sessionsLog.child("tether") });
  }
  tasks.prime(sessions.list());
  events.start(sessions.list());
  const stopRecorder = recordCustomEvents(events, store, identity.id);

  // The account link first: a signed-in primary asks the server's registry before it takes
  // the role, and a secondary with no primary in reach links through the relay. The stored
  // entitlement still rides on the brain's first frame after hello.
  cloud.start();
  direct.start();

  // The role settles here: a configured primary listens for a live one first, so the brain
  // never starts under a primary of a higher epoch; a secondary begins seeking.
  await nodes.start();

  // The brain runs only while this node is the primary; a promotion later starts it through
  // `nodes`. Its link is built now, ahead of the hooks and the scheduler, and the brain is
  // spawned last: located again at every spawn, after the update module has promoted a
  // staged release, and verified.
  const primary = nodes.roleOf() === "primary";
  if (primary) buildBrain();

  await editable.start();
  if (primary) automation.start();

  // The recall index: memory reconciled now, the backfill and the model in the background.
  // Startup never waits on the model; recall is full-text only until it is up.
  const indexLog = log.child("index");
  const embedder =
    opts.embedder !== undefined
      ? (opts.embedder ?? undefined)
      : config.store.embedding === "off"
        ? undefined
        : config.store.embedding === "server"
          ? cloud.embedder()
          : loadEmbedder(config.store.embedding_model ?? DEFAULT_MODEL_DIR, indexLog);
  void store.index.start({ ...(embedder ? { embedder } : {}), config: config.store, log: indexLog, memories: () => memory.all() });
  // a hosted embedder's queue stops while the link is down: the next link-up drains it
  if (config.store.embedding === "server") cloud.onUp(() => store.index.kick());

  if (primary) await startBrain();
  update.start();
  await metrics.start();
  await voice.start();
  remote.start();

  log.info("cophylad started", {
    node: identity.id,
    name: identity.name,
    role: nodes.roleOf(),
    epoch: nodes.epoch(),
    home: p.home,
    harnesses: profiles.harnessesOk(),
    brain: brain?.state ?? "off",
    platform: PLATFORM_VERSION,
    install: install?.dir ?? "checkout",
    tz,
    tools: tools.list().filter((t) => t.source === "editable").length,
    hooks: hooks.list().length,
    problems: editable.problems().length,
    voice: config.voice.enabled ? voice.stageStates() : "off",
    controller: controller?.origin ?? "off",
    metrics: config.metrics.enabled ? metrics.snapshot().engine : "off",
    remote: config.remote.enabled ? remote.state().host.status : "off",
    nodes: nodes.state(),
    cluster: nodes.member()?.cluster ?? "none",
    account: cloud.signedIn ? cloud.state().plan : "signed out",
    relay: config.nodes.relay ? "on" : "off",
    push: config.push.enabled ? "on" : "off",
  });

  const daemon: Daemon = {
    paths: p,
    config,
    store,
    identity,
    node,
    token,
    hookToken,
    bus,
    policy,
    asks,
    audit,
    gate,
    profiles,
    workspaces,
    sessions,
    views,
    chat,
    activity,
    tasks,
    scheduler,
    listeners,
    tools,
    prompts,
    memory,
    events,
    catalogue,
    hooks,
    editable,
    tz,
    cloud,
    backup,
    llm,
    update,
    get brain() {
      return brain;
    },
    api,
    clients,
    grants,
    pairing,
    tickets,
    sidecars,
    voice,
    metrics,
    remote,
    pipes,
    direct,
    nodes,
    push,
    ...(controller ? { controller } : {}),
    stop: async () => {
      grantClock?.dispose();
      push.dispose();
      await cloud.stop();
      metrics.dispose();
      update.dispose();
      await nodes!.stop();
      directClients.stop();
      await direct.stop();
      await stopBrain();
      await voice.stop();
      pipes.closeAll("stopping");
      await remote.stop();
      await sidecars.stopAll();
      pairing.dispose();
      automation.stop();
      await editable.stop();
      await hooks.dispose();
      stopRecorder();
      events.dispose();
      offProfiles();
      await sessions.stop();
      processEngine?.dispose?.();
      await terminalStreams?.stop();
      terminalRows?.stop();
      await tether?.stop();
      if (controller) await controller.stop();
      await api.stop();
      activity.dispose();
      tasks.dispose();
      workspaces.dispose();
      asks.dispose();
      await store.index.stop();
      store.close();
      log.info("cophylad stopped");
    },
  };
  stopper = daemon.stop;
  return daemon;
}
