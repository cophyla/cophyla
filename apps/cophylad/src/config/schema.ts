// config.toml: node role, zone and scope, the api binding, the gate's policy, the sessions
// module and tether, the brain, provider routing, the ACP adapters, the tool caps, the
// editable layer's poll, the release feed, the controller listener, the voice stages, the
// metrics sampler, the node link and the cloud account. Every field has a default, so an
// empty file is a valid one.

import { z } from "zod";
import { BrainChannel, Decision, NodeRole, NodeScope, PrincipalKind, RiskClass } from "@cophyla/protocol";

/** Whether `tz` names a zone Intl knows. */
function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type RiskPolicy = { read: Decision; write: Decision; exec: Decision; network: Decision };

/** A policy section whose fields each default, so a partial section is a valid one. */
function riskPolicy(d: RiskPolicy) {
  return z
    .object({
      read: Decision.default(d.read),
      write: Decision.default(d.write),
      exec: Decision.default(d.exec),
      network: Decision.default(d.network),
    })
    .prefault({});
}

const ALL_ALLOW: RiskPolicy = { read: "allow", write: "allow", exec: "allow", network: "allow" };
const READ_ONLY: RiskPolicy = { read: "allow", write: "ask", exec: "ask", network: "ask" };

/**
 * A rule key is `principal:action` or `principal:action@target`, where principal is a
 * principal kind or `*`. Examples: `brain:session.send`, `brain:tool.run@my.deploy`,
 * `*:remote.open`.
 */
export const RULE_KEY = /^(\*|user|brain|node|harness):([A-Za-z0-9_.*-]+)(?:@(.+))?$/;

export const GateConfig = z.object({
  /** Bytes. A result at or under it is kept whole in the audit table; over it, as hash and size. */
  audit_result_cap: z.number().int().nonnegative().default(65536),
  /** Milliseconds a gate ask stays open. 0 means until it is answered. */
  ask_timeout_ms: z.number().int().nonnegative().default(0),
  /** The default decision per risk class, per principal kind. */
  policy: z
    .object({
      user: riskPolicy(ALL_ALLOW),
      brain: riskPolicy(READ_ONLY),
      node: riskPolicy(READ_ONLY),
      harness: riskPolicy(READ_ONLY),
    })
    .prefault({}),
  /** Per-action overrides, keyed as RULE_KEY describes. */
  rules: z
    .record(z.string().regex(RULE_KEY, { message: "expected principal:action or principal:action@target" }), Decision)
    .default({}),
});
export type GateConfig = z.infer<typeof GateConfig>;

/** The `sessions` module: discovery cadence, hook timeouts, receipts. */
export const SessionsConfig = z.object({
  /** Claude registry poll and transcript/rollout tail, in milliseconds. */
  poll_ms: z.number().int().positive().default(2000),
  /** `thread/list` cadence per Codex profile. */
  codex_list_ms: z.number().int().positive().default(10000),
  /** Seconds on every hook cophylad installs; a harness ask's `expiresAt` follows it. */
  hook_timeout_s: z.number().int().positive().default(7200),
  /** Codex: withdraw a queued message with no receipt after this, once the thread is not busy. */
  receipt_timeout_ms: z.number().int().positive().default(30000),
  /** A Codex thread with rollout activity this recent is listed before any hook is seen. */
  codex_recent_ms: z.number().int().positive().default(600000),
  /** `session/list` cadence per Muse profile: Muse lists a session only once it is closed, so one listed ends. */
  muse_list_ms: z.number().int().positive().default(2000),
  /** A Muse session with no process known ends this long after its log was last written; the list looks as far back. */
  muse_recent_ms: z.number().int().positive().default(600000),
  /** A Claude session known only from its hooks, with no process to watch, ends this long after its last hook. */
  claude_hook_grace_ms: z.number().int().positive().default(600000),
  /** Write cophylad's hooks into each profile's configuration at start. */
  install_hooks: z.boolean().default(true),
  /** Scan the default installation of each harness. Declared profiles are always used. */
  discover: z.boolean().default(true),
  /**
   * Where a session cophylad starts runs. `terminal` runs it in a terminal of its own, which is
   * the harness's own interface: held by tether when tether is found, with a window on it in
   * the editor's panel or the platform's terminal, else started straight in such a window.
   * `acp` starts it as a child speaking ACP, with no window (a Muse session: on its own
   * `muse serve` host). A node that can do neither starts it headless.
   */
  launch: z.enum(["terminal", "acp"]).default("terminal"),
  /**
   * How the brain's messages reach a session in tether. `pipe` sends them over the harness's
   * messaging pipe, where it treats them as another agent's; `typed` types them, as the
   * user's own words are.
   */
  brain_sends: z.enum(["pipe", "typed"]).default("pipe"),
});
export type SessionsConfig = z.infer<typeof SessionsConfig>;

