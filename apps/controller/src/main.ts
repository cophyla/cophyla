// The browser entry: the controller page the node serves on its LAN listener. The link is
// the page's own socket back to that origin; views are staged by the node under a ticket;
// the credential lives in the page's storage, or, on a shared computer, in its memory alone.
// This build stays LAN-only: its content policy is `connect-src 'self'`, so the relay is the
// native app's (`native.ts`).
//
// One build, two forms. In a wide window with a pointer (decided once, at load) the page is the
// whole panel on a computer: no bar, the view's own talk button, a remote desktop beside the
// view, and the link and the microphone kept while the tab is in the background. Anywhere else
// it is the phone's page, as it was. Either pairs with a key typed here, or carried by the
// link that opened the page: the key is read from the fragment and the fragment cleared before
// anything else runs, so it is in no history entry and no later URL.

import type { NotifyAsk } from "@cophyla/viewhost";
import { keyFromFragment } from "@cophyla/protocol";
import { boot } from "./app.ts";
import { browserStore, codeFromUrl, guessBrowser, guessName } from "./pairing.ts";
import { lanTransport } from "./transport.ts";
import { indexedDbCache } from "@cophyla/voicehost";

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/client`;
/** The asks' notifications up, by ask: a settled ask closes its own. */
const asksShown = new Map<string, Notification>();

/** A wide window with a pointer, on a computer: decided once, so the page does not change form under the user. */
const desk = window.matchMedia("(min-width: 900px) and (pointer: fine)").matches;

// A key in the link that opened the page: taken, and gone from the address bar.
const keyFromLaunch = keyFromFragment(location.hash);
if (location.hash !== "") history.replaceState(null, "", location.pathname + location.search);

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

let marks: Storage | undefined;
try {
  marks = sessionStorage;
} catch {
  marks = undefined;
}

const app = boot({
  name: desk ? guessBrowser(navigator.userAgent) : guessName(navigator.userAgent),
  device: desk ? "browser" : "phone",
  desk,
  keyPairing: true,
  ...(keyFromLaunch ? { keyFromLaunch } : {}),
  address: location.origin,
  ...(marks ? { marks } : {}),
  link: {
    store: browserStore(localStorage),
    // the page's own origin, whatever the credential recorded: this page is served by the node it pairs with
    lan: () => [lanTransport(wsUrl)],
  },
  // an invite pasted here is redeemed on the page's own socket: the relay is the native app's
  inviteWays: () => ({ lans: [lanTransport(wsUrl)] }),
  // A node that serves the document frame names it (`docFrame`); an older one does not.
  stage: (conn, manifest) => conn.request<{ base: string; version: string; docFrame?: string }>("view.stage", { id: manifest.id }),
  // a stream's page comes from the node's stream port, into a frame of this page's own
  frames: true,
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
  // a phone's screen is kept on while something listens; a computer's is its own business
  ...(desk ? {} : { keepAwake }),
  // The wake files come from the node over a certificate Chromium will not cache for: kept here, checked on arrival.
  wake: { cache: indexedDbCache(), verify: true },
  ...(codeFromUrl(location.search) ? { codeFromLaunch: codeFromUrl(location.search)! } : {}),
});

// A phone with the screen off should hold no microphone and no socket. A computer's tab in the
// background keeps both: it is the panel, and what it hears is asked for in its settings. A
// shared computer's keeps its socket too: the node ends its session a little after its last one.
document.addEventListener("visibilitychange", () => {
  if (desk || app.session) return;
  if (document.visibilityState === "hidden") app.background();
  else app.foreground();
});

// A shared computer's tab going away says so to the node, which would otherwise wait out the
// linger; and asks first, since a reload ends what cannot be got back without pairing again.
window.addEventListener("pagehide", (ev) => {
  if (app.session && !ev.persisted) app.io.revokeSelf();
});
window.addEventListener("beforeunload", (ev) => {
  if (!app.session) return;
  ev.preventDefault();
  ev.returnValue = "";
});
