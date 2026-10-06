// The host's settings: a layer over the frame that is the host's own, like the view picker,
// so any view opens the same one by asking `host.settings` and none has to draw it. It is
// made of sections, and more will join. Chat comes first: the chat runs in an agent session
// of the user's own, and the section says where it stands (`assistant.state`), which harness
// and which account it runs on, each left to cophylad or picked (`assistant.configure`, which
// starts it afresh), and has a button that ends it and starts it again where it was
// (`assistant.restart`); a node from before the chat ran so leaves the section out. Then
// Listening for: what wakes Cophyla
// besides the user's messages, the listeners it set with its tools (`listener.list`), each
// with why it listens, on what, how it tells, the fires left and made, and a Remove
// (`listener.remove`); a node from before there were listeners leaves the section out.
// Voice follows on a host with a microphone of its own (the desktop app; the phone keeps
// its switches in its bar's menu): whether it listens
// for the wake words and which ones the node listens for, whether replies are spoken, the
// talk key, which microphone it listens on (the system's default, or one picked, which
// `micOptions` lists), and what is wrong with the microphone when something is. On every host it holds
// the node's wake words, a box each for every phrase its wake model has, ticked for the ones
// that listen (none ticked, only the talk key and the button wake it), with where the pick came
// from and a way back to config.toml's (`voice.configure` `wake`), and the node's engines:
// the one that transcribes and the one that reads replies out
// (`voice.settings`, set with `voice.configure`), the voice, the speed replies are read at,
// where each choice came from with a way back to config.toml's, and Hear it
// (`voice.preview`). An online engine says where it goes first, the account's server (Cophyla
// cloud, on a Pro plan) or the user's own key alone, and the node's Gemini and DeepInfra keys
// show where each comes from and its last four characters, with a field to give one and a
// Clear for one given here (`account.apiKey`); what is typed there is gone from the page once
// it is saved. A local engine the node has not
// installed shows the licences it comes under, each a link, and an Install button with what
// it would download (`voice.install`); nothing is installed unless that is pressed. While an
// engine loads or installs the panel asks again each second, so the status follows it. Then
// Agents. For each machine and harness it
// shows the usual account — Automatic, naming the profile cophylad picks and why, or one the
// user picks — and for each profile its name, whether it is signed in, how much of its
// session and weekly limits it has used (`profile.limits`) and, for a Claude profile, what a
// session cophylad starts under it is started with: a permission mode and other flags, with
// where the launch in use came from (set here, config.toml, or the user's own last session
// there) and a Reset. It reads with the host's own connection and writes with
// `profile.update`. It closes on its ✕, on Escape and on a click outside its card, and says
// what failed beside what failed. `settingsRows`, `chatRow`, `speechRow`, `wakeRow`, `listenerLine` and
// `SettingsModel` are DOM-free; the panel draws them. Its look is `settings.css`, which each
// host page links.

import type { AssistantHarness, AssistantState, HarnessProfile, LaunchMode, Listener, ListenerKind, Node, ProfileLimits, ProviderKeyName, ProviderKeys, ProviderKeyState, SpeechLicence, SttEngineId, TtsEngineId, VoiceRoute, VoiceSettings as SpeechSettings } from "@cophyla/protocol";

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
}

/** The host as the paired device it is: what it says of itself, and how it is forgotten. */
export interface DeviceSettings {
  state(): DeviceSettingsState;
  /** Calls `changed` whenever the state moves; returns how to stop. */
  subscribe?(changed: () => void): () => void;
  /** Ends this device's access on the node and drops what it kept here. */
  forget(): Promise<void>;
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
  /** The host's own voice, when it has a microphone: the Voice section shows. */
  voice?: VoiceSettings;
  /** The host as a paired device of its own, when it is one: its section shows last. */
  device?: DeviceSettings;
  /** Where the layer goes; the page's body when absent. */
  root?: HTMLElement;
  /** Where the focus goes once the layer closes: the view's frame. */
  refocus?: () => void;
  /** Opens a web page in the user's browser: a licence's link. A new window when absent. */
  openLink?: (url: string) => Promise<void>;
  /** Hears the layer open and close: what the host lays over the page goes under it meanwhile. */
  onToggle?: (open: boolean) => void;
}

