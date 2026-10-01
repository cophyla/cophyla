// One view's share of the host's connection. A view speaks the client protocol to the host
// by postMessage in an envelope; the bridge validates each request, refuses the host's
// own (`hello`, `pair.claim`, `pair.account`, `relay.info`: the ones with no scope, since they hand out
// credentials), unknown methods and anything outside the view's scopes, remaps ids into its own
// namespace, forwards, and restores ids on the way back. A signal (a frame with a method
// and no id, such as `chat.typing`) is forwarded unchanged when its scope is the view's.
// Notifications reach the view only within its scopes. Signals and notifications with no
// scope (a data channel's signalling, a stream's pipes) are the host's alone: a view never
// sends or hears them. The manifest's `scopes` narrow the
// connection's; a manifest that lists none lets the view send nothing. A `host.*` request
// is the host's own, never cophylad's: `host.open` shows a URL `remote.open` answered (a stream
// page, an invite link), allowed only to a view holding the `remote` scope and only where
// the host has the seam; a host that can lay a stream page over the view (`embed` in
// `host.ready`: the desktop app) opens one there for `host.open {embed: true}`, puts it over
// the rectangle `host.place` names or hides it, and ends it with `host.close`, likewise for
// the `remote` scope, and says `host.streamClosed` when one it showed is gone, however that
// came about; `host.chooseView` shows the host's view picker and `host.settings`
// the host's settings, to any view, since what is picked or set there is the user's doing and
// never the view's; `host.openLink` opens a web page the user clicked (a URL in a terminal) in
// their browser, to any view, only http and https and never with credentials in it, and only
// where the host has the seam; `host.savePrefs` keeps a small record of the view's own (how
// the user left its layout) on this device, to any view, each view's apart from the others',
// and `host.ready` hands it back as `prefs`. The host tells the view
// things of its own as notifications, never scoped: `host.ready` and `host.state`, and
// `host.menu` when the host has a menu button of its own (`menu` in `host.ready`) and it was
// pressed. `talk` in `host.ready` says the host has a microphone and no talk button of its
// own, so a view with the voice scope may draw one that holds `voice.ptt`; such a host says
// `host.mic` whenever its microphone goes off or comes back, with why it is off, so the view
// can say so beside the button (and again after `host.ready` while it is off). A host with a
// microphone says `host.recording` when it starts or stops recording an utterance, however it
// began, and `host.levels` with how loud each 20 ms of it is meanwhile, so the view can draw
// it: to a view with the voice scope alone, and `host.recording` again after `host.ready`
// while it records. `host.filePaths`
// says where the files just dropped on the view from the desktop are, by the names the view
// saw them under (a page learns only a dropped file's name), or with no names where the page
// saw none (WebKitGTK, which shows a page no dropped file: the Linux shell answers all the
// drop's paths then, and no other does), to any view, and only where the host has the seam,
// which `filePaths` in `host.ready` says; the shell hands a drop over once, and only while it
// is fresh. On Windows the view asks WebView2 itself instead, past this bridge: WebView2
// grants a dropped file to the frame's process alone, so only the frame can hand it on
// (apps/ui/src-tauri/src/dropped.rs). `docFrame` in `host.ready` is where the host serves the
// document frame (@cophyla/protocol's docframe.ts), in which a view may run an HTML file's
// scripts apart from its own; a host that serves none leaves it out. DOM-free.

import { failure, notification, notificationScope, protocolError, requestScope, RpcNotification, RpcRequest, signalScope } from "@cophyla/protocol";
import type { RpcId, RpcMessage, RpcResponse, Scope, ViewManifest } from "@cophyla/protocol";
import type { HelloResult } from "./connection.ts";

export const ENVELOPE = "cophyla.view/1";

export interface Envelope {
  cophyla: typeof ENVELOPE;
  frame: RpcMessage;
}

export function envelope(frame: RpcMessage): Envelope {
  return { cophyla: ENVELOPE, frame };
}

export function isEnvelope(data: unknown): data is { cophyla: typeof ENVELOPE; frame: unknown } {
  return typeof data === "object" && data !== null && (data as { cophyla?: unknown }).cophyla === ENVELOPE && "frame" in data;
}

