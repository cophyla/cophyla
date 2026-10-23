// The host's settings: a layer over the frame that is the host's own, like the view picker,
// so any view opens the same one by asking `host.settings` and none has to draw it. A side list
// of pages, the one picked beside it (across the top on a phone), each page a few titled
// groups of rows: a label and a line of help on the left, the control on the right. Switches
// and picks take effect at once; text is kept with Save or Enter; what few need (a launch's
// flags) is folded away. The pages:
// - Sessions: which of the user's own sessions each machine connects to (`session.scope`, set
//   with `session.setScope` as each change is made): its accounts, each ticked unless left off,
//   "Tether (Cophyla) started sessions only", and the allowed and hidden folders (`scope.ts`).
// - Accounts: per machine and harness, the usual account (Automatic, naming the profile
//   cophylad picks and why, or one the user picks), and for each profile its name, sign-in
//   state and how much of its limits it has used (`profile.limits`), and for a Claude profile
//   what a session cophylad starts under it is started with: a permission mode and other flags,
//   with where the launch came from (set here, config.toml, or the user's own last session
//   there) and a Reset, written with `profile.update`.
// - Usage: where the agents' spend went (`usage.ts`, `usage.report` from each machine), with
//   filters, a chart over time, a bar list per dimension, the sessions that spent most and what
//   the numbers suggest; the card widens while it shows.
// - Chat: where the chat's own agent session stands (`assistant.state`), the harness and the
//   account it runs on, each left to cophylad or picked (`assistant.configure`, which starts
//   it afresh), and Restart (`assistant.restart`), which keeps the conversation.
// - Voice: on a host with a microphone of its own (the desktop app; the phone keeps its
//   switches in its bar's menu) what voice is doing, which microphone (`micOptions`), listening
//   for the wake words and speaking replies, and the talk key; on every host the node's wake
//   words, a box each, with where the pick came from (`voice.configure` `wake`), the engine
//   that transcribes and the one that reads replies out (`voice.settings`, `voice.configure`)
//   with the voice, the speed, Hear it (`voice.preview`), where an online engine goes first,
//   and for a local engine not installed its licences and Install (`voice.install`), read again
//   each second while one loads or installs; and the node's Gemini and DeepInfra keys, by where
//   each comes from and its last four characters (`account.apiKey`; what is typed leaves the
//   page once it is sent).
// - Listeners: what wakes Cophyla besides the user's messages (`listener.list`), each with why
//   it listens, on what, how it tells and its fires, and Remove (`listener.remove`).
// - Updates, on a host that can check (the desktop app): the version the node runs, Check for
//   updates (`update.check`, `updates.ts`) and what it found, and Update now once a release is
//   ready (`update.apply` when nothing waits).
// - This browser, on a host that is a paired device of its own: when its access ends, Install
//   as an app, and Forget, asked twice.
// A node from before a page's requests says so on the page. The layer closes on its ✕, on
// Escape and on a click outside its card, and says what failed beside what failed.
// `settingsRows`, `chatRow`, `speechRow`, `wakeRow`, `listenerLine`, `settingsPages` and
// `SettingsModel` are DOM-free; the panel draws them with `ui.ts`. Its look is `settings.css`,
// which each host page links.

import type { AssistantHarness, AssistantState, HarnessProfile, LaunchMode, Listener, ListenerKind, Node, ProfileLimits, ProviderKeyName, ProviderKeys, ProviderKeyState, SpeechLicence, SttEngineId, TtsEngineId, VoiceRoute, VoiceSettings as SpeechSettings } from "@cophyla/protocol";
import { HARNESS_NAMES, ScopeModel, scopeControls } from "./scope.ts";
import type { FolderDrafts } from "./scope.ts";
import { checkWords, outcomeOf } from "./updates.ts";
import { UsageModel, usagePage } from "./usage.ts";
import type { UpdateChecker } from "./updates.ts";
import { block, button, checkRow, controlId, el, group, keepFocus, message, pill, row, select, span, switchInput } from "./ui.ts";

export type SettingsRequest = <T>(method: string, params: unknown) => Promise<T>;

/** The permission modes a launch can start in, as the app names them; `""` leaves it to the profile's own settings. */
export const LAUNCH_MODES: readonly { value: "" | LaunchMode; label: string }[] = [
  { value: "", label: "The profile's own setting" },
  { value: "default", label: "Ask" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "auto", label: "Auto" },
  { value: "plan", label: "Plan" },
  { value: "bypassPermissions", label: "Skip permissions" },
];

const HARNESS_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", muse: "Muse" };

/** What a listener listens on, as the settings name it. */
const KIND_LABEL: Record<ListenerKind, string> = {
  "session.started": "a session starts",
  "session.idle": "a session finishes",
  "session.waiting": "a session waits on its shell or you",
  "session.ask": "a session asks",
  "session.said": "a session says something",
  "session.tool": "a session uses a tool",
  "session.ended": "a session ends",
  "task.ready": "a task is ready",
  "node.pressure": "a machine is short of a resource",
  "node.joined": "a machine joins",
  "node.left": "a machine leaves",
  metric: "a reading",
  custom: "a hook's event",
};

const DELIVER_LABEL: Record<Listener["deliver"], string> = { wake: "wakes Cophyla", note: "a note for the next time you talk", notify: "tells you in a line" };

const RESOURCE_LABEL: Record<string, string> = { cpu: "CPU", memory: "memory", gpu: "GPU", vram: "GPU memory" };

/** An id as a line has room for: its kind and its last four characters. */
function shortId(id: string): string {
  const m = /^([a-z]+)_[0-9A-Z]{22}([0-9A-Z]{4})$/.exec(id);
  return m ? `${m[1]}_…${m[2]}` : id;
}

/**
 * The line under a listener's why: what it listens on and for, how a fire tells, the fires
 * left and made. E.g. `a session finishes or a session asks · session sess_…5FB2 · until
 * task_…5FB2 is over · wakes Cophyla · until removed · fired twice`.
 */
export function listenerLine(l: Listener): string {
  const on = l.on.map((k) => (k === "metric" && l.metric ? `${RESOURCE_LABEL[l.metric.resource] ?? l.metric.resource} ${l.metric.above !== undefined ? `above ${l.metric.above}%` : `below ${l.metric.below}%`} for ${l.metric.forS} s` : k === "custom" && l.name ? `the event ${l.name}` : KIND_LABEL[k]));
  const parts = [on.length > 1 ? `${on.slice(0, -1).join(", ")} or ${on.at(-1)}` : on[0]!];
  if (l.session) parts.push(`session ${shortId(l.session)}`);
  if (l.task) parts.push(`task ${shortId(l.task)}`);
  if (l.workspace) parts.push(`workspace ${shortId(l.workspace)}`);
  if (l.harness) parts.push(HARNESS_LABEL[l.harness] ?? l.harness);
  if (l.origin) parts.push(l.origin === "user" ? "your sessions" : "sessions Cophyla started");
  if (l.node) parts.push(`machine ${shortId(l.node)}`);
  if (l.tool) parts.push(`tool ${l.tool}`);
  if (l.level) parts.push(`level ${l.level}`);
  if (l.match) parts.push(Object.entries(l.match).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", "));
  if (l.until) parts.push(`until ${shortId(l.until)} is over`);
  parts.push(DELIVER_LABEL[l.deliver]);
  if (l.cooldownS) parts.push(`at most once in ${l.cooldownS} s`);
  parts.push(l.times === undefined ? "until removed" : `${l.times} ${l.times === 1 ? "fire" : "fires"} left`);
  parts.push(l.fired === 0 ? "not fired yet" : l.fired === 1 ? "fired once" : l.fired === 2 ? "fired twice" : `fired ${l.fired} times`);
  return parts.join(" · ");
}

const STATUS_LABEL: Record<HarnessProfile["status"], string> = { ok: "Signed in", unauthenticated: "Not signed in", missing: "Its folder is missing" };

const WHY_AUTOMATIC: Record<string, string> = { recent: "your latest session's", config: "from config.toml", discovered: "found on this computer", you: "" };

export interface Choice {
  value: string;
  label: string;
}

/** A harness's usual account on a machine: `value` is the profile picked here, `""` for automatic. */
export interface UsualRow {
  key: string;
  node: string;
  harness: string;
  value: string;
  options: Choice[];
  busy: boolean;
  note?: string;
}

/** A Claude profile's launch, as it stands or as it is being edited. */
export interface LaunchRow {
  mode: string;
  flags: string;
  /** Where the launch in use came from, in words. */
  source: string;
  /** Set here: Reset hands it back to config or the mirror. */
  reset: boolean;
  /** Edited and not yet saved. */
  dirty: boolean;
  busy: boolean;
  note?: string;
  /** A mode the list does not name (a mirrored `dontAsk`), kept as a choice so it survives a save. */
  extraMode?: Choice;
}

export interface ProfileRow {
  id: string;
  node: string;
  harness: string;
  name: string;
  configDir: string;
  status: HarnessProfile["status"];
  signedIn: string;
  usage: string;
  usual: boolean;
  launch?: LaunchRow;
}

export interface HarnessSection {
  harness: string;
  label: string;
  usual: UsualRow;
  profiles: ProfileRow[];
}

export interface MachineSection {
  node: string;
  name: string;
  harnesses: HarnessSection[];
}

/** Edits to a launch not yet saved. */
export interface LaunchDraft {
  mode: string;
  flags: string;
}

export interface RowsInput {
  nodes: Node[];
  profiles: HarnessProfile[];
  limits: Record<string, ProfileLimits>;
  drafts?: ReadonlyMap<string, LaunchDraft>;
  notes?: ReadonlyMap<string, string>;
  busy?: ReadonlySet<string>;
  now: number;
  /** A time as the reader's clock shows it; the host's locale when absent. */
  time?: (at: number, now: number) => string;
}

export const usualKey = (node: string, harness: string): string => `usual:${node}:${harness}`;
export const launchKey = (id: string): string => `launch:${id}`;

