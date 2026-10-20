// Which of the user's own sessions each machine connects to (`SessionScope`), as the host's
// first-run screen (`SetupPanel`) and the Sessions page of its settings show it. For each
// machine: a box for every account (profile) on it, ticked unless left off; "Tether (Cophyla)
// started sessions only"; and two optional lists of folders, the allowed ones (when any is
// listed, only sessions in them connect) and the hidden ones (sessions in them never do), with
// the folders its sessions worked in to pick from. The settings save each change as it is made
// (`autosave`); the first-run screen keeps them until Continue, which saves every machine and so
// marks each set. `ScopeModel` and `scopeMachines` are DOM-free; `scopeControls` draws one
// machine's with the settings' own pieces.

import type { HarnessProfile, Node, SessionScope, SessionScopeState, Workspace } from "@cophyla/protocol";
import { button, checkRow, controlId, el, group, message, option, row, switchInput } from "./ui.ts";

export type ScopeRequest = <T>(method: string, params: unknown) => Promise<T>;

/** The harnesses as the user knows them, in the order they are listed. */
export const HARNESS_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", muse: "Muse" };
const HARNESS_ORDER = ["claude", "codex", "muse"];

/** What a machine connects to before anyone says otherwise: everything. */
export const OPEN_SCOPE: SessionScope = { profilesOff: [], tetherOnly: false, allowedFolders: [], hiddenFolders: [] };

export type FolderKind = "allowedFolders" | "hiddenFolders";

export interface ScopeProfileRow {
  id: string;
  /** "Claude Code · work" */
  label: string;
  configDir: string;
  on: boolean;
  signedIn: boolean;
}

export interface ScopeMachine {
  node: string;
  name: string;
  /** The machine the host is connected to. */
  here: boolean;
  /** Its paths are Windows ones. */
  windows: boolean;
  profiles: ScopeProfileRow[];
  tetherOnly: boolean;
  allowedFolders: string[];
  hiddenFolders: string[];
  /** Folders the machine's sessions worked in, most recent first, to pick from. */
  suggestions: string[];
  /** Why the machine's scope cannot be read: its Cophyla is too old, or out of reach. */
  unavailable?: string;
  busy: boolean;
  note?: string;
}

export interface MachinesInput {
  here?: string;
  nodes: Node[];
  profiles: HarnessProfile[];
  workspaces: Workspace[];
  scopes: ReadonlyMap<string, SessionScope>;
  unavailable?: ReadonlyMap<string, string>;
  busy?: ReadonlySet<string>;
  notes?: ReadonlyMap<string, string>;
}

/** The machines to show: the one the host is connected to first, then the others by name. */
export function scopeMachines(input: MachinesInput): ScopeMachine[] {
  const names = new Map(input.nodes.map((n) => [n.id, n.name]));
  const platforms = new Map(input.nodes.map((n) => [n.id, n.platform]));
  const ids = [...new Set([...(input.here ? [input.here] : []), ...input.scopes.keys(), ...(input.unavailable?.keys() ?? [])])];
  return ids
    .map((node): ScopeMachine => {
      const scope = input.scopes.get(node) ?? OPEN_SCOPE;
      const profiles = input.profiles
        .filter((p) => p.node === node)
        .sort((a, b) => rank(a.harness) - rank(b.harness) || a.name.localeCompare(b.name))
        .map((p) => ({ id: p.id, label: `${HARNESS_NAMES[p.harness] ?? p.harness} · ${p.name}`, configDir: p.configDir, on: !scope.profilesOff.includes(p.id), signedIn: p.status === "ok" }));
      const listed = new Set([...scope.allowedFolders, ...scope.hiddenFolders].map((f) => f.toLowerCase()));
      const suggestions = [...new Set(input.workspaces.filter((w) => w.node === node).sort((a, b) => b.lastActivity - a.lastActivity).map((w) => w.path))].filter((p) => !listed.has(p.toLowerCase()));
      const unavailable = input.unavailable?.get(node);
      const note = input.notes?.get(node);
      return {
        node,
        name: names.get(node) ?? (node === input.here ? "This computer" : node),
        here: node === input.here,
        windows: platforms.get(node) === "windows" || (!platforms.has(node) && input.profiles.some((p) => p.node === node && /^[a-zA-Z]:[\\/]/.test(p.configDir))),
        profiles,
        tetherOnly: scope.tetherOnly,
        allowedFolders: [...scope.allowedFolders],
        hiddenFolders: [...scope.hiddenFolders],
        suggestions,
        ...(unavailable !== undefined ? { unavailable } : {}),
        busy: input.busy?.has(node) ?? false,
        ...(note ? { note } : {}),
      };
    })
    .sort((a, b) => Number(b.here) - Number(a.here) || a.name.localeCompare(b.name));
}