export interface HostReady {
  client: HelloResult["client"];
  node: HelloResult["node"];
  protocolVersion: number;
  platformVersion: string;
  view: ViewManifest;
  scopes: Scope[];
  /** The host has a menu button of its own and says `host.menu` when it is pressed. */
  menu?: boolean;
  /** The host has a microphone and no talk button of its own: the view may draw one, holding `voice.ptt`. */
  talk?: boolean;
  /** What the view last saved with `host.savePrefs` on this device, when it saved anything. */
  prefs?: ViewPrefs;
  /** The host says where files dropped on the view from the desktop are (`host.filePaths`): the desktop app. */
  filePaths?: boolean;
  /** Where the host serves the document frame, which the view may frame to run an HTML file's scripts. */
  docFrame?: string;
  /** The host lays a stream page over the view where it says (`host.open {embed}`, `host.place`, `host.close`): the desktop app. */
  embed?: true;
}

/** The host's microphone, for a view that draws the talk button: why it is off, while it is. */
export interface HostMic {
  error?: string;
}

/** A view's own record on the device it runs on: plain JSON, a few kilobytes at most. */
export type ViewPrefs = Record<string, unknown>;

/** The most a view's prefs may take, as JSON. */
export const PREFS_MAX = 8192;

/** Where a view's prefs are kept: the host's, one record per view. */
export interface PrefsStore {
  load(): ViewPrefs | undefined;
  save(prefs: ViewPrefs): void;
}

export interface BridgeConfig {
  manifest: ViewManifest;
  clientScopes: Scope[];
  /** Distinguishes this mount from any other in the same host, so ids never collide. */
  instance: number;
  /** The host's own requests (`host.open`); absent, they answer `unsupported`. */
  host?: HostRequests;
  /** The host has a menu button of its own (`host.menu`). */
  menu?: boolean;
  /** The host has a microphone and no talk button of its own. */
  talk?: boolean;
  /** Shows the host's view picker (`host.chooseView`); absent, it answers `unsupported`. */
  chooseView?: () => void;
  /** Shows the host's settings (`host.settings`); absent, it answers `unsupported`. */
  openSettings?: () => void;
  /** Opens a web page in the user's browser (`host.openLink`); absent, it answers `unsupported`. */
  openLink?: (url: string) => Promise<void>;
  /** Keeps the view's prefs (`host.savePrefs`); absent, it answers `unsupported`. */
  prefs?: PrefsStore;
  /** Where the files just dropped on the view are, by their names, in their order, or with no names all of them where the shell allows it (`host.filePaths`); absent, it answers `unsupported`. */
  filePaths?: (names?: string[]) => Promise<string[]>;
  /** Where the host serves the document frame; absent, `host.ready` names none. */
  docFrame?: string;
  /** The host lays stream pages over the view (`embed` in `host.ready`). */
  embed?: boolean;
}

/** The requests a view may make of the host itself, by method. */
export type HostRequests = (method: string, params: unknown) => Promise<unknown>;

/** The host requests a view may make, and the scope each needs; `null` is none. */
const HOST_METHODS: Record<string, Scope | null> = { "host.open": "remote", "host.place": "remote", "host.close": "remote", "host.chooseView": null, "host.settings": null, "host.openLink": null, "host.savePrefs": null, "host.filePaths": null };

/** The record a `host.savePrefs` keeps: a plain object whose JSON fits in `PREFS_MAX`. */
export function viewPrefs(params: unknown): ViewPrefs {
  const prefs = (params as { prefs?: unknown } | null)?.prefs;
  if (typeof prefs !== "object" || prefs === null || Array.isArray(prefs)) throw new Error("host.savePrefs needs prefs, an object");
  if (JSON.stringify(prefs).length > PREFS_MAX) throw new Error(`prefs take at most ${PREFS_MAX} bytes`);
  return prefs as ViewPrefs;
}

/** The most files one `host.filePaths` may name. */
export const DROPPED_MAX = 4096;

/** The names a `host.filePaths` asks about: none, or 1 to `DROPPED_MAX` file names, each 1 to 1024 characters with no slash or NUL. */
export function droppedNames(params: unknown): string[] | undefined {
  const names = (params as { names?: unknown } | null)?.names;
  if (names === undefined) return undefined;
  if (!Array.isArray(names) || names.length === 0 || names.length > DROPPED_MAX) throw new Error(`host.filePaths needs names, 1 to ${DROPPED_MAX} of them`);
  for (const name of names) {
    if (typeof name !== "string" || name === "" || name.length > 1024 || /[/\0]/.test(name)) throw new Error("a dropped file's name is not a file name");
  }
  return names as string[];
}

/** The page a `host.openLink` names, if it may open: an http or https URL with a host and no credentials. */
export function webLink(params: unknown): string {
  const raw = (params as { url?: unknown } | null)?.url;
  if (typeof raw !== "string" || raw.length > 8192) throw new Error("host.openLink needs a url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("that link cannot be opened");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "" || url.username !== "" || url.password !== "") {
    throw new Error("only a web page opens");
  }
  return url.href;
}