/** tether, the pseudo-terminal host the sessions cophylad starts run in. */
export const TetherConfig = z.object({
  /** The binary; found in the platform's version folder, or a checkout's build, when absent. */
  command: z.string().min(1).optional(),
  /** tether's state folder (TETHER_DIR); the user's own by default, which every tether client shares. */
  dir: z.string().min(1).optional(),
  /** A host cophylad starts exits after this long with no session and no client. */
  idle_exit_s: z.number().int().nonnegative().default(600),
  /** Where a window on a session opens when no editor has its folder: Windows Terminal, a console, the classic console, or nowhere. */
  window: z.enum(["auto", "wt", "console", "conhost", "none"]).default("auto"),
  /** A session cophylad starts gets a window at once, as well as its place in the apps; off, one opens when the user raises it. */
  window_on_start: z.boolean().default(false),
  /** Write the Windows Terminal profile that starts the user's own Claude in tether, and tell the editor extension where tether is. */
  profiles: z.boolean().default(true),
  /** An installed platform keeps a `tether` command on the user's PATH. */
  on_path: z.boolean().default(true),
});
export type TetherConfig = z.infer<typeof TetherConfig>;

/** A harness installation the user declared; discovered ones need no entry. */
export const ProfileConfig = z.object({
  harness: z.enum(["claude", "codex", "muse"]),
  name: z.string().min(1),
  config_dir: z.string().min(1),
  /** The binary; the one on PATH by default. */
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  default: z.boolean().default(false),
  /** Claude only: http hooks, or the command shim where http is forbidden. Codex is always command; Muse runs the shim from cophylad's plugin. */
  hooks: z.enum(["http", "command"]).default("http"),
});
export type ProfileConfig = z.infer<typeof ProfileConfig>;

/** The brain child: where it comes from and how it is restarted. */
export const BrainConfig = z.object({
  /** Run the brain. Defaults to the node being the primary. */
  enabled: z.boolean().optional(),
  /** The brain binary or script; found under `data/brain/current` or the dev tree when absent. */
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  restart_backoff_ms: z.number().int().positive().default(1000),
  restart_backoff_max_ms: z.number().int().positive().default(30000),
  /** How long the brain may take to answer `hello`. */
  hello_timeout_ms: z.number().int().positive().default(10000),
});
export type BrainConfig = z.infer<typeof BrainConfig>;

const MODEL_NAME = /^[^/]+\/.+$/;

export const TierConfig = z.object({
  /** `vendor/model`. */
  model: z.string().regex(MODEL_NAME, { message: "expected vendor/model" }),
  /** The vendor's thinking level for the tier: minimal, low, medium, high. */
  thinking: z.enum(["minimal", "low", "medium", "high"]).optional(),
});
export type TierConfig = z.infer<typeof TierConfig>;

/** One route `llm.complete` may take: `byok:<vendor>`, `local:<engine>` or `server`. */
export const Route = z.string().regex(/^(byok:[a-z0-9-]+|local:[a-z0-9-]+|server)$/, { message: "expected byok:<vendor>, local:<engine> or server" });

/** Provider routing: which routes serve `llm.complete` and in what order, the keys, and what each tier means. */
export const ProvidersConfig = z.object({
  /**
   * The routes in order: a route that cannot serve (`unavailable`, `quota_exceeded`) passes
   * the call to the next; any other failure is the answer. One string is a list of one.
   */
  llm: z
    .union([Route, z.array(Route).min(1)])
    .default(["server", "byok:gemini"])
    .transform((r) => (typeof r === "string" ? [r] : r)),
  gemini: z
    .object({
      /** `GEMINI_API_KEY` in the environment when absent. */
      api_key: z.string().optional(),
      base_url: z.string().url().default("https://generativelanguage.googleapis.com"),
    })
    .prefault({}),
  tiers: z
    .object({
      tiny: TierConfig.default({ model: "gemini/gemini-3.1-flash-lite", thinking: "minimal" }),
      fast: TierConfig.default({ model: "gemini/gemini-3.8-flash", thinking: "low" }),
      smart: TierConfig.default({ model: "gemini/gemini-3.1-pro-preview", thinking: "medium" }),
      local: TierConfig.optional(),
    })
    .prefault({}),
  /** Milliseconds a completion may run. */
  timeout_ms: z.number().int().positive().default(120000),
});
export type ProvidersConfig = z.infer<typeof ProvidersConfig>;

const AcpCommand = z.object({ command: z.string().min(1), args: z.array(z.string()).default([]) });

/** The ACP adapters: what runs them and how long a start may take. */
export const AcpConfig = z.object({
  /** What runs the adapter packages: `node` on PATH, or the daemon's own Bun. */
  runtime: z.enum(["node", "bun"]).default("node"),
  spawn_timeout_ms: z.number().int().positive().default(60000),
  /** A command that replaces the packaged adapter. */
  claude: AcpCommand.optional(),
  codex: AcpCommand.optional(),
});
export type AcpConfig = z.infer<typeof AcpConfig>;

/** Caps on the built-in tools. */
export const ToolsConfig = z.object({
  /** Lines `fs.read` returns at most in one call. */
  read_max_lines: z.number().int().positive().default(400),
  /** Characters kept of one line. */
  line_max_chars: z.number().int().positive().default(400),
  grep_max: z.number().int().positive().default(200),
  glob_max: z.number().int().positive().default(500),
  outline_max_files: z.number().int().positive().default(400),
  http_max_bytes: z.number().int().positive().default(262144),
  http_timeout_ms: z.number().int().positive().default(20000),
});
export type ToolsConfig = z.infer<typeof ToolsConfig>;

