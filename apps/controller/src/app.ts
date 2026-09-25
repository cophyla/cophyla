// The controller app: the phone's microphone and speaker around the same view host the
// desktop app runs. It pairs once — with a code from the desktop, with an invite the desktop
// made for it (pasted, or opened as a link), or, in the native app, by signing in with the
// account from any network — keeps the token it is given, and from
// then on holds a link to the node while it is open: over the LAN, or through the server
// relay when the LAN is out of reach and the node granted the access.
//
// The parts it adds over the desktop host: the microphone, which the app starts itself and
// the browser at the Start tap it needs; the wake word, which the phone listens for in a
// worker the whole time it is open (unless listening was turned off in its menu), sending
// frames up as `voice.audio` only once it heard the word or while the button is held — a
// node that cannot hand it the word (an older one, or a head this build does not carry) gets
// the stream while the phone listens and detects the word itself, as before; speech, which
// comes back the same way and is played through a jitter buffer, each reply acked with
// `voice.played` once it has played, and dropped the moment the node says the conversation
// is no longer speaking; and views, staged by the platform — the node serves them under a
// ticket to the browser, the native app writes them to its own storage. Audio goes as Opus
// both ways when WebCodecs has it and the node takes it, as PCM otherwise; a frame up is
// numbered, and shed rather than queued when the link already holds more than it can send.
// `boot(platform)` is what the two entries call: `main.ts` for the browser the node serves,
// `native.ts` for the Capacitor app.

