// The client protocol: WebSocket at /ws/client, spoken by the desktop app and the controller,
// and by the views inside them over the host's connection. JSON-RPC, like the capability
// protocol. See architecture.md, "Client protocol".

import { z } from "zod";
import {
  Access,
  Ask,
  AudioCapabilities,
  AudioCodec,
  AuditEntry,
  BackupState,
  Client,
  ClientKind,
  ContentBlock,
  Controller,
  DirectState,
  EventDefinition,
  Grant,
  GrantKind,
  GrantRole,
  GuestInfo,
  HarnessProfile,
  LaunchMode,
  IceServer,
  Listener,
  Message,
  MetricsSample,
  Node,
  ProfileLimits,
  PushPlatform,
  Remember,
  Session,
  SessionEvent,
  SpendTotals,
  Task,
  Terminal,
  Thread,
  Usage,
  ViewManifest,
  VoiceState,
  VoiceStopped,
  VoiceUnheard,
  Workspace,
} from "./entities.ts";
import { AskId, ClientId, ControllerId, GrantRef, ListenerId, MessageId, NodeId, ProfileId, SessionId, TaskId, ThreadId, Timestamp, WorkspaceId } from "./ids.ts";
import { LlmMessage, SendResult, TaskCreate, TaskFilter, TaskPatch, TimeRange, TurnProgress } from "./capability.ts";
import { Secret } from "./invite.ts";

const Empty = z.object({});

export const ViewFile = z.object({
  path: z.string(),
  mime: z.string(),
  /** Text files carry `text`; binary ones carry `base64`. */
  text: z.string().optional(),
  base64: z.string().optional(),
});
export type ViewFile = z.infer<typeof ViewFile>;

export const ViewContent = z.object({
  id: z.string(),
  version: z.string(),
  files: z.array(ViewFile),
});
export type ViewContent = z.infer<typeof ViewContent>;

export const UpdateComponent = z.enum(["platform", "brain", "model"]);

/**
 * What the brain would send the model on its next turn, built without a model call: the fixed
 * rules before the situation, the situation, the log as the window shows it, the window's
 * messages after the log, the tools it declares by name, and the estimated tokens of each tier.
 */
export const BrainContext = z.object({
  thread: ThreadId.optional(),
  at: Timestamp,
  tokens: z.object({ situation: z.number(), working: z.number(), loaded: z.number(), log: z.number(), total: z.number() }),
  rules: z.string(),
  situation: z.string(),
  log: z.string().optional(),
  messages: z.array(LlmMessage),
  tools: z.array(z.string()),
});
export type BrainContext = z.infer<typeof BrainContext>;

/**
 * What a controller needs to reach its node through the server relay from any network:
 * the server's origin, the peer id it speaks as, the relay token it presents there, and
 * the pairing secret (32 bytes as hex) the tunnel keys are derived from. Minted at
 * pairing; only ever answered on the pairing node's own sockets.
 */
export const RelayAccess = z.object({
  url: z.string(),
  peer: ControllerId,
  token: z.string(),
  key: z.string().regex(/^[0-9a-f]{64}$/, { message: "expected 32 bytes as hex" }),
});
export type RelayAccess = z.infer<typeof RelayAccess>;

/** The node's LAN listener as the native app pins it: where it answers, and the SHA-256 of its key (SPKI, base64). */
export const PairedLan = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  spki: z.string().min(1),
});
export type PairedLan = z.infer<typeof PairedLan>;

/** An invite as the node that minted it hands it out: the text to paste, the link a QR code holds, and until when it may be redeemed. */
export const InviteOffer = z.object({ text: z.string(), link: z.string(), expiresAt: Timestamp });
export type InviteOffer = z.infer<typeof InviteOffer>;

/** A six-digit pairing code, shown on the desktop and typed on the phone. */
export const PairingCode = z.string().regex(/^\d{6}$/, { message: "expected six digits" });

/** A voice stage's engine being set up on demand: the bootstrap of a sidecar, step by step. */
export const VoiceSetupStage = z.enum(["wake", "stt", "tts"]);
export const VoiceSetupStep = z.enum(["uv", "venv", "deps", "weights", "runtime", "model", "starting", "ready", "failed"]);

/** One phrase a client's wake word listens for: the head's file, the score it fires at, its input scale, what is said. */
export const WakeHeadMode = z.object({
  head: z.string().min(1),
  threshold: z.number().min(0).max(1),
  scale: z.enum(["int16", "unit"]),
  phrase: z.string().min(1).max(64).optional(),
});
export type WakeHeadMode = z.infer<typeof WakeHeadMode>;

/**
 * Where a controller's wake word is detected. `phone`: the client runs the node's configured
 * heads itself, each at the node's threshold and input scale, and sends audio only once it
 * heard a word; `heads` lists them all, and `head`, `threshold` and `scale` repeat the first
 * for a client from before there were several. `node`: the client does not carry every one
 * of them, so it streams while listening and the node detects. `off`: there is no wake word;
 * audio goes up only while the button is held.
 */
export const WakewordMode = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("phone"), head: z.string().min(1), threshold: z.number().min(0).max(1), scale: z.enum(["int16", "unit"]), heads: z.array(WakeHeadMode).min(1).max(16).optional() }),
  z.object({ mode: z.literal("node") }),
  z.object({ mode: z.literal("off") }),
]);
export type WakewordMode = z.infer<typeof WakewordMode>;

/**
 * The engines a node can speak with, as `[voice] tts` names them. `kokoro-online` goes through
 * the node's speech routes (the account's server, then the user's own key); `server` is the
 * name it had before, and a node reads it as `kokoro-online`.
 */
export const TtsEngineId = z.enum(["piper", "kokoro", "supertonic", "chatterbox", "kokoro-online", "server", "off"]);
export type TtsEngineId = z.infer<typeof TtsEngineId>;

/**
 * The engines a node can transcribe with, as `[voice] stt` names them. `gemini-live` and
 * `gemini` go through the node's transcription routes (the account's server, then the user's
 * own key): `gemini-live` streams the words as they are said, `gemini` sends each utterance
 * once it ends, for less. `server` is the name the online one had before, and a node reads it
 * as `gemini-live`.
 */
export const SttEngineId = z.enum(["moonshine-tiny", "moonshine-base", "whisper-base", "nemotron", "gemini-live", "gemini", "server", "off"]);
export type SttEngineId = z.infer<typeof SttEngineId>;