/** The sections the panel draws: a machine each, by name, then its harnesses: Claude, Codex, Muse. */
export function settingsRows(input: RowsInput): MachineSection[] {
  const names = new Map(input.nodes.map((n) => [n.id, n.name]));
  const byNode = new Map<string, HarnessProfile[]>();
  for (const p of input.profiles) byNode.set(p.node, [...(byNode.get(p.node) ?? []), p]);
  const time = input.time ?? clockTime;
  return [...byNode.entries()]
    .map(([node, profiles]) => ({
      node,
      name: names.get(node) ?? node,
      harnesses: ["claude", "codex", "muse"]
        .map((harness) => profiles.filter((p) => p.harness === harness))
        .filter((list) => list.length > 0)
        .map((list) => harnessSection(node, list, input, time)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.node.localeCompare(b.node));
}

function harnessSection(node: string, list: HarnessProfile[], input: RowsInput, time: (at: number, now: number) => string): HarnessSection {
  const harness = list[0]!.harness;
  const auto = list.find((p) => p.automatic !== undefined);
  const why = auto?.automatic ? WHY_AUTOMATIC[auto.automatic] : "";
  const key = usualKey(node, harness);
  const usual: UsualRow = {
    key,
    node,
    harness,
    value: list.find((p) => p.defaultBy === "you")?.id ?? "",
    options: [
      { value: "", label: auto ? `Automatic (${auto.name}${why ? `, ${why}` : ""})` : "Automatic" },
      ...list.map((p) => ({ value: p.id, label: p.status === "ok" ? p.name : `${p.name} (${STATUS_LABEL[p.status].toLowerCase()})` })),
    ],
    busy: input.busy?.has(key) ?? false,
    ...(input.notes?.get(key) ? { note: input.notes.get(key)! } : {}),
  };
  return {
    harness,
    label: HARNESS_LABEL[harness] ?? harness,
    usual,
    profiles: list.map((p) => profileRow(p, input, time)),
  };
}

function profileRow(p: HarnessProfile, input: RowsInput, time: (at: number, now: number) => string): ProfileRow {
  const row: ProfileRow = {
    id: p.id,
    node: p.node,
    harness: p.harness,
    name: p.name,
    configDir: p.configDir,
    status: p.status,
    signedIn: STATUS_LABEL[p.status],
    usage: usageText(input.limits[p.id]),
    usual: p.default === true,
  };
  if (p.harness === "claude") row.launch = launchRow(p, input, time);
  return row;
}

/** Session and weekly use, as a line. */
export function usageText(l: ProfileLimits | undefined): string {
  if (!l || (!l.session && !l.weekly)) return "Usage not known";
  const parts: string[] = [];
  if (l.session) parts.push(`Session ${Math.round(l.session.percent)}%`);
  if (l.weekly) parts.push(`Week ${Math.round(l.weekly.percent)}%`);
  return parts.join(" · ");
}

function launchRow(p: HarnessProfile, input: RowsInput, time: (at: number, now: number) => string): LaunchRow {
  const key = launchKey(p.id);
  const current = { mode: p.launch?.mode ?? "", flags: joinFlags(p.launch?.args ?? []) };
  const draft = input.drafts?.get(p.id);
  const shown = draft ?? current;
  const source = !p.launch
    ? "Nothing set: sessions start as this profile's own settings say. Start one yourself and its flags are used."
    : p.launch.source === "you"
      ? "Set here."
      : p.launch.source === "config"
        ? "From config.toml ([[profiles]] args)."
        : `Mirrored from your own session${p.launch.at !== undefined ? ` at ${time(p.launch.at, input.now)}` : ""}.`;
  const row: LaunchRow = {
    mode: shown.mode,
    flags: shown.flags,
    source,
    reset: p.launch?.source === "you",
    dirty: draft !== undefined && (draft.mode !== current.mode || splitFlags(draft.flags).join("\u0000") !== (p.launch?.args ?? []).join("\u0000")),
    busy: input.busy?.has(key) ?? false,
  };
  const note = input.notes?.get(key);
  if (note) row.note = note;
  const named = LAUNCH_MODES.some((m) => m.value === shown.mode);
  if (!named) row.extraMode = { value: shown.mode, label: shown.mode === "dontAsk" ? "Don't ask" : shown.mode };
  return row;
}

/** A time today as hours and minutes; another day's with its date. */
function clockTime(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now).toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * Flags typed as one line, split as a POSIX shell splits words: whitespace separates, single
 * quotes keep everything, double quotes keep all but a backslash before `"` or `\`, and a
 * backslash outside quotes keeps the next character.
 */
export function splitFlags(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) cur += line[++i];
      else cur += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    started = true;
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\" && i + 1 < line.length && /[\s"'\\]/.test(line[i + 1]!)) cur += line[++i];
    else cur += ch;
  }
  if (started) out.push(cur);
  return out;
}

/**
 * Flags as one line that `splitFlags` reads back the same: a word with a space or a quote in
 * double quotes, escaping only a quote and a backslash that comes before one (or ends the
 * word), so a Windows path reads as it is typed.
 */
export function joinFlags(args: readonly string[]): string {
  return args.map((a) => (a === "" || /[\s"']/.test(a) ? `"${a.replace(/\\(?=["\\]|$)/g, "\\\\").replace(/"/g, '\\"')}"` : a)).join(" ");
}

/** What the speech part of the Voice section shows. */
export interface SpeechRow {
  stage: "stt" | "tts";
  engine: string;
  options: Choice[];
  /** What the engine picked is like. */
  detail: string;
  /** Where the engine stands, in words, and whether that is trouble. */
  status: string;
  trouble: boolean;
  /** The voice as the user counts it, from 1, among `voices`; neither when the engine has no choice of voices. */
  voice?: number;
  voices?: number;
  /** How fast replies are read, among `speeds`; neither for transcription, with speech off, or from a node that cannot say. */
  speed?: number;
  speeds?: Choice[];
  /** Hear it can be pressed: the engine is up. */
  canPreview: boolean;
  /** Where the choice came from, in words. */
  source: string;
  /** Set here: the reset hands it back to config.toml. */
  reset: boolean;
  busy: boolean;
  note?: string;
  /** The engine runs on this computer and is not installed: what it comes under, what it would download, and how an install goes. */
  install?: InstallRow;
  /** The engine goes over the network: where it goes first. */
  route?: RouteRow;
}

/** Where an online engine goes first, for the choice under it. */
export interface RouteRow {
  value: VoiceRoute;
  options: Choice[];
  /** What the choice means; trouble when it cannot work, the user's own key alone with none given. */
  detail: string;
  trouble: boolean;
}

/** One vendor's key as the Voice section shows it: never the key, only where it comes from and how it ends. */
export interface KeyRow {
  provider: ProviderKeyName;
  label: string;
  /** Where the key in use comes from, in words, with its last four characters. */
  status: string;
  /** What the key is for. */
  detail: string;
  /** Given here: Clear forgets it, and config.toml's or the environment's is used again. */
  clearable: boolean;
  busy: boolean;
  note?: string;
}

/** The two routes an online engine can take, as the choice names them. */
export const ROUTE_CHOICES: readonly Choice[] = [
  { value: "cloud", label: "Cophyla cloud (Pro)" },
  { value: "own", label: "My own key" },
];

const VENDORS: Record<ProviderKeyName, { name: string; env: string; detail: string }> = {
  gemini: { name: "Gemini", env: "GEMINI_API_KEY", detail: "Transcription with your own key, and the assistant's model when it goes to Gemini." },
  deepinfra: { name: "DeepInfra", env: "DEEPINFRA_API_KEY", detail: "Kokoro online with your own key." },
};

/** The vendor an online engine goes to with the user's own key; none for an engine on this computer. */
function vendorOf(stage: "stt" | "tts", engine: string): ProviderKeyName | undefined {
  if (stage === "stt") return engine === "gemini-live" || engine === "gemini" || engine === "server" ? "gemini" : undefined;
  return engine === "kokoro-online" || engine === "server" ? "deepinfra" : undefined;
}

/** "From config.toml, ending ••••x9Qa" */
function keyWords(provider: ProviderKeyName, k: ProviderKeyState): string {
  const ending = k.last4 ? `, ending ••••${k.last4}` : "";
  if (k.source === "app") return `Set here${ending}.`;
  if (k.source === "config") return `From config.toml${ending}.`;
  if (k.source === "env") return `From ${VENDORS[provider].env} in the environment${ending}.`;
  return "No key.";
}

/** The route of a stage whose engine goes online, on a node that says where its engines go. */
function routeRow(s: SpeechSettings, stage: "stt" | "tts", engine: string): RouteRow | undefined {
  const provider = vendorOf(stage, engine);
  const keys = (s as { keys?: ProviderKeys }).keys;
  if (!provider || !keys) return undefined;
  const value = (stage === "stt" ? s.sttRoute : s.ttsRoute) ?? "cloud";
  const vendor = VENDORS[provider].name;
  const has = keys[provider].source !== "none";
  if (value === "cloud") {
    const detail = `Through your account's server on a Pro plan; ${has ? `your own ${vendor} key when the server cannot.` : `without one, your own ${vendor} key is needed.`}`;
    return { value, options: [...ROUTE_CHOICES], detail, trouble: false };
  }
  if (has) return { value, options: [...ROUTE_CHOICES], detail: `Straight to ${vendor} with your own key, never through Cophyla's server.`, trouble: false };
  return { value, options: [...ROUTE_CHOICES], detail: `Your own ${vendor} key is needed: give one below.`, trouble: true };
}

/** The node's keys, a row each, from `voice.settings`; none from a node that cannot say. */
export function keyRows(s: SpeechSettings, busy: ReadonlySet<string> = new Set(), notes: ReadonlyMap<string, string> = new Map()): KeyRow[] {
  const keys = (s as { keys?: ProviderKeys }).keys;
  if (!keys) return [];
  return (["gemini", "deepinfra"] as const).map((provider) => {
    const k = keys[provider];
    const note = notes.get(provider);
    return {
      provider,
      label: `${VENDORS[provider].name} key`,
      status: keyWords(provider, k),
      detail: VENDORS[provider].detail,
      clearable: k.source === "app",
      busy: busy.has(provider),
      ...(note ? { note } : {}),
    };
  });
}

export interface InstallRow {
  licences: SpeechLicence[];
  bytes: number;
  /** "Installing Piper: the model, 42%" while it runs. */
  progress?: string;
  /** Why the last install of this engine failed. */
  error?: string;
}

/** "92 MB" */
export function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

/** The speeds the speech row offers, the engine's own pace being 1. */
export const SPEECH_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];

/** "1.5×" */
export function speedLabel(speed: number): string {
  return `${speed}×`;
}

/** The speeds offered, with one set some other way among them. */
function speedChoices(speed: number): Choice[] {
  const speeds = SPEECH_SPEEDS.includes(speed) ? SPEECH_SPEEDS : [...SPEECH_SPEEDS, speed].sort((a, b) => a - b);
  return speeds.map((v) => ({ value: String(v), label: speedLabel(v) }));
}

