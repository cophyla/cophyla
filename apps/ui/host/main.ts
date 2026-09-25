// The host page: a multiplexer between the shell and the view. It attaches to the shell's
// link, keeps the daemon's snapshot for whatever view mounts, loads the default view into
// a sandboxed frame and reloads it when cophylad says it changed, and toasts asks. Until a view
// is up it says where the link is, in one line; after that it renders nothing of its own:
// the view is the product, and shows the link itself. A staged update is the tray's. A
// desktop with no route to it opens, through `host.open`, in a window of its own (open.ts);
// a link clicked in a view (`host.openLink`) opens in the system browser.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ViewContent } from "@cophyla/protocol";
import { AskNotifier, Connection, SnapshotCache, ViewHost } from "@cophyla/viewhost";
import type { Activated, LinkSnapshot, TauriIo } from "@cophyla/viewhost";
import { StreamWindows } from "./open.ts";

const io: TauriIo = {
  invoke: (cmd, args) => invoke(cmd, args),
  listen: (event, handler) => listen(event, (e) => handler(e.payload as never)).then((off) => off),
};

const statusEl = document.getElementById("status")!;
const viewEl = document.getElementById("view")!;
const appWindow = getCurrentWindow();

const conn = new Connection(io);
const cache = new SnapshotCache();
const streams = new StreamWindows({ invoke: io.invoke, request: (method, params) => conn.request(method, params), log: (m) => console.warn(m) });
// The view's files come over the host's connection and are staged on the shell's native side.
const viewhost = new ViewHost({
  conn,
  cache,
  container: viewEl,
  host: streams.host,
  openLink: (url) => io.invoke<void>("open_link", { url }),
  stage: async (manifest) => {
    const content = await conn.request<ViewContent>("view.get", { id: manifest.id });
    const { base } = await io.invoke<{ base: string }>("view_stage", { view: content });
    return { base, version: content.version };
  },
  onError: (m) => note(m),
});
const notifier = new AskNotifier({
  notify: (ask) => io.invoke<void>("notify_ask", { ask }),
  dismiss: (id) => io.invoke<void>("dismiss_ask", { ask: id }),
  answer: (id, option) => conn.request("ask.answer", { id, option }),
  showWindow: () => void showWindow(),
  onError: (m) => note(m),
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
    cache.upsert(frame);
    notifier.onNotification(frame);
    if (frame.method === "session.state") renderTitle();
    if (frame.method === "view.changed") viewhost.onChanged((frame.params as { id: string }).id);
  }
  viewhost.handleFrame(frame);
});

conn.onState((s) => {
  if (s.state !== "connected") cache.clear();
  else notifier.onConnected();
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

conn
  .attach()
  .then((s) => renderStatus(s))
  .catch((e) => note(`attach: ${e instanceof Error ? e.message : String(e)}`));