function rank(harness: string): number {
  const i = HARNESS_ORDER.indexOf(harness);
  return i < 0 ? HARNESS_ORDER.length : i;
}

/** Whether a folder is written whole: from a drive, a share, the root or the home. */
export function isWholePath(folder: string): boolean {
  return /^([a-zA-Z]:[\\/]|\\\\|\/|~([\\/]|$))/.test(folder.trim());
}

/** Whether a scope leaves every session in. */
export function isOpenScope(s: SessionScope): boolean {
  return s.profilesOff.length === 0 && !s.tetherOnly && s.allowedFolders.length === 0 && s.hiddenFolders.length === 0;
}

/** What the first-run screen's button says it will do. */
export function continueLabel(machines: readonly ScopeMachine[]): string {
  const shown = machines.filter((m) => m.unavailable === undefined);
  const profiles = shown.flatMap((m) => m.profiles);
  if (profiles.length > 0 && profiles.every((p) => !p.on)) return "Continue without sessions";
  const open = shown.every((m) => m.profiles.every((p) => p.on) && !m.tetherOnly && m.allowedFolders.length === 0 && m.hiddenFolders.length === 0);
  return open ? "Connect all sessions" : "Connect selected sessions";
}

/**
 * The machines' scopes: read when it loads, changed by the controls, and saved — each change at
 * once with `autosave`, all of them together otherwise. `changed` is called whenever there is
 * something new to draw.
 */
export class ScopeModel {
  profiles: HarnessProfile[] = [];
  nodes: Node[] = [];
  workspaces: Workspace[] = [];
  /** The machine the host is connected to, as its `session.scope` named it. */
  here?: string;
  /** Loading, or why nothing could be read; empty once read. */
  note = "Loading…";
  readonly kept = new Map<string, SessionScopeState>();
  readonly drafts = new Map<string, SessionScope>();
  readonly unavailable = new Map<string, string>();
  readonly notes = new Map<string, string>();
  /** Why a folder typed was not added, by machine and list. */
  readonly fieldNotes = new Map<string, string>();
  readonly busy = new Set<string>();
  private sent = new Map<string, number>();
  private request: ScopeRequest;
  private changed: () => void;
  private autosave: boolean;

  constructor(request: ScopeRequest, changed: () => void, opts: { autosave: boolean }) {
    this.request = request;
    this.changed = changed;
    this.autosave = opts.autosave;
  }

  /** The scope of the machine the host is connected to, then the accounts, machines and folders, then every other machine's scope. */
  async load(): Promise<void> {
    this.note = "Loading…";
    this.changed();
    try {
      const [here, profiles, nodes, workspaces] = await Promise.all([
        this.request<SessionScopeState>("session.scope", {}),
        this.request<{ profiles: HarnessProfile[] }>("profile.list", {}).catch(() => ({ profiles: [] as HarnessProfile[] })),
        this.request<{ nodes: Node[] }>("node.list", {}).catch(() => ({ nodes: [] as Node[] })),
        this.request<{ workspaces: Workspace[] }>("workspace.list", {}).catch(() => ({ workspaces: [] as Workspace[] })),
      ]);
      this.here = here.node;
      this.kept.set(here.node, here);
      this.profiles = profiles.profiles;
      this.nodes = nodes.nodes;
      this.workspaces = workspaces.workspaces;
    } catch (e) {
      this.note = `Which sessions Cophyla connects to could not be read: ${message(e)}`;
      this.changed();
      return;
    }
    const others = [...new Set([...this.nodes.filter((n) => n.status === "online" && !n.hands).map((n) => n.id), ...this.profiles.map((p) => p.node)])].filter((id) => id !== this.here);
    await Promise.all(
      others.map(async (node) => {
        try {
          this.kept.set(node, await this.request<SessionScopeState>("session.scope", { node }));
        } catch (e) {
          this.unavailable.set(node, `Not available: ${message(e)}. Update Cophyla there to choose its sessions.`);
        }
      }),
    );
    this.note = "";
    this.changed();
  }

  /** What a machine's scope is now: the change being made, else what it keeps. */
  scope(node: string): SessionScope {
    return this.drafts.get(node) ?? this.kept.get(node)?.scope ?? OPEN_SCOPE;
  }

