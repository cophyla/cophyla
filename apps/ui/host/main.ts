// The host page: a multiplexer between the shell and the view. It attaches to the shell's
// link, keeps the daemon's snapshot for whatever view mounts, loads the default view into
// a sandboxed frame and reloads it when cophylad says it changed, and toasts asks. Until a view
// is up it says where the link is, in one line; after that it renders nothing of its own:
// the view is the product, and shows the link itself. A staged update is the tray's. Another
// node's desktop opens, through `host.open`, in a window of its own or beside the view, laid
// over the frame where the view places it (open.ts); a link clicked in a view (`host.openLink`) opens in the system browser. Where the files a
// view had dropped on it from the desktop are (`host.filePaths`) the shell says, from the drop
// it saw pass into the page (dropped.rs); on Windows the view asks WebView2 for them instead.
// Voice is voice.ts: the microphone, the wake words, the talk key and the speaker, and its
// section in Settings. For where the node reads replies out, the page says whether the window
// is in front and shown (`voice.presence`), on every connect and as that changes; focus moving
// into the view's frame is still the window's.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ViewContent } from "@cophyla/protocol";
import { AskNotifier, Connection, SnapshotCache, ViewHost } from "@cophyla/viewhost";
import type { Activated, LinkSnapshot, TauriIo } from "@cophyla/viewhost";
import { StreamWindows } from "./open.ts";
import { DesktopVoice } from "./voice.ts";

const io: TauriIo = {
  invoke: (cmd, args) => invoke(cmd, args),
  listen: (event, handler) => listen(event, (e) => handler(e.payload as never)).then((off) => off),
};

const statusEl = document.getElementById("status")!;
const viewEl = document.getElementById("view")!;
const appWindow = getCurrentWindow();

const conn = new Connection(io);
const cache = new SnapshotCache();
const voice = new DesktopVoice({
  link: conn,
  invoke: io.invoke,
  listen: io.listen,
  store: (() => {
    try {
      return window.localStorage;
    } catch {
      return undefined;
    }
  })(),
  // The view draws the microphone while it records, over its input.
  onRecording: (on) => viewhost.recording(on),
  onLevels: (levels) => viewhost.levels(levels),
  log: (m) => console.info(m),
});
const streams = new StreamWindows({
  invoke: io.invoke,
  request: (method, params) => conn.request(method, params),
  // a stream beside the view is placed in the frame's coordinates
  frame: () => viewEl.querySelector("iframe")?.getBoundingClientRect(),
  onClosed: (stream) => viewhost.streamClosed(stream),
  log: (m) => console.warn(m),
});
// The view's files come over the host's connection and are staged on the shell's native side.
const viewhost = new ViewHost({
  conn,
  cache,
  container: viewEl,
  host: streams.host,
  // a stream's page laid over the view: hidden under the host's own layers, gone with the view's document
  embed: true,
  onOverlay: (open) => streams.overlay(open),
  onUnmount: () => streams.unmounted(),
  openLink: (url) => io.invoke<void>("open_link", { url }),
  // With no names on Linux, whose web view shows a page no dropped file (dropped.rs).
  filePaths: (names) => io.invoke<string[]>("dropped_paths", { names: names ?? null }),
  // The app has a microphone and no bar of its own: the view draws the talk button.
  talk: true,
  voice,
  stage: async (manifest) => {
    const content = await conn.request<ViewContent>("view.get", { id: manifest.id });
    // An older shell serves no document frame, and names none.
    const { base, docFrame } = await io.invoke<{ base: string; docFrame?: string }>("view_stage", { view: content });
    return { base, version: content.version, ...(docFrame ? { docFrame } : {}) };
  },
  onError: (m) => note(m),
});
const notifier = new AskNotifier({
  notify: (ask) => io.invoke<void>("notify_ask", { ask }),
  dismiss: (id) => io.invoke<void>("dismiss_ask", { ask: id }),
  answer: (id, option) => conn.request("ask.answer", { id, option }),
  showWindow: () => void showWindow(),
  onError: (m) => note(m),
  // an ask is toasted where someone is: this machine's input, and its desktop not streamed elsewhere
  idleMs: async () => (await io.invoke<number | null>("user_idle_ms")) ?? undefined,
  // the machine this app is on, which a relayed hello's `node` (the primary) is not
  node: () => conn.state.hello?.client.node ?? conn.state.hello?.node,
});