/** One stage's part of the Voice section, from the node's `voice.settings`: speech (`tts`) or transcription (`stt`). */
function engineRow(s: SpeechSettings, stage: "stt" | "tts", busy: boolean, note: string | undefined): SpeechRow {
  const engine = stage === "tts" ? s.tts : s.stt;
  const state = stage === "tts" ? s.stage : s.sttStage;
  // A node from before transcription could be picked names no stage: its engines are speech engines.
  const mine = s.engines.filter((e) => ((e as { stage?: string }).stage ?? "tts") === stage);
  const info = mine.find((e) => e.id === engine);
  const label = info?.label ?? engine;
  let status: string;
  let trouble = false;
  if (!s.enabled) {
    status = "Voice is off on this computer: it is turned on in config.toml, under [voice].";
    trouble = true;
  } else if (engine === "off" || state.status === "off") status = stage === "tts" ? "Replies are not spoken." : "Nothing is transcribed.";
  else if (state.status === "uninstalled" || (info?.local && info.installed === false)) status = `${label} is not installed on this computer.`;
  else if (state.status === "loading") status = engine === "chatterbox" ? "Setting up Chatterbox… the first time takes several minutes." : `Loading ${label}…`;
  else if (state.status === "ready") status = `${label} is ready.`;
  else {
    status = `${label} cannot ${stage === "tts" ? "speak" : "transcribe"}${state.reason ? `: ${state.reason}` : "."}`;
    trouble = true;
  }
  const options = mine.map((e) => ({ value: e.id, label: e.local && e.installed === false ? `${e.label} (not installed)` : e.label }));
  if (!info) options.push({ value: engine, label: engine });
  const many = stage === "tts" && s.voices !== undefined && s.voices > 1;
  // A node from before the speed could be set says none.
  const speed = (s as { speed?: number }).speed;
  const paced = stage === "tts" && s.enabled && engine !== "off" && speed !== undefined;
  const source = stage === "tts" ? s.source : s.sttSource;
  const route = s.enabled && engine !== "off" ? routeRow(s, stage, engine) : undefined;
  let install: InstallRow | undefined;
  if (info?.local && info.installed === false) {
    const running = s.installing?.engine === engine ? s.installing : undefined;
    install = {
      licences: info.licences ?? [],
      bytes: info.bytes ?? 0,
      ...(running ? { progress: `Installing ${label}: ${running.step === "runtime" ? "the runtime" : "the model"}, ${Math.round(running.progress * 100)}%` } : {}),
      ...(s.installError?.engine === engine ? { error: `The install failed: ${s.installError.message}` } : {}),
    };
  }
  return {
    stage,
    engine,
    options,
    detail: info?.detail ?? "",
    status,
    trouble,
    ...(many ? { voice: (s.voice ?? 0) + 1, voices: s.voices } : {}),
    ...(paced ? { speed, speeds: speedChoices(speed) } : {}),
    canPreview: stage === "tts" && s.enabled && state.status === "ready" && engine !== "off",
    source: source === "app" ? "Picked here." : "From config.toml.",
    reset: source === "app",
    busy: busy || s.installing !== undefined,
    ...(note ? { note } : {}),
    ...(install ? { install } : {}),
    ...(route ? { route } : {}),
  };
}

/** The speech part of the Voice section, from the node's `voice.settings`. */
export function speechRow(s: SpeechSettings, busy = false, note?: string): SpeechRow {
  return engineRow(s, "tts", busy, note);
}

/** The transcription part of the Voice section. */
export function sttRow(s: SpeechSettings, busy = false, note?: string): SpeechRow {
  return engineRow(s, "stt", busy, note);
}

/** One phrase the node's wake model has, as its box shows it. */
export interface WakeChoiceRow {
  head: string;
  label: string;
  /** How it is said, when the model says. */
  sound?: string;
  on: boolean;
}

/** The wake words part of the Voice section: a box per phrase, what listens in words, and where the pick came from. */
export interface WakeRow {
  choices: WakeChoiceRow[];
  status: string;
  trouble: boolean;
  source: string;
  /** Picked here: the reset hands it back to config.toml. */
  reset: boolean;
  busy: boolean;
  note?: string;
}

/** "“A”", "“A” and “B”", "“A”, “B” and “C”". */
function quoted(names: string[]): string {
  const q = names.map((n) => `“${n}”`);
  return q.length <= 1 ? (q[0] ?? "") : `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}`;
}

/** The node's wake words, from its `voice.settings`; none from a node that cannot pick them or whose wake word is off. */
export function wakeRow(s: SpeechSettings, busy = false, note?: string): WakeRow | undefined {
  const heads = s.wake;
  if (!heads || heads.length === 0) return undefined;
  const choices = heads.map((h) => ({ head: h.head, label: titleCase(h.phrase), ...(h.sound ? { sound: h.sound } : {}), on: h.on }));
  const on = choices.filter((c) => c.on);
  const stage = s.wakeStage;
  let status: string;
  let trouble = false;
  if (!s.enabled) {
    status = "Voice is off on this computer: it is turned on in config.toml, under [voice].";
    trouble = true;
  } else if (on.length === 0) status = "No wake word listens: hold the talk key, or the button, to talk.";
  else if (stage?.status === "loading") status = "Loading the wake words…";
  else if (stage && (stage.status === "unavailable" || stage.status === "failed")) {
    status = `The wake words cannot listen${stage.reason ? `: ${stage.reason}` : "."}`;
    trouble = true;
  } else {
    // The same phrase said two ways reads as one name; how each is said is beside its box.
    const names = [...new Set(on.map((c) => c.label))];
    status = `Listening for ${quoted(names)}.`;
  }
  return {
    choices,
    status,
    trouble,
    source: s.wakeSource === "app" ? "Picked here." : "From config.toml.",
    reset: s.wakeSource === "app",
    busy: busy || s.installing !== undefined,
    ...(note ? { note } : {}),
  };
}

/** The harnesses the chat can run on, as the settings name them. */
const CHAT_HARNESS: Record<AssistantHarness, string> = { claude: "Claude Code", codex: "Codex" };

const CHAT_STATUS: Record<AssistantState["status"], string> = {
  off: "Off",
  unavailable: "No account is signed in",
  starting: "Starting…",
  idle: "Ready",
  busy: "Working",
  down: "Starting again…",
};

