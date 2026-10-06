// Loads the default view into a sandboxed frame and runs a Bridge over it, and loads it
// again when a reconnect, or a `view.changed` from cophylad, finds it serving a different
// version. The frame has `sandbox="allow-scripts allow-forms"` and no `allow-same-origin`,
// so its document has an opaque origin: `event.origin` is "null" and nothing it holds is the
// host's. `allow-forms` is there because without it Chromium drops a submission before its
// `submit` event fires, and a view's forms (Send, Enter, Answer) are its handlers; where a
// submission may go is the frame's CSP's, `form-action 'none'`, so it goes nowhere.
// Messages are accepted only from that frame's window, and posted only to it. The host's
// view picker (`ViewChooser`) lies over the frame when a view asks for it (`host.chooseView`),
// and so do its settings (`SettingsPanel`, `host.settings`). A host that draws no talk button
// of its own tells the view when its microphone goes off or comes back (`host.mic`). A host
// with a microphone tells it when recording starts and stops and how loud it is meanwhile
// (`recording`, `levels`: `host.recording`, `host.levels`). A link a view asks it to open
// (`host.openLink`) opens only on a fresh click: a click in the frame activates this page too,
// so a view cannot open pages the user never asked for. What a view saves with `host.savePrefs`
// is kept in this page's storage, under the view's id, and comes back in its `host.ready`.
// Where the files come from is the host's: the desktop app fetches them with `view.get` and
// stages them on its native side, the controller asks the node for a `view.stage` ticket.
// Staging also says where the host serves the document frame, when it does, and the view is
// told in its `host.ready`. A host that lays stream pages over the view (`embed`) hears when
// what it laid there must go under the page's own layers (`onOverlay`, while the picker or
// the settings are open) and when it must go altogether (`onUnmount`: the view was replaced,
// or reloaded itself), and tells the view a stream is gone with `streamClosed`. A host that is
// a wide window on a computer without being the desktop app says so (`desk`), and the view is
// told in its `host.ready`; one that is a paired device of its own shows itself in the settings
// (`device`).

import type { RpcMessage, ViewManifest } from "@cophyla/protocol";
import { Bridge, envelope, isEnvelope } from "./bridge.ts";
import type { HostMic, HostRequests, PrefsStore, ViewPrefs } from "./bridge.ts";
import { ViewChooser } from "./chooser.ts";
import { SettingsPanel } from "./settings.ts";
import type { DeviceSettings, VoiceSettings } from "./settings.ts";
import type { Connection, LinkSnapshot } from "./connection.ts";
import type { SnapshotCache } from "./snapshot.ts";

/**
 * Where a view's files are served for the frame: `base` + the manifest's entry is the URL;
 * `version` is what was staged when the host knows it; `docFrame` where the host serves the
 * document frame, when it does.
 */
export interface Staged {
  base: string;
  version?: string;
  docFrame?: string;
}

export interface ViewHostDeps {
  conn: Connection;
  cache: SnapshotCache;
  container: HTMLElement;
  /** Makes a view's files loadable by the frame and says where. */
  stage: (manifest: ViewManifest) => Promise<Staged>;
  /** The host's own requests a view may make (`host.open`); the desktop app has none. */
  host?: HostRequests;
  /** The host has a menu button of its own, and calls `menu()` when it is pressed: the phone's bar. */
  menu?: boolean;
  /** The host has a microphone and no talk button of its own, so the view may draw one: the desktop app. */
  talk?: boolean;
  /** The host's own voice, for the Voice section of its settings. */
  voice?: VoiceSettings;
  /** Opens a web page in the user's browser, for a view's `host.openLink`. */
  openLink?: (url: string) => Promise<void>;
  /** Where views' prefs are kept; absent, this page's localStorage, when it has one. */
  store?: Pick<Storage, "getItem" | "setItem">;
  /** Where the files just dropped on a view from the desktop are, by their names or with none, for a view's `host.filePaths`: the desktop app's shell. */
  filePaths?: (names?: string[]) => Promise<string[]>;
  /** The host lays stream pages over the view (`host.open {embed}`, `host.place`, `host.close`): the desktop app. */
  embed?: boolean;
  /** The view's document went: replaced, or reloaded by the view itself. What the host laid over it goes. */
  onUnmount?: () => void;
  /** The picker or the settings opened (`true`) or both are closed again: what the host laid over the view hides meanwhile. */
  onOverlay?: (open: boolean) => void;
  /** The host is a wide window with a pointer on a computer: the controller page in a desktop browser. */
  desk?: boolean;
  /** The host as the paired device it is, for a section of its own in the settings: a browser on another computer. */
  device?: DeviceSettings;
  onError?: (message: string) => void;
}

interface Mounted {
  frame: HTMLIFrameElement;
  bridge: Bridge;
  manifest: ViewManifest;
}

/** The view the host shows from a `view.list`: the default, else the first. */
export function chooseView(views: ViewManifest[]): ViewManifest | undefined {
  return views.find((v) => v.default) ?? views[0];
}