  machines(): ScopeMachine[] {
    const scopes = new Map([...this.kept.keys(), ...this.drafts.keys()].map((n) => [n, this.scope(n)]));
    return scopeMachines({ ...(this.here ? { here: this.here } : {}), nodes: this.nodes, profiles: this.profiles, workspaces: this.workspaces, scopes, unavailable: this.unavailable, busy: this.busy, notes: this.notes });
  }

  setProfile(node: string, id: string, on: boolean): void {
    this.change(node, (s) => ({ ...s, profilesOff: on ? s.profilesOff.filter((p) => p !== id) : [...new Set([...s.profilesOff, id])] }));
  }

  setTetherOnly(node: string, on: boolean): void {
    this.change(node, (s) => ({ ...s, tetherOnly: on }));
  }

  /** A folder added to a list; false when it is blank, listed there already, or not a whole path, with why beside the field. */
  addFolder(node: string, kind: FolderKind, path: string): boolean {
    const folder = path.trim();
    const key = `${node}:${kind}`;
    this.fieldNotes.delete(key);
    if (folder === "") return false;
    if (!isWholePath(folder)) {
      this.fieldNotes.set(key, "Write the whole path: from its drive (C:\\…), from / or from ~.");
      this.changed();
      return false;
    }
    if (this.scope(node)[kind].some((f) => f.toLowerCase() === folder.toLowerCase())) {
      this.fieldNotes.set(key, "It is listed already.");
      this.changed();
      return false;
    }
    this.change(node, (s) => ({ ...s, [kind]: [...s[kind], folder] }));
    return true;
  }

  removeFolder(node: string, kind: FolderKind, path: string): void {
    this.change(node, (s) => ({ ...s, [kind]: s[kind].filter((f) => f !== path) }));
  }

  private change(node: string, edit: (s: SessionScope) => SessionScope): void {
    this.drafts.set(node, edit(this.scope(node)));
    this.notes.delete(node);
    if (this.autosave) void this.save(node);
    else this.changed();
  }

  /**
   * One machine's scope as it stands, sent whole, which marks it set. Only the answer to the
   * latest send is kept, so quick changes land in order. A refusal says why beside it; with
   * `autosave` the change goes, and what the machine keeps shows again.
   */
  async save(node: string): Promise<boolean> {
    const scope = this.scope(node);
    const seq = (this.sent.get(node) ?? 0) + 1;
    this.sent.set(node, seq);
    this.busy.add(node);
    this.changed();
    try {
      const state = await this.request<SessionScopeState>("session.setScope", { node, scope });
      if (this.sent.get(node) !== seq) return true;
      this.kept.set(node, state);
      if (this.drafts.get(node) === scope) this.drafts.delete(node);
      return true;
    } catch (e) {
      if (this.sent.get(node) !== seq) return false;
      this.notes.set(node, `Not saved: ${message(e).replace(/^[a-z_]+: /, "")}`);
      if (this.autosave) this.drafts.delete(node);
      return false;
    } finally {
      if (this.sent.get(node) === seq) this.busy.delete(node);
      this.changed();
    }
  }

  /** Every machine that can say, saved together: true once each took its scope. */
  async saveAll(): Promise<boolean> {
    const nodes = [...this.kept.keys()];
    const done = await Promise.all(nodes.map((n) => this.save(n)));
    return done.every(Boolean);
  }
}

/** What the folder fields hold as typed, by machine and list, kept across redraws. */
export type FolderDrafts = Map<string, string>;

const FOLDER_WORDS: Record<FolderKind, { title: string; help: string; empty: string; placeholder: string }> = {
  allowedFolders: {
    title: "Allowed folders",
    help: "When any is listed, only sessions working in these folders connect.",
    empty: "None: sessions in any folder connect.",
    placeholder: "Add a folder, e.g. C:\\Code\\my-app",
  },
  hiddenFolders: {
    title: "Hidden folders",
    help: "Sessions working in these folders never connect, inside an allowed folder too.",
    empty: "None.",
    placeholder: "Add a folder to hide",
  },
};

/** The folder placeholder in the platform's own spelling. */
function placeholder(kind: FolderKind, windows: boolean): string {
  const words = FOLDER_WORDS[kind].placeholder;
  return windows ? words : words.replace("C:\\Code\\my-app", "~/code/my-app");
}

export interface ScopeControlsOptions {
  model: ScopeModel;
  drafts: FolderDrafts;
  /** Draws again: a field's draft changed in a way the model does not hear. */
  redraw: () => void;
  /**
   * A form saved as a whole, the first-run screen: tether only is a box to tick rather than a
   * switch, since nothing takes effect until Continue, and the folder lists start folded.
   */
  form?: boolean;
  /** The machines whose folded folder lists are unfolded, kept across redraws. */
  unfolded?: Set<string>;
}