/** A count of tokens, short: 41k, 1.2k. */
function shortCount(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** The chat's section: where its session stands, what it runs with, and the two choices. */
export interface ChatRow {
  status: string;
  /** It is not running, for a reason the user can act on. */
  trouble: boolean;
  /** Why, in the node's words. */
  detail?: string;
  /** What it runs with, while a harness is picked: the model, the effort and its context. */
  runs?: string;
  harness: { value: "" | AssistantHarness; options: { value: "" | AssistantHarness; label: string }[] };
  account: { value: string; options: { value: string; label: string }[] };
  /** Whether it can be started again from here. */
  restartable: boolean;
  busy: boolean;
  note?: string;
}

/**
 * The chat's row, from what the node says of its session and the accounts signed in on the
 * machine it runs on: the primary, or the machine of the account in use. Automatic names
 * what cophylad picked; the accounts offered are those of the harness picked, or of both.
 */
export function chatRow(input: { state: AssistantState; profiles: HarnessProfile[]; nodes: Node[]; busy: boolean; note?: string }): ChatRow {
  const { state, profiles } = input;
  const running = profiles.find((p) => p.id === state.profile);
  const home = running?.node ?? input.nodes.find((n) => n.role === "primary")?.id;
  const chosen = state.chosen ?? {};
  const offered = profiles.filter((p) => (p.harness === "claude" || p.harness === "codex") && p.status === "ok" && (home === undefined || p.node === home) && (chosen.harness === undefined || p.harness === chosen.harness));
  const label = (p: HarnessProfile) => `${CHAT_HARNESS[p.harness as AssistantHarness]} · ${p.name}`;
  const picked = profiles.find((p) => p.id === chosen.profile);
  const accounts = offered.map((p) => ({ value: p.id, label: label(p) }));
  // One picked that is no longer among them stays listed, so the choice still shows.
  if (chosen.profile !== undefined && !accounts.some((a) => a.value === chosen.profile)) accounts.push({ value: chosen.profile, label: picked ? `${label(picked)} (not signed in)` : "An account that is gone" });
  const autoHarness = chosen.harness === undefined && state.harness ? `Automatic (${CHAT_HARNESS[state.harness]})` : "Automatic";
  const autoAccount = chosen.profile === undefined && running ? `Automatic (${running.name})` : "Automatic";
  const parts = state.harness ? [state.model, state.effort !== undefined ? `${state.effort} effort` : undefined, state.context ? `${shortCount(state.context.used)} of ${shortCount(state.context.limit)} tokens of context` : undefined].filter((w) => w !== undefined) : [];
  return {
    status: CHAT_STATUS[state.status],
    trouble: state.status === "unavailable" || state.status === "down",
    ...(state.detail !== undefined ? { detail: state.detail } : {}),
    ...(parts.length > 0 ? { runs: parts.join(" · ") } : {}),
    harness: { value: chosen.harness ?? "", options: [{ value: "", label: autoHarness }, { value: "claude", label: CHAT_HARNESS.claude }, { value: "codex", label: CHAT_HARNESS.codex }] },
    account: { value: chosen.profile ?? "", options: [{ value: "", label: autoAccount }, ...accounts] },
    restartable: state.status !== "off",
    busy: input.busy,
    ...(input.note ? { note: input.note } : {}),
  };
}

/** How often the panel asks again while an engine loads. */
export const SPEECH_POLL_MS = 1000;

/**
 * What the panel shows, and what it changes: the profiles, the machines' names and the
 * limits, read when it opens; edits to a launch held as drafts until saved; the node's
 * speech and the picks made for it; a note beside what failed. `changed` is called whenever
 * there is something new to draw.
 */
export class SettingsModel {
  nodes: Node[] = [];
  profiles: HarnessProfile[] = [];
  limits: Record<string, ProfileLimits> = {};
  /** Loading, or why the profiles could not be read; empty once they are shown. */
  note = "Loading…";
  readonly drafts = new Map<string, LaunchDraft>();
  readonly notes = new Map<string, string>();
  readonly busy = new Set<string>();
  /** The node's speech, once read; absent while reading and on a node that has none to say. */
  speech?: SpeechSettings;
  /** The speech, the listeners and the chat were each asked for and answered, or refused. */
  speechRead = false;
  listenersRead = false;
  chatRead = false;
  speechBusy = false;
  speechNote = "";
  sttNote = "";
  wakeNote = "";
  /** A key being saved or cleared, and why the last one could not be, by vendor. */
  readonly keyBusy = new Set<ProviderKeyName>();
  readonly keyNotes = new Map<ProviderKeyName, string>();
  /** The brain's listeners, once read; absent while reading and on a node from before there were any. */
  listeners?: Listener[];
  /** Why a listener could not be removed, by id. */
  readonly listenerNotes = new Map<string, string>();
  /** The session the chat runs in, once read; absent while reading and on a node from before the chat ran in one. */
  chat?: AssistantState;
  chatBusy = false;
  chatNote = "";
  readonly removing = new Set<string>();
  private speechTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private request: SettingsRequest;
  private changed: () => void;

  constructor(request: SettingsRequest, changed: () => void) {
    this.request = request;
    this.changed = changed;
  }

  sections(now = Date.now(), time?: (at: number, now: number) => string): MachineSection[] {
    return settingsRows({ nodes: this.nodes, profiles: this.profiles, limits: this.limits, drafts: this.drafts, notes: this.notes, busy: this.busy, now, ...(time ? { time } : {}) });
  }

  /** The profiles, the machines and the limits. The limits are read last and may be slow or fail: the rest shows first. */
  async load(): Promise<void> {
    this.note = "Loading…";
    this.changed();
    try {
      const [profiles, nodes] = await Promise.all([this.request<{ profiles: HarnessProfile[] }>("profile.list", {}), this.request<{ nodes: Node[] }>("node.list", {}).catch(() => ({ nodes: [] as Node[] }))]);
      this.profiles = profiles.profiles;
      this.nodes = nodes.nodes;
      this.note = this.profiles.length === 0 ? "No agent is installed on any of your machines." : "";
    } catch (e) {
      this.note = `The agents' settings could not be read: ${message(e)}`;
      this.changed();
      return;
    }
    this.changed();
    try {
      this.limits = (await this.request<{ limits: Record<string, ProfileLimits> }>("profile.limits", {})).limits;
    } catch {
      this.limits = {};
    }
    this.changed();
  }

  /** The chat's row; none until the node has said where its session stands. */
  chatRow(): ChatRow | undefined {
    return this.chat ? chatRow({ state: this.chat, profiles: this.profiles, nodes: this.nodes, busy: this.chatBusy, note: this.chatNote }) : undefined;
  }

  /** Where the chat's session stands. A node from before the chat ran in one leaves the section out. */
  async loadChat(): Promise<void> {
    try {
      this.chat = (await this.request<{ state: AssistantState }>("assistant.state", {})).state;
    } catch {
      this.chat = undefined;
    }
    this.chatRead = true;
    this.changed();
  }

  /** The harness the chat runs on, or `""` to leave it to cophylad. An account picked for another harness goes with it. */
  async setChatHarness(value: "" | AssistantHarness): Promise<void> {
    if (!this.chat || value === (this.chat.chosen?.harness ?? "")) return;
    const pinned = this.profiles.find((p) => p.id === this.chat?.chosen?.profile);
    const keeps = value === "" || pinned === undefined || pinned.harness === value;
    await this.chatWrite("assistant.configure", { harness: value === "" ? null : value, ...(keeps ? {} : { profile: null }) });
  }

  /** The account the chat runs on, or `""` to leave it to cophylad. A harness picked that is not the account's goes to the account's. */
  async setChatAccount(value: string): Promise<void> {
    if (!this.chat || value === (this.chat.chosen?.profile ?? "")) return;
    const account = this.profiles.find((p) => p.id === value);
    const harness = this.chat.chosen?.harness;
    const moves = account !== undefined && harness !== undefined && account.harness !== harness;
    await this.chatWrite("assistant.configure", { profile: value === "" ? null : value, ...(moves ? { harness: account.harness as AssistantHarness } : {}) });
  }

  /** Ends the chat's session and starts it again where it was. */
  async restartChat(): Promise<void> {
    await this.chatWrite("assistant.restart", {});
  }

  private async chatWrite(method: "assistant.configure" | "assistant.restart", params: unknown): Promise<void> {
    if (this.chatBusy) return;
    this.chatBusy = true;
    this.chatNote = "";
    this.changed();
    try {
      this.chat = (await this.request<{ state: AssistantState }>(method, params)).state;
    } catch (e) {
      this.chatNote = `${method === "assistant.restart" ? "Not restarted" : "Not changed"}: ${message(e)}`;
    } finally {
      this.chatBusy = false;
    }
    this.changed();
  }

  /** What Cophyla listens for. A node from before there were listeners leaves the section out. */
  async loadListeners(): Promise<void> {
    try {
      this.listeners = (await this.request<{ listeners: Listener[] }>("listener.list", {})).listeners;
    } catch {
      this.listeners = undefined;
    }
    this.listenersRead = true;
    this.changed();
  }

  /** Takes a listener away; the list is read again after, so a fire or another removal meanwhile shows too. */
  async removeListener(id: string): Promise<void> {
    if (this.removing.has(id)) return;
    this.removing.add(id);
    this.listenerNotes.delete(id);
    this.changed();
    try {
      await this.request("listener.remove", { id });
      this.listeners = this.listeners?.filter((l) => l.id !== id);
    } catch (e) {
      this.listenerNotes.set(id, `Not removed: ${message(e)}`);
    } finally {
      this.removing.delete(id);
    }
    this.changed();
    if (!this.listenerNotes.has(id)) await this.loadListeners();
  }

  /** The node's speech. A node that cannot say (one from before it could) leaves the part out. */
  async loadSpeech(): Promise<void> {
    try {
      this.speech = await this.request<SpeechSettings>("voice.settings", {});
    } catch {
      this.speech = undefined;
    }
    this.speechRead = true;
    this.afterSpeech();
  }

  speechRow(): SpeechRow | undefined {
    return this.speech ? speechRow(this.speech, this.speechBusy, this.speechNote || undefined) : undefined;
  }

  /** None from a node that cannot pick one, from before transcription could be. */
  sttRow(): SpeechRow | undefined {
    return this.speech?.sttStage ? sttRow(this.speech, this.speechBusy, this.sttNote || undefined) : undefined;
  }

  /** The node's wake words; none from a node that cannot pick them. */
  wakeRow(): WakeRow | undefined {
    return this.speech ? wakeRow(this.speech, this.speechBusy, this.wakeNote || undefined) : undefined;
  }

  /** One wake word on or off, the others as they are, in the model's order. */
  setWake(head: string, on: boolean): Promise<void> {
    const heads = this.speech?.wake;
    const choice = heads?.find((h) => h.head === head);
    if (!heads || !choice || choice.on === on) return Promise.resolve();
    const wake = heads.filter((h) => (h.head === head ? on : h.on)).map((h) => h.head);
    return this.configure({ wake }, "wake");
  }

  /** Back to config.toml's wake words. */
  resetWake(): Promise<void> {
    if (this.speech?.wakeSource !== "app") return Promise.resolve();
    return this.configure({ wake: null }, "wake");
  }

  /** The node's keys, a row each; none from a node that cannot say. */
  keyRows(): KeyRow[] {
    return this.speech ? keyRows(this.speech, this.keyBusy, this.keyNotes) : [];
  }

  /** Where an online engine goes first. */
  setRoute(stage: "stt" | "tts", route: VoiceRoute): Promise<void> {
    const now = (stage === "stt" ? this.speech?.sttRoute : this.speech?.ttsRoute) ?? "cloud";
    if (route === now) return Promise.resolve();
    return this.configure(stage === "stt" ? { sttRoute: route } : { ttsRoute: route }, stage);
  }

  /**
   * A vendor's key given here, or forgotten with `null`. The answer names the keys by their last
   * four characters, and the row shows it; the key itself is never read back. False when it was
   * not taken, with the note saying why.
   */
  async setKey(provider: ProviderKeyName, apiKey: string | null): Promise<boolean> {
    const key = apiKey === null ? null : apiKey.trim();
    if (key === "" || this.keyBusy.has(provider)) return false;
    this.keyBusy.add(provider);
    this.keyNotes.delete(provider);
    this.changed();
    try {
      const keys = await this.request<ProviderKeys>("account.apiKey", { provider, apiKey: key });
      if (this.speech) this.speech = { ...this.speech, keys };
      return true;
    } catch (e) {
      this.keyNotes.set(provider, `${key === null ? "Not cleared" : "Not saved"}: ${message(e)}`);
      return false;
    } finally {
      this.keyBusy.delete(provider);
      if (!this.disposed) this.changed();
    }
  }

  /** Another transcription engine, or back to config.toml's with `null`. */
  setStt(stt: SttEngineId | null): Promise<void> {
    if (stt !== null && stt === this.speech?.stt && this.speech.sttSource === "app") return Promise.resolve();
    return this.configure({ stt }, "stt");
  }

  /** Installs a local engine, the licences having been shown beside the button. */
  async install(engine: string, stage: "stt" | "tts"): Promise<void> {
    if (this.speechBusy) return;
    this.speechBusy = true;
    this.setNote(stage, "");
    this.changed();
    try {
      this.speech = await this.request<SpeechSettings>("voice.install", { engine });
    } catch (e) {
      this.setNote(stage, `Not installed: ${message(e)}`);
    } finally {
      this.speechBusy = false;
    }
    this.afterSpeech();
  }

  private setNote(stage: "stt" | "tts" | "wake", note: string): void {
    if (stage === "stt") this.sttNote = note;
    else if (stage === "wake") this.wakeNote = note;
    else this.speechNote = note;
  }

  /** Another engine, or back to config.toml's with `null`. */
  setEngine(tts: TtsEngineId | null): Promise<void> {
    if (tts !== null && tts === this.speech?.tts && this.speech.source === "app") return Promise.resolve();
    return this.configure(tts === null ? { tts: null, voice: null } : { tts });
  }

  /** A voice as the user counts it, from 1. */
  setVoice(voice: number): Promise<void> {
    const n = Math.round(voice) - 1;
    const voices = this.speech?.voices;
    if (!Number.isFinite(n) || n < 0 || (voices !== undefined && n >= voices) || n === this.speech?.voice) return Promise.resolve();
    return this.configure({ voice: n });
  }

  /** How fast replies are read, whichever engine reads them. */
  setSpeed(speed: number): Promise<void> {
    if (!Number.isFinite(speed) || speed === this.speech?.speed) return Promise.resolve();
    return this.configure({ speed });
  }

  /** A line in the voice set now, spoken to this host. */
  async preview(): Promise<void> {
    this.speechNote = "";
    this.changed();
    try {
      await this.request("voice.preview", {});
    } catch (e) {
      this.speechNote = `Could not play it: ${message(e)}`;
      this.changed();
    }
  }

  /** Stops asking again: the panel closed. */
  dispose(): void {
    this.disposed = true;
    if (this.speechTimer) clearTimeout(this.speechTimer);
    this.speechTimer = undefined;
  }

  private async configure(patch: { tts?: TtsEngineId | null; voice?: number | null; speed?: number; stt?: SttEngineId | null; sttRoute?: VoiceRoute; ttsRoute?: VoiceRoute; wake?: string[] | null }, stage: "stt" | "tts" | "wake" = "tts"): Promise<void> {
    if (this.speechBusy) return;
    this.speechBusy = true;
    this.setNote(stage, "");
    this.changed();
    try {
      this.speech = await this.request<SpeechSettings>("voice.configure", patch);
    } catch (e) {
      this.setNote(stage, `Not saved: ${message(e)}`);
    } finally {
      this.speechBusy = false;
    }
    this.afterSpeech();
  }

  /** Draws, and while an engine loads or installs asks again in a second, until the panel closes. */
  private afterSpeech(): void {
    if (this.disposed) return;
    this.changed();
    if (this.speechTimer) clearTimeout(this.speechTimer);
    this.speechTimer = undefined;
    const s = this.speech;
    if (s && (s.installing || (s.enabled && (s.stage.status === "loading" || s.sttStage?.status === "loading" || s.wakeStage?.status === "loading")))) {
      this.speechTimer = setTimeout(() => {
        this.speechTimer = undefined;
        void this.loadSpeech();
      }, SPEECH_POLL_MS);
    }
  }

  /** The usual account for a harness on a machine: a profile, or `""` for automatic. */
  async setUsual(node: string, harness: string, value: string): Promise<void> {
    const key = usualKey(node, harness);
    const picked = this.profiles.find((p) => p.node === node && p.harness === harness && p.defaultBy === "you");
    const id = value || picked?.id;
    if (!id || value === (picked?.id ?? "")) return;
    await this.write(key, id, value ? { usual: true } : { usual: null }, true);
  }

  /** A launch being edited: held until saved. */
  edit(id: string, draft: LaunchDraft): void {
    this.drafts.set(id, draft);
    this.notes.delete(launchKey(id));
  }

  async saveLaunch(id: string): Promise<void> {
    const draft = this.drafts.get(id);
    if (!draft) return;
    const args = splitFlags(draft.flags);
    const launch = { ...(draft.mode ? { mode: draft.mode as LaunchMode } : {}), args };
    await this.write(launchKey(id), id, { launch }, false);
  }

  async resetLaunch(id: string): Promise<void> {
    await this.write(launchKey(id), id, { launch: null }, false);
  }

  /**
   * One `profile.update`; the answer replaces the profile, or all of them when the usual
   * account moved, and a saved launch's draft goes before the panel draws again.
   */
  private async write(key: string, id: string, patch: Record<string, unknown>, relist: boolean): Promise<boolean> {
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile || this.busy.has(key)) return false;
    this.busy.add(key);
    this.notes.delete(key);
    this.changed();
    try {
      const { profile: updated } = await this.request<{ profile: HarnessProfile }>("profile.update", { node: profile.node, id, patch });
      this.profiles = this.profiles.map((p) => (p.id === id ? updated : p));
      if (relist) this.profiles = (await this.request<{ profiles: HarnessProfile[] }>("profile.list", {})).profiles;
      if (key === launchKey(id)) this.drafts.delete(id);
      return true;
    } catch (e) {
      this.notes.set(key, `Not saved: ${message(e)}`);
      return false;
    } finally {
      this.busy.delete(key);
      this.changed();
    }
  }
}

