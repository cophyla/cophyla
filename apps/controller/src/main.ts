// The browser entry: the controller page the node serves on its LAN listener. The link is
// the page's own socket back to that origin; views are staged by the node under a ticket;
// the credential lives in the page's storage. This build stays LAN-only: its content policy
// is `connect-src 'self'`, so the relay is the native app's (`native.ts`).

import type { NotifyAsk } from "@cophyla/viewhost";
import { boot } from "./app.ts";
import { codeFromUrl, guessName, syncStore } from "./pairing.ts";
import { hostOpen } from "./remote.ts";
import { lanTransport } from "./transport.ts";
import { indexedDbCache } from "@cophyla/voicehost";

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/client`;
/** The asks' notifications up, by ask: a settled ask closes its own. */
const asksShown = new Map<string, Notification>();

async function keepAwake(want: boolean): Promise<void> {
  try {
    const api = (navigator as unknown as { wakeLock?: { request(kind: string): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (!api) return;
    if (want && !wakeLock) wakeLock = await api.request("screen");
    else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = undefined;
    }
  } catch {
    // A wake lock is a nicety; a phone that refuses one still works while the screen is on.
  }
}
let wakeLock: { release(): Promise<void> } | undefined;

const app = boot({
  name: guessName(navigator.userAgent),
  link: {
    store: syncStore(localStorage),
    // the page's own origin, whatever the credential recorded: this page is served by the node it pairs with
    lan: () => [lanTransport(wsUrl)],
  },
  // an invite pasted here is redeemed on the page's own socket: the relay is the native app's
  inviteWays: () => ({ lans: [lanTransport(wsUrl)] }),
  stage: (conn, manifest) => conn.request<{ base: string; version: string }>("view.stage", { id: manifest.id }),
  hostOpen: (params) => hostOpen(params, location.origin, window),
  openLink: async (url) => void window.open(url, "_blank", "noopener"),
  notify: async (ask: NotifyAsk) => {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    // No action buttons: the view's own ask form is where an answer is given.
    const shown = new Notification(ask.title, { body: ask.detail ?? "", tag: ask.id });
    asksShown.set(ask.id, shown);
    shown.onclose = () => {
      if (asksShown.get(ask.id) === shown) asksShown.delete(ask.id);
    };
  },
  dismiss: async (id: string) => {
    asksShown.get(id)?.close();
    asksShown.delete(id);
  },
  keepAwake,
  // The wake files come from the node over a certificate Chromium will not cache for: kept here, checked on arrival.
  wake: { cache: indexedDbCache(), verify: true },
  ...(codeFromUrl(location.search) ? { codeFromLaunch: codeFromUrl(location.search)! } : {}),
});

// A phone with the screen off should hold no microphone and no socket.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") app.background();
  else app.foreground();
});