/** One machine's controls as groups: its accounts, tether only, and the two folder lists. */
export function scopeControls(m: ScopeMachine, o: ScopeControlsOptions): HTMLElement[] {
  if (m.unavailable) return [group(undefined, [row({ label: m.name, help: m.unavailable })])];
  const accounts = group(
    `Accounts on ${m.here ? "this computer" : m.name}`,
    m.profiles.length === 0
      ? [row({ label: "No agent accounts found", help: "Sign in to Claude Code, Codex or Muse on this machine and it shows here." })]
      : m.profiles.map((p) =>
          checkRow(`scope:${m.node}:profile:${p.id}`, p.label, p.on, (on) => o.model.setProfile(m.node, p.id, on), {
            help: p.configDir,
            ...(p.signedIn ? {} : { aside: "Not signed in" }),
          }),
        ),
    "Sessions from the accounts you leave ticked connect to Cophyla.",
  );
  const tetherLabel = "Tether (Cophyla) started sessions only";
  const tetherHelp = "Only sessions running in a Cophyla terminal connect. Sessions in other terminals and editors are left alone.";
  const tether = group(undefined, [
    o.form
      ? checkRow(`scope:${m.node}:tether`, tetherLabel, m.tetherOnly, (on) => o.model.setTetherOnly(m.node, on), { help: tetherHelp })
      : row({ label: tetherLabel, help: tetherHelp, for: controlId(`scope:${m.node}:tether`), control: switchInput(`scope:${m.node}:tether`, tetherLabel, m.tetherOnly, (on) => o.model.setTetherOnly(m.node, on)) }),
  ]);
  const lists = (["allowedFolders", "hiddenFolders"] as const).map((kind) => folderGroup(m, kind, o));
  const out: HTMLElement[] = [accounts, tether];
  if (o.form) {
    const more = el("details", "host-settings-disclosure");
    more.open = (o.unfolded?.has(m.node) ?? false) || m.allowedFolders.length > 0 || m.hiddenFolders.length > 0;
    more.addEventListener("toggle", () => {
      if (more.open) o.unfolded?.add(m.node);
      else o.unfolded?.delete(m.node);
    });
    const summary = el("summary", "", "Limit by folder (optional)");
    summary.dataset["focus"] = `scope:${m.node}:folders`;
    more.append(summary, ...lists);
    out.push(more);
  } else out.push(...lists);
  if (m.note) out.push(el("p", "host-settings-page-note", m.note));
  return out;
}

function folderGroup(m: ScopeMachine, kind: FolderKind, o: ScopeControlsOptions): HTMLElement {
  const words = FOLDER_WORDS[kind];
  const key = `${m.node}:${kind}`;
  const listId = `hs-folders-${key}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  const rows: HTMLElement[] = [];
  const folders = m[kind];
  if (folders.length === 0) rows.push(el("div", "host-settings-row host-settings-row-empty", words.empty));
  for (const f of folders) {
    rows.push(
      row({
        label: f,
        control: button(`scope:${key}:remove:${f}`, "Remove", "quiet", () => o.model.removeFolder(m.node, kind, f), { title: `Stop ${kind === "allowedFolders" ? "allowing" : "hiding"} ${f}` }),
      }),
    );
  }
  const input = el("input", "host-settings-input host-settings-path");
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.placeholder = placeholder(kind, m.windows);
  input.setAttribute("aria-label", words.title);
  input.setAttribute("list", listId);
  input.dataset["focus"] = `scope:${key}:input`;
  input.value = o.drafts.get(key) ?? "";
  const datalist = el("datalist");
  datalist.id = listId;
  for (const s of m.suggestions) datalist.append(option(s, s));
  const add = button(`scope:${key}:add`, "Add", "secondary", () => commit(), { disabled: input.value.trim() === "" });
  const commit = (): void => {
    if (!o.model.addFolder(m.node, kind, input.value)) return;
    o.drafts.delete(key);
    o.redraw();
  };
  input.addEventListener("input", () => {
    if (input.value === "") o.drafts.delete(key);
    else o.drafts.set(key, input.value);
    add.disabled = input.value.trim() === "";
    if (o.model.fieldNotes.delete(key)) o.redraw();
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      commit();
    }
  });
  rows.push(el("div", "host-settings-row host-settings-row-add", input, datalist, add));
  const why = o.model.fieldNotes.get(key);
  if (why) rows.push(el("p", "host-settings-row-note host-settings-row-alone", why));
  return group(words.title, rows, words.help);
}