/** What the Voice section shows. */
export interface VoiceSettingsState {
  /** Listening for the wake words. */
  listening: boolean;
  /** Replies are spoken aloud. */
  speak: boolean;
  /** The talk key as the shell reads it; `""` when there is none, and on a host that has no such key at all. */
  talkKey: string;
  /** The phrases the node listens for, once it said which; the node detects them itself when empty. */
  phrases: string[];
  /** What voice is doing now, in words: listening for the words, the microphone refused, voice off on the node. */
  status: string;
  /** The microphone could not be had, or its device went away, and why. */
  micError?: string;
  /** The device the microphone runs on, by name. */
  mic?: string;
  /** Why it runs on another than the one it did or the one picked. */
  micNote?: string;
  /** The microphone picked; the system's default when absent. */
  micChoice?: { id: string; label: string };
  /** The microphones there are to pick from, once the host listed them. */
  mics?: { id: string; label: string }[];
  /** The system's default microphone, by name, when the host can say. */
  defaultMic?: string;
}

/**
 * The Microphone row's choices: the system's default first, named when the host knows it, then
 * each device. A pick that is not connected stays listed, marked, so what was picked still shows.
 */
export function micOptions(v: VoiceSettingsState): { options: { value: string; label: string }[]; value: string } {
  const options = [{ value: "", label: v.defaultMic ? `System default (${v.defaultMic})` : "System default" }];
  for (const m of v.mics ?? []) options.push({ value: m.id, label: m.label });
  const choice = v.micChoice;
  if (!choice) return { options, value: "" };
  const listed = options.find((o) => o.value !== "" && o.value === choice.id) ?? options.find((o) => o.value !== "" && o.label === choice.label);
  if (listed) return { options, value: listed.value };
  options.push({ value: choice.id, label: `${choice.label} (not connected)` });
  return { options, value: choice.id };
}

/** A host's own voice, for the Voice section: the desktop app's, and the controller page's in a desktop browser. */
export interface VoiceSettings {
  state(): VoiceSettingsState;
  /** Calls `changed` whenever the state moves; returns how to stop. */
  subscribe(changed: () => void): () => void;
  setListening(on: boolean): void;
  setSpeak(on: boolean): void;
  /** The talk key, by name; resolves with it as the shell reads it, rejects with why it could not be had. Absent on a host with no key held outside its window: a page in a browser. */
  setTalkKey?(accelerator: string): Promise<string>;
  /** Asks for the microphone again. */
  retry(): Promise<void>;
  /** Listens on the microphone with this id from `mics`, or on the system's default for `""`. */
  setMic?(id: string): Promise<void>;
  /** Lists the microphones again: the section is open, and devices may have come and gone. */
  listMics?(): void;
}

/** What the host shows of itself as a paired device: a browser on another computer. */
export interface DeviceSettingsState {
  /** What the device is called on the node. */
  name: string;
  /** Where it reaches the node, as the address bar says it, and whether it does now. */
  address: string;
  connected: boolean;
  /** When its access ends by itself. */
  expiresAt?: number;
  /** A shared computer's: nothing is kept here, and the access ends when the tab closes. */
  session?: boolean;
  /** The browser offers to install the page as an app of its own, now. */
  installable?: boolean;
}

/** The host as the paired device it is: what it says of itself, and how it is forgotten. */
export interface DeviceSettings {
  state(): DeviceSettingsState;
  /** Calls `changed` whenever the state moves; returns how to stop. */
  subscribe?(changed: () => void): () => void;
  /** Ends this device's access on the node and drops what it kept here. */
  forget(): Promise<void>;
  /** Has the browser ask whether to install the page as an app of its own. */
  install?(): Promise<void>;
}

/** When a device's access ends, in words. */
export function deviceEnds(d: DeviceSettingsState, now: number = Date.now(), locale?: string): string {
  if (d.session) {
    const by = d.expiresAt !== undefined ? `, and by ${new Date(d.expiresAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })} at the latest` : "";
    return `This is a shared computer: nothing is kept here, and its access ends when this tab closes${by}.`;
  }
  if (d.expiresAt === undefined) return "Its access has no end: it lasts until it is forgotten here or removed on the node.";
  const days = Math.ceil((d.expiresAt - now) / 86_400_000);
  const on = new Date(d.expiresAt).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
  if (days <= 0) return "Its access has ended.";
  return `Its access ends on ${on} (${days === 1 ? "tomorrow at the latest" : `in ${days} days`}). Pair it again then, from a device that is already in.`;
}

export interface SettingsPanelDeps {
  /** The host's own connection. */
  request: SettingsRequest;
  /** The host's own voice, when it has a microphone: the Voice page shows its switches. */
  voice?: VoiceSettings;
  /** The host as a paired device of its own, when it is one: its page shows last. */
  device?: DeviceSettings;
  /** Checking for a new Cophyla by hand, on a host that can: the Updates page. */
  updates?: UpdateChecker;
  /** Where the layer goes; the page's body when absent. */
  root?: HTMLElement;
  /** Where the focus goes once the layer closes: the view's frame. */
  refocus?: () => void;
  /** Opens a web page in the user's browser: a licence's link. A new window when absent. */
  openLink?: (url: string) => Promise<void>;
  /** Hears the layer open and close: what the host lays over the page goes under it meanwhile. */
  onToggle?: (open: boolean) => void;
}

/** The pages of the settings, in the order the side list shows them. */
export type SettingsPage = "sessions" | "accounts" | "usage" | "chat" | "voice" | "listeners" | "updates" | "device";

const PAGES: readonly SettingsPage[] = ["sessions", "accounts", "usage", "chat", "voice", "listeners", "updates", "device"];

/** Whether a page a view asked for (`host.settings` `page`) is one of these. */
export function isSettingsPage(page: unknown): page is SettingsPage {
  return typeof page === "string" && (PAGES as readonly string[]).includes(page);
}

export interface PageEntry {
  id: SettingsPage;
  label: string;
  /** The line under the page's title: what is set there. */
  lead: string;
}

/** The pages a host shows: every one, Updates on a host that can check, and the paired device's only on a host that is one. */
export function settingsPages(o: { device: boolean; microphone: boolean; updates?: boolean }): PageEntry[] {
  const pages: PageEntry[] = [
    { id: "sessions", label: "Sessions", lead: "Which of your agent sessions Cophyla connects to. A session that is not connected stays out of its lists, its chat and other agents' messages, and asks its questions in its own window." },
    { id: "accounts", label: "Accounts", lead: "The accounts sessions start under, and how Cophyla starts them. It uses the usual account, and another signed-in one only when that one nears its limit." },
    {
      id: "usage",
      label: "Usage",
      lead: "Where your agents' spend went, priced at API list prices. Your plans charge by limits, not dollars, so read a dollar as how fast a limit drains. Click any bar, legend entry or session to look at it alone.",
    },
    { id: "chat", label: "Chat", lead: "The chat runs in an agent session of your own, on your Claude Code or Codex plan: Cophyla starts it, gives it its tools and wakes it." },
    {
      id: "voice",
      label: "Voice",
      lead: o.microphone ? "Say a wake word, or hold the talk key, and Cophyla listens: what you say is transcribed and answered as if you had typed it." : "How Cophyla hears you and reads its replies out when you talk to it.",
    },
    { id: "listeners", label: "Listeners", lead: "What wakes Cophyla besides your messages: what it set itself to hear when you asked, and the agents it started. Each wake-up is a model call." },
  ];
  if (o.updates) pages.push({ id: "updates", label: "Updates", lead: "Cophyla reads its release feed every hour and gets a new version ready by itself. Check now to get one at once." });
  if (o.device) pages.push({ id: "device", label: "This browser", lead: "This page is paired with the node as a device of its own. What it may do was decided where it was added, and ends by itself." });
  return pages;
}