/**
 * Whether a mounted view is behind what cophylad serves now: the default moved to another
 * view, or the same view's files changed (its `version` is a hash of them). A version
 * unknown on either side is not a change; a list with no view at all is not one either,
 * since there is nothing to mount instead.
 */
export function isStale(mounted: ViewManifest, served: ViewManifest | undefined): boolean {
  if (!served) return false;
  if (served.id !== mounted.id) return true;
  return served.version !== undefined && mounted.version !== undefined && served.version !== mounted.version;
}

/** The storage key a view's prefs are kept under. */
export function prefsKey(viewId: string): string {
  return `cophyla.view-prefs.${viewId}`;
}

/** A view's prefs in a store: what it saved, if it reads back as an object; saving where the store refuses is lost quietly. */
export function prefsStore(store: Pick<Storage, "getItem" | "setItem"> | undefined, viewId: string): PrefsStore {
  const key = prefsKey(viewId);
  return {
    load: () => {
      try {
        const raw = store?.getItem(key);
        const prefs: unknown = raw ? JSON.parse(raw) : undefined;
        return typeof prefs === "object" && prefs !== null && !Array.isArray(prefs) ? (prefs as ViewPrefs) : undefined;
      } catch {
        return undefined;
      }
    },
    save: (prefs) => {
      try {
        store?.setItem(key, JSON.stringify(prefs));
      } catch {
        // full, or refused: the layout is as the user left it until the view reloads
      }
    },
  };
}

function pageStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** What `host.mic` says of the host's voice: why its microphone is off, while it is. */
function hostMic(voice: VoiceSettings): HostMic {
  const error = voice.state().micError;
  return error !== undefined ? { error } : {};
}

/** Milliseconds `view.changed` notices are gathered for before one `view.list` asks what moved. */
export const CHANGED_COALESCE_MS = 300;

/** The frame's sandbox: scripts, and forms that fire `submit`; never `allow-same-origin`. */
export const FRAME_SANDBOX = "allow-scripts allow-forms";

export class ViewHost {
  private deps: ViewHostDeps;
  private mounted?: Mounted;
  private instances = 0;
  private loading?: Promise<void>;
  private changedTimer?: ReturnType<typeof setTimeout>;
  private chooser: ViewChooser;
  private settings: SettingsPanel;
  private recordingNow = false;

  constructor(deps: ViewHostDeps) {
    this.deps = deps;
    this.chooser = new ViewChooser({
      request: (method, params) => deps.conn.request(method, params),
      showing: () => this.mounted?.manifest.id,
      reload: () => this.load(),
      refocus: () => this.mounted?.frame.focus(),
      onToggle: () => this.overlay(),
    });
    this.settings = new SettingsPanel({
      request: (method, params) => deps.conn.request(method, params),
      refocus: () => this.mounted?.frame.focus(),
      onToggle: () => this.overlay(),
      ...(deps.voice ? { voice: deps.voice } : {}),
      ...(deps.device ? { device: deps.device } : {}),
      ...(deps.openLink ? { openLink: deps.openLink } : {}),
    });
    // A view that draws the talk button hears when the microphone behind it goes off.
    const voice = deps.voice;
    if (deps.talk && voice) voice.subscribe(() => this.mounted?.bridge.mic(hostMic(voice)));
    window.addEventListener("message", (ev) => this.onMessage(ev));
  }

  get manifest(): ViewManifest | undefined {
    return this.mounted?.manifest;
  }

  /** `view.list` → the default → `view.get` → stage → frame. Once at a time. */
  load(): Promise<void> {
    if (!this.loading) {
      this.loading = this.doLoad().finally(() => {
        this.loading = undefined;
      });
    }
    return this.loading;
  }

  private async doLoad(): Promise<void> {
    const { conn, container } = this.deps;
    const { views } = await conn.request<{ views: ViewManifest[] }>("view.list", {});
    const listed = chooseView(views);
    if (!listed) throw new Error("cophylad serves no view");
    const staged = await this.deps.stage(listed);
    // The version that was staged is the one mounted: a later `view.list` compares against it.
    const manifest: ViewManifest = staged.version !== undefined ? { ...listed, version: staged.version } : listed;
    const base = staged.base;

    this.unmount();
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", FRAME_SANDBOX);
    frame.setAttribute("title", manifest.name);
    frame.src = base + manifest.entry;
    const bridge = new Bridge(
      {
        manifest,
        clientScopes: conn.state.hello?.client.scopes ?? [],
        instance: ++this.instances,
        ...(this.deps.host ? { host: this.deps.host } : {}),
        ...(this.deps.menu ? { menu: true } : {}),
        ...(this.deps.talk ? { talk: true } : {}),
        chooseView: () => this.chooseView(),
        openSettings: () => this.openSettings(),
        ...(this.deps.openLink ? { openLink: (url: string) => this.openLink(url) } : {}),
        ...(this.deps.filePaths ? { filePaths: this.deps.filePaths } : {}),
        ...(staged.docFrame ? { docFrame: staged.docFrame } : {}),
        ...(this.deps.embed ? { embed: true } : {}),
        ...(this.deps.desk ? { desk: true } : {}),
        prefs: prefsStore(this.deps.store ?? pageStorage(), manifest.id),
      },
      {
        toCophylad: (req) => conn.send(req).catch((e) => this.fail(String(e instanceof Error ? e.message : e))),
        toView: (msg) => frame.contentWindow?.postMessage(envelope(msg), "*"),
      },
    );
    this.mounted = { frame, bridge, manifest };
    // Kept by the bridge until the view is ready to hear it.
    if (this.deps.talk && this.deps.voice) bridge.mic(hostMic(this.deps.voice));
    if (this.recordingNow) bridge.recording(true);
    let loaded = false;
    frame.addEventListener("load", () => {
      if (this.mounted?.frame !== frame) return;
      // the view loaded itself again: what the host laid over its last document goes
      if (loaded) this.deps.onUnmount?.();
      loaded = true;
      if (conn.connected && conn.state.hello) {
        bridge.ready(conn.state.hello);
        for (const n of this.deps.cache.replay()) bridge.fromCophylad(n);
      } else {
        bridge.disconnected();
      }
    });
    container.replaceChildren(frame);
  }