/**
 * Where the online engines go first: `cloud`, the account's server (a plan with hosted voice),
 * with the user's own key after it when the server cannot; `own`, the user's own key alone.
 */
export const VoiceRoute = z.enum(["cloud", "own"]);
export type VoiceRoute = z.infer<typeof VoiceRoute>;

/** The vendors whose keys the user can give the node, for the online engines and the model. */
export const ProviderKeyName = z.enum(["gemini", "deepinfra"]);
export type ProviderKeyName = z.infer<typeof ProviderKeyName>;

/**
 * Whether the node has a vendor's key, and from where: typed in the app (`app`), config.toml
 * (`config`) or the environment (`env`), the first of them winning. Only the key's last four
 * characters ever leave the node.
 */
export const ProviderKeyState = z.object({
  source: z.enum(["app", "config", "env", "none"]),
  last4: z.string().max(4).optional(),
});
export type ProviderKeyState = z.infer<typeof ProviderKeyState>;

export const ProviderKeys = z.object({ gemini: ProviderKeyState, deepinfra: ProviderKeyState });
export type ProviderKeys = z.infer<typeof ProviderKeys>;

/** How fast replies are read, the engine's own pace being 1: from half as fast to three times as fast. */
export const SpeechSpeed = z.number().min(0.5).max(3);

/** A licence a local engine comes under: what it covers, its name, where to read it. */
export const SpeechLicence = z.object({ covers: z.string(), name: z.string().min(1), url: z.string().url() });
export type SpeechLicence = z.infer<typeof SpeechLicence>;

/**
 * One engine a node offers, for the app's picker: the stage it serves, its name and what it is
 * like. A `local` one runs on the node and is installed there only when the user asks, from
 * where its makers publish it, so it says whether it is `installed`, the `bytes` installing it
 * would still fetch, and the `licences` it comes under, for the user to read first.
 */
export const SpeechEngineInfo = z.object({
  id: z.string().min(1),
  stage: z.enum(["stt", "tts"]),
  label: z.string().min(1),
  detail: z.string(),
  local: z.boolean(),
  installed: z.boolean().optional(),
  bytes: z.number().int().nonnegative().optional(),
  licences: z.array(SpeechLicence).optional(),
});
export type SpeechEngineInfo = z.infer<typeof SpeechEngineInfo>;

/** A voice stage as the app shows it: loading, ready, not installed on this machine, or why it is not up. */
export const VoiceStageState = z.object({
  status: z.enum(["off", "uninstalled", "unavailable", "loading", "ready", "failed"]),
  reason: z.string().optional(),
  engine: z.string().optional(),
});
export type VoiceStageState = z.infer<typeof VoiceStageState>;

/**
 * A node's voice as the app's Settings shows it: whether voice is on at all; the engine that
 * speaks, where that choice came from (`app`: set in Settings; `config`: config.toml), the
 * voice among the engine's `voices` (the model's own default when absent; `voices` is known
 * once the engine is loaded), the `speed` replies are read at, whichever engine reads them,
 * and the speech stage; the same for transcription (`stt`,
 * `sttSource`, `sttStage`); where the online engines go first (`sttRoute`, `ttsRoute`) and
 * the keys they would use; every engine there is for either; and the install under way or
 * the last one that failed.
 */
export const VoiceSettings = z.object({
  enabled: z.boolean(),
  tts: TtsEngineId,
  source: z.enum(["app", "config"]),
  voice: z.number().int().nonnegative().optional(),
  voices: z.number().int().positive().optional(),
  speed: SpeechSpeed,
  stage: VoiceStageState,
  stt: SttEngineId,
  sttSource: z.enum(["app", "config"]),
  sttStage: VoiceStageState,
  /** Where online transcription and speech go first; `cloud` unless the app set another. */
  sttRoute: VoiceRoute.optional(),
  ttsRoute: VoiceRoute.optional(),
  /** The vendors' keys the online engines use, as their source and last four characters. */
  keys: ProviderKeys.optional(),
  engines: z.array(SpeechEngineInfo),
  installing: z.object({ engine: z.string(), step: z.enum(["runtime", "model"]), progress: z.number().min(0).max(1) }).optional(),
  installError: z.object({ engine: z.string(), message: z.string() }).optional(),
});
export type VoiceSettings = z.infer<typeof VoiceSettings>;

/**
 * Whether the next reply or result is to be read out, for the speaker button: `speak` when it
 * is, on the client `target` (called `name`); `hushed` when the user silenced what was pending,
 * which the button undoes.
 */
export const VoiceNext = z.object({
  speak: z.boolean(),
  hushed: z.boolean().optional(),
  target: ClientId.optional(),
  name: z.string().optional(),
});
export type VoiceNext = z.infer<typeof VoiceNext>;

/**
 * An ICE candidate as a browser's `RTCIceCandidateInit` has it, between a phone and its node
 * for a data channel.
 */
export const IceCandidate = z.object({
  candidate: z.string().max(1024),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});
export type IceCandidate = z.infer<typeof IceCandidate>;

/** How a stream page reaches its desktop's video: moonlight-web's WebSocket (the LAN), or its WebRTC (off it). */
export const StreamTransport = z.enum(["websocket", "webrtc"]);
export type StreamTransport = z.infer<typeof StreamTransport>;

/** A pipe's id: one TCP connection of a stream page, carried over the links. */
export const PipeId = z.string().min(1).max(64);

/** One side's candidate for the data channel `peer`, either way; `null` ends that side's. */
const DirectCandidate = z.object({ peer: z.string().min(1).max(64), candidate: IceCandidate.nullable() });
/** Bytes of a stream page's connection, base64, in order; at most the window the pipe has left. */
const PipeData = z.object({ pipe: PipeId, data: z.string().max(90_000) });
/** The receiver took `bytes` more of a pipe's data: that much window back to its sender. */
const PipeAck = z.object({ pipe: PipeId, bytes: z.number().int().positive() });
/** The connection behind a pipe ended, at either end. */
const PipeClose = z.object({ pipe: PipeId, reason: z.string().max(200).optional() });

/** A terminal's size in character cells. */
export const TerminalSize = z.object({ cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(1000) });
export type TerminalSize = z.infer<typeof TerminalSize>;