/** The layer itself: opened by `host.settings`, drawn from a `SettingsModel`. */
export class SettingsPanel {
  private deps: SettingsPanelDeps;
  private layer?: HTMLElement;
  private model?: SettingsModel;
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
  private onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") this.close();
  };

  constructor(deps: SettingsPanelDeps) {
    this.deps = deps;
  }

  get isOpen(): boolean {
    return this.layer !== undefined;
  }

  /** Shows the layer and reads what there is; open already, it only takes the focus. */
  open(): void {
    if (this.layer) {
      this.layer.querySelector<HTMLElement>(".host-settings-close")?.focus();
      return;
    }
    const layer = document.createElement("div");
    layer.className = "host-settings";
    layer.addEventListener("click", (ev) => {
      if (ev.target === layer) this.close();
    });
    const card = document.createElement("div");
    card.className = "host-settings-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "host-settings-title");
    const head = document.createElement("div");
    head.className = "host-settings-head";
    const title = document.createElement("h2");
    title.id = "host-settings-title";
    title.textContent = "Settings";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "host-settings-close";
    close.setAttribute("aria-label", "Close");
    close.title = "Close";
    close.textContent = "✕";
    close.addEventListener("click", () => this.close());
    head.append(title, close);
    const body = document.createElement("div");
    body.className = "host-settings-body";
    card.append(head, body);
    layer.append(card);
    (this.deps.root ?? document.body).append(layer);
    this.layer = layer;
    const model = new SettingsModel(this.deps.request, () => {
      if (this.model === model) this.render();
    });
    this.model = model;
    document.addEventListener("keydown", this.onKey);
    this.unsubscribe = this.deps.voice?.subscribe(() => this.render());
    this.unsubscribeDevice = this.deps.device?.subscribe?.(() => this.render());
    this.deps.voice?.listMics?.();
    this.render();
    close.focus();
    this.deps.onToggle?.(true);
    void model.load();
    void model.loadSpeech();
    void model.loadListeners();
    void model.loadChat();
  }

  close(): void {
    if (!this.layer) return;
    this.layer.remove();
    this.layer = undefined;
    this.model?.dispose();
    this.model = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeDevice?.();
    this.unsubscribeDevice = undefined;
    this.forgetAsked = false;
    this.forgetNote = "";
    this.keyDraft = undefined;
    this.keyNote = "";
    this.apiKeyDrafts.clear();
    document.removeEventListener("keydown", this.onKey);
    this.deps.onToggle?.(false);
    this.deps.refocus?.();
  }

  /** Draws the model anew, keeping the focus (and the caret) where it was. */
  private render(): void {
    const layer = this.layer;
    const model = this.model;
    if (!layer || !model) return;
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active && layer.contains(active) ? active.dataset["focus"] : undefined;
    const caret = active instanceof HTMLInputElement ? ([active.selectionStart, active.selectionEnd] as const) : undefined;
    const body = layer.querySelector<HTMLElement>(".host-settings-body")!;
    const agents = section("Agents", "The accounts sessions start under, and how Cophyla starts them. Cophyla uses the usual account, and another signed-in one only when it is near its limit.");
    const note = paragraph("host-settings-note", model.note);
    note.hidden = model.note === "";
    agents.append(note, ...model.sections().map((m) => this.machine(m, model)));
    const speech = model.speechRow();
    const voice = this.deps.voice
      ? this.voiceSection(this.deps.voice, speech, model)
      : speech
        ? this.speechOnly(speech, model)
        : undefined;
    const listening = model.listeners ? this.listeningSection(model.listeners, model) : undefined;
    const chatRow = model.chatRow();
    const chat = chatRow ? this.chatSection(chatRow, model) : undefined;
    const device = this.deps.device ? this.deviceSection(this.deps.device) : undefined;
    body.replaceChildren(...(chat ? [chat] : []), ...(listening ? [listening] : []), ...(voice ? [voice] : []), agents, ...(device ? [device] : []));
    if (focusKey) {
      const again = layer.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusKey)}"]`);
      again?.focus();
      if (again instanceof HTMLInputElement && caret && caret[0] !== null && caret[1] !== null) again.setSelectionRange(caret[0], caret[1]);
    }
  }

  private chatSection(row: ChatRow, model: SettingsModel): HTMLElement {
    const box = section("Chat", "The chat runs in an agent session of your own, on your Claude Code or Codex plan: Cophyla starts it, gives it its tools and wakes it. Changing where it runs starts it with a fresh context.");
    box.dataset["section"] = "chat";
    const card = document.createElement("div");
    card.className = "host-settings-profile";
    const top = document.createElement("div");
    top.className = "host-settings-profile-top";
    const restart = document.createElement("button");
    restart.type = "button";
    restart.className = "host-settings-reset";
    restart.dataset["focus"] = "chat:restart";
    restart.textContent = row.busy ? "Working…" : "Restart chat agent";
    restart.title = "End the agent session the chat runs in and start it again, with the conversation it had";
    restart.disabled = row.busy || !row.restartable;
    restart.addEventListener("click", () => void model.restartChat());
    top.append(span(`host-settings-state state-${row.trouble ? "unauthenticated" : "ok"}`, row.status), restart);
    card.append(top);
    if (row.runs) card.append(paragraph("host-settings-usage", row.runs));
    if (row.detail) card.append(paragraph(row.trouble ? "host-settings-error" : "host-settings-note", row.detail));
    const pick = (focus: string, label: string, value: string, options: { value: string; label: string }[], set: (value: string) => void): HTMLElement => {
      const line = document.createElement("label");
      line.className = "host-settings-usual";
      const select = document.createElement("select");
      select.dataset["focus"] = focus;
      for (const o of options) select.append(option(o.value, o.label));
      select.value = value;
      select.disabled = row.busy;
      select.addEventListener("change", () => set(select.value));
      line.append(span("host-settings-label", label), select);
      return line;
    };
    card.append(
      pick("chat:harness", "Runs on", row.harness.value, row.harness.options, (v) => void model.setChatHarness(v as "" | AssistantHarness)),
      pick("chat:account", "Account", row.account.value, row.account.options, (v) => void model.setChatAccount(v)),
    );
    if (row.note) card.append(paragraph("host-settings-error", row.note));
    box.append(card);
    return box;
  }

  /** The host as the paired device it is: its name, where it is connected, when its access ends, and Forget, asked twice. */
  private deviceSection(device: DeviceSettings): HTMLElement {
    const d = device.state();
    const box = section("This browser", "This page is paired with the node as a device of its own. What it may do was decided where it was added, and ends by itself.");
    box.dataset["section"] = "device";
    const card = document.createElement("div");
    card.className = "host-settings-profile";
    const top = document.createElement("div");
    top.className = "host-settings-profile-top";
    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "host-settings-reset host-settings-remove";
    forget.dataset["focus"] = "device:forget";
    forget.textContent = this.forgetAsked ? "Forget it" : "Forget this browser";
    forget.title = "End this browser's access on the node and remove what it keeps here";
    forget.addEventListener("click", () => {
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
    });
    top.append(span("host-settings-name", d.name), forget);
    if (this.forgetAsked) {
      const keep = document.createElement("button");
      keep.type = "button";
      keep.className = "host-settings-reset";
      keep.dataset["focus"] = "device:keep";
      keep.textContent = "Keep it";
      keep.addEventListener("click", () => {
        this.forgetAsked = false;
        this.render();
      });
      top.append(keep);
    }
    card.append(top, paragraph("host-settings-usage", `${d.connected ? "Connected to" : "Not connected to"} ${d.address}`), paragraph("host-settings-source", deviceEnds(d)));
    if (this.forgetAsked) card.append(paragraph("host-settings-note", "It will have to be paired again, with a new key or code from a device that is already in."));
    if (this.forgetNote) card.append(paragraph("host-settings-error", this.forgetNote));
    box.append(card);
    return box;
  }

  private listeningSection(listeners: Listener[], model: SettingsModel): HTMLElement {
    const box = section("Listening for", "What wakes Cophyla besides your messages: what it set itself to hear when you asked, and the agents it started. Each fire is a model call.");
    box.dataset["section"] = "listening";
    if (listeners.length === 0) box.append(paragraph("host-settings-note", "Only your messages wake Cophyla."));
    for (const l of listeners) {
      const card = document.createElement("div");
      card.className = "host-settings-profile";
      card.dataset["listener"] = l.id;
      const top = document.createElement("div");
      top.className = "host-settings-profile-top";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "host-settings-reset host-settings-remove";
      remove.dataset["focus"] = `listener:${l.id}`;
      remove.textContent = model.removing.has(l.id) ? "Removing…" : "Remove";
      remove.disabled = model.removing.has(l.id);
      remove.addEventListener("click", () => void model.removeListener(l.id));
      top.append(span("host-settings-name", l.why), remove);
      card.append(top, paragraph("host-settings-usage", listenerLine(l)));
      const note = model.listenerNotes.get(l.id);
      if (note) card.append(paragraph("host-settings-error", note));
      box.append(card);
    }
    return box;
  }

  private voiceSection(voice: VoiceSettings, speech: SpeechRow | undefined, model: SettingsModel): HTMLElement {
    const v = voice.state();
    const setTalkKey = voice.setTalkKey?.bind(voice);
    const box = section("Voice", `Say a wake word, or hold the talk ${setTalkKey ? "key" : "button"}, and Cophyla listens; what you say is transcribed and answered as if you had typed it.`);
    box.dataset["section"] = "voice";
    box.append(paragraph(v.micError ? "host-settings-error" : "host-settings-voice-status", v.micError ? `The microphone is off: ${v.micError}` : v.status));
    if (v.micError) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "host-settings-reset";
      retry.dataset["focus"] = "voice:retry";
      retry.textContent = "Try the microphone again";
      retry.addEventListener("click", () => void voice.retry().catch(() => {}));
      box.append(retry);
    }
    if (voice.setMic) box.append(this.micRow(voice, v));
    if (v.micNote) box.append(paragraph("host-settings-source", v.micNote));
    // A name heard by two heads (said two ways) is named once.
    const words = v.phrases.length > 0 ? [...new Set(v.phrases.map(titleCase))].map((p) => `“${p}”`).join(", ") : "the node's wake words";
    box.append(
      toggle("voice:listen", `Listen for ${words}`, v.listening, (on) => voice.setListening(on)),
      toggle("voice:speak", "Speak the replies to what I say", v.speak, (on) => voice.setSpeak(on)),
    );
    // The talk key is held outside the window, which only a host with a shell can arrange.
    if (setTalkKey) box.append(...this.talkKeyRow(setTalkKey, v));
    const wake = model.wakeRow();
    if (wake) box.append(this.wake(wake, model));
    const stt = model.sttRow();
    if (stt) box.append(this.speech(stt, model));
    if (speech) box.append(this.speech(speech, model));
    const keys = model.keyRows();
    if (keys.length > 0) box.append(this.keys(keys, model));
    return box;
  }

  /** The talk key: what is held, and Set. */
  private talkKeyRow(setTalkKey: (accelerator: string) => Promise<string>, v: VoiceSettingsState): HTMLElement[] {
    const key = document.createElement("div");
    key.className = "host-settings-controls host-settings-talk";
    const input = document.createElement("input");
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.placeholder = "No talk key";
    input.setAttribute("aria-label", "Talk key");
    input.dataset["focus"] = "voice:key";
    input.value = this.keyDraft ?? v.talkKey;
    const save = document.createElement("button");
    save.type = "button";
    save.className = "host-settings-save";
    save.textContent = "Set";
    save.disabled = this.keyDraft === undefined || this.keyDraft.trim() === v.talkKey;
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
    input.addEventListener("input", () => {
      this.keyDraft = input.value;
      save.disabled = input.value.trim() === v.talkKey;
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !save.disabled) set();
    });
    save.addEventListener("click", set);
    key.append(span("host-settings-label", "Hold to talk"), input, save);
    const rows = [key, paragraph("host-settings-source", "Held anywhere, even while Cophyla is behind other windows: it listens until you let go. For example Ctrl+Shift+Space or Ctrl+Shift+F9; empty for none.")];
    if (this.keyNote) rows.push(paragraph("host-settings-error", this.keyNote));
    return rows;
  }

  /** Which microphone the host listens on: the system's default, or one picked. */
  private micRow(voice: VoiceSettings, v: VoiceSettingsState): HTMLElement {
    const line = document.createElement("div");
    line.className = "host-settings-controls host-settings-mic";
    const select = document.createElement("select");
    select.dataset["focus"] = "voice:mic";
    select.setAttribute("aria-label", "Microphone");
    select.title = v.mic ? `Listening on ${v.mic}` : "No microphone is on";
    const { options, value } = micOptions(v);
    for (const o of options) select.append(option(o.value, o.label));
    select.value = value;
    select.addEventListener("change", () => void voice.setMic?.(select.value).catch(() => {}));
    line.append(span("host-settings-label", "Microphone"), select);
    return line;
  }

  /** The Voice section on a host with no microphone of its own: the node's engines alone. */
  private speechOnly(speech: SpeechRow, model: SettingsModel): HTMLElement {
    const box = section("Voice", "How Cophyla hears you and reads its replies out when you talk to it.");
    box.dataset["section"] = "voice";
    const wake = model.wakeRow();
    if (wake) box.append(this.wake(wake, model));
    const stt = model.sttRow();
    if (stt) box.append(this.speech(stt, model));
    box.append(this.speech(speech, model));
    const keys = model.keyRows();
    if (keys.length > 0) box.append(this.keys(keys, model));
    return box;
  }

  /** The node's wake words: a box each, ticked for the ones that listen, with how each is said, what listens, where the pick came from and Reset. */
  private wake(row: WakeRow, model: SettingsModel): HTMLElement {
    const box = document.createElement("div");
    box.className = "host-settings-speech host-settings-wake";
    box.dataset["stage"] = "wake";
    const top = document.createElement("div");
    top.className = "host-settings-controls";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "host-settings-reset";
    reset.dataset["focus"] = "wake:reset";
    reset.textContent = "Reset";
    reset.title = "Forget what was picked here: config.toml's wake words are used again";
    reset.hidden = !row.reset;
    reset.disabled = row.busy;
    reset.addEventListener("click", () => void model.resetWake());
    top.append(span("host-settings-label", "Wake words"), reset);
    box.append(top);
    for (const c of row.choices) {
      const line = document.createElement("label");
      line.className = "host-settings-toggle";
      line.dataset["head"] = c.head;
      const tick = document.createElement("input");
      tick.type = "checkbox";
      tick.checked = c.on;
      tick.disabled = row.busy;
      tick.dataset["focus"] = `wake:${c.head}`;
      tick.addEventListener("change", () => void model.setWake(c.head, tick.checked));
      line.append(tick, span("", c.label));
      if (c.sound) line.append(span("host-settings-sound", `said ${c.sound}`));
      box.append(line);
    }
    box.append(paragraph(row.trouble ? "host-settings-error" : "host-settings-voice-status", row.status), paragraph("host-settings-source", row.source));
    if (row.note) box.append(paragraph("host-settings-error", row.note));
    return box;
  }

  /**
   * The node's own keys: a field each to give one, saved with Save or Enter and gone from the
   * field as it is sent, and Clear for one given here. Only where each comes from and how it
   * ends is shown.
   */
  private keys(rows: KeyRow[], model: SettingsModel): HTMLElement {
    const box = document.createElement("div");
    box.className = "host-settings-speech host-settings-keys";
    box.dataset["stage"] = "keys";
    for (const row of rows) {
      const line = document.createElement("div");
      line.className = "host-settings-controls host-settings-key";
      line.dataset["provider"] = row.provider;
      const input = document.createElement("input");
      input.type = "password";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = row.clearable ? "Replace the key" : "Paste a key";
      input.setAttribute("aria-label", row.label);
      input.dataset["focus"] = `key:${row.provider}`;
      input.value = this.apiKeyDrafts.get(row.provider) ?? "";
      input.disabled = row.busy;
      const save = document.createElement("button");
      save.type = "button";
      save.className = "host-settings-save";
      save.textContent = row.busy ? "Saving…" : "Save";
      save.disabled = row.busy || input.value.trim() === "";
      const send = (): void => {
        const typed = input.value;
        this.apiKeyDrafts.delete(row.provider);
        input.value = "";
        save.disabled = true;
        void model.setKey(row.provider, typed);
      };
      input.addEventListener("input", () => {
        if (input.value === "") this.apiKeyDrafts.delete(row.provider);
        else this.apiKeyDrafts.set(row.provider, input.value);
        save.disabled = input.value.trim() === "";
      });
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !save.disabled) send();
      });
      save.addEventListener("click", send);
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "host-settings-reset";
      clear.dataset["focus"] = `key:${row.provider}:clear`;
      clear.textContent = "Clear";
      clear.title = "Forget the key given here: config.toml's or the environment's is used again";
      clear.hidden = !row.clearable;
      clear.disabled = row.busy;
      clear.addEventListener("click", () => void model.setKey(row.provider, null));
      line.append(span("host-settings-label", row.label), input, save, clear);
      box.append(line, paragraph("host-settings-voice-status", row.status), paragraph("host-settings-source", row.detail));
      if (row.note) box.append(paragraph("host-settings-error", row.note));
    }
    return box;
  }

  /** Where an online engine goes first: the account's server, or the user's own key alone. */
  private route(row: SpeechRow, route: RouteRow, model: SettingsModel): HTMLElement {
    const box = document.createElement("div");
    const line = document.createElement("div");
    line.className = "host-settings-controls host-settings-route";
    const select = document.createElement("select");
    select.dataset["focus"] = `${row.stage}:route`;
    select.setAttribute("aria-label", row.stage === "tts" ? "Where speech goes" : "Where transcription goes");
    for (const o of route.options) select.append(option(o.value, o.label));
    select.value = route.value;
    select.disabled = row.busy;
    select.addEventListener("change", () => void model.setRoute(row.stage, select.value as VoiceRoute));
    line.append(span("host-settings-label", "Goes through"), select);
    box.append(line, paragraph(route.trouble ? "host-settings-error" : "host-settings-source", route.detail));
    return box;
  }

  /** What a local engine not installed comes under, each licence a link, and the button that installs it. */
  private install(row: SpeechRow, install: InstallRow, model: SettingsModel): HTMLElement {
    const box = document.createElement("div");
    box.className = "host-settings-install";
    box.append(paragraph("host-settings-source", "Cophyla does not ship this engine. Installing downloads it to this computer from where its makers publish it, under these licences:"));
    const list = document.createElement("ul");
    list.className = "host-settings-licences";
    for (const l of install.licences) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = l.url;
      link.textContent = l.name;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        if (this.deps.openLink) void this.deps.openLink(l.url).catch(() => {});
        else window.open(l.url, "_blank", "noopener");
      });
      item.append(link, document.createTextNode(` — ${l.covers}`));
      list.append(item);
    }
    box.append(list);
    const go = document.createElement("button");
    go.type = "button";
    go.className = "host-settings-save";
    go.dataset["focus"] = `${row.stage}:install`;
    go.textContent = install.progress ? "Installing…" : `Install (${megabytes(install.bytes)})`;
    go.disabled = row.busy;
    go.addEventListener("click", () => void model.install(row.engine, row.stage));
    box.append(go);
    if (install.progress) box.append(paragraph("host-settings-voice-status", install.progress));
    if (install.error) box.append(paragraph("host-settings-error", install.error));
    return box;
  }

  /** One stage's engine: the one that transcribes, or the one that reads replies out with its voice and Hear it; where the choice came from; and, for one not installed, what installing it means. */
  private speech(row: SpeechRow, model: SettingsModel): HTMLElement {
    const tts = row.stage === "tts";
    const box = document.createElement("div");
    box.className = "host-settings-speech";
    box.dataset["stage"] = row.stage;
    const line = document.createElement("div");
    line.className = "host-settings-controls";
    const engine = document.createElement("select");
    engine.dataset["focus"] = `${row.stage}:engine`;
    engine.setAttribute("aria-label", tts ? "Speech engine" : "Transcription engine");
    for (const o of row.options) engine.append(option(o.value, o.label));
    engine.value = row.engine;
    engine.disabled = row.busy;
    engine.addEventListener("change", () => void (tts ? model.setEngine(engine.value as TtsEngineId) : model.setStt(engine.value as SttEngineId)));
    line.append(span("host-settings-label", tts ? "Reads replies with" : "Transcribes with"), engine);
    if (row.voices !== undefined) {
      const voice = document.createElement("input");
      voice.type = "number";
      voice.min = "1";
      voice.max = String(row.voices);
      voice.step = "1";
      voice.value = String(row.voice ?? 1);
      voice.className = "host-settings-voice";
      voice.dataset["focus"] = "speech:voice";
      voice.setAttribute("aria-label", `Voice, 1 to ${row.voices}`);
      voice.title = `One of ${row.voices} voices`;
      voice.disabled = row.busy;
      voice.addEventListener("change", () => void model.setVoice(Number(voice.value)));
      line.append(span("host-settings-label", "Voice"), voice);
    }
    if (row.speeds !== undefined) {
      const speed = document.createElement("select");
      speed.dataset["focus"] = "speech:speed";
      speed.setAttribute("aria-label", "Speed");
      speed.title = "How fast replies are read, whichever engine reads them";
      for (const o of row.speeds) speed.append(option(o.value, o.label));
      speed.value = String(row.speed);
      speed.disabled = row.busy;
      speed.addEventListener("change", () => void model.setSpeed(Number(speed.value)));
      line.append(span("host-settings-label", "Speed"), speed);
    }
    if (tts && !row.install) {
      const hear = document.createElement("button");
      hear.type = "button";
      hear.className = "host-settings-save";
      hear.dataset["focus"] = "speech:hear";
      hear.textContent = "Hear it";
      hear.disabled = !row.canPreview || row.busy;
      hear.addEventListener("click", () => void model.preview());
      line.append(hear);
    }
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "host-settings-reset";
    reset.dataset["focus"] = `${row.stage}:reset`;
    reset.textContent = "Reset";
    reset.title = tts ? "Forget what was picked here: config.toml's engine and voice are used again" : "Forget what was picked here: config.toml's engine is used again";
    reset.hidden = !row.reset;
    reset.disabled = row.busy;
    reset.addEventListener("click", () => void (tts ? model.setEngine(null) : model.setStt(null)));
    line.append(reset);
    box.append(line, paragraph(row.trouble ? "host-settings-error" : "host-settings-voice-status", row.status));
    if (row.detail) box.append(paragraph("host-settings-source", `${row.detail} ${row.source}`));
    else box.append(paragraph("host-settings-source", row.source));
    if (row.route) box.append(this.route(row, row.route, model));
    if (row.install) box.append(this.install(row, row.install, model));
    if (row.note) box.append(paragraph("host-settings-error", row.note));
    return box;
  }

  private machine(m: MachineSection, model: SettingsModel): HTMLElement {
    const box = document.createElement("div");
    box.className = "host-settings-machine";
    box.append(heading("h3", m.name));
    for (const h of m.harnesses) {
      const group = document.createElement("div");
      group.className = "host-settings-harness";
      group.dataset["harness"] = h.harness;
      group.append(heading("h4", h.label), this.usual(h.usual, model));
      for (const p of h.profiles) group.append(this.profile(p, model));
      box.append(group);
    }
    return box;
  }

  private usual(row: UsualRow, model: SettingsModel): HTMLElement {
    const line = document.createElement("label");
    line.className = "host-settings-usual";
    const select = document.createElement("select");
    select.dataset["focus"] = row.key;
    for (const o of row.options) select.append(option(o.value, o.label));
    select.value = row.value;
    select.disabled = row.busy;
    select.addEventListener("change", () => void model.setUsual(row.node, row.harness, select.value));
    line.append(span("host-settings-label", "Usual account"), select);
    const wrap = document.createElement("div");
    wrap.append(line);
    if (row.note) wrap.append(paragraph("host-settings-error", row.note));
    return wrap;
  }

  private profile(p: ProfileRow, model: SettingsModel): HTMLElement {
    const card = document.createElement("div");
    card.className = "host-settings-profile";
    card.dataset["profile"] = p.id;
    const top = document.createElement("div");
    top.className = "host-settings-profile-top";
    const name = span("host-settings-name", p.name);
    name.title = p.configDir;
    const state = span(`host-settings-state state-${p.status}`, p.signedIn);
    top.append(name, ...(p.usual ? [span("host-settings-badge", "usual")] : []), state);
    card.append(top, paragraph("host-settings-usage", p.usage));
    if (p.launch) card.append(this.launch(p, p.launch, model));
    return card;
  }

  private launch(p: ProfileRow, l: LaunchRow, model: SettingsModel): HTMLElement {
    const box = document.createElement("div");
    box.className = "host-settings-launch";
    box.append(span("host-settings-label", "Start sessions with"));
    const mode = document.createElement("select");
    mode.dataset["focus"] = `${launchKey(p.id)}:mode`;
    mode.setAttribute("aria-label", "Permission mode");
    for (const m of LAUNCH_MODES) mode.append(option(m.value, m.label));
    if (l.extraMode) mode.append(option(l.extraMode.value, l.extraMode.label));
    mode.value = l.mode;
    const flags = document.createElement("input");
    flags.type = "text";
    flags.spellcheck = false;
    flags.autocomplete = "off";
    flags.placeholder = "Other flags, e.g. --effort high --add-dir ../lib";
    flags.setAttribute("aria-label", "Other flags");
    flags.dataset["focus"] = `${launchKey(p.id)}:flags`;
    flags.value = l.flags;
    const save = document.createElement("button");
    save.type = "button";
    save.className = "host-settings-save";
    save.textContent = l.busy ? "Saving…" : "Save";
    save.disabled = !l.dirty || l.busy;
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "host-settings-reset";
    reset.textContent = "Reset";
    reset.title = "Forget what was set here: config.toml's flags, or your own last session's, are used again";
    reset.hidden = !l.reset;
    reset.disabled = l.busy;
    mode.disabled = flags.disabled = l.busy;
    const edited = (): void => {
      model.edit(p.id, { mode: mode.value, flags: flags.value });
      const row = model.sections().flatMap((m) => m.harnesses.flatMap((h) => h.profiles)).find((x) => x.id === p.id)?.launch;
      save.disabled = !row?.dirty;
    };
    mode.addEventListener("change", edited);
    flags.addEventListener("input", edited);
    flags.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !save.disabled) void model.saveLaunch(p.id);
    });
    save.addEventListener("click", () => void model.saveLaunch(p.id));
    reset.addEventListener("click", () => void model.resetLaunch(p.id));
    const controls = document.createElement("div");
    controls.className = "host-settings-controls";
    controls.append(mode, flags, save, reset);
    box.append(controls, paragraph("host-settings-source", l.source));
    if (l.note) box.append(paragraph("host-settings-error", l.note));
    return box;
  }
}

function section(title: string, lead: string): HTMLElement {
  const s = document.createElement("section");
  s.className = "host-settings-section";
  const h = heading("h3", title);
  h.className = "host-settings-section-title";
  s.append(h, paragraph("host-settings-lead", lead));
  return s;
}

function toggle(focus: string, label: string, on: boolean, set: (on: boolean) => void): HTMLElement {
  const line = document.createElement("label");
  line.className = "host-settings-toggle";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = on;
  box.dataset["focus"] = focus;
  box.addEventListener("change", () => set(box.checked));
  line.append(box, span("", label));
  return line;
}

/** "hey phyla" → "Hey Phyla": a phrase as it reads in a sentence. */
export function titleCase(phrase: string): string {
  return phrase.replace(/(^|\s)(\p{Ll})/gu, (_m, space: string, ch: string) => space + ch.toUpperCase());
}

function heading(tag: "h3" | "h4", text: string): HTMLElement {
  const h = document.createElement(tag);
  h.textContent = text;
  return h;
}

function paragraph(className: string, text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  return p;
}

function span(className: string, text: string): HTMLElement {
  const s = document.createElement("span");
  s.className = className;
  s.textContent = text;
  return s;
}

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
