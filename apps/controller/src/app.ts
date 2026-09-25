// The controller app: the phone's microphone and speaker around the same view host the
// desktop app runs. It pairs once — with a code from the desktop, with an invite the desktop
// made for it (pasted, or opened as a link), or, in the native app, by signing in with the
// account from any network — keeps the token it is given, and from
// then on holds a link to the node while it is open: over the LAN, or through the server
// relay when the LAN is out of reach and the node granted the access.
//
// The parts it adds over the view host: voice (`@cophyla/voicehost`, which the desktop app
// runs too) — the microphone, which the app starts itself and the browser at the Start tap it
// needs, the wake word the phone listens for the whole time it is open (unless listening was
// turned off in its menu), and the speaker; its own bar, with the talk button; and views,
// staged by the platform — the node serves them under a ticket to the browser, the native app
// writes them to its own storage.
// `boot(platform)` is what the two entries call: `main.ts` for the browser the node serves,
// `native.ts` for the Capacitor app.

import { Connection, SnapshotCache, ViewHost, AskNotifier } from "@cophyla/viewhost";
import type { LinkSnapshot, RpcMessage, Staged } from "@cophyla/viewhost";
import type { Controller, InviteBody, ViewManifest } from "@cophyla/protocol";
import type { NotifyAsk } from "@cophyla/viewhost";
import { VoiceHost } from "@cophyla/voicehost";
import type { Audio, FileCache } from "@cophyla/voicehost";
import { deriveChrome } from "./chrome.ts";
import type { ChromeInput } from "./chrome.ts";
import { LinkCore } from "./link-core.ts";
import type { InviteWays, LinkCoreOptions } from "./link-core.ts";
import { parseCode, parseInviteLink, readListen, writeListen } from "./pairing.ts";
import type { NodeAddress } from "./pairing.ts";
import type { Transport } from "./transport.ts";
import { bind, elements, render, showInvite } from "./ui.ts";
import type { UiElements } from "./ui.ts";

/** What the browser and the native app each supply. */
export interface AppPlatform {
  /** The link core's transports and store. */
  link: Omit<LinkCoreOptions, "name">;
  name: string;
  /** Where a view's files come from, for the frame. */
  stage: (conn: Connection, manifest: ViewManifest) => Promise<Staged>;
  /** A `host.open` from a view. */
  hostOpen: (params: unknown) => Promise<unknown>;
  /** A web page a view's user clicked (`host.openLink`), in the browser. */
  openLink?: (url: string) => Promise<void>;
  /** An ask to show while the app has a window; the native app leaves this to the push. */
  notify: (ask: NotifyAsk) => Promise<void>;
  /** A settled ask's notification taken down; the push withdraws its own. */
  dismiss: (id: string) => Promise<void>;
  /** The transport pairing goes over, from what the user typed (the native app's address field); the browser's own URL otherwise. */
  pairingTransport?: (address: NodeAddress | undefined) => Transport | undefined;
  /** The pairing form has an address field: the native app must be told where the node is. */
  askAddress?: boolean;
  /** Called once the link is built: the native app wires push and deep links here. */
  ready?: (app: App) => void;
  /** The native app's sign-in with the account: opens the server's page in the browser; the grant comes back as a deep link. */
  signIn?: () => Promise<void>;
  /** The ways to the node an invite names, as this platform opens them; absent where an invite cannot be used. */
  inviteWays?: (invite: InviteBody) => InviteWays;
  /** A code the app was opened with. */
  codeFromLaunch?: string;
  /** Names the first LAN URL for the credential, given the transport pairing used. */
  keepAwake?: (want: boolean) => Promise<void>;
  /** The microphone and the speaker start once paired, with no Start tap: the app's web view lets audio start without a gesture. */
  autoStart?: boolean;
  /** How the wake files are kept: the browser page caches and checks what it fetched; the app has them as assets. */
  wake?: { cache?: FileCache; verify?: boolean };
}

/** How long the app waits for its audio to start on its own before asking for the Start tap. */
export const AUTO_START_MS = 4000;

export interface App {
  conn: Connection;
  io: LinkCore;
  voice: VoiceHost;
  audio: Audio;
  ui: UiElements;
  state: ChromeInput;
  paint(): void;
  /** The m8 rule on a phone going away: the microphone off, the button up, the link paused. */
  background(): void;
  foreground(): void;
  /** A remote desktop covers the app, or no longer does: the microphone and the wake word stand down meanwhile, and the speaker is quiet. */
  watching(on: boolean): void;
  /** The sign-in came back with its grant: pairs over the tunnel it opens, and says how it went on the pairing screen. */
  pairThroughAccount(transport: Transport): Promise<void>;
  /** A word on the pairing screen: what the sign-in is doing, or why it stopped. */
  pairNote(text: string, error?: boolean): void;
  /** An invite the app was opened with: the pairing screen names its node and asks to join. */
  offerInvite(text: string): void;
}