  private unmount(): void {
    if (!this.mounted) return;
    this.mounted.frame.remove();
    this.mounted = undefined;
    this.deps.onUnmount?.();
  }

  /** The picker or the settings opened or closed: the host hears whether either is open now. */
  private overlay(): void {
    this.deps.onOverlay?.(this.chooser.isOpen || this.settings.isOpen);
  }

  /** The view picker over the frame: what a view's `host.chooseView` opens. */
  chooseView(): void {
    this.chooser.open();
  }

  /** The host's settings over the frame: what a view's `host.settings` opens. */
  openSettings(): void {
    this.settings.open();
  }

  /** A view's `host.openLink`, while the user's click is fresh: in a browser without the signal, as it comes. */
  private async openLink(url: string): Promise<void> {
    if (navigator.userActivation && !navigator.userActivation.isActive) throw new Error("a link opens only when it is clicked");
    await this.deps.openLink!(url);
  }

  /** The host's menu button: the mounted view is told, and shows or hides what it keeps there. */
  menu(): void {
    this.mounted?.bridge.menu();
  }

  /** The host's microphone started or stopped recording an utterance: the mounted view is told, and one mounted later. */
  recording(active: boolean): void {
    this.recordingNow = active;
    this.mounted?.bridge.recording(active);
  }

  /** How loud the microphone was over its last frame, while it records. */
  levels(levels: number[]): void {
    this.mounted?.bridge.levels(levels);
  }

  /** A stream the host showed for the view is gone: the mounted view is told. */
  streamClosed(stream: string): void {
    this.mounted?.bridge.streamClosed(stream);
  }

  /** Every frame from cophylad that is not the host's own response. */
  handleFrame(frame: RpcMessage): void {
    this.mounted?.bridge.fromCophylad(frame);
  }

  handleState(snapshot: LinkSnapshot): void {
    const m = this.mounted;
    if (!m) return;
    if (snapshot.state === "connected" && snapshot.hello) {
      m.bridge.ready(snapshot.hello);
      for (const n of this.deps.cache.replay()) m.bridge.fromCophylad(n);
      void this.reloadIfStale(m.manifest);
    } else {
      m.bridge.disconnected();
    }
  }

  /**
   * cophylad says a view's files moved, or the default did. An edit lands as a burst of
   * notices, so they are gathered for a moment and one `view.list` decides; a view half
   * written keeps the mounted one, since a load swaps frames only once `view.get` and the
   * staging have succeeded.
   */
  onChanged(_id: string): void {
    if (!this.mounted || this.changedTimer) return;
    this.changedTimer = setTimeout(() => {
      this.changedTimer = undefined;
      const m = this.mounted;
      if (m) void this.reloadIfStale(m.manifest);
    }, CHANGED_COALESCE_MS);
  }

  /**
   * After a reconnect the daemon may be a newer one, serving newer files: the mounted view
   * is readied at once so the reconnect costs nothing, and replaced only when `view.list`
   * says it moved. A load already in flight fetches the fresh view on its own.
   */
  private async reloadIfStale(mounted: ViewManifest): Promise<void> {
    if (this.loading) return;
    try {
      const { views } = await this.deps.conn.request<{ views: ViewManifest[] }>("view.list", {});
      if (this.mounted?.manifest !== mounted) return;
      if (isStale(mounted, chooseView(views))) await this.load();
    } catch (e) {
      this.fail(`view: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private onMessage(ev: MessageEvent): void {
    const m = this.mounted;
    if (!m || !m.frame.contentWindow || ev.source !== m.frame.contentWindow) return;
    if (!isEnvelope(ev.data)) return;
    m.bridge.fromView(ev.data);
  }

  private fail(message: string): void {
    this.deps.onError?.(message);
  }
}