/** The store's recall index: the embedding route and the index's sizes. */
export const StoreConfig = z.object({
  /** `local` runs the model shipped with the platform; `server` embeds on the account's hosted compute; `off` keeps recall full-text only. */
  embedding: z.enum(["local", "server", "off"]).default("local"),
  /** A model directory holding `manifest.json`, `model.onnx` and the tokenizer files; the platform's own when absent. */
  embedding_model: z.string().min(1).optional(),
  /** Chunks per model call. */
  embed_batch: z.number().int().positive().default(8),
  /** Characters of a chunk the model reads; the full text is still searchable. */
  embed_max_chars: z.number().int().positive().default(1536),
  /** Vectors kept in memory, newest first; older chunks stay findable by full text. */
  vector_max_rows: z.number().int().positive().default(150000),
  /** Rows per batch when indexing what the store held before the index existed. */
  backfill_batch: z.number().int().positive().default(200),
});
export type StoreConfig = z.infer<typeof StoreConfig>;

/** The `editable` module: the watcher over `~/.cophyla`. */
export const EditableConfig = z.object({
  /** Milliseconds between safety scans behind the file watcher, for edits it misses (a network drive, a silent platform). 0 turns the poll off. */
  poll_ms: z.number().int().nonnegative().default(10000),
});
export type EditableConfig = z.infer<typeof EditableConfig>;

/** The `update` module: the public release feed and how often it is read. */
export const UpdateConfig = z.object({
  /** Poll the feed on a schedule. Off, `update.check` still works by hand. */
  enabled: z.boolean().default(true),
  channel: BrainChannel.default("stable"),
  /** The feed root; the request is `<feed>/<channel>/<os>-<arch>.json` and nothing else. */
  feed: z.string().url().default("https://feed.getcophyla.com"),
  check_interval_ms: z.number().int().positive().default(21600000),
  first_check_delay_ms: z.number().int().nonnegative().default(30000),
  /** Apply a staged brain when the brain is idle, and a staged platform when nothing waits and no desktop app is attached. */
  auto_apply: z.boolean().default(true),
  /** Allow an `http:` feed or artifact off loopback, for a LAN feed during testing. Logged loudly. */
  allow_insecure_feed: z.boolean().default(false),
});
export type UpdateConfig = z.infer<typeof UpdateConfig>;

/** The second listener: the controller app, its views and its socket, on the LAN over TLS; and whether a phone may pair through the account. */
export const ControllerConfig = z.object({
  /** Serve the controller app on the LAN. Off, a phone reaches this node only through the relay, paired through the account. */
  enabled: z.boolean().default(false),
  /** `0.0.0.0` is the point of it: a phone is not on loopback. */
  host: z.string().default("0.0.0.0"),
  port: z.number().int().min(0).max(65535).default(4818),
  /** The built controller app; the one beside the daemon by default. */
  app_dir: z.string().min(1).optional(),
  /** A phone signed in with this node's account pairs through the relay with no code. Off, only a code on the LAN pairs one. */
  account_pairing: z.boolean().default(true),
});
export type ControllerConfig = z.infer<typeof ControllerConfig>;

/** The phrases the wake word listens for unless the config names others: "Cophyla" and "Hey Phyla". */
export const DEFAULT_WAKE_HEADS = ["cophyla_v0.1.onnx", "hey_phyla_v0.1.onnx"] as const;

/** The voice pipeline: which engine serves each stage, and what each one needs. */
export const VoiceConfig = z.object({
  /** Run the pipeline at all. Off, the models are never fetched and nothing listens. */
  enabled: z.boolean().default(false),
  wake: z.enum(["openwakeword", "off"]).default("openwakeword"),
  /** `server` sends each utterance to the account's hosted transcription; the wake word and the VAD stay local. */
  stt: z.enum(["nemotron", "server", "off"]).default("nemotron"),
  /** Kokoro runs in-process on the CPU; Chatterbox needs the GPU sidecar, bootstrapped on demand; `server` is the account's hosted voice. */
  tts: z.enum(["kokoro", "chatterbox", "server", "off"]).default("kokoro"),
  /**
   * The keyword heads inside the wake model directory, one per phrase, all listening at once;
   * one name or a list. A head the model does not have is skipped. A phone that carries every
   * one runs them itself, at the thresholds and scales the node gives it.
   */
  wake_model: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(8)])
    .transform((v) => (typeof v === "string" ? [v] : v))
    .default([...DEFAULT_WAKE_HEADS]),
  /** The input scale every head was trained at; each head's own, from the model's manifest, when absent. */
  wake_scale: z.enum(["int16", "unit"]).optional(),
  /**
   * Score at or above which a phrase counts as said: one for every head, or per head by file
   * name. Each head's own, from the model's manifest, when absent (0.7 when it names none).
   */
  wake_threshold: z.union([z.number().min(0).max(1), z.record(z.string().min(1), z.number().min(0).max(1))]).optional(),
  /** Silence that ends an utterance. */
  vad_min_silence_ms: z.number().int().positive().default(700),
  stt_threads: z.number().int().positive().default(2),
  /** Pin the recogniser to one language; it detects the language when absent. */
  stt_language: z.string().min(2).optional(),
  tts_threads: z.number().int().positive().default(2),
  /** Which of the model's voices speaks. */
  tts_voice: z.number().int().nonnegative().default(0),
  chatterbox_device: z.enum(["cuda", "cpu", "auto"]).default("cuda"),
  /** The reference clip Chatterbox clones, longer than five seconds; the stage is unavailable without one. */
  chatterbox_voice: z.string().min(1).optional(),
  /** `auto` pins the inference threads to the performance cores on a hybrid CPU; or a CPU list, or `off`. */
  cpu_affinity: z.string().regex(/^(auto|off|[\d,-]+)$/, { message: "expected auto, off, or a CPU list such as 0-15" }).default("auto"),
  /** A directory of model folders to use instead of the release feed, for development. */
  models_dir: z.string().min(1).optional(),
  /** How long a turn may wait for the brain before the phone goes idle again. */
  thinking_timeout_ms: z.number().int().positive().default(60000),
});
export type VoiceConfig = z.infer<typeof VoiceConfig>;

