// The host's settings: a layer over the frame that is the host's own, like the view picker,
// so any view opens the same one by asking `host.settings` and none has to draw it. It is
// made of sections, and more will join. Voice comes first on a host with a microphone of its
// own (the desktop app; the phone keeps its switches in its bar's menu): whether it listens
// for the wake words and which ones the node listens for, whether replies are spoken, the
// talk key, and what is wrong with the microphone when something is. Then Agents. For each machine and harness it
// shows the usual account — Automatic, naming the profile cophylad picks and why, or one the
// user picks — and for each profile its name, whether it is signed in, how much of its
// session and weekly limits it has used (`profile.limits`) and, for a Claude profile, what a
// session cophylad starts under it is started with: a permission mode and other flags, with
// where the launch in use came from (set here, config.toml, or the user's own last session
// there) and a Reset. It reads with the host's own connection and writes with
// `profile.update`. It closes on its ✕, on Escape and on a click outside its card, and says
// what failed beside what failed. `settingsRows` and `SettingsModel` are DOM-free; the panel
// draws them. Its look is `settings.css`, which each host page links.

import type { HarnessProfile, LaunchMode, Node, ProfileLimits } from "@cophyla/protocol";

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

/**
 * What the panel shows, and what it changes: the profiles, the machines' names and the
 * limits, read when it opens; edits to a launch held as drafts until saved; a note beside
 * what failed. `changed` is called whenever there is something new to draw.
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
  /** The talk key as the shell reads it; `""` when there is none. */
  talkKey: string;
  /** The phrases the node listens for, once it said which; the node detects them itself when empty. */
  phrases: string[];
  /** What voice is doing now, in words: listening for the words, the microphone refused, voice off on the node. */
  status: string;
  /** The microphone could not be had, and why. */
  micError?: string;
}

/** A host's own voice, for the Voice section: the desktop app's. */
export interface VoiceSettings {
  state(): VoiceSettingsState;
  /** Calls `changed` whenever the state moves; returns how to stop. */
  subscribe(changed: () => void): () => void;
  setListening(on: boolean): void;
  setSpeak(on: boolean): void;
  /** The talk key, by name; resolves with it as the shell reads it, rejects with why it could not be had. */
  setTalkKey(accelerator: string): Promise<string>;
  /** Asks for the microphone again. */
  retry(): Promise<void>;
}

export interface SettingsPanelDeps {
  /** The host's own connection. */
  request: SettingsRequest;
  /** The host's own voice, when it has a microphone: the Voice section shows. */
  voice?: VoiceSettings;
  /** Where the layer goes; the page's body when absent. */
  root?: HTMLElement;
  /** Where the focus goes once the layer closes: the view's frame. */
  refocus?: () => void;
}

/** The layer itself: opened by `host.settings`, drawn from a `SettingsModel`. */
export class SettingsPanel {
  private deps: SettingsPanelDeps;
  private layer?: HTMLElement;
  private model?: SettingsModel;
  /** The talk key as typed and not yet set, and why the last one could not be. */
  private keyDraft?: string;
  private keyNote = "";
  private unsubscribe?: () => void;
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
    this.render();
    close.focus();
    void model.load();
  }

  close(): void {
    if (!this.layer) return;
    this.layer.remove();
    this.layer = undefined;
    this.model = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.keyDraft = undefined;
    this.keyNote = "";
    document.removeEventListener("keydown", this.onKey);
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
    body.replaceChildren(...(this.deps.voice ? [this.voiceSection(this.deps.voice)] : []), agents);
    if (focusKey) {
      const again = layer.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusKey)}"]`);
      again?.focus();
      if (again instanceof HTMLInputElement && caret && caret[0] !== null && caret[1] !== null) again.setSelectionRange(caret[0], caret[1]);
    }
  }

  private voiceSection(voice: VoiceSettings): HTMLElement {
    const v = voice.state();
    const box = section("Voice", "Say a wake word, or hold the talk key, and Cophyla listens; what you say is transcribed and answered as if you had typed it.");
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
    const words = v.phrases.length > 0 ? v.phrases.map((p) => `“${titleCase(p)}”`).join(", ") : "the node's wake words";
    box.append(
      toggle("voice:listen", `Listen for ${words}`, v.listening, (on) => voice.setListening(on)),
      toggle("voice:speak", "Speak the replies to what I say", v.speak, (on) => voice.setSpeak(on)),
    );
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
      voice.setTalkKey(input.value).then(
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
    box.append(key, paragraph("host-settings-source", "Held anywhere, even while Cophyla is behind other windows: it listens until you let go. For example Ctrl+Alt+Space or Ctrl+Shift+F9; empty for none."));
    if (this.keyNote) box.append(paragraph("host-settings-error", this.keyNote));
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

/** "hey jarvis" → "Hey Jarvis": a phrase as it reads in a sentence. */
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