export function boot(platform: AppPlatform, doc: Document = document): App {
  const ui = elements(doc);
  ui.pairName.placeholder = platform.name;
  if (platform.codeFromLaunch) ui.pairCode.value = platform.codeFromLaunch;
  if (platform.askAddress && ui.pairAddress) ui.pairAddress.hidden = false;
  if (platform.signIn && ui.pairAccount) {
    ui.pairAccount.hidden = false;
    if (ui.pairOr) ui.pairOr.hidden = false;
  }

  const io = new LinkCore({ ...platform.link, name: platform.name });
  const conn = new Connection(io);
  const cache = new SnapshotCache();

  let storage: Storage | undefined;
  try {
    storage = doc.defaultView?.localStorage;
  } catch {
    storage = undefined;
  }

  const state: ChromeInput = {
    link: "starting",
    paired: false,
    audioReady: false,
    sttReady: true,
    listening: readListen(storage),
    wake: "node",
    pending: false,
    talking: false,
    muted: false,
    ...(platform.autoStart ? { autoStart: true } : {}),
  };

  // The microphone, the wake word and the speaker: what the phone says in its hello follows
  // what WebCodecs speaks.
  const voice = new VoiceHost({
    link: conn,
    backlog: () => io.backlog(),
    ...(platform.wake ? { wake: platform.wake } : {}),
    listening: state.listening,
    onChange: () => paint(),
    onCodecs: (codecs) => {
      io.codecs = codecs;
    },
  });
  const audio = voice.audio;

  const viewhost = new ViewHost({
    conn,
    cache,
    container: ui.view,
    stage: (manifest) => platform.stage(conn, manifest),
    host: (method, params) => (method === "host.open" ? platform.hostOpen(params) : Promise.reject(new Error(`no ${method}`))),
    ...(platform.openLink ? { openLink: platform.openLink } : {}),
    // The bar's menu button shows and hides the view's rail.
    menu: true,
    onError: (message) => console.warn(message),
  });

  const notifier = new AskNotifier({
    notify: (ask) => platform.notify(ask),
    dismiss: (id) => platform.dismiss(id),
    answer: (id, option) => conn.request("ask.answer", { id, option }),
    showWindow: () => {},
    onError: (message) => console.warn(message),
  });

  let loaded = false;

  /** What voice shows, into the chrome's input. */
  function sync(): void {
    const v = voice.view;
    state.audioReady = v.audioReady;
    if (v.voice) state.voice = v.voice;
    else delete state.voice;
    state.wake = v.wake;
    state.pending = v.pending;
    state.talking = v.talking;
    state.listening = v.listening;
    state.muted = v.muted;
    if (v.watching) state.watching = true;
    else delete state.watching;
  }

  /** The bar and the screens, and the screen kept on while something listens. */
  function paint(): void {
    sync();
    const chrome = deriveChrome(state);
    render(ui, chrome, state.listening);
    void platform.keepAwake?.(chrome.awakeLock);
  }

  // Where the wake word and the voice's audio stand, for Playwright and chrome://inspect.
  const view = doc.defaultView as (Window & { __cophylaWake?: unknown; __cophylaVoice?: unknown }) | null;
  if (view) {
    view.__cophylaVoice = {
      get state() {
        return { ...voice.audioState, backlog: io.backlog() };
      },
    };
    view.__cophylaWake = {
      get state() {
        return voice.wakeState;
      },
    };
  }

  /** The context, the worklet, then the microphone: inside the Start tap in a browser, on its own in the app. */
  async function startAudio(): Promise<void> {
    await voice.start();
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
    paint();
  }

  /**
   * The app listens from the moment it is paired and open. Only the context is timed: the
   * microphone may wait on the phone's permission prompt for as long as the user reads it.
   * A context the web view holds back, or a microphone refused, hands over to the Start
   * screen with the reason, and the tap does it instead.
   */
  let autoStarting = false;
  function autoStart(): void {
    if (!state.autoStart || !state.paired || voice.view.audioReady || autoStarting) return;
    autoStarting = true;
    const late = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), AUTO_START_MS));
    void Promise.race([voice.openAudio().then(() => "open" as const), late])
      .then(async (how) => {
        if (how === "late") throw new Error("The audio did not start on its own: tap Start.");
        await startAudio();
      })
      .catch((e: unknown) => {
        state.autoStart = false;
        ui.gateError.textContent = e instanceof Error ? e.message : String(e);
        ui.gateError.hidden = false;
        paint();
      })
      .finally(() => {
        autoStarting = false;
      });
  }

  // --- frames from the node ------------------------------------------------------------------

  conn.onFrame((frame: RpcMessage) => {
    if ("method" in frame && !("id" in frame)) {
      // Speech is played here and never handed to the view.
      if (voice.handleFrame(frame)) return;
      cache.upsert(frame);
      notifier.onNotification(frame);
      if (frame.method === "view.changed") viewhost.onChanged((frame.params as { id: string }).id);
    }
    viewhost.handleFrame(frame);
  });

  conn.onState((snapshot: LinkSnapshot) => {
    state.link = snapshot.state;
    if (snapshot.error !== undefined) state.error = snapshot.error;
    else delete state.error;
    state.paired = io.credential !== undefined;
    state.via = io.via;
    if (io.via === "p2p" && io.snapshot.path) state.path = io.snapshot.path;
    else delete state.path;
    voice.setVia(io.via);
    if (snapshot.state !== "connected") cache.clear();
    else notifier.onConnected();
    // Down, the conversation is gone; up, it is a new one: the phone's word starts over with it.
    voice.linkChanged(snapshot.state === "connected");
    paint();
    if (snapshot.state === "connected" && !loaded) {
      loaded = true;
      viewhost.load().catch((e: unknown) => {
        loaded = false;
        console.warn("view", e);
      });
      return;
    }
    viewhost.handleState(snapshot);
  });

  // --- what the user does -----------------------------------------------------------------------

  const pairNote = (text: string, error = false): void => {
    ui.pairError.textContent = error ? text : "";
    ui.pairError.hidden = !error;
    if (ui.pairStatus) {
      ui.pairStatus.textContent = error ? "" : text;
      ui.pairStatus.hidden = error || text === "";
    }
  };

  const pairThroughAccount = async (transport: Transport): Promise<void> => {
    // A second grant, from Sign in tapped twice: the first one already paired this phone.
    if (io.credential) return;
    const name = ui.pairName.value.trim() || ui.pairName.placeholder;
    pairNote("Signed in: pairing this phone through your account…");
    try {
      await io.pairAccount(name, transport);
      pairNote("");
      state.paired = true;
      paint();
      autoStart();
    } catch (e) {
      pairNote(e instanceof Error ? e.message : String(e), true);
    }
  };

  /** The invite read last, waiting for Join. */
  let invite: InviteBody | undefined;
  const readInvite = (text: string): string => {
    const body = parseInviteLink(text);
    if (io.credential) throw new Error("this phone is paired already: forget it first, from the ⋯ menu");
    if (!platform.inviteWays) throw new Error("this app cannot use an invite");
    invite = body;
    return body.node.name;
  };
  const offerInvite = (text: string): void => {
    try {
      showInvite(ui, readInvite(text));
      pairNote("");
    } catch (e) {
      if (io.credential) console.warn("invite", e);
      else pairNote(e instanceof Error ? e.message : String(e), true);
    }
  };

  bind(ui, {
    readInvite,
    redeem: async (chosen) => {
      const body = invite;
      if (!body || !platform.inviteWays) throw new Error("paste the invite first");
      await io.redeem({ grant: body.grant, secret: body.secret }, chosen, platform.inviteWays(body));
      invite = undefined;
      state.paired = true;
      paint();
      autoStart();
    },
    cancelInvite: () => {
      invite = undefined;
    },
    signIn: async () => {
      if (!platform.signIn) throw new Error("this app cannot sign in");
      await platform.signIn();
      pairNote("Finish signing in with GitHub in the browser; the app pairs as soon as it is back.");
    },
    pair: async (code, chosen, address) => {
      const digits = parseCode(code);
      if (!digits) throw new Error("the code is six digits");
      const transport = platform.pairingTransport?.(address);
      if (platform.askAddress && !transport) throw new Error("the node's address is host:port");
      await io.pair(digits, chosen, transport);
      state.paired = true;
      paint();
      autoStart();
    },
    // Inside the gesture.
    start: startAudio,
    menu: () => viewhost.menu(),
    listen: (on) => {
      writeListen(storage, on);
      voice.listen(on);
    },
    ptt: (down) => voice.ptt(down),
    mute: (on) => voice.mute(on),
    forget: async () => {
      const credential = io.credential;
      if (credential && conn.connected) await conn.request("controller.revoke", { id: credential.controller }).catch(() => {});
      io.forget();
      state.paired = false;
      paint();
    },
  });

  const app: App = {
    conn,
    io,
    voice,
    audio,
    ui,
    state,
    paint,
    background: () => {
      voice.pause();
      io.suspend();
    },
    watching: (on) => voice.watch(on),
    foreground: () => {
      io.resume();
      // The microphone is back after a gap: what the word carried on from is gone.
      void voice.resume();
    },
    pairThroughAccount,
    pairNote,
    offerInvite,
  };

  paint();
  void io
    .load()
    .then(() => {
      state.paired = io.credential !== undefined;
      paint();
      platform.ready?.(app);
      autoStart();
      return conn.attach();
    })
    .then((snapshot) => {
      state.link = snapshot.state;
      paint();
    })
    .catch((e: unknown) => console.warn("attach", e));
  return app;
}

/** The controller row a pairing answered, for a caller that wants it. */
export type Paired = Controller;