/** A model's prices in USD per million tokens. */
export const PriceConfig = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
});
export type PriceConfig = z.infer<typeof PriceConfig>;

/** The `metrics` module: the sampler's rates, retention, the pressure thresholds and the price table. */
export const MetricsConfig = z
  .object({
    /** Sample at all. Off, `metrics.*` answers `unsupported` and no ring or rollup is kept. */
    enabled: z.boolean().default(true),
    /** Milliseconds between samples while no client is subscribed. */
    idle_interval_ms: z.number().int().positive().default(15000),
    /** The floor under a subscriber's interval: nothing samples faster than this. */
    min_interval_ms: z.number().int().positive().default(1000),
    /** Days of per-minute rollups kept in the store. */
    retention_days: z.number().int().positive().default(7),
    /** Percent of a resource at which `node.pressure` says `warn`, and `critical`. */
    warn: z.number().min(0).max(100).default(80),
    critical: z.number().min(0).max(100).default(95),
    /** Read the GPU through NVML where the driver is there. */
    gpu: z.boolean().default(true),
    /**
     * Read each harness login's plan limits for the samples, while a client watches them:
     * Claude's from its usage endpoint with the login's own token, Codex's from its rollouts.
     */
    limits: z.boolean().default(true),
    /** Prices by `vendor/model` (or a bare model name), over the built-in table. */
    prices: z.record(z.string(), PriceConfig).default({}),
  })
  .refine((m) => m.critical > m.warn, { message: "critical must be above warn", path: ["critical"] });
export type MetricsConfig = z.infer<typeof MetricsConfig>;

/** The `remote` module: this node's desktop host, the viewers it acquires, the web sidecar and the screenshot. */
export const RemoteConfig = z.object({
  /** Share this node's desktop: run (and, with `install`, acquire) the host. Off, the node can still view others and take screenshots. */
  enabled: z.boolean().default(false),
  /** Which host to run: `auto` takes whichever is installed, Apollo first. */
  host: z.enum(["auto", "apollo", "sunshine"]).default("auto"),
  /** Install a missing host or viewer through the package manager (winget, brew, flatpak). */
  install: z.boolean().default(true),
  /** The host binary, over the known install paths. */
  host_command: z.string().min(1).optional(),
  /** The moonlight-qt binary, over the known install paths. */
  moonlight: z.string().min(1).optional(),
  /** The host's web credentials, when the user set their own; made and kept under data/remote otherwise. */
  host_user: z.string().min(1).optional(),
  host_password: z.string().min(1).optional(),
  /** Serve phones a stream from this node through the moonlight-web sidecar. */
  web: z.boolean().default(true),
  /** How the browser gets the video: over the controller listener's socket, or WebRTC on UDP 40000–40010. */
  web_transport: z.enum(["websocket", "webrtc"]).default("websocket"),
  /**
   * View another node's desktop over the LAN when there is a route to it. Off, every other
   * node's desktop is shown the way one with no route is, through the links: a check on one machine.
   */
  lan_route: z.boolean().default(true),
  /** The width a screenshot is scaled to. */
  screenshot_width: z.number().int().positive().default(1280),
  /** Milliseconds between polls of the host's client list while it serves. */
  poll_ms: z.number().int().positive().default(3000),
});
export type RemoteConfig = z.infer<typeof RemoteConfig>;

/** A `host:port` another node is reached at. */
const ENDPOINT = /^[A-Za-z0-9.\-[\]:%]+:\d{1,5}$/;