/** One entry of a folder as `session.files` lists it: a folder (a link to one too), or a file. */
export const FileEntry = z.object({ name: z.string().min(1), kind: z.enum(["dir", "file"]) });
export type FileEntry = z.infer<typeof FileEntry>;

/**
 * A folder under a session's working directory: its path there (`/` between the names, `""`
 * the directory itself) and its entries, folders first and then files, each by name, cut
 * short where `truncated` says; or why it could not be read.
 */
export const FolderListing = z.object({
  dir: z.string(),
  entries: z.array(FileEntry).optional(),
  truncated: z.literal(true).optional(),
  error: z.string().optional(),
});
export type FolderListing = z.infer<typeof FolderListing>;

/**
 * A repository as VS Code's status bar has it: the branch checked out (none while HEAD is
 * detached), the commit it is at (none before the first), the branch it tracks, the commits
 * it has that one lacks (`ahead`, to push) and the other way (`behind`, to pull) as of the
 * last fetch, and how many files changed or are new.
 */
export const GitState = z.object({
  branch: z.string().optional(),
  commit: z.string().optional(),
  upstream: z.string().optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  changes: z.number().int().nonnegative(),
});
export type GitState = z.infer<typeof GitState>;

/**
 * A file under a session's working directory as a viewer shows it: its path there as it was
 * asked for, its size in bytes and when it last changed (ms since the epoch), and its text,
 * the first MiB of it where `truncated` says; a file that is not text (`binary`) comes
 * without any. An image asked for as one (`image` in the request) comes whole, as `base64`
 * with its `mime` type, when it is small enough to show. A file asked for `whole` comes as
 * its bytes, whatever it is, a piece at a time: `base64` holds the piece starting `at` bytes
 * in, of `total` bytes in all, the size and the time the same for every piece while the file
 * stays as it was. A TIFF or a HEIC image comes as the PNG this computer's own codecs make of
 * it, which `total` counts; one past what is sent whole, or one no codec here reads, comes as
 * `binary` without bytes, with a `note` saying why when it is not the size.
 */
export const FileText = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  modified: z.number().int().nonnegative(),
  text: z.string().optional(),
  truncated: z.literal(true).optional(),
  binary: z.literal(true).optional(),
  mime: z.string().max(100).optional(),
  base64: z.string().optional(),
  at: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  note: z.string().max(500).optional(),
});
export type FileText = z.infer<typeof FileText>;

/**
 * What a viewer asks of a file: its path under the folder, `/` between the names, whether an
 * image is to come whole (as an older node reads it), and whether the file is to come as its
 * bytes (`whole`), the piece starting `at` bytes in.
 */
const FileAsk = { path: z.string().min(1).max(4096), image: z.literal(true).optional(), whole: z.literal(true).optional(), at: z.number().int().nonnegative().optional() };

/**
 * A session, a workspace and a thread as a client gets them: without the summary and tags
 * the archive writes, which are the brain's and never leave the node for a client.
 */
export const ClientSession = Session.omit({ summary: true, tags: true });
export type ClientSession = z.infer<typeof ClientSession>;
export const ClientWorkspace = Workspace.omit({ summary: true, tags: true });
export type ClientWorkspace = z.infer<typeof ClientWorkspace>;
export const ClientThread = Thread.omit({ summary: true, tags: true });
export type ClientThread = z.infer<typeof ClientThread>;