import { Connection, SnapshotCache, ViewHost, AskNotifier } from "@cophyla/viewhost";
import type { LinkSnapshot, RpcMessage, Staged } from "@cophyla/viewhost";
import type { AudioCodec, Controller, InviteBody, ViewManifest, VoiceState, WakewordMode } from "@cophyla/protocol";
import type { NotifyAsk } from "@cophyla/viewhost";
import { Audio } from "./audio.ts";
import type { PlayStats, SpeechFrame } from "./audio.ts";
import { detectCodecs, MicEncoder } from "./opus.ts";
import { Uplink } from "./uplink.ts";
import { deriveChrome } from "./chrome.ts";
import type { ChromeInput } from "./chrome.ts";
import { LinkCore } from "./link-core.ts";
import type { InviteWays, LinkCoreOptions } from "./link-core.ts";
import { parseCode, parseInviteLink, readListen, writeListen } from "./pairing.ts";
import type { NodeAddress } from "./pairing.ts";
import { encodeChunk } from "./pcm.ts";
import type { Transport } from "./transport.ts";
import { bind, elements, render, showInvite } from "./ui.ts";
import type { UiElements } from "./ui.ts";
import { WakeDetector } from "./wake/detector.ts";
import type { FileCache } from "./wake/detector.ts";
import { FrameRing } from "./wake/ring.ts";
import { initialWake, PENDING_MS, reduceWake } from "./wake/state.ts";
import type { WakeEvent } from "./wake/state.ts";

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

  let wake = initialWake();
  const state: ChromeInput = {
    link: "starting",
    paired: false,
    audioReady: false,
    sttReady: true,
    listening: readListen(storage),
    wake: wake.mode,
    pending: wake.pending,
    talking: false,
    muted: false,
    ...(platform.autoStart ? { autoStart: true } : {}),
  };

  // --- where each microphone frame goes ---------------------------------------------------------

  let streaming = false;
  let detecting = false;
  let seq = 0;
  const ring = new FrameRing();
  let detector: WakeDetector | undefined;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  const heard = { count: 0, lastScore: 0 };

  // --- the microphone's frames up, and the speech down ------------------------------------------

  /** What this phone speaks, known once WebCodecs has been asked; PCM until then. */
  let codecs: AudioCodec[] = ["pcm"];
  let encoder: MicEncoder | undefined;
  const played = { count: 0, last: undefined as (PlayStats & { reply: number }) | undefined };
  const uplink = new Uplink({
    backlog: () => io.backlog(),
    send: (params) => void conn.send({ jsonrpc: "2.0", method: "voice.audio", params }).catch(() => {}),
  });
  const sendAudio = (chunk: string, codec: AudioCodec): void => void uplink.frame(chunk, codec);

  /** The node said in its hello that it takes Opus, and this phone can make it. */
  const opusUp = (): boolean => codecs.includes("opus") && conn.state.hello?.audio?.codecs.includes("opus") === true;

  const sendFrame = (pcm: Int16Array): void => {
    if (opusUp()) {
      try {
        encoder ??= new MicEncoder(
          (chunk) => sendAudio(chunk, "opus"),
          (e) => {
            console.warn("opus encoder", e);
            codecs = ["pcm"];
            io.codecs = codecs;
          },
        );
        if (encoder.ok) {
          encoder.encode(pcm);
          return;
        }
      } catch (e) {
        console.warn("opus encoder", e);
      }
      encoder?.close();
      encoder = undefined;
      codecs = ["pcm"];
      io.codecs = codecs;
    }
    sendAudio(encodeChunk(pcm), "pcm");
  };

  void detectCodecs().then((found) => {
    codecs = found;
    io.codecs = found;
  });

  const audio = new Audio({
    // Every frame is numbered and kept a moment, so the ones captured while the worker scored the
    // word can follow `voice.wake` up; each goes to the node, to the phone's wake word, or both.
    onFrame: (pcm) => {
      const n = ++seq;
      ring.push(n, pcm);
      if (streaming) sendFrame(pcm);
      if (detecting) detector?.feed(n, pcm);
    },
    onPlayed: (reply, stats) => {
      played.count++;
      played.last = { reply, ...stats };
      if (conn.connected) void conn.send({ jsonrpc: "2.0", method: "voice.played", params: { reply, stats } }).catch(() => {});
    },
    onNote: (message) => console.info(message),
  });

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
  /** The app is in the background: nothing turns the microphone back on until it is not. */
  let away = false;

  function paint(): void {
    render(ui, deriveChrome(state), state.listening);
  }

  /** Which way frames go, from what the chrome derives: to the node, to the wake word, the screen kept on. */
  function refreshForwarding(): void {
    const chrome = deriveChrome(state);
    streaming = chrome.streaming;
    detecting = chrome.detecting;
    void platform.keepAwake?.(chrome.awakeLock);
  }

  /** Something happened to the wake word's bookkeeping: the frames and the page follow it. */
  function dispatch(event: WakeEvent): void {
    wake = reduceWake(wake, event);
    state.wake = wake.mode;
    state.pending = wake.pending;
    if (!wake.pending && pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }
    refreshForwarding();
    paint();
  }

  /** Tells the node which heads this phone can run, once the detector is up and on every connect. */
  function negotiate(): void {
    const d = detector;
    if (!conn.connected || !d?.ready) return;
    void conn
      .request<WakewordMode>("voice.wakeword", { heads: d.heads })
      .then((answer) => {
        if (detector !== d || !d.ready) return;
        if (answer.mode === "phone") d.configure(answer);
        d.reset();
        dispatch({ type: "answer", mode: answer.mode });
      })
      .catch((e: unknown) => {
        // A node from before the phone could hear the word detects it itself.
        if (codeOf(e) === "unsupported") dispatch({ type: "answer", mode: "node" });
        else console.warn("voice.wakeword", e);
      });
  }

  /** The detector or its worker failed: the node takes the word back, for as long as the page is open. */
  function wakeFailed(reason: string): void {
    console.warn("wake word", reason);
    dispatch({ type: "failed" });
    if (conn.connected) void conn.request("voice.wakeword", { heads: [] }).catch(() => {});
  }

  /** Loads the detector once, at the first time the audio starts. */
  function loadDetector(): void {
    if (detector) return;
    const d = new WakeDetector({ ...(platform.wake ?? {}), onWake, onError: wakeFailed });
    detector = d;
    d.load().then(negotiate, (e: unknown) => wakeFailed(e instanceof Error ? e.message : String(e)));
  }

  /**
   * The worker heard the word. The reply stops playing into the microphone, the node is told,
   * and the frames captured since the one that fired go up before the live ones; until the
   * node says `listening` (or three seconds pass) the phone streams on its own say-so.
   */
  function onWake(score: number, heardIn: number): void {
    if (!detecting || !conn.connected) return;
    heard.count++;
    heard.lastScore = Number(score.toFixed(3));
    audio.flush();
    detector?.reset();
    dispatch({ type: "heard", at: Date.now() });
    void conn.request("voice.wake", { score: Math.min(1, Math.max(0, score)) }).catch((e: unknown) => {
      console.warn("voice.wake", e);
      dispatch({ type: "refused", code: codeOf(e) });
    });
    for (const f of ring.after(heardIn)) sendFrame(f.pcm);
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      dispatch({ type: "tick", at: Date.now() });
    }, PENDING_MS);
  }

  // Where the wake word and the voice's audio stand, for Playwright and chrome://inspect.
  const view = doc.defaultView as (Window & { __cophylaWake?: unknown; __cophylaVoice?: unknown }) | null;
  if (view) {
    view.__cophylaVoice = {
      get state() {
        return { codecs, opusUp: opusUp(), up: { ...uplink.counts }, played: { ...played }, backlog: io.backlog(), targetMs: audio.queue?.targetMs, queuedMs: audio.queue?.queuedMs, audio: audio.info, down: { ...audio.counts } };
      },
    };
    view.__cophylaWake = {
      get state() {
        return { detector: detector?.state ?? "idle", mode: wake.mode, pending: wake.pending, streaming, detecting, heard: { ...heard }, loadMs: detector?.loadMs, fromCache: detector?.fromCache ?? 0, configured: detector?.configured, stats: detector?.stats };
      },
    };
  }

  /** The context, the worklet, then the microphone: inside the Start tap in a browser, on its own in the app. */
  async function startAudio(): Promise<void> {
    await audio.open();
    await audio.mic(true);
    state.audioReady = true;
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
    loadDetector();
    refreshForwarding();
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
    if (!state.autoStart || !state.paired || state.audioReady || autoStarting) return;
    autoStarting = true;
    const late = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), AUTO_START_MS));
    void Promise.race([audio.open().then(() => "open" as const), late])
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
      if (frame.method === "voice.audio") {
        // Speech: played here and never handed to the view.
        audio.play(frame.params as SpeechFrame);
        return;
      }
      if (frame.method === "voice.state") {
        const params = frame.params as { state: VoiceState; client?: string };
        const mine = params.client === undefined || params.client === conn.state.hello?.client.id;
        if (mine) {
          state.voice = params.state;
          // The node stopped speaking, whatever it had queued: drop what is scheduled here too.
          if (params.state !== "speaking") audio.flush();
          // `listening` settles a word the phone heard; every state moves where frames go.
          dispatch({ type: "voice", state: params.state });
        }
      }
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
    audio.setVia(io.via);
    if (snapshot.state !== "connected") {
      cache.clear();
      delete state.voice;
      audio.flush();
      state.talking = false;
      dispatch({ type: "disconnected" });
    } else {
      // A new conversation on the node: the phone's word starts over with it, and is asked for again.
      detector?.reset();
      negotiate();
      notifier.onConnected();
    }
    refreshForwarding();
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
      state.listening = on;
      if (on) detector?.reset();
      writeListen(storage, on);
      refreshForwarding();
      paint();
    },
    ptt: (down) => {
      state.talking = down;
      if (down) detector?.reset();
      refreshForwarding();
      paint();
      void conn.request("voice.ptt", { active: down }).catch((e: unknown) => console.warn("voice.ptt", e));
    },
    mute: (on) => {
      state.muted = on;
      if (audio.queue) audio.queue.muted = on;
      if (on) audio.flush();
      paint();
    },
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
    audio,
    ui,
    state,
    paint,
    background: () => {
      away = true;
      if (state.talking) void conn.request("voice.ptt", { active: false }).catch(() => {});
      state.talking = false;
      dispatch({ type: "background" });
      streaming = false;
      detecting = false;
      audio.flush();
      void audio.mic(false);
      io.suspend();
    },
    watching: (on) => {
      if ((state.watching === true) === on) return;
      state.watching = on;
      if (on) {
        if (state.talking) void conn.request("voice.ptt", { active: false }).catch(() => {});
        state.talking = false;
        audio.flush();
        void audio.mic(false);
      } else if (state.audioReady && !away) {
        void audio.mic(true).then(() => detector?.reset());
      }
      refreshForwarding();
      paint();
    },
    foreground: () => {
      away = false;
      io.resume();
      void audio.resume().then(async () => {
        if (state.audioReady && !state.watching) await audio.mic(true);
        // The microphone is back after a gap: what the word carried on from is gone.
        detector?.reset();
        refreshForwarding();
        paint();
      });
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

/** A protocol error's code, from whatever a request rejected with. */
function codeOf(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