/** The `nodes` module: the link to the primary, discovery on the LAN, the heartbeat and failover timings. */
export const NodesConfig = z.object({
  /** Accept other nodes on the LAN listener: what makes this node a primary others can join. */
  accept: z.boolean().default(false),
  /** Where the primary is, when discovery cannot find it or must not be trusted. */
  primary: z.string().regex(ENDPOINT, { message: "expected host:port" }).optional(),
  /** From before grants, when every node shared one token: read only to say it is ignored, since each node now holds a grant of its own. */
  token: z.string().optional(),
  /** Find the primary by UDP broadcast on this network. */
  discovery: z.boolean().default(true),
  discovery_port: z.number().int().min(1).max(65535).default(4819),
  /** Milliseconds between queries while seeking. */
  discovery_interval_ms: z.number().int().positive().default(2000),
  /** Milliseconds between a primary's beacons. */
  beacon_ms: z.number().int().positive().default(5000),
  heartbeat_ms: z.number().int().positive().default(5000),
  /** How long a backup waits without a primary before it promotes itself, times its rank. */
  failover_ms: z.number().int().positive().default(15000),
  /** How long a starting primary listens for a live one before it takes the role. */
  claim_wait_ms: z.number().int().nonnegative().default(3000),
  reconnect_ms: z.number().int().positive().default(2000),
  reconnect_max_ms: z.number().int().positive().default(30000),
  hello_timeout_ms: z.number().int().positive().default(5000),
  /** Link through the server's relay when the primary is on another network, and let the server's registry arbitrate the role; needs a signed-in account whose plan has the relay. */
  relay: z.boolean().default(true),
  /** Milliseconds between a primary's lease renewals on the server's registry. */
  registry_heartbeat_ms: z.number().int().positive().default(15000),
});
export type NodesConfig = z.infer<typeof NodesConfig>;

/**
 * Direct connections: the helper (`cophyla-net`) opens WebRTC data channels to this node's
 * phones and nodes on other networks, beside the relay. Switched on per node from the
 * account card; these are how it runs once on.
 */
export const DirectConfig = z.object({
  /** The helper's one UDP port on every address; 0 picks one and keeps it. */
  port: z.number().int().min(0).max(65535).default(0),
  /** Ask the router to map the port (UPnP, NAT-PMP, PCP). */
  map_port: z.boolean().default(true),
  /** Use global IPv6 addresses too. */
  ipv6: z.boolean().default(true),
  /** Ports tried past a peer's public one, for a NAT that hands them out in order. */
  predict: z.number().int().min(0).max(64).default(12),
  /** Links to other nodes go direct too, not only phones. */
  nodes: z.boolean().default(true),
  /** Send the server a daily count of the paths that opened: no account, node or address in it. */
  report: z.boolean().default(true),
  /** The STUN servers this node learns its public address from. */
  stun: z.array(z.string().min(1)).default(["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"]),
  /** The helper binary, over the one the platform ships. */
  command: z.string().min(1).optional(),
  /** Milliseconds before the helper is started again after it exited, doubling up to the max. */
  restart_backoff_ms: z.number().int().positive().default(1000),
  restart_backoff_max_ms: z.number().int().positive().default(30000),
});
export type DirectConfig = z.infer<typeof DirectConfig>;

/** Push: an open ask reaches a paired phone that has nothing open, through the server. */
export const PushConfig = z.object({
  enabled: z.boolean().default(true),
});
export type PushConfig = z.infer<typeof PushConfig>;

/** The `cloud` module: the account's server, the outbound link to it and how often the entitlement is refreshed. */
export const CloudConfig = z.object({
  /** Off, the node never contacts the server: no login, no link, no hosted route. */
  enabled: z.boolean().default(true),
  url: z.string().url().default("https://api.getcophyla.com"),
  /** Milliseconds between entitlement refreshes while the link is up. */
  refresh_interval_ms: z.number().int().positive().default(21600000),
  reconnect_ms: z.number().int().positive().default(2000),
  reconnect_max_ms: z.number().int().positive().default(60000),
  /** Milliseconds a hosted request may take. */
  request_timeout_ms: z.number().int().positive().default(120000),
  /** Milliseconds the socket and the auth may take together; a starting primary waits this long for the link before it takes the role on its own. */
  hello_timeout_ms: z.number().int().positive().default(15000),
  /** Allow an `http:` server off loopback, for a fake during testing. Logged loudly. */
  allow_insecure: z.boolean().default(false),
});
export type CloudConfig = z.infer<typeof CloudConfig>;

export const Config = z.object({
  node: z
    .object({
      role: NodeRole.default("primary"),
      /** Defaults to the hostname. */
      name: z.string().min(1).optional(),
      backup: z.boolean().default(false),
      /** Which backup promotes first: 1 before 2. */
      backup_rank: z.number().int().min(1).default(1),
      scope: NodeScope.default({ kind: "machine" }),
      /** The IANA zone cron triggers run in and the brain tells the time in; the machine's own when absent. */
      tz: z.string().refine(validTz, { message: "expected an IANA time zone such as Europe/Istanbul" }).optional(),
    })
    .prefault({}),
  api: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(0).max(65535).default(4817),
    })
    .prefault({}),
  gate: GateConfig.prefault({}),
  sessions: SessionsConfig.prefault({}),
  tether: TetherConfig.prefault({}),
  profiles: z.array(ProfileConfig).default([]),
  brain: BrainConfig.prefault({}),
  providers: ProvidersConfig.prefault({}),
  acp: AcpConfig.prefault({}),
  tools: ToolsConfig.prefault({}),
  store: StoreConfig.prefault({}),
  editable: EditableConfig.prefault({}),
  update: UpdateConfig.prefault({}),
  controller: ControllerConfig.prefault({}),
  voice: VoiceConfig.prefault({}),
  metrics: MetricsConfig.prefault({}),
  nodes: NodesConfig.prefault({}),
  remote: RemoteConfig.prefault({}),
  cloud: CloudConfig.prefault({}),
  direct: DirectConfig.prefault({}),
  push: PushConfig.prefault({}),
  log: z
    .object({
      level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    })
    .prefault({}),
});
export type Config = z.infer<typeof Config>;