export interface BridgeIo {
  toCophylad(frame: RpcRequest | RpcNotification): void;
  toView(frame: RpcMessage): void;
}

export class Bridge {
  readonly scopes: Scope[];
  readonly manifest: ViewManifest;
  private io: BridgeIo;
  private instance: number;
  private host?: HostRequests;
  private hasMenu: boolean;
  private hasTalk: boolean;
  /** `host.chooseView`: the picker shows, and the answer is that it did. */
  private chooser?: HostRequests;
  /** `host.settings`: the same for the settings. */
  private settings?: HostRequests;
  /** `host.openLink`: the page opens, once it is one that may. */
  private links?: HostRequests;
  /** `host.savePrefs`, and the prefs `host.ready` carries. */
  private prefs?: PrefsStore;
  private savePrefs?: HostRequests;
  /** `host.filePaths`: the paths, once the names, if any, are file names. */
  private filePaths?: HostRequests;
  private docFrame?: string;
  private embed: boolean;
  private n = 0;
  /** The host's microphone as last said, so a view that loads while it is off hears it. */
  private micState: HostMic = {};
  /** The host's microphone records an utterance, so a view that loads meanwhile hears it. */
  private recordingNow = false;
  /** wire id → the view's own id and method. */
  private pending = new Map<string, { id: RpcId; method: string }>();