const STATUS_TONE: Record<HarnessProfile["status"], "ok" | "warn"> = { ok: "ok", unauthenticated: "warn", missing: "warn" };

/** The layer itself: opened by `host.settings`, a side list of pages and the page picked, drawn from a `SettingsModel` and a `ScopeModel`. */
export class SettingsPanel {
  private deps: SettingsPanelDeps;
  private layer?: HTMLElement;
  private model?: SettingsModel;
  private scope?: ScopeModel;
  private usage?: UsageModel;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  /** The usage chart is drawn for the page's width: a resize draws it again. */
  private onResize = (): void => {
    if (this.page !== "usage") return;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.render(), 120);
  };
  /** The page showing; the one left open last time when the layer opens again. */
  private page: SettingsPage = "sessions";
  /** The machine the Sessions and Accounts pages show, when there are several. */
  private machine?: string;
  /** Folder fields as typed, by machine and list. */
  private folderDrafts: FolderDrafts = new Map();
  /** Launch options unfolded, by profile. */
  private launchOpen = new Set<string>();
  /** The talk key as typed and not yet set, and why the last one could not be. */
  private keyDraft?: string;
  private keyNote = "";
  /** A vendor's key as typed and not yet saved; dropped the moment it is sent. */
  private apiKeyDrafts = new Map<ProviderKeyName, string>();
  /** Forget was pressed once: the next press does it. */
  private forgetAsked = false;
  private forgetNote = "";
  private unsubscribe?: () => void;
  private unsubscribeDevice?: () => void;
  private unsubscribeUpdates?: () => void;
  private onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") this.close();
  };

  constructor(deps: SettingsPanelDeps) {
    this.deps = deps;
  }

  get isOpen(): boolean {
    return this.layer !== undefined;
  }

  /** Shows the layer, at `page` when one is asked for, and reads what there is; open already, it shows that page or takes the focus. */
  open(page?: SettingsPage): void {
    if (this.layer) {
      if (page) this.show(page);
      else this.layer.querySelector<HTMLElement>(".host-settings-close")?.focus();
      return;
    }
    if (page) this.page = page;
    const layer = el("div", "host-settings");
    layer.addEventListener("click", (ev) => {
      if (ev.target === layer) this.close();
    });
    const card = el("div", "host-settings-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "host-settings-title");
    const title = el("h2", "host-settings-title", "Settings");
    title.id = "host-settings-title";
    const list = el("div", "host-settings-nav-list");
    list.setAttribute("role", "tablist");
    list.setAttribute("aria-orientation", "vertical");
    list.addEventListener("keydown", (ev) => this.navKey(ev));
    const nav = el("nav", "host-settings-nav", title, list);
    nav.setAttribute("aria-label", "Settings pages");
    const close = button("close", "✕", "quiet", () => this.close(), { title: "Close" });
    close.classList.add("host-settings-close");
    close.setAttribute("aria-label", "Close settings");
    const pageTitle = el("h2", "host-settings-page-title");
    pageTitle.id = "host-settings-page-title";
    const body = el("div", "host-settings-page");
    body.setAttribute("role", "tabpanel");
    body.setAttribute("aria-labelledby", "host-settings-page-title");
    const main = el("div", "host-settings-main", el("div", "host-settings-main-head", pageTitle, close), body);
    card.append(nav, main);
    layer.append(card);
    (this.deps.root ?? document.body).append(layer);
    this.layer = layer;
    const model = new SettingsModel(this.deps.request, () => {
      if (this.model === model) this.render();
    });
    this.model = model;
    const scope = new ScopeModel(this.deps.request, () => {
      if (this.scope === scope) this.render();
    }, { autosave: true });
    this.scope = scope;
    const usage = new UsageModel(this.deps.request, () => {
      if (this.usage === usage) this.render();
    });
    this.usage = usage;
    document.addEventListener("keydown", this.onKey);
    window.addEventListener("resize", this.onResize);
    this.unsubscribe = this.deps.voice?.subscribe(() => this.render());
    this.unsubscribeDevice = this.deps.device?.subscribe?.(() => this.render());
    this.unsubscribeUpdates = this.deps.updates?.subscribe(() => this.render());
    this.deps.voice?.listMics?.();
    if ((this.page === "device" && !this.deps.device) || (this.page === "updates" && !this.deps.updates)) this.page = "sessions";
    this.render();
    layer.querySelector<HTMLElement>(`[data-page="${this.page}"]`)?.focus();
    this.deps.onToggle?.(true);
    void model.load();
    void model.loadSpeech();
    void model.loadListeners();
    void model.loadChat();
    void scope.load();
    if (this.page === "usage") void usage.load();
  }

  close(): void {
    if (!this.layer) return;
    this.layer.remove();
    this.layer = undefined;
    this.model?.dispose();
    this.model = undefined;
    this.scope = undefined;
    this.usage?.dispose();
    this.usage = undefined;
    clearTimeout(this.resizeTimer);
    window.removeEventListener("resize", this.onResize);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeDevice?.();
    this.unsubscribeDevice = undefined;
    this.unsubscribeUpdates?.();
    this.unsubscribeUpdates = undefined;
    this.forgetAsked = false;
    this.forgetNote = "";
    this.keyDraft = undefined;
    this.keyNote = "";
    this.apiKeyDrafts.clear();
    this.folderDrafts.clear();
    document.removeEventListener("keydown", this.onKey);
    this.deps.onToggle?.(false);
    this.deps.refocus?.();
  }

  /** Another page: drawn at once, scrolled to its top. */
  show(page: SettingsPage): void {
    if (this.page === page) return;
    this.page = page;
    if (page === "usage" && this.usage && !this.usage.loaded) void this.usage.load();
    this.render();
    const body = this.layer?.querySelector<HTMLElement>(".host-settings-page");
    if (body) body.scrollTop = 0;
  }

  /** Up and down move along the side list, Home and End to its ends; the page follows the focus. */
  private navKey(ev: KeyboardEvent): void {
    const items = [...(this.layer?.querySelectorAll<HTMLElement>(".host-settings-nav-item") ?? [])];
    const at = items.findIndex((i) => i === document.activeElement);
    if (at < 0) return;
    const next = ev.key === "ArrowDown" || ev.key === "ArrowRight" ? at + 1 : ev.key === "ArrowUp" || ev.key === "ArrowLeft" ? at - 1 : ev.key === "Home" ? 0 : ev.key === "End" ? items.length - 1 : undefined;
    if (next === undefined) return;
    ev.preventDefault();
    const item = items[(next + items.length) % items.length]!;
    this.show(item.dataset["page"] as SettingsPage);
    this.layer?.querySelector<HTMLElement>(`[data-page="${item.dataset["page"]}"]`)?.focus();
  }

  /** Draws the side list and the page showing, keeping the focus, the caret and the scroll where they were. */
  private render(): void {
    const layer = this.layer;
    const model = this.model;
    if (!layer || !model) return;
    const pages = settingsPages({ device: this.deps.device !== undefined, microphone: this.deps.voice !== undefined, updates: this.deps.updates !== undefined });
    const entry = pages.find((p) => p.id === this.page) ?? pages[0]!;
    const body = layer.querySelector<HTMLElement>(".host-settings-page")!;
    const scrolled = body.scrollTop;
    keepFocus(layer, () => {
      const list = layer.querySelector<HTMLElement>(".host-settings-nav-list")!;
      list.replaceChildren(
        ...pages.map((p) => {
          const item = el("button", "host-settings-nav-item", p.label);
          item.type = "button";
          item.dataset["page"] = p.id;
          item.dataset["focus"] = `nav:${p.id}`;
          item.setAttribute("role", "tab");
          item.setAttribute("aria-selected", String(p.id === entry.id));
          item.tabIndex = p.id === entry.id ? 0 : -1;
          item.addEventListener("click", () => this.show(p.id));
          return item;
        }),
      );
      layer.querySelector<HTMLElement>(".host-settings-page-title")!.textContent = entry.label;
      layer.querySelector<HTMLElement>(".host-settings-card")!.dataset["page"] = entry.id;
      body.dataset["page"] = entry.id;
      body.replaceChildren(el("p", "host-settings-page-lead", entry.lead), ...this.pageBody(entry.id, model));
    });
    body.scrollTop = scrolled;
  }

  private pageBody(page: SettingsPage, model: SettingsModel): HTMLElement[] {
    switch (page) {
      case "sessions":
        return this.sessionsPage();
      case "accounts":
        return this.accountsPage(model);
      case "usage":
        return this.usage ? usagePage(this.usage, { width: this.pageWidth() }) : [];
      case "chat":
        return this.chatPage(model);
      case "voice":
        return this.voicePage(model);
      case "listeners":
        return this.listenersPage(model);
      case "updates":
        return this.deps.updates ? this.updatesPage(this.deps.updates) : [];
      case "device":
        return this.deps.device ? this.devicePage(this.deps.device) : [];
    }
  }

  /** How wide the page's content is: the body less its padding, for what is drawn to a width. */
  private pageWidth(): number {
    const body = this.layer?.querySelector<HTMLElement>(".host-settings-page");
    if (!body) return 640;
    const css = getComputedStyle(body);
    return Math.max(260, body.clientWidth - parseFloat(css.paddingLeft || "0") - parseFloat(css.paddingRight || "0"));
  }

  /** A choice of machine above a page that shows one at a time, when there are several. */
  private machinePicker(machines: { node: string; name: string }[], current: string): HTMLElement | undefined {
    if (machines.length < 2) return undefined;
    return group(undefined, [
      row({
        label: "Machine",
        help: "Each machine keeps its own.",
        for: controlId("machine"),
        control: select("machine", "Machine", current, machines.map((m) => ({ value: m.node, label: m.name })), (v) => {
          this.machine = v;
          this.render();
        }),
      }),
    ]);
  }

  // --- Sessions -------------------------------------------------------------------------

  private sessionsPage(): HTMLElement[] {
    const scope = this.scope;
    if (!scope) return [];
    if (scope.note) return [el("p", scope.note === "Loading…" ? "host-settings-page-note is-quiet" : "host-settings-page-note", scope.note)];
    const machines = scope.machines();
    const m = machines.find((x) => x.node === this.machine) ?? machines[0];
    if (!m) return [];
    return [
      ...[this.machinePicker(machines, m.node)].filter((x): x is HTMLElement => x !== undefined),
      ...scopeControls(m, { model: scope, drafts: this.folderDrafts, redraw: () => this.render() }),
      el("p", "host-settings-page-foot", m.busy ? "Saving…" : "Sessions Cophyla starts itself are always connected. Changes apply at once."),
    ];
  }

  // --- Accounts -------------------------------------------------------------------------

  private accountsPage(model: SettingsModel): HTMLElement[] {
    const sections = model.sections();
    if (model.note) return [el("p", model.note === "Loading…" ? "host-settings-page-note is-quiet" : "host-settings-page-note", model.note)];
    const m = sections.find((s) => s.node === this.machine) ?? sections[0];
    if (!m) return [];
    const out: HTMLElement[] = [];
    const picker = this.machinePicker(sections, m.node);
    if (picker) out.push(picker);
    for (const h of m.harnesses) out.push(group(HARNESS_NAMES[h.harness] ?? h.label, [this.usual(h.usual, model), ...h.profiles.map((p) => this.account(p, model))]));
    return out;
  }

  private usual(r: UsualRow, model: SettingsModel): HTMLElement {
    return row({
      label: "Usual account",
      help: "What sessions Cophyla starts use, unless it is near its limit.",
      for: controlId(r.key),
      control: select(r.key, "Usual account", r.value, r.options, (v) => void model.setUsual(r.node, r.harness, v), r.busy),
      ...(r.note ? { note: r.note } : {}),
    });
  }

  private account(p: ProfileRow, model: SettingsModel): HTMLElement {
    const name = span("host-settings-account-name", p.name);
    name.title = p.configDir;
    const head = el("div", "host-settings-account-head", name, p.usual ? pill("Usual", "accent") : undefined, pill(p.signedIn, STATUS_TONE[p.status]));
    const card = block(head, el("p", "host-settings-row-help host-settings-mono", p.configDir), el("p", "host-settings-row-help", p.usage));
    card.dataset["profile"] = p.id;
    if (p.launch) card.append(this.launch(p, p.launch, model));
    return card;
  }

  private launch(p: ProfileRow, l: LaunchRow, model: SettingsModel): HTMLElement {
    const more = el("details", "host-settings-disclosure is-inline");
    more.open = this.launchOpen.has(p.id) || l.dirty || l.note !== undefined;
    more.addEventListener("toggle", () => {
      if (more.open) this.launchOpen.add(p.id);
      else this.launchOpen.delete(p.id);
    });
    const summary = el("summary", "", "Launch options");
    summary.dataset["focus"] = `${launchKey(p.id)}:more`;
    const mode = select(`${launchKey(p.id)}:mode`, "Permission mode", l.mode, [...LAUNCH_MODES, ...(l.extraMode ? [l.extraMode] : [])], () => edited(), l.busy);
    const flags = el("input", "host-settings-input host-settings-mono");
    flags.type = "text";
    flags.spellcheck = false;
    flags.autocomplete = "off";
    flags.placeholder = "Other flags, e.g. --effort high --add-dir ../lib";
    flags.setAttribute("aria-label", "Other flags");
    flags.dataset["focus"] = `${launchKey(p.id)}:flags`;
    flags.value = l.flags;
    flags.disabled = l.busy;
    const save = button(`${launchKey(p.id)}:save`, l.busy ? "Saving…" : "Save", "primary", () => void model.saveLaunch(p.id), { disabled: !l.dirty || l.busy });
    const reset = button(`${launchKey(p.id)}:reset`, "Reset", "quiet", () => void model.resetLaunch(p.id), { disabled: l.busy, hidden: !l.reset, title: "Forget what was set here: config.toml's flags, or your own last session's, are used again" });
    const edited = (): void => {
      model.edit(p.id, { mode: mode.value, flags: flags.value });
      const now = model.sections().flatMap((m) => m.harnesses.flatMap((h) => h.profiles)).find((x) => x.id === p.id)?.launch;
      save.disabled = !now?.dirty;
    };
    flags.addEventListener("input", edited);
    flags.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !save.disabled) void model.saveLaunch(p.id);
    });
    more.append(
      summary,
      el("p", "host-settings-row-help", "What a session Cophyla starts under this account is started with."),
      el("div", "host-settings-inline", mode, flags),
      el("div", "host-settings-inline is-end", el("span", "host-settings-row-help", l.source), reset, save),
    );
    if (l.note) more.append(el("p", "host-settings-row-note", l.note));
    return more;
  }

  // --- Chat -----------------------------------------------------------------------------

  private chatPage(model: SettingsModel): HTMLElement[] {
    const r = model.chatRow();
    if (!r) return [el("p", model.chatRead ? "host-settings-page-note" : "host-settings-page-note is-quiet", model.chatRead ? "This Cophyla runs no chat agent of its own: update it to choose where the chat runs." : "Loading…")];
    const restart = button("chat:restart", r.busy ? "Working…" : "Restart", "secondary", () => void model.restartChat(), { disabled: r.busy || !r.restartable, title: "End the agent session the chat runs in and start it again, with the conversation it had" });
    return [
      group(undefined, [
        row({ label: "Chat agent", help: r.runs ?? "Not running yet.", control: [pill(r.status, r.trouble ? "warn" : r.status === "Off" ? "off" : "ok"), restart], ...(r.detail ? { note: r.detail, trouble: r.trouble } : {}) }),
        row({ label: "Runs on", help: "Changing it starts the chat with a fresh context.", for: controlId("chat:harness"), control: select("chat:harness", "Runs on", r.harness.value, r.harness.options, (v) => void model.setChatHarness(v as "" | AssistantHarness), r.busy) }),
        row({ label: "Account", help: "A signed-in account of that harness.", for: controlId("chat:account"), control: select("chat:account", "Account", r.account.value, r.account.options, (v) => void model.setChatAccount(v), r.busy), ...(r.note ? { note: r.note } : {}) }),
      ]),
    ];
  }

  // --- Voice ----------------------------------------------------------------------------

  private voicePage(model: SettingsModel): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (this.deps.voice) out.push(this.microphone(this.deps.voice));
    const wake = model.wakeRow();
    if (wake) out.push(this.wake(wake, model));
    const stt = model.sttRow();
    if (stt) out.push(group("Transcription", this.engine(stt, model)));
    const speech = model.speechRow();
    if (speech) out.push(group("Spoken replies", this.engine(speech, model)));
    const keys = model.keyRows();
    if (keys.length > 0) out.push(group("Your keys", keys.map((k) => this.key(k, model)), "Your own keys, for the online engines and the assistant's model. Only where each comes from and its last four characters show."));
    if (!speech && !this.deps.voice) out.push(el("p", model.speechRead ? "host-settings-page-note" : "host-settings-page-note is-quiet", model.speechRead ? "This Cophyla cannot say how it speaks: update it to choose its engines." : "Loading…"));
    return out;
  }

  /** The host's own microphone: what it is doing, which one, the two switches and the talk key. */
  private microphone(voice: VoiceSettings): HTMLElement {
    const v = voice.state();
    const setTalkKey = voice.setTalkKey?.bind(voice);
    // A name heard by two heads (said two ways) is named once.
    const words = v.phrases.length > 0 ? [...new Set(v.phrases.map(titleCase))].map((p) => `“${p}”`).join(", ") : "the wake words";
    const rows: (HTMLElement | undefined)[] = [
      v.micError
        ? row({ label: "The microphone is off", help: v.micError, control: button("voice:retry", "Try again", "secondary", () => void voice.retry().catch(() => {})), trouble: true })
        : row({ label: "Status", help: v.status }),
    ];
    if (voice.setMic) {
      const { options, value } = micOptions(v);
      const mic = select("voice:mic", "Microphone", value, options, (id) => void voice.setMic?.(id).catch(() => {}));
      mic.title = v.mic ? `Listening on ${v.mic}` : "No microphone is on";
      rows.push(row({ label: "Microphone", ...(v.micNote ? { help: v.micNote } : {}), for: controlId("voice:mic"), control: mic }));
    }
    rows.push(
      row({ label: `Listen for ${words}`, help: "Cophyla starts listening when it hears one.", for: controlId("voice:listen"), control: switchInput("voice:listen", `Listen for ${words}`, v.listening, (on) => voice.setListening(on)) }),
      row({ label: "Speak replies", help: "Answers to what you say aloud are read out.", for: controlId("voice:speak"), control: switchInput("voice:speak", "Speak replies", v.speak, (on) => voice.setSpeak(on)) }),
    );
    // The talk key is held outside the window, which only a host with a shell can arrange.
    if (setTalkKey) rows.push(this.talkKey(setTalkKey, v));
    return group("Microphone", rows);
  }

  /** The talk key: what is held, and Set. */
  private talkKey(setTalkKey: (accelerator: string) => Promise<string>, v: VoiceSettingsState): HTMLElement {
    const input = el("input", "host-settings-input host-settings-key-input");
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.placeholder = "No talk key";
    input.setAttribute("aria-label", "Talk key");
    input.dataset["focus"] = "voice:key";
    input.id = controlId("voice:key");
    input.value = this.keyDraft ?? v.talkKey;
    const set = (): void => {
      setTalkKey(input.value).then(
        () => {
          this.keyDraft = undefined;
          this.keyNote = "";
          this.render();
        },
        (e: unknown) => {
          this.keyNote = message(e).replace(/^(invalid|unavailable): /, "");
          this.render();
        },
      );
    };
    const save = button("voice:key:set", "Set", "secondary", set, { disabled: this.keyDraft === undefined || this.keyDraft.trim() === v.talkKey });
    input.addEventListener("input", () => {
      this.keyDraft = input.value;
      save.disabled = input.value.trim() === v.talkKey;
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !save.disabled) set();
    });
    return row({ label: "Hold to talk", help: "Held anywhere, even with Cophyla behind other windows. For example Ctrl+Shift+Space; empty for none.", for: input.id, control: [input, save], ...(this.keyNote ? { note: this.keyNote } : {}) });
  }

  /** The node's wake words: a box each, what listens in words, where the pick came from and Reset. */
  private wake(r: WakeRow, model: SettingsModel): HTMLElement {
    const reset = button("wake:reset", "Reset", "quiet", () => void model.resetWake(), { disabled: r.busy, hidden: !r.reset, title: "Forget what was picked here: config.toml's wake words are used again" });
    const rows: HTMLElement[] = r.choices.map((c) => {
      const line = checkRow(`wake:${c.head}`, c.label, c.on, (on) => void model.setWake(c.head, on), { ...(c.sound ? { aside: `said ${c.sound}` } : {}), disabled: r.busy });
      line.dataset["head"] = c.head;
      return line;
    });
    rows.push(row({ label: r.status, help: r.source, control: reset, ...(r.note ? { note: r.note } : {}) }));
    const g = group("Wake words", rows);
    if (r.trouble) g.classList.add("is-trouble");
    return g;
  }

  /** One stage's engine: the pick, its status and where it came from, its voice, speed and a sample for speech, where it goes online, and an install for one not here. */
  private engine(r: SpeechRow, model: SettingsModel): HTMLElement[] {
    const tts = r.stage === "tts";
    const rows: HTMLElement[] = [];
    const reset = button(`${r.stage}:reset`, "Reset", "quiet", () => void (tts ? model.setEngine(null) : model.setStt(null)), {
      disabled: r.busy,
      hidden: !r.reset,
      title: tts ? "Forget what was picked here: config.toml's engine and voice are used again" : "Forget what was picked here: config.toml's engine is used again",
    });
    const pick = select(`${r.stage}:engine`, tts ? "Speech engine" : "Transcription engine", r.engine, r.options, (v) => void (tts ? model.setEngine(v as TtsEngineId) : model.setStt(v as SttEngineId)), r.busy);
    rows.push(row({ label: "Engine", help: [r.detail, r.source].filter(Boolean).join(" "), for: pick.id, control: [pick, reset] }));
    // Green only for an engine that is up: one not installed, turned off or still loading is grey.
    rows.push(statusRow(r.status, r.trouble ? "trouble" : r.install || r.engine === "off" || r.status.endsWith("…") ? "idle" : "ok"));
    if (r.voices !== undefined) {
      const voice = el("input", "host-settings-input host-settings-number");
      voice.type = "number";
      voice.min = "1";
      voice.max = String(r.voices);
      voice.step = "1";
      voice.value = String(r.voice ?? 1);
      voice.dataset["focus"] = "speech:voice";
      voice.id = controlId("speech:voice");
      voice.setAttribute("aria-label", `Voice, 1 to ${r.voices}`);
      voice.disabled = r.busy;
      voice.addEventListener("change", () => void model.setVoice(Number(voice.value)));
      rows.push(row({ label: "Voice", help: `One of ${r.voices}.`, for: voice.id, control: voice }));
    }
    if (r.speeds !== undefined) rows.push(row({ label: "Speed", help: "How fast replies are read, whichever engine reads them.", for: controlId("speech:speed"), control: select("speech:speed", "Speed", String(r.speed), r.speeds, (v) => void model.setSpeed(Number(v)), r.busy) }));
    if (tts && !r.install) rows.push(row({ label: "Hear it", help: "A line in the voice set now.", control: button("speech:hear", "Play a sample", "secondary", () => void model.preview(), { disabled: !r.canPreview || r.busy }) }));
    if (r.route) {
      const route = r.route;
      rows.push(row({ label: "Goes through", help: route.detail, for: controlId(`${r.stage}:route`), control: select(`${r.stage}:route`, tts ? "Where speech goes" : "Where transcription goes", route.value, route.options, (v) => void model.setRoute(r.stage, v as VoiceRoute), r.busy), ...(route.trouble ? { note: route.detail, trouble: true } : {}) }));
    }
    if (r.install) rows.push(this.install(r, r.install, model));
    if (r.note) rows.push(el("p", "host-settings-row-note host-settings-row-alone", r.note));
    return rows;
  }

  /** What a local engine not installed comes under, each licence a link, and the button that installs it. */
  private install(r: SpeechRow, install: InstallRow, model: SettingsModel): HTMLElement {
    const list = el("ul", "host-settings-licences");
    for (const l of install.licences) {
      const link = el("a", "", l.name);
      link.href = l.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        if (this.deps.openLink) void this.deps.openLink(l.url).catch(() => {});
        else window.open(l.url, "_blank", "noopener");
      });
      list.append(el("li", "", link, ` — ${l.covers}`));
    }
    const go = button(`${r.stage}:install`, install.progress ? "Installing…" : `Install (${megabytes(install.bytes)})`, "primary", () => void model.install(r.engine, r.stage), { disabled: r.busy });
    return block(
      el("p", "host-settings-row-help", "Cophyla does not ship this engine. Installing downloads it to this computer from where its makers publish it, under these licences:"),
      list,
      el("div", "host-settings-inline is-end", install.progress ? el("span", "host-settings-row-help", install.progress) : undefined, go),
      install.error ? el("p", "host-settings-row-note", install.error) : undefined,
    );
  }

  /** A vendor's key: where it comes from, a field to give one, saved with Save or Enter and gone from the field as it is sent, and Clear for one given here. */
  private key(r: KeyRow, model: SettingsModel): HTMLElement {
    const input = el("input", "host-settings-input host-settings-mono host-settings-key-input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = r.clearable ? "Replace the key" : "Paste a key";
    input.setAttribute("aria-label", r.label);
    input.dataset["focus"] = `key:${r.provider}`;
    input.id = controlId(`key:${r.provider}`);
    input.value = this.apiKeyDrafts.get(r.provider) ?? "";
    input.disabled = r.busy;
    const send = (): void => {
      const typed = input.value;
      this.apiKeyDrafts.delete(r.provider);
      input.value = "";
      save.disabled = true;
      void model.setKey(r.provider, typed);
    };
    const save = button(`key:${r.provider}:save`, r.busy ? "Saving…" : "Save", "secondary", send, { disabled: r.busy || input.value.trim() === "" });
    const clear = button(`key:${r.provider}:clear`, "Clear", "quiet", () => void model.setKey(r.provider, null), { disabled: r.busy, hidden: !r.clearable, title: "Forget the key given here: config.toml's or the environment's is used again" });
    input.addEventListener("input", () => {
      if (input.value === "") this.apiKeyDrafts.delete(r.provider);
      else this.apiKeyDrafts.set(r.provider, input.value);
      save.disabled = input.value.trim() === "";
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !save.disabled) send();
    });
    const line = row({ label: r.label, help: `${r.status} ${r.detail}`, for: input.id, control: [input, save, clear], ...(r.note ? { note: r.note } : {}) });
    line.dataset["provider"] = r.provider;
    return line;
  }

  // --- Listeners ------------------------------------------------------------------------

  private listenersPage(model: SettingsModel): HTMLElement[] {
    const listeners = model.listeners;
    if (!listeners) return [el("p", model.listenersRead ? "host-settings-page-note" : "host-settings-page-note is-quiet", model.listenersRead ? "This Cophyla keeps no listeners: update it to see them here." : "Loading…")];
    if (listeners.length === 0) return [group(undefined, [el("div", "host-settings-row host-settings-row-empty", "Only your messages wake Cophyla.")])];
    return [
      group(
        undefined,
        listeners.map((l) => {
          const removing = model.removing.has(l.id);
          const r = row({ label: l.why, help: listenerLine(l), control: button(`listener:${l.id}`, removing ? "Removing…" : "Remove", "danger", () => void model.removeListener(l.id), { disabled: removing }), ...(model.listenerNotes.get(l.id) ? { note: model.listenerNotes.get(l.id)! } : {}) });
          r.dataset["listener"] = l.id;
          return r;
        }),
      ),
    ];
  }

  // --- Updates --------------------------------------------------------------------------

  /** The version that runs, Check for updates and what it found, and Update now once a release is ready. */
  private updatesPage(u: UpdateChecker): HTMLElement[] {
    const current = u.current();
    const state = u.platform();
    const now = outcomeOf(state, current);
    const check = button("updates:check", u.checking ? "Checking…" : "Check for updates", "secondary", () => void u.check(), { disabled: u.checking });
    const rows: (HTMLElement | undefined)[] = [row({ label: "This version", help: current ? `Cophyla ${current}` : "Not known yet", control: check })];
    // what the last check here said, or what the node has found by itself since
    const shown = now.kind === "found" ? now : u.last;
    // a ready release has its own row below, with Update now
    if (shown && !(shown.kind === "found" && shown.ready)) {
      const words = checkWords(shown);
      rows.push(statusRow(`${words.title}. ${words.detail}`, shown.kind === "failed" ? "trouble" : shown.kind === "found" && shown.ready ? "ok" : "idle"));
    }
    if (now.kind === "found" && now.ready) {
      const waiting = state?.waiting && state.waiting.length > 0 ? `It restarts once these finish: ${state.waiting.join(", ")}.` : "";
      const restarting = state?.restarting === true;
      const apply = button("updates:apply", restarting ? "Restarting…" : u.applying ? "Waiting…" : "Update now", "primary", () => void u.apply(), { disabled: u.applying || restarting });
      rows.push(row({ label: `Cophyla ${now.version}`, help: "Cophyla restarts into it as soon as nothing waits on it: an open question, or a turn under way.", control: apply, ...(waiting || u.applyNote ? { note: waiting || u.applyNote } : {}) }));
    }
    return [group(undefined, rows)];
  }

  // --- This browser ---------------------------------------------------------------------

  /** The host as the paired device it is: its name, where it is connected, when its access ends, Install, and Forget asked twice. */
  private devicePage(device: DeviceSettings): HTMLElement[] {
    const d = device.state();
    const forget = button("device:forget", this.forgetAsked ? "Forget it" : "Forget this browser", "danger", () => {
      if (!this.forgetAsked) {
        this.forgetAsked = true;
        this.render();
        return;
      }
      forget.disabled = true;
      device.forget().then(
        () => this.close(),
        (e: unknown) => {
          this.forgetAsked = false;
          this.forgetNote = message(e);
          this.render();
        },
      );
    }, { title: "End this browser's access on the node and remove what it keeps here" });
    const keep = this.forgetAsked
      ? button("device:keep", "Keep it", "secondary", () => {
          this.forgetAsked = false;
          this.render();
        })
      : undefined;
    const rows: (HTMLElement | undefined)[] = [
      row({ label: d.name, help: `${d.connected ? "Connected to" : "Not connected to"} ${d.address}` }),
      row({ label: "Access", help: deviceEnds(d) }),
    ];
    // Offered while the browser offers it: Cophyla in a window of its own, opened like any app.
    if (d.installable && device.install) {
      const install = button("device:install", "Install as an app", "secondary", () => {
        install.disabled = true;
        void device.install!().catch(() => undefined);
      }, { title: "Cophyla in a window of its own, with its icon, opened from this computer's own menu" });
      rows.push(row({ label: "Keep Cophyla as an app on this computer", control: install }));
    }
    rows.push(
      row({
        label: "Forget this browser",
        help: this.forgetAsked ? "It will have to be paired again, with a new key or code from a device that is already in." : "Ends its access on the node and removes what it keeps here.",
        control: [keep, forget],
        ...(this.forgetNote ? { note: this.forgetNote } : {}),
      }),
    );
    return [group(undefined, rows)];
  }
}

/** A status line with a dot coloured by how it stands. */
function statusRow(text: string, tone: "ok" | "idle" | "trouble"): HTMLElement {
  return el("div", `host-settings-row host-settings-status is-${tone}`, el("span", "host-settings-status-dot"), el("span", "host-settings-status-text", text));
}

/** "hey phyla" → "Hey Phyla": a phrase as it reads in a sentence. */
export function titleCase(phrase: string): string {
  return phrase.replace(/(^|\s)(\p{Ll})/gu, (_m, space: string, ch: string) => space + ch.toUpperCase());
}