export type ConfigInput = z.input<typeof Config>;

export { Decision, PrincipalKind, RiskClass };

export const DEFAULT_CONFIG_TOML = `# cophylad configuration. Every setting has a default; delete a line to get it back.

[node]
# role = "primary"        # primary runs the brain; secondary is hands only
# name = "desk"           # defaults to the hostname
# backup = false          # a secondary that replicates the primary and can take over
# backup_rank = 1         # which backup promotes first: 1 before 2
# tz = "Europe/Istanbul"  # the zone schedules run in; the machine's own when absent

[node.scope]
kind = "machine"          # or "workspaces" with paths = ["/home/me/src/app"] (Windows: "C:\\\\src\\\\app")

[api]
host = "127.0.0.1"
port = 4817

[gate]
audit_result_cap = 65536  # bytes kept whole in the audit table; larger results keep hash and size
ask_timeout_ms = 0        # 0: a gate ask stays open until answered

# The default decision per risk class, per principal kind: allow, deny or ask.
[gate.policy.user]
read = "allow"
write = "allow"
exec = "allow"
network = "allow"

[gate.policy.brain]
read = "allow"
write = "ask"
exec = "ask"
network = "ask"

[gate.policy.node]
read = "allow"
write = "ask"
exec = "ask"
network = "ask"

[gate.policy.harness]
read = "allow"
write = "ask"
exec = "ask"
network = "ask"

# Per-action overrides: "principal:action" or "principal:action@target", principal may be *.
[gate.rules]
# Per-action overrides, above the class defaults and the built-in rules that let the brain
# speak, keep its tasks and threads, write memory and call the configured model without asking.
# "brain:session.send" = "allow"
# "brain:session.spawn" = "allow"
# "brain:llm.complete" = "ask"
# "brain:tool.run@my.deploy" = "deny"
# "node:session.send" = "allow"     # a node that trusts its primary: no second ask on forwarded writes
# "node:remote.pair" = "allow"      # let any node's viewer pair with this desktop without asking

[sessions]
poll_ms = 2000             # Claude registry poll and transcript/rollout tail
codex_list_ms = 10000      # thread/list cadence per Codex profile
hook_timeout_s = 7200      # on every cophylad hook; a harness ask's expiresAt follows it
receipt_timeout_ms = 30000 # Codex: withdraw a queued message with no receipt once the thread is not busy
codex_recent_ms = 600000   # a Codex thread with rollout activity this recent is listed before a hook is seen
muse_list_ms = 2000        # session/list cadence per Muse profile (a listed session has closed)
muse_recent_ms = 600000    # a Muse session with no process known ends this long after its log's last write
claude_hook_grace_ms = 600000 # a Claude session known only from its hooks ends this long after its last one
install_hooks = true       # write cophylad's hooks into each profile at start
discover = true            # scan ~/.claude, ~/.codex and ~/.config/muse, plus CLAUDE_CONFIG_DIR and CODEX_HOME when they name another
launch = "terminal"        # where a session cophylad starts runs: "terminal" (in tether when found, shown in the apps) or "acp" (no window)
brain_sends = "pipe"       # the brain's messages to a session in tether: "pipe" (as another agent's) or "typed" (as the user's)

# tether: the pseudo-terminal host sessions run in, so what the user sends is typed as theirs.
[tether]
# command = "/path/to/tether"   # found in the platform's folder, or tether/target in a checkout, when absent
# dir = "/path/to/state"        # TETHER_DIR; the user's own by default, shared with every tether client
idle_exit_s = 600          # a host cophylad starts leaves after this long with nothing to hold
window = "auto"            # where a window opens when no editor has the folder: auto, wt, console, conhost or none
window_on_start = false    # a session cophylad starts shows in the apps; true also opens a window on it at once
profiles = true            # write the Windows Terminal profile that starts Claude in tether, and the editor's tether.json
on_path = true             # an installed platform keeps a tether command on the user's PATH

# A harness installation beyond the discovered one; its sessions are found in config_dir.
# config_dir and args are all a second account needs: cophylad names the directory to the
# harness itself and starts Claude sessions with args, so a wrapper script that sets the
# directory and adds flags is not needed (and would hide from cophylad which account it runs).
# Without args, a Claude session cophylad starts takes the flags of your own last session under
# the profile; what you set in the app's Settings wins over both.
# [[profiles]]
# harness = "claude"       # claude | codex | muse
# name = "work"
# config_dir = "/home/me/.claude-accounts/work"   # Windows: "C:\\\\Users\\\\me\\\\.claude-accounts\\\\work"
# command = "claude"       # binary; PATH by default
# args = []                # Claude: flags every session cophylad starts gets, e.g. ["--permission-mode", "auto", "--settings", "/home/me/.claude/settings.json"]
# env = { }
# default = false          # the usual account for its harness; picking one in the app wins, else your latest session's
# hooks = "http"           # http | command (Claude); Codex is always command
#
# A second Muse login is its two homes: config_dir is <XDG_CONFIG_HOME>/muse, and cophylad sets
# XDG_CONFIG_HOME from it; its sessions live under XDG_DATA_HOME, named in env.
# [[profiles]]
# harness = "muse"
# name = "work"
# config_dir = "/home/me/.muse-work/config/muse"
# env = { XDG_DATA_HOME = "/home/me/.muse-work/data" }
# args = []                # Muse: the TUI's flags, for the terminals cophylad starts; never its own serve

# The brain: spawned by the primary, found under data/brain/current or the dev tree.
[brain]
# enabled = true              # the brain may run here; it runs while this node is the primary
# command = "/path/to/brain"  # Windows: "C:\\\\path\\\\to\\\\brain.exe"
# args = []
restart_backoff_ms = 1000
restart_backoff_max_ms = 30000
hello_timeout_ms = 10000

# Provider routing: the routes llm.complete tries in order. server is the account's hosted
# model (signed in, on a plan that has one); byok:<vendor> your own key; local:<engine> is
# not there yet. A route that cannot serve passes the call on; one string is a list of one.
[providers]
llm = ["server", "byok:gemini"]
timeout_ms = 120000

[providers.gemini]
# api_key = "..."            # GEMINI_API_KEY in the environment when absent
base_url = "https://generativelanguage.googleapis.com"

# What each logical tier means; the brain asks for a tier, never a vendor. tiny is the
# bookkeeping tier: the running summary and anything else the user never reads.
[providers.tiers.tiny]
model = "gemini/gemini-3.1-flash-lite"
thinking = "minimal"

[providers.tiers.fast]
model = "gemini/gemini-3.8-flash"
thinking = "low"

[providers.tiers.smart]
model = "gemini/gemini-3.1-pro-preview"
thinking = "medium"

# The ACP adapters that start Claude Code and Codex sessions.
[acp]
runtime = "node"             # node on PATH, or bun: the daemon's own runtime
spawn_timeout_ms = 60000
# [acp.claude]
# command = "claude-agent-acp"
# args = []

# Caps on the built-in tools.
[tools]
read_max_lines = 400
line_max_chars = 400
grep_max = 200
glob_max = 500
outline_max_files = 400
http_max_bytes = 262144
http_timeout_ms = 20000

# The recall index: full text always; vectors from the local embedding model the platform ships,
# or from the account's hosted compute ("server": a plan with it, and full text alone until the link is up).
[store]
embedding = "local"            # local | server | off (full-text only)
# embedding_model = "C:\\\\models\\\\bge-small-en-v1.5"  # a model directory with manifest.json; the platform's own when absent
embed_batch = 8                # chunks per model call
embed_max_chars = 1536         # characters of a chunk the model reads
vector_max_rows = 150000       # vectors kept in memory, newest first
backfill_batch = 200           # rows per batch when indexing what the store held before the index

# The editable layer: tools/, hooks/, views/, prompts/ and memory/ are watched; the poll catches what the watcher misses.
[editable]
poll_ms = 10000                # 0 turns the safety poll off

# The public release feed: the request carries the channel, OS and architecture and nothing else.
[update]
enabled = true
channel = "stable"             # stable | beta
feed = "https://feed.getcophyla.com"
check_interval_ms = 21600000   # six hours
first_check_delay_ms = 30000
auto_apply = true              # a staged brain when idle; a staged platform when idle and no desktop app is attached
allow_insecure_feed = false    # http off loopback, for a LAN feed while testing

# The controller: a second listener on the LAN, over TLS with a certificate this node makes
# for itself, serving the phone's web app, its views and its socket. The loopback [api]
# listener is unchanged and keeps the harness hooks; nothing but the app is served here.
# The same listener also comes up, app or not, when [nodes] accept is on or this node is a
# backup: it is where other nodes link at /ws/node. The phone app can also pair from any
# network by signing in with the account this node is signed in to, through the relay.
[controller]
enabled = false
host = "0.0.0.0"               # a phone is not on loopback
port = 4818
# app_dir = "C:\\path\\to\\controller\\dist"   # the built app; the one beside the daemon by default
account_pairing = true         # a phone signed in to this node's account pairs through the relay, no code

# Voice: wake word, then transcription, then the reply read out on the phone that asked.
# Models come from the release feed the first time a stage is turned on.
[voice]
enabled = false
wake = "openwakeword"          # openwakeword | off (push-to-talk still works)
stt = "nemotron"               # nemotron | server (the account's hosted transcription) | off
tts = "kokoro"                 # kokoro (in-process, CPU) | chatterbox (GPU sidecar, bootstrapped on demand) | server (hosted) | off
wake_model = ["cophyla_v0.1.onnx", "hey_phyla_v0.1.onnx"]   # "Cophyla", "Hey Phyla"; a client that carries them all hears them itself, otherwise it streams and the node listens
# wake_threshold = 0.6         # one for every phrase, or { "cophyla_v0.1.onnx" = 0.6 }; each head's own from the model when absent
# wake_scale = "int16"         # the scale the heads were trained at: int16 | unit; each head's own when absent
vad_min_silence_ms = 700       # silence that ends an utterance
stt_threads = 2
# stt_language = "en"          # pinned; detected when absent
tts_threads = 2
tts_voice = 0
chatterbox_device = "cuda"     # cuda | cpu | auto
# chatterbox_voice = "C:\\clips\\me.wav"   # the reference clip it clones; the stage needs one, longer than 5 s
cpu_affinity = "auto"          # auto pins to the performance cores on a hybrid CPU; or "0-15", or "off"
# models_dir = "C:\\models\\voice"          # local model folders instead of the feed, for development
thinking_timeout_ms = 60000

# Metrics: CPU, memory and GPU per process, owned by session; per-minute rollups in the store.
[metrics]
enabled = true
idle_interval_ms = 15000       # between samples while no client is subscribed
min_interval_ms = 1000         # the floor under a subscriber's interval
retention_days = 7             # per-minute rollups kept
warn = 80                      # percent at which node.pressure says warn
critical = 95                  # and critical
gpu = true                     # read the GPU through NVML where the driver is there
limits = true                  # each login's session and weekly limits: Claude's usage endpoint, Codex's rollouts

# Prices in USD per million tokens, by vendor/model, over the built-in table.
# [metrics.prices."gemini/gemini-3.8-flash"]
# input = 1.5                  # the 2027 price
# output = 7.5
# cache_read = 0.15

# Nodes: several machines, one primary. A primary accepts links on the LAN listener; a new
# machine joins with an invite the primary mints (cophylad invite, or Add node in the app;
# cophylad join on the new machine), which gives it a grant of its own in data/link.json.
[nodes]
accept = false                 # accept other nodes on the LAN listener
# primary = "192.168.1.44:4818"  # where the primary is, when discovery cannot find it
discovery = true               # find the primary by UDP broadcast
discovery_port = 4819
discovery_interval_ms = 2000   # between queries while seeking
beacon_ms = 5000               # between a primary's beacons
heartbeat_ms = 5000
failover_ms = 15000            # a backup promotes after this without a primary, times its rank
claim_wait_ms = 3000           # a starting primary listens this long for a live one first
reconnect_ms = 2000
reconnect_max_ms = 30000
hello_timeout_ms = 5000
relay = true                   # reach a primary on another network through the server's relay (signed in, a plan with it)
registry_heartbeat_ms = 15000  # a primary renews its lease on the server's registry this often

# Remote desktop: see a node's screen and drive it. enabled shares this desktop through a
# streaming host (Apollo, or Sunshine) that runs as a service on Windows and is installed
# through winget when missing; viewing another node needs no flag, the viewer (moonlight-qt
# for the desktop app, the moonlight-web sidecar for a phone) is acquired on first use. The
# brain's screenshot needs no host at all.
[remote]
enabled = false
host = "auto"                  # auto | apollo | sunshine
install = true                 # acquire a missing host or viewer through the package manager
# host_command = "C:\\Program Files\\Apollo\\sunshine.exe"   # over the known install paths
# moonlight = "C:\\Program Files\\Moonlight Game Streaming\\Moonlight.exe"
# host_user = "cophyla"         # the host's web credentials, when you set your own
# host_password = "..."
web = true                     # serve phones a stream from this node
web_transport = "websocket"    # websocket (through the controller listener) | webrtc (UDP 40000-40010)
lan_route = true               # off: other nodes' desktops stream through the links, as with no route (a one-machine check)
screenshot_width = 1280        # what a screenshot is scaled to
poll_ms = 3000                 # between polls of the host's client list

# The account: the server that signs the plan, reached over one outbound link once signed in.
# Signed out, nothing here is contacted and every plan limit is the free one.
[cloud]
enabled = true
url = "https://api.getcophyla.com"
refresh_interval_ms = 21600000 # six hours: how often the entitlement token is renewed
reconnect_ms = 2000
reconnect_max_ms = 60000
request_timeout_ms = 120000    # a hosted model or speech request
hello_timeout_ms = 15000       # the link's auth; a starting primary waits this long for it before taking the role alone
allow_insecure = false         # http off loopback, for a fake server while testing

# Direct connections: phones and nodes on other networks reach this node over a WebRTC data
# channel instead of the relay, when a direct path opens (TURN when it does not). Switched
# on per node in the account card, on a plan that has it; these are how the helper runs.
[direct]
port = 0                       # the helper's UDP port; 0 picks one and keeps it
map_port = true                # ask the router to map it (UPnP, NAT-PMP, PCP)
ipv6 = true
predict = 12                   # ports tried past a peer's public one, for NATs that count up
nodes = true                   # links to other nodes go direct too
report = true                  # a daily count of the paths that opened, with nothing that names you
stun = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"]
# command = "C:\\path\\to\\cophyla-net.exe"   # over the helper the platform ships
restart_backoff_ms = 1000
restart_backoff_max_ms = 30000

# Push: an ask reaches a paired phone as a notification when it has nothing open, through
# the server (signed in, a plan with push, the phone's app registered).
[push]
enabled = true

[log]
level = "info"
`;