  constructor(cfg: BridgeConfig, io: BridgeIo) {
    this.manifest = cfg.manifest;
    const wanted = new Set(cfg.manifest.scopes ?? []);
    this.scopes = cfg.clientScopes.filter((s) => wanted.has(s));
    this.instance = cfg.instance;
    if (cfg.host) this.host = cfg.host;
    this.hasMenu = cfg.menu === true;
    this.hasTalk = cfg.talk === true;
    const show = cfg.chooseView;
    if (show) {
      this.chooser = async () => {
        show();
        return {};
      };
    }
    const settings = cfg.openSettings;
    if (settings) {
      this.settings = async () => {
        settings();
        return {};
      };
    }
    const open = cfg.openLink;
    if (open) {
      this.links = async (_method, params) => {
        await open(webLink(params));
        return {};
      };
    }
    const prefs = cfg.prefs;
    if (prefs) {
      this.prefs = prefs;
      this.savePrefs = async (_method, params) => {
        prefs.save(viewPrefs(params));
        return {};
      };
    }
    const dropped = cfg.filePaths;
    if (dropped) this.filePaths = async (_method, params) => ({ paths: await dropped(droppedNames(params)) });
    if (cfg.docFrame) this.docFrame = cfg.docFrame;
    this.embed = cfg.embed === true;
    this.io = io;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** A message from the frame. Anything that is not an enveloped request or signal is dropped. */
  fromView(data: unknown): void {
    if (!isEnvelope(data)) return;
    const frame = data.frame as { id?: unknown; method?: unknown } | null;
    if (frame && typeof frame === "object" && frame.id === undefined && typeof frame.method === "string") {
      const signal = RpcNotification.safeParse(frame);
      if (!signal.success) return;
      const scope = signalScope(signal.data.method);
      if (scope !== undefined && scope !== null && this.scopes.includes(scope)) this.io.toCophylad(signal.data);
      return;
    }
    const parsed = RpcRequest.safeParse(data.frame);
    if (!parsed.success) {
      const id = idOf(data.frame);
      if (id !== undefined) this.io.toView(failure(id, protocolError("invalid", "frame is not a JSON-RPC request")));
      return;
    }
    const req = parsed.data;
    if (req.method.startsWith("host.")) {
      this.hostRequest(req);
      return;
    }
    const needs = requestScope(req.method);
    if (needs === undefined) {
      this.io.toView(failure(req.id, protocolError("unsupported", `unknown method ${req.method}`)));
      return;
    }
    // The scope-less requests establish or hand out credentials: the host's alone.
    if (needs === null) {
      this.io.toView(failure(req.id, protocolError("unsupported", `${req.method} is the host's alone`)));
      return;
    }
    if (!this.scopes.includes(needs)) {
      this.io.toView(failure(req.id, protocolError("denied", `view ${this.manifest.id} lacks scope ${needs}`)));
      return;
    }
    const wire = `v${this.instance}-${++this.n}`;
    this.pending.set(wire, { id: req.id, method: req.method });
    this.io.toCophylad({ ...req, id: wire });
  }

  /** A request the host answers itself, within the view's scopes. */
  private hostRequest(req: RpcRequest): void {
    const needs = HOST_METHODS[req.method];
    const own: Record<string, HostRequests | undefined> = { "host.chooseView": this.chooser, "host.settings": this.settings, "host.openLink": this.links, "host.savePrefs": this.savePrefs, "host.filePaths": this.filePaths };
    const handler = req.method in own ? own[req.method] : this.host;
    if (needs === undefined || !handler) {
      this.io.toView(failure(req.id, protocolError("unsupported", `this host has no ${req.method}`)));
      return;
    }
    if (needs !== null && !this.scopes.includes(needs)) {
      this.io.toView(failure(req.id, protocolError("denied", `view ${this.manifest.id} lacks scope ${needs}`)));
      return;
    }
    handler(req.method, req.params ?? {}).then(
      (result) => this.io.toView({ jsonrpc: "2.0", id: req.id, result: result ?? {} } as RpcResponse),
      (e: unknown) => this.io.toView(failure(req.id, protocolError("invalid", e instanceof Error ? e.message : String(e)))),
    );
  }

  /** A frame from cophylad. Responses to this bridge's requests go back with their ids restored. */
  fromCophylad(frame: RpcMessage): void {
    if ("method" in frame) {
      if ("id" in frame) return;
      const needs = notificationScope(frame.method);
      if (needs === undefined || needs === null || !this.scopes.includes(needs)) return;
      this.io.toView(frame);
      return;
    }
    if (typeof frame.id !== "string") return;
    const p = this.pending.get(frame.id);
    if (!p) return;
    this.pending.delete(frame.id);
    this.io.toView({ ...frame, id: p.id } as RpcResponse);
  }

  /** Tells the view who it is talking to, then that the line is open. */
  ready(hello: HelloResult): void {
    const params: HostReady = {
      client: hello.client,
      node: hello.node,
      protocolVersion: hello.protocolVersion,
      platformVersion: hello.platformVersion,
      view: this.manifest,
      scopes: this.scopes,
    };
    if (this.hasMenu) params.menu = true;
    if (this.hasTalk) params.talk = true;
    const prefs = this.prefs?.load();
    if (prefs) params.prefs = prefs;
    if (this.filePaths) params.filePaths = true;
    if (this.docFrame) params.docFrame = this.docFrame;
    if (this.embed) params.embed = true;
    this.io.toView(notification("host.ready", params));
    this.io.toView(notification("host.state", { connected: true }));
    if (this.hasTalk && this.micState.error !== undefined) this.io.toView(notification("host.mic", this.micState));
    if (this.recordingNow && this.scopes.includes("voice")) this.io.toView(notification("host.recording", { active: true }));
  }

  /** The host's menu button was pressed: what it shows or hides is the view's. */
  menu(): void {
    if (this.hasMenu) this.io.toView(notification("host.menu", {}));
  }

  /** The host's microphone went off, or came back: a view that draws the talk button is told. */
  mic(state: HostMic): void {
    if (!this.hasTalk || state.error === this.micState.error) return;
    this.micState = state.error !== undefined ? { error: state.error } : {};
    this.io.toView(notification("host.mic", this.micState));
  }

  /** The host's microphone started or stopped recording an utterance: a view that may hear voice is told. */
  recording(active: boolean): void {
    if (active === this.recordingNow) return;
    this.recordingNow = active;
    if (this.scopes.includes("voice")) this.io.toView(notification("host.recording", { active }));
  }

  /** A stream the host showed for the view is gone: its window closed, or the page over the view ended. */
  streamClosed(stream: string): void {
    if (this.scopes.includes("remote")) this.io.toView(notification("host.streamClosed", { stream }));
  }

  /** How loud the microphone was over its last frame, while it records, 0 to 1 per 20 ms. */
  levels(levels: number[]): void {
    if (this.recordingNow && this.scopes.includes("voice")) this.io.toView(notification("host.levels", { levels }));
  }

  /** Fails every request in flight and tells the view the line is down. */
  disconnected(): void {
    for (const [wire, p] of this.pending) {
      this.pending.delete(wire);
      this.io.toView(failure(p.id, protocolError("unavailable", `${p.method}: not connected to cophylad`)));
    }
    this.io.toView(notification("host.state", { connected: false }));
  }
}

function idOf(frame: unknown): RpcId | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  const id = (frame as { id?: unknown }).id;
  return typeof id === "string" || (typeof id === "number" && Number.isInteger(id)) ? id : undefined;
}