export const clientRequests = {
  hello: {
    params: z.object({
      token: z.string(),
      kind: ClientKind,
      name: z.string().optional(),
      node: NodeId.optional(),
      audio: AudioCapabilities,
      /**
       * This client shows a stream page through a forwarder of its own (the phone app's
       * loopback one): `remote.open` answers it a path to fetch through it, not a URL.
       */
      forward: z.boolean().optional(),
      /**
       * On the loopback listener, a terminal command of this machine: served by this node even
       * while it is a node of a cluster, never relayed to the primary.
       */
      local: z.boolean().optional(),
    }),
    result: z.object({
      client: Client,
      node: NodeId,
      protocolVersion: z.number().int().positive(),
      platformVersion: z.string(),
      /** The codecs the node takes and sends `voice.audio` in; PCM alone when absent. */
      audio: z.object({ codecs: z.array(AudioCodec) }).optional(),
    }),
  },
  "chat.send": {
    params: z.object({ text: z.string(), mode: z.literal("quick").optional() }),
    result: z.object({ message: MessageId }),
  },
  "chat.load": {
    params: z.object({ before: ThreadId.optional(), limit: z.number().int().positive().optional() }),
    result: z.object({ threads: z.array(ClientThread), messages: z.array(Message) }),
  },
  "session.list": { params: Empty, result: z.object({ sessions: z.array(ClientSession) }) },
  "session.history": {
    params: z.object({
      id: SessionId,
      before: z.number().int().nonnegative().optional(),
      /** A seq to centre the window on: half the limit before it, half after. */
      around: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    }),
    result: z.object({ events: z.array(SessionEvent) }),
  },
  "session.send": {
    params: z.object({ id: SessionId, text: z.string() }),
    result: SendResult,
  },
  /**
   * Raises the window a session runs in, or opens one. With `open: false` none is opened: where
   * no window shows a session in a tether terminal, or a background job it attaches into one,
   * `attach` is the command that shows it in a terminal of the user's own.
   */
  "session.focus": {
    params: z.object({ id: SessionId, open: z.boolean().optional() }),
    result: z.object({ attach: z.string().optional() }),
  },
  /**
   * Ends a session by the user's hand: one cophylad started as the brain's `session.stop` would,
   * and one of the user's own too, with its terminal when the node started that terminal, else
   * its process alone, so a shell in a window of the user's stays. A session
   * whose process the node does not know is `unsupported`, one that already ended a `conflict`.
   */
  "session.stop": { params: z.object({ id: SessionId }), result: Empty },
  /**
   * Puts a Claude session in a permission mode, as Shift+Tab in its terminal does: pressed in
   * its tether terminal until the footer shows the mode, or set over ACP for a session cophylad
   * runs that way. The mode it is in afterwards comes back. A mode the session does not offer
   * (bypassing permissions when it was not started allowing it, auto on a model without it,
   * `dontAsk`, which Shift+Tab never reaches) and a session in a window cophylad cannot type
   * into are `unsupported`; an open ask, a screen with no prompt on it, and a busy session whose
   * way there passes a looser mode are a `conflict`.
   */
  "session.mode": { params: z.object({ id: SessionId, mode: LaunchMode }), result: z.object({ mode: LaunchMode }) },
  /**
   * The sessions whose every event this client hears as it lands, as `session.event`: the
   * tab that is open. The list replaces the one before; an empty one stops them. Without
   * it a client hears a session only as `session.state` and `ask.state`.
   */
  "session.watch": { params: z.object({ ids: z.array(SessionId).max(16) }), result: Empty },
  /**
   * Folders under a session's working directory, a level each, for a file explorer: each by
   * its path there, the directory itself when none is named. One that is not under it (through
   * `..` or a link that leads out) comes back with an error of its own. Answered by the
   * session's node.
   */
  "session.files": {
    params: z.object({ id: SessionId, dirs: z.array(z.string().max(4096)).min(1).max(64).optional() }),
    result: z.object({ root: z.string(), dirs: z.array(FolderListing) }),
  },
  /** The repository a session's working directory is in, as a status bar shows it, without fetching; none outside one, or without git. Answered by the session's node. */
  "session.git": { params: z.object({ id: SessionId }), result: z.object({ git: GitState.optional() }) },
  /**
   * A file under a session's working directory, by its path there (`/` between the names), for
   * a viewer: its text, decoded from UTF-8 or from UTF-16 by its byte order mark, or that it is
   * not text; with `image`, a PNG, JPEG, GIF, WebP, BMP, ICO or AVIF whole, as base64, up to
   * 5 MiB; with `whole`, its bytes up to 64 MiB, a piece of 1.5 MiB from `at` per answer, a TIFF
   * or a HEIC image as the PNG this computer's codecs make of it. One that is not under the
   * directory (through `..` or a link that leads out), a folder or anything but a plain file is
   * refused. Answered by the session's node.
   */
  "session.file": { params: z.object({ id: SessionId, ...FileAsk }), result: FileText },
  /**
   * Shows a file or a folder under a session's working directory in the file manager of the
   * computer it is on (File Explorer, the Finder, the desktop's own): a file selected in its
   * folder, a folder opened; `""` the directory itself. The window opens on that computer, so
   * only the desktop app there may ask: from anywhere else, and on a computer with no desktop,
   * it is `unsupported`. A path not under the directory is refused as `session.file` refuses
   * it. Answered by this node alone, never forwarded.
   */
  "session.reveal": { params: z.object({ id: SessionId, path: z.string().max(4096) }), result: Empty },
  /** The terminals this node's tether hosts hold: harness sessions' own, and any program started in one. */
  "terminal.list": { params: Empty, result: z.object({ terminals: z.array(Terminal) }) },
  /**
   * Starts a program in a terminal on this node, the user's shell without `argv`, in `cwd` or
   * a workspace's folder (the user's home without either).
   */
  "terminal.spawn": {
    params: z.object({
      argv: z.array(z.string().min(1)).min(1).max(64).optional(),
      cwd: z.string().optional(),
      workspace: WorkspaceId.optional(),
      name: z.string().max(64).optional(),
      size: TerminalSize.optional(),
    }),
    result: z.object({ terminal: Terminal }),
  },
  /**
   * Opens a terminal's screen for this client: the repaint (`data`, with the scrollback) and
   * the output position it stands at. Its output follows as `terminal.output`, to this client
   * alone, until `terminal.close`. `input` lets the client type into it (`terminal.input`);
   * `drive` sizes the terminal to the client's own size, as a window would, until another
   * window types or resizes (`terminal.resize` moves it). Opening again replaces the view.
   */
  "terminal.open": {
    params: z.object({ terminal: z.string(), input: z.boolean().optional(), drive: TerminalSize.optional() }),
    result: z.object({ terminal: Terminal, seq: z.number().int().nonnegative(), cols: z.number().int().positive(), rows: z.number().int().positive(), data: z.string() }),
  },
  /** Stops this client's view of a terminal; `end` also ends its program. */
  "terminal.close": { params: z.object({ terminal: z.string(), end: z.boolean().optional() }), result: Empty },
  /**
   * A file under the folder a terminal started in, as `session.file` reads one under a
   * session's: for the viewer of a bare terminal's tab. The terminal's scope, since that folder
   * is often the user's home, where a session's reader has no business.
   */
  "terminal.file": { params: z.object({ terminal: z.string(), ...FileAsk }), result: FileText },
  "ask.answer": {
    params: z.object({
      id: AskId,
      option: z.string(),
      options: z.array(z.string()).optional(),
      text: z.string().optional(),
      remember: Remember.optional(),
    }),
    result: Empty,
  },
  "task.list": { params: z.object({ filter: TaskFilter.optional() }), result: z.object({ tasks: z.array(Task) }) },
  "task.create": { params: TaskCreate, result: z.object({ id: TaskId }) },
  "task.update": { params: z.object({ id: TaskId, patch: TaskPatch }), result: Empty },
  "workspace.list": { params: Empty, result: z.object({ workspaces: z.array(ClientWorkspace) }) },
  "workspace.put": {
    params: z.object({ id: WorkspaceId.optional(), node: NodeId, path: z.string(), name: z.string() }),
    result: z.object({ id: WorkspaceId }),
  },
  "event.list": { params: Empty, result: z.object({ events: z.array(EventDefinition) }) },
  /**
   * The talk button, held and let go. `cancel` takes back this client's utterance while it is
   * heard or transcribed, however it began (the button, the talk key or the wake word): nothing
   * is sent, and the button is let go. With nothing to take back it is no error.
   */
  "voice.ptt": { params: z.object({ active: z.boolean(), cancel: z.literal(true).optional() }), result: Empty },
  /**
   * The keyword heads this controller can run itself, for the node to say where its wake word
   * is detected. Sent again on every connect; an empty list hands detection back to the node.
   */
  "voice.wakeword": { params: z.object({ heads: z.array(z.string().min(1).max(128)).max(16) }), result: WakewordMode },
  /**
   * The phone heard the wake word: an utterance begins and ends on silence. `score` and the
   * `head` that heard it are for the log; `lead` counts the frames that follow which were
   * captured before the word fired, for the recogniser and not the end-of-speech detector.
   */
  "voice.wake": { params: z.object({ score: z.number().min(0).max(1), head: z.string().min(1).max(128).optional(), lead: z.number().int().min(0).max(16).optional() }), result: Empty },
  /** The node's voice: the engines that speak and transcribe, where they were set, their stages, and the engines there are. */
  "voice.settings": { params: Empty, result: VoiceSettings },
  /**
   * The engine or the voice, set from the app over config.toml; `null` hands either back to
   * it. A voice belongs to the engine it was set for. The speed is every engine's, from the
   * next line on; `null` is the engines' own pace. A route says where the online engines go
   * first, from the next utterance or line on; `null` is `cloud`. Answered at once: the engine
   * loads behind the answer, and `voice.settings` says when its stage is up.
   */
  "voice.configure": {
    params: z.object({
      tts: TtsEngineId.nullable().optional(),
      voice: z.number().int().nonnegative().max(9999).nullable().optional(),
      speed: SpeechSpeed.nullable().optional(),
      stt: SttEngineId.nullable().optional(),
      sttRoute: VoiceRoute.nullable().optional(),
      ttsRoute: VoiceRoute.nullable().optional(),
    }),
    result: VoiceSettings,
  },
  /**
   * Installs a local engine on this node, from where its makers publish it, after the user has
   * seen its licences: the runtime when it is missing, then its models. Answered at once; the
   * install goes on behind it as `voice.setup` (`runtime`, `model`, then `ready` or `failed`),
   * and the stage that uses the engine loads once it is in. `conflict` while another installs.
   */
  "voice.install": { params: z.object({ engine: z.string().min(1).max(64) }), result: VoiceSettings },
  /** A line spoken to this client in the voice set now, for trying one out; a sample line when no text is given. */
  "voice.preview": { params: z.object({ text: z.string().min(1).max(500).optional() }), result: Empty },
  /**
   * The speaker button. `on` stops what is being read out now and silences every reply and
   * result that was to be, until the next request asks again; `off` reads them out again, and
   * with nothing to read out, turns speech on for the client's device: the results pending and
   * the next reply are read out there.
   */
  "voice.hush": { params: z.object({ on: z.boolean() }), result: VoiceNext },
  "view.list": { params: Empty, result: z.object({ views: z.array(ViewManifest) }) },
  "view.get": { params: z.object({ id: z.string() }), result: ViewContent },
  "view.setDefault": { params: z.object({ id: z.string() }), result: Empty },
  /** Stages a view's files on the node for this client's frame: `base` is the URL its entry loads under. */
  "view.stage": { params: z.object({ id: z.string() }), result: z.object({ base: z.string(), version: z.string(), docFrame: z.string().optional() }) },
  /** Opens a pairing window: the code and the URL a phone opens, good until `expiresAt`, one use. */
  "pair.start": { params: Empty, result: z.object({ code: PairingCode, url: z.string(), expiresAt: Timestamp }) },
  /** A phone's first frame, before `hello`: the code for a token of its own, and the relay access when the node could mint it. */
  "pair.claim": {
    params: z.object({ code: PairingCode, name: z.string().min(1).max(64) }),
    result: z.object({ token: z.string(), client: Controller, relay: RelayAccess.optional() }),
  },
  /**
   * A phone that signed in with the account, on the pairing tunnel the server opened to this
   * node (and nowhere else): a controller of its own, its relay access, and the node's LAN
   * listener with its key when that is up. Answered before `hello`, like `pair.claim`.
   */
  "pair.account": {
    params: z.object({ name: z.string().min(1).max(64) }),
    result: z.object({ token: z.string(), client: Controller, relay: RelayAccess, lan: PairedLan.optional() }),
  },
  /**
   * A phone's first frame, before `hello`, with the invite it was given: the grant it names
   * and the invite's secret. Answered on the node's LAN listener and on the relay tunnel of
   * the invite's own peer: the phone's token, its row, and a relay access minted fresh for it.
   */
  "invite.redeem": {
    params: z.object({ grant: ControllerId, secret: Secret, name: z.string().min(1).max(64) }),
    result: z.object({ token: z.string(), client: Controller, relay: RelayAccess.optional(), lan: PairedLan.optional() }),
  },
  /** A paired controller asking its pairing node for the relay access it did not get at pairing; `unavailable` while the node cannot grant it. */
  "relay.info": { params: Empty, result: RelayAccess },
  /** A controller registers the device it receives push notifications on; `push.unregister` forgets it. */
  "push.register": { params: z.object({ platform: PushPlatform, token: z.string().min(1), name: z.string().optional() }), result: Empty },
  "push.unregister": { params: Empty, result: Empty },
  "controller.list": { params: Empty, result: z.object({ controllers: z.array(Controller) }) },
  "controller.revoke": { params: z.object({ id: ControllerId }), result: Empty },
  /**
   * A grant for a new phone or node, pending until its invite is redeemed. A phone's `access`
   * is FULL unless given; a node's is FULL, and its `role` says whether it may hold the
   * replica (`full`) or is hands the primary drives. `expiresIn` ends the grant itself that
   * many milliseconds after it is minted; `inviteExpiresIn` the invite, an hour by default.
   */
  "grant.invite": {
    params: z.object({
      kind: GrantKind,
      name: z.string().min(1).max(64),
      access: Access.optional(),
      role: GrantRole.optional(),
      expiresIn: z.number().int().positive().optional(),
      inviteExpiresIn: z.number().int().positive().optional(),
    }),
    result: z.object({ grant: Grant, invite: InviteOffer }),
  },
  /** Every grant this node keeps: the primary's and its own. */
  "grant.list": { params: Empty, result: z.object({ grants: z.array(Grant) }) },
  /** Ends a grant: its phone's sockets or its node's link close, its relay access goes; a pending one's invite is dead. */
  "grant.revoke": { params: z.object({ id: GrantRef }), result: Empty },
  "node.list": { params: Empty, result: z.object({ nodes: z.array(Node) }) },
  /**
   * This node joins the primary that minted `invite`, on the desktop of this machine alone.
   * `paths` confine what that primary may see and do here to those folders; `answerHere`
   * keeps the asks raised here to this machine's own clients.
   */
  "node.join": {
    params: z.object({ invite: z.string().min(1), paths: z.array(z.string().min(1)).max(64).optional(), answerHere: z.boolean().optional() }),
    result: z.object({ primary: z.object({ id: NodeId, name: z.string() }), role: GrantRole }),
  },
  /** This node leaves the primary it joined: the link closes and the grant is forgotten here. */
  "node.leave": { params: Empty, result: Empty },
  /**
   * Lends a folder of this machine to another person's cluster, as a workspace node that
   * redeems `invite` (a hands invite that cluster's primary minted). Without `invite` the
   * folder is only checked, and the name it would go by answered. On this machine's loopback
   * listener alone; the invite is kept in no audit row.
   */
  "guest.add": {
    params: z.object({ folder: z.string().min(1).max(4096), name: z.string().min(1).max(64).optional(), profile: ProfileId.optional(), invite: z.string().min(1).optional() }),
    result: z.object({ folder: z.string(), name: z.string(), guest: GuestInfo.optional() }),
  },
  /** The workspace nodes this machine hosts. */
  "guest.list": { params: Empty, result: z.object({ guests: z.array(GuestInfo) }) },
  /** A workspace node in no cluster joins one with a fresh invite; joining another cluster than its last takes away what it held. */
  "guest.join": { params: z.object({ name: z.string().min(1), invite: z.string().min(1) }), result: z.object({ guest: GuestInfo }) },
  /** A workspace node leaves its cluster for good; what it holds on the machine stays. */
  "guest.leave": { params: z.object({ name: z.string().min(1) }), result: z.object({ guest: GuestInfo }) },
  /** A workspace node is removed: it leaves, what it held goes (its sessions' ids kept as tombstones), its id is retired. */
  "guest.remove": { params: z.object({ name: z.string().min(1) }), result: Empty },
  /** Hands the primary role to a backup by the user's choice; the current primary steps down and rejoins. */
  "node.promote": { params: z.object({ id: NodeId }), result: Empty },
  /**
   * Stops the daemon this client is connected to and starts it again. `conflict` with the
   * `reasons` while something would be cut off (an open ask, a held hook response, an agent
   * prompt or a brain request in flight), unless `force`.
   */
  "node.restart": { params: z.object({ force: z.boolean().optional() }), result: Empty },
  /** What the brain listens for beyond the user's messages, as its tools set it; the user sees them in the settings and may remove one. */
  "listener.list": { params: Empty, result: z.object({ listeners: z.array(Listener) }) },
  "listener.remove": { params: z.object({ id: ListenerId }), result: Empty },
  /**
   * What the brain sees on its next turn, for the Context button: on only with `[brain]
   * show_context`, `unsupported` otherwise. `check` answers `{}` without asking the brain, so
   * a view can tell whether to show the button; the answer is kept in no audit row.
   */
  "brain.context": { params: z.object({ check: z.boolean().optional() }), result: z.object({ context: BrainContext.optional() }) },
  "profile.list": { params: z.object({ node: NodeId.optional() }), result: z.object({ profiles: z.array(HarnessProfile) }) },
  /** Each profile's plan limits, read now when the last reading is old; a node's alone when one is named. */
  "profile.limits": { params: z.object({ node: NodeId.optional() }), result: z.object({ limits: z.record(ProfileId, ProfileLimits) }) },
  /**
   * What the user sets on a profile in the app: whether it is its harness's usual account, and
   * what a session cophylad starts under it is started with. `null` hands either back to cophylad:
   * the usual account chosen automatically, the launch from config or the user's own last session.
   */
  "profile.update": {
    params: z.object({
      node: NodeId,
      id: ProfileId,
      patch: z.object({
        usual: z.boolean().nullable().optional(),
        launch: z.object({ mode: LaunchMode.optional(), args: z.array(z.string()) }).nullable().optional(),
      }),
    }),
    result: z.object({ profile: HarnessProfile }),
  },
  /**
   * Live samples at `intervalMs`, floored per client (a controller's at five seconds); each
   * carries every token count since the last one this client was sent. `processes: owners`
   * sums the processes into one row per owner, with `pid` 0. `spend` also sums each
   * profile's spend over that range through the sample the subscription starts from, in the
   * same instant, so the totals and the samples after `spend.at` count every token once.
   */
  "metrics.subscribe": {
    params: z.object({ node: NodeId.optional(), intervalMs: z.number().int().positive(), processes: z.enum(["all", "owners"]).optional(), spend: TimeRange.optional() }),
    result: z.object({ spend: SpendTotals.optional() }),
  },
  "metrics.unsubscribe": { params: Empty, result: Empty },
  "metrics.history": {
    params: z.object({ node: NodeId, range: TimeRange }),
    result: z.object({ samples: z.array(MetricsSample) }),
  },
  /** Has `node`'s host accept a viewer's PIN; `name` labels the viewer in the host's list and is the gate's target. */
  "remote.pair": { params: z.object({ node: NodeId, pin: z.string(), name: z.string().optional() }), result: Empty },
  /** A host-minted code for a phone (Apollo's OTP): `link` opens Artemis with it, `passphrase` is typed beside it. */
  "remote.invite": {
    params: z.object({ node: NodeId }),
    result: z.object({
      otp: z.string(),
      link: z.string().optional(),
      passphrase: z.string().optional(),
      expiresAt: Timestamp.optional(),
    }),
  },
  /**
   * Opens `node`'s desktop for this client, answered by the node the socket is on. A desktop
   * client gets a native viewer window (`{}`) where the host is on its LAN, or a loopback
   * `url` and its `stream` to show in a window of its own where it is not. A controller
   * gets the URL of a stream page on this node's controller origin; one that `forward`s
   * gets the page's `path` instead, which it fetches through its own forwarder: on the LAN
   * over its pinned socket (`transport: websocket`), off it through pipes to `node`, the
   * host, whose video then goes over WebRTC (`transport: webrtc`).
   */
  "remote.open": {
    params: z.object({ node: NodeId, forward: z.boolean().optional() }),
    result: z.object({
      url: z.string().optional(),
      path: z.string().optional(),
      transport: StreamTransport.optional(),
      node: NodeId.optional(),
      stream: z.string().optional(),
    }),
  },
  /** Ends a stream this client opened (`remote.open`'s `stream`): its window closed. */
  "remote.close": { params: z.object({ stream: z.string().min(1).max(64) }), result: Empty },
  /**
   * Opens a pipe to `node`'s stream proxy (this node's without it): one TCP connection of a
   * stream page the client's forwarder accepted. `window` is the bytes the client may send
   * before an ack. The bytes ride `remote.pipe.data` both ways, acked by `remote.pipe.ack`.
   */
  "remote.pipe.open": { params: z.object({ node: NodeId.optional() }), result: z.object({ pipe: PipeId, window: z.number().int().positive() }) },
  "remote.revoke": { params: z.object({ node: NodeId, viewer: z.string() }), result: Empty },
  "account.login": {
    params: Empty,
    result: z.object({ verificationUrl: z.string(), userCode: z.string(), expiresAt: Timestamp }),
  },
  "account.logout": { params: Empty, result: Empty },
  /**
   * A vendor's key for the online engines and the model, kept on this node alone (never in a
   * backup, never on another node) over config.toml's and the environment's; `null` forgets
   * it. The answer says which keys the node has now, by their last four characters.
   */
  "account.apiKey": {
    params: z.object({ provider: ProviderKeyName, apiKey: z.string().trim().min(8).max(512).nullable() }),
    result: ProviderKeys,
  },
  /**
   * The cloud backup on, keyed by a passphrase this node derives the key from and keeps.
   * When the server already holds a backup under another passphrase the answer is `denied`
   * unless `replace`, which starts over. The primary sends; a fresh install with the same
   * passphrase carries the existing backup on.
   */
  "backup.enable": { params: z.object({ passphrase: z.string().min(1), replace: z.boolean().optional() }), result: Empty },
  /** The sender off and the key gone from this node; `forget` drops the server's copy too. */
  "backup.disable": { params: z.object({ forget: z.boolean().optional() }), result: Empty },
  /**
   * The server's backup applied to this node: memory, prompts, the chat stream, tasks,
   * workspaces, the brain's state and the editable files, replacing what is here. Meant for
   * a fresh install; refused on a node that is not the primary or has a backup node linked.
   */
  "backup.restore": { params: z.object({ passphrase: z.string().min(1) }), result: Empty },
  /**
   * Direct connections on `node` (this node without it): phones and other nodes may open data
   * channels to it across networks, through TURN when nothing direct opens. Needs sign-in and
   * a plan with them; the state says which is missing.
   */
  "direct.enable": { params: z.object({ node: NodeId.optional() }), result: Empty },
  "direct.disable": { params: z.object({ node: NodeId.optional() }), result: Empty },
  /**
   * What a phone needs before it offers a data channel: the STUN and TURN servers, with TURN
   * credentials good until `expiresAt`. `unavailable` while direct connections are off or
   * not ready here.
   */
  "direct.info": { params: Empty, result: z.object({ iceServers: z.array(IceServer), expiresAt: Timestamp }) },
  /**
   * A phone's offer of a data channel, with the fresh ephemeral key its records will be
   * sealed under; the node answers with its SDP and its own key, and `peer` names the channel
   * in `direct.candidate` both ways. Asked over the relay, never on the LAN.
   */
  "direct.offer": {
    params: z.object({ sdp: z.string().min(1).max(65536), epk: z.string().min(1).max(256), curve: z.enum(["x25519", "p256"]).optional() }),
    result: z.object({ peer: z.string().min(1), sdp: z.string(), epk: z.string() }),
  },
  "update.check": { params: Empty, result: Empty },
  /** `name` names the model when the component is `model`. */
  "update.apply": { params: z.object({ component: UpdateComponent.optional(), name: z.string().optional() }), result: Empty },
} as const;