let lastNote = "";
let loaded = false;

function note(message: string): void {
  lastNote = message;
  console.warn(message);
  renderStatus(conn.state);
}

async function showWindow(): Promise<void> {
  try {
    await appWindow.show();
    await appWindow.unminimize();
    await appWindow.setFocus();
  } catch (e) {
    console.warn("show window", e);
  }
}

function statusText(s: LinkSnapshot): string {
  switch (s.state) {
    case "starting":
      return "starting cophylad…";
    case "connecting":
      return "connecting to cophylad…";
    case "connected":
      return `connected${s.hello ? ` — ${s.hello.node} · platform ${s.hello.platformVersion}` : ""}`;
    case "disconnected":
      return `disconnected${s.error ? ` — ${s.error}` : ""}`;
    case "unauthorized":
      return `cophylad refused the connection${s.error ? ` — ${s.error}` : ""}`;
  }
}

/** The line shows only while no view is mounted: starting, connecting, or a view that did not load. */
function renderStatus(s: LinkSnapshot): void {
  statusEl.hidden = viewhost.manifest !== undefined;
  statusEl.dataset["state"] = s.state;
  const parts = [statusText(s)];
  if (lastNote) parts.push(lastNote);
  statusEl.textContent = parts.join(" · ");
}

function renderTitle(): void {
  const n = cache.sessions.size;
  void appWindow.setTitle(n === 0 ? "Cophyla" : `Cophyla — ${n} session${n === 1 ? "" : "s"}`).catch(() => {});
}

conn.onFrame((frame) => {
  if ("method" in frame && !("id" in frame)) {
    // Speech is played here and never handed to the view.
    if (voice.handleFrame(frame)) return;
    cache.upsert(frame);
    notifier.onNotification(frame);
    if (frame.method === "session.state") renderTitle();
    if (frame.method === "view.changed") viewhost.onChanged((frame.params as { id: string }).id);
  }
  viewhost.handleFrame(frame);
});

/** Whether the window is in front and shown, as far as this page can tell. */
function tellWindow(p: { focused?: boolean; visible?: boolean } = { focused: document.hasFocus(), visible: document.visibilityState === "visible" }): void {
  if (conn.state.state !== "connected") return;
  void conn.send({ jsonrpc: "2.0", method: "voice.presence", params: p }).catch(() => {});
}
window.addEventListener("focus", () => tellWindow({ focused: true }));
// A blur that only moved the focus into the view's frame leaves the window in front.
window.addEventListener("blur", () => setTimeout(() => tellWindow({ focused: document.hasFocus() }), 0));
document.addEventListener("visibilitychange", () => tellWindow({ visible: document.visibilityState === "visible" }));

conn.onState((s) => {
  if (s.state !== "connected") cache.clear();
  else {
    notifier.onConnected();
    tellWindow();
  }
  voice.linkChanged(s);
  if (s.state === "disconnected" || s.state === "unauthorized") streams.linkLost();
  renderStatus(s);
  renderTitle();
  if (s.state === "connected" && !loaded) {
    loaded = true;
    viewhost
      .load()
      .then(() => {
        lastNote = "";
        renderStatus(conn.state);
      })
      .catch((e) => {
        loaded = false;
        note(`view: ${e instanceof Error ? e.message : String(e)}`);
      });
    return;
  }
  viewhost.handleState(s);
});

void io.listen<Activated>("ask:activated", (a) => void notifier.onActivated(a));
void io.listen<{ stream: string }>("stream:closed", (e) => streams.closed(e.stream));

// Where the wake word and the voice's audio stand, for Playwright over the web view's debugger.
Object.assign(window, {
  __cophylaVoice: {
    get state() {
      return voice.host.audioState;
    },
  },
  __cophylaWake: {
    get state() {
      return { ...voice.host.wakeState, view: voice.host.view };
    },
  },
});

// The hello says what the page has for audio, so the link attaches once WebCodecs has answered.
void voice
  .helloAudio()
  .then((audio) => conn.attach({ audio }))
  .then((s) => renderStatus(s))
  .catch((e) => note(`attach: ${e instanceof Error ? e.message : String(e)}`));
void voice.start().catch((e: unknown) => console.warn("voice", e));