export type ClientRequestName = keyof typeof clientRequests;
export type ClientParams<N extends ClientRequestName> = z.infer<(typeof clientRequests)[N]["params"]>;
export type ClientResult<N extends ClientRequestName> = z.infer<(typeof clientRequests)[N]["result"]>;

/** Client → cophylad signals that expect no response and are not audited one by one. */
export const clientSignals = {
  "chat.typing": z.object({ active: z.boolean() }),
  /**
   * A microphone frame, 16 kHz mono: base64 of int16 samples (`pcm`, the default) or of
   * length-prefixed Opus packets (`opus`, see `packPackets`). `seq` numbers the frames sent,
   * so the node can count the ones lost or late.
   */
  "voice.audio": z.object({
    chunk: z.string(),
    codec: AudioCodec.optional(),
    seq: z.number().int().nonnegative().optional(),
  }),
  /** A reply finished playing on the phone, with how its playback went. */
  "voice.played": z.object({
    reply: z.number().int().nonnegative(),
    stats: z
      .object({
        /** Times the buffer ran dry mid-reply. */
        underruns: z.number().int().nonnegative(),
        /** The latest a slice arrived after its turn to play, in ms. */
        maxLateMs: z.number().nonnegative(),
        /** The jitter buffer's target when the reply ended, in ms. */
        targetMs: z.number().nonnegative(),
        frames: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  /**
   * Where the user is, for where replies are read out: whether this client's window is
   * `visible` and `focused`, that the user just acted in it (`active`, at most every half
   * minute), and whether its speaker is on (`speaker`, false while it is muted). Any subset.
   */
  "voice.presence": z.object({
    visible: z.boolean().optional(),
    focused: z.boolean().optional(),
    active: z.boolean().optional(),
    speaker: z.boolean().optional(),
  }),
  /** Keys typed into a terminal this client opened with `input` or `drive`, as a terminal sends them. */
  "terminal.input": z.object({ terminal: z.string(), data: z.string().min(1).max(65536) }),
  /** The size a client driving a terminal now has. */
  "terminal.resize": z.object({ terminal: z.string(), cols: TerminalSize.shape.cols, rows: TerminalSize.shape.rows }),
  "direct.candidate": DirectCandidate,
  "remote.pipe.data": PipeData,
  "remote.pipe.ack": PipeAck,
  "remote.pipe.close": PipeClose,
} as const;

export type ClientSignalName = keyof typeof clientSignals;

/** A viewer a node knows: a client its host has paired (`native`) or a web session it serves (`web`). */
export const RemoteViewer = z.object({
  id: z.string(),
  name: z.string().optional(),
  kind: z.enum(["native", "web"]),
  since: Timestamp,
  /** Streaming right now, when the node can tell. */
  connected: z.boolean().optional(),
});
export type RemoteViewer = z.infer<typeof RemoteViewer>;

export const RemoteHostKind = z.enum(["apollo", "sunshine", "none"]);
export const RemoteHostStatus = z.enum(["off", "installing", "starting", "ready", "unavailable"]);

/** The state of a node's own desktop host: what it is, whether it serves, and why not. */
export const RemoteHost = z.object({
  kind: RemoteHostKind,
  status: RemoteHostStatus,
  /** What the node is doing while `installing` or `starting`. */
  step: z.string().optional(),
  progress: z.number().min(0).max(1).optional(),
  /** Why the host is `unavailable`. */
  reason: z.string().optional(),
});
export type RemoteHost = z.infer<typeof RemoteHost>;

export const RemoteState = z.object({
  node: NodeId,
  host: RemoteHost,
  viewers: z.array(RemoteViewer),
  /** Someone is watching this desktop: a client of its host is connected, or a Sunshine host says it is busy. */
  streaming: z.boolean(),
});
export type RemoteState = z.infer<typeof RemoteState>;

export const clientNotifications = {
  "chat.message": z.object({ message: Message }),
  "chat.delta": z.object({ message: MessageId, block: z.number().int().nonnegative(), delta: ContentBlock }),
  /** A provisional reply was abandoned: no `chat.message` will take its id, so the placeholder goes. */
  "chat.retract": z.object({ message: MessageId }),
  /** What the orchestrator is doing in the turn it is running, whole each time; `turn` absent once it is over. */
  "chat.progress": z.object({ turn: TurnProgress.optional() }),
  /**
   * A session's row, debounced, to every client when it starts, ends or changes what it is
   * doing (its status, ask, title, intent); a change of `lastActivity` or `stats` alone
   * reaches only the clients watching it (`session.watch`).
   */
  "session.state": ClientSession,
  /** One stored session event as it lands, without `raw`, to the clients watching its session (`session.watch`). */
  "session.event": SessionEvent,
  /** A terminal's row, to every client, when it starts or ends, or its title, size, windows or session change. */
  "terminal.state": Terminal,
  /**
   * Output of a terminal this client opened, batched, as text; to that client alone. `seq` is
   * the output position after `data`. `reset` replaces the screen with `data`, a repaint: what
   * a client that fell behind gets instead of what it missed. `cols` and `rows` come when the
   * terminal's size changed since the output before, and with every reset: `data` is drawn at it.
   */
  "terminal.output": z.object({
    terminal: z.string(),
    seq: z.number().int().nonnegative(),
    data: z.string(),
    reset: z.boolean().optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
  }),
  "task.state": Task,
  /** A thread's row changed: opened, closed, or given a topic or a workspace. Its messages ride `chat.message`. */
  "thread.state": ClientThread,
  /** A workspace's row when it is added or changed; one that moved only `lastActivity` is not streamed. */
  "workspace.state": ClientWorkspace,
  "ask.state": Ask,
  /**
   * `client` is the controller whose conversation the state belongs to; absent when idle with none.
   * `unheard` says why an utterance the button held ended with nothing sent. `limit` comes with
   * `listening`: the seconds the utterance may last. `stopped` comes with the `transcribing` a
   * stop forced while the user was still speaking: the limit or the allowance was reached.
   */
  "voice.state": z.object({
    state: VoiceState,
    client: ClientId.optional(),
    unheard: VoiceUnheard.optional(),
    limit: z.number().positive().optional(),
    stopped: VoiceStopped.optional(),
  }),
  /**
   * The words heard so far of this client's utterance, to that client alone, as they grow.
   * `from` is how much of the text before to keep, `text` what follows it: a long transcript
   * is not sent again whole. The last one, once the utterance is in the chat, names its
   * `message`.
   */
  "voice.partial": z.object({
    client: ClientId.optional(),
    text: z.string(),
    from: z.number().int().nonnegative().optional(),
    message: MessageId.optional(),
  }),
  /**
   * Speech for one controller: base64 of int16 samples (`pcm`, the default) or of
   * length-prefixed Opus packets, at `rate` (24 kHz when absent). `reply` numbers the reply
   * it belongs to and `seq` the frame within it; the last frame of a reply says `end`, and
   * may carry no audio. A client that said `played` answers the end with `voice.played`.
   */
  "voice.audio": z.object({
    chunk: z.string(),
    codec: AudioCodec.optional(),
    rate: z.number().int().positive().optional(),
    seq: z.number().int().nonnegative().optional(),
    reply: z.number().int().nonnegative().optional(),
    end: z.literal(true).optional(),
  }),
  /** Whether the next reply or result is to be read out, and where; whenever that changes. */
  "voice.next": VoiceNext,
  /** A voice engine being bootstrapped on the node; `progress` is 0..1 within the step. */
  "voice.setup": z.object({
    stage: VoiceSetupStage,
    engine: z.string(),
    step: VoiceSetupStep,
    progress: z.number().min(0).max(1).optional(),
    message: z.string().optional(),
  }),
  "view.content": ViewContent,
  "view.changed": z.object({ id: z.string() }),
  "node.state": Node,
  "metrics.sample": MetricsSample,
  "remote.state": RemoteState,
  /**
   * An audit entry with its result summarised: `result.body` is never streamed, and the entry
   * of a read-class action, or of the brain's own bookkeeping (what the gate's built-in rules
   * let it do: speak, ask, call the model, keep its threads, tasks, memory and prompts), is
   * kept but not streamed.
   */
  "audit.entry": AuditEntry,
  /**
   * The account as this node sees it: the plan its verified entitlement grants (free when
   * signed out, forged or long expired), `subject` while signed in, `connected` whether the
   * server link is up, `usage` once a refresh reported the period's meter, `backup` the
   * cloud backup once the plan has one.
   */
  "account.state": z.object({
    plan: z.string(),
    limits: z.record(z.string(), z.unknown()),
    usage: Usage.optional(),
    subject: z.string().optional(),
    connected: z.boolean().optional(),
    backup: BackupState.optional(),
  }),
  /** A node's direct connections: on or off, ready or why not, and the channels open now. */
  "direct.state": DirectState,
  /** The node's candidates for a phone's data channel. */
  "direct.candidate": DirectCandidate,
  /** A pipe's bytes, window and end, toward the client that opened it. */
  "remote.pipe.data": PipeData,
  "remote.pipe.ack": PipeAck,
  "remote.pipe.close": PipeClose,
  "update.state": z.object({
    node: NodeId,
    component: UpdateComponent,
    /** The model's name when the component is `model`. */
    name: z.string().optional(),
    current: z.string(),
    available: z.string().optional(),
    staged: z.string().optional(),
    progress: z.number().min(0).max(1).optional(),
  }),
} as const;

export type ClientNotificationName = keyof typeof clientNotifications;
export type ClientNotificationParams<N extends ClientNotificationName> = z.infer<(typeof clientNotifications)[N]>;
