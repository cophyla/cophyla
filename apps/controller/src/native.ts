// The native entry: the same app as the browser's, inside the Capacitor shell. What differs
// is supplied here: the credential in the app's preferences; the LAN leg over the Kotlin
// socket plugin, which pins the node's key learned at pairing; the relay transport when the
// LAN is out of reach; views staged under the app's own storage, and fetched again only when
// they changed; asks that arrive as push notifications whose buttons deep-link back here;
// the sign-in with the account, which opens the server's page in the browser and pairs
// when `cophyla://pair?grant=…` brings the app back; an invite from the desktop, pasted or
// opened as `cophyla://invite?i=…`, redeemed on the LAN addresses it names pinned to its key,
// or through its own relay peer; a data channel straight to the node when
// it has direct connections on (`direct.ts`); the remote desktop, shown by the Kotlin
// stream plugin in a dialog of its own through a forwarder on the phone's loopback (the
// hello says `forward`, so the node answers the page's path); and the phone's own signals —
// the app going to the background (the m8 rule: the button up, the microphone off, the
// socket closed, a stream closed) and the network changing (the LAN tried again, and not at
// all on mobile data).

import { App as CapApp } from "@capacitor/app";
import { AppLauncher } from "@capacitor/app-launcher";
import { registerPlugin } from "@capacitor/core";
import { Filesystem } from "@capacitor/filesystem";
import { Network } from "@capacitor/network";
import { PushNotifications } from "@capacitor/push-notifications";
import type { ViewContent } from "@cophyla/protocol";
import { boot } from "./app.ts";
import { guessName, inviteLanNodes, isInviteLink, nodeFromLan, parsePairLink, pkcePair, signInUrl } from "./pairing.ts";
import type { Credential, NodeAddress } from "./pairing.ts";
import { inviteTransport, pairingTransport, relayTransport } from "./transport.ts";
import { lanUrl, nativeTransport } from "./native/native-io.ts";
import type { CophylaSocketPlugin } from "./native/native-io.ts";
import { fileUrl } from "./native/platform.ts";
import { openDirect } from "./direct.ts";
import type { PeerLike } from "./direct.ts";
import type { P2pTransport } from "./link-core.ts";
import { PipeBridge, planOpen, Streams } from "./native/stream.ts";
import type { CophylaStreamPlugin } from "./native/stream.ts";
import { PushBridge } from "./native/push.ts";
import { stageLocally } from "./native/stage.ts";
import { pendingSignIn, preferencesStore } from "./native/storage.ts";

/** The server the app signs in to; the build sets it (`--server`), the production one by default. */
declare const COPHYLA_SERVER_URL: string;
const SERVER_URL = typeof COPHYLA_SERVER_URL === "string" ? COPHYLA_SERVER_URL : "https://api.getcophyla.com";

const socketPlugin = registerPlugin<CophylaSocketPlugin>("CophylaSocket");
const streamPlugin = registerPlugin<CophylaStreamPlugin>("CophylaStream");

/** The remote desktop on the screen; built once the app is. */
let streams: Streams | undefined;

/** The data channel, where the web view has WebRTC: opened over the link, keyed from the pairing secret. */
const p2p: P2pTransport | undefined =
  typeof RTCPeerConnection === "function"
    ? { label: "direct", open: (sig, credential) => openDirect(sig, { credential, peer: (config) => new RTCPeerConnection(config as RTCConfiguration) as unknown as PeerLike }) }
    : undefined;

/** The key of the node the pairing socket accepted, kept until the claim writes the credential. */
let learnedSpki: string | undefined;
let pairingAddress: NodeAddress | undefined;

/**
 * The network the phone is on, as it last said. On mobile data the node's LAN address cannot
 * answer, so the LAN is not tried and the relay opens at once; until the first answer comes
 * the LAN is tried, which costs no more than its head start.
 */
let connectionType: string | undefined;
void Network.getStatus()
  .then((s) => (connectionType = s.connectionType))
  .catch(() => undefined);

const app = boot({
  name: guessName(navigator.userAgent),
  askAddress: true,
  // Capacitor's web view lets audio start without a gesture: the app listens from launch, no Start tap
  autoStart: true,
  link: {
    store: preferencesStore(),
    // a stream page is fetched through the app's own forwarder: the node answers its path
    helloExtra: { forward: true },
    ...(p2p ? { p2p } : {}),
    // the link moves only while nothing would notice: no stream on the screen, the button up
    quiet: () => !streams?.open && !app.state.talking,
    lan: (credential: Credential | undefined) => (credential?.node && connectionType !== "cellular" ? [nativeTransport(credential.node, socketPlugin, { ...(credential.node.spki ? { pin: credential.node.spki } : {}) })] : []),
    relay: (access) => relayTransport(access),
    // the address typed at pairing and the key its socket learned go into the credential with the token
    credentialFor: () => (pairingAddress ? { lan: [lanUrl(pairingAddress)], node: { ...pairingAddress, ...(learnedSpki ? { spki: learnedSpki } : {}) } } : {}),
    // paired through the account: the LAN listener and the key the node itself reported
    credentialForLan: (lan) => {
      const node = nodeFromLan(lan);
      return { lan: [lanUrl(node)], node };
    },
  },
  signIn: async () => {
    const { verifier, challenge } = await pkcePair();
    await pendingSignIn.save({ verifier, startedAt: Date.now() });
    await AppLauncher.openUrl({ url: signInUrl(SERVER_URL, challenge) });
  },
  // an invite: the LAN addresses it names, each pinned to its key (none on mobile data), and its relay peer beside them
  inviteWays: (invite) => {
    const nodes = new Map<string, NodeAddress>();
    const lans = connectionType === "cellular" ? [] : inviteLanNodes(invite).map((node) => {
      const t = nativeTransport(node, socketPlugin, { pin: node.spki! });
      nodes.set(t.label, node);
      return t;
    });
    return {
      lans,
      ...(invite.relay ? { relay: inviteTransport(invite.relay, invite.secret) } : {}),
      credentialFor: (t) => {
        const node = nodes.get(t.label);
        return node ? { lan: [lanUrl(node)], node } : {};
      },
    };
  },
  pairingTransport: (address) => {
    if (!address) return undefined;
    pairingAddress = address;
    learnedSpki = undefined;
    return nativeTransport(address, socketPlugin, { onSpki: (spki) => (learnedSpki = spki) });
  },
  stage: (conn, manifest) =>
    stageLocally(
      {
        fs: {
          writeFile: (o) => Filesystem.writeFile({ path: o.path, data: o.data, directory: o.directory as never, ...(o.encoding ? { encoding: o.encoding as never } : {}), ...(o.recursive ? { recursive: true } : {}) }),
          readFile: (o) => Filesystem.readFile({ path: o.path, directory: o.directory as never, encoding: o.encoding as never }),
          readdir: (o) => Filesystem.readdir({ path: o.path, directory: o.directory as never }),
          rmdir: (o) => Filesystem.rmdir({ path: o.path, directory: o.directory as never, ...(o.recursive ? { recursive: true } : {}) }),
          getUri: (o) => Filesystem.getUri({ path: o.path, directory: o.directory as never }),
        },
        fileUrl,
        get: (id) => conn.request<ViewContent>("view.get", { id }),
        ...(conn.state.hello ? { platform: conn.state.hello.platformVersion } : {}),
      },
      manifest,
    ),
  hostOpen: async (params) => {
    const plan = planOpen(params, { via: app.io.via, credential: app.io.credential, canForward: streams !== undefined, origin: location.origin });
    switch (plan.kind) {
      case "lan":
      case "link":
        await streams!.show(plan);
        return {};
      case "window":
      case "app":
        await AppLauncher.openUrl({ url: plan.url });
        return {};
      case "refuse":
        throw new Error(plan.reason);
    }
  },
  openLink: async (url) => void (await AppLauncher.openUrl({ url })),
  // in the foreground the ask is on the socket and the view shows it; the push carries it while the app sleeps
  notify: async () => {},
  dismiss: async () => {},
  ready: (a) => {
    // the pipes go on the link core itself: the view's path to the node refuses them
    const pipes = new PipeBridge({
      plugin: streamPlugin,
      link: { open: (node) => a.io.pipeOpen(node), signal: (method, params) => a.io.pipeSignal(method, params), onPipe: (fn) => a.io.onPipe(fn) },
      log: (m) => console.info(m),
    });
    streams = new Streams({ plugin: streamPlugin, request: (method, params) => a.conn.request(method, params), watching: (on) => a.watching(on), pipes, log: (m) => console.info(m) });
    const push = new PushBridge({
      request: (method, params) => a.conn.request(method, params),
      connected: () => a.conn.connected,
      platform: "android",
      log: (m) => console.info(m),
    });
    a.conn.onState((s) => {
      if (s.state === "connected") push.onConnected();
    });
    void PushNotifications.addListener("registration", (t) => push.onToken(t.value));
    void PushNotifications.addListener("registrationError", (e) => console.warn("push registration", e));
    void PushNotifications.requestPermissions().then((p) => {
      if (p.receive === "granted") void PushNotifications.register();
    });
    // the sign-in's grant, once: a cold start by the link reports it both as the launch URL and as an open
    const spent = new Set<string>();
    const signedIn = async (grant: string): Promise<void> => {
      if (spent.has(grant)) return;
      spent.add(grant);
      const pending = await pendingSignIn.take();
      if (!pending) {
        a.pairNote("That sign-in was not started here, or took too long: tap Sign in with GitHub again.", true);
        return;
      }
      await a.pairThroughAccount(pairingTransport(SERVER_URL, grant, pending.verifier));
    };
    const onUrl = (url: string): void => {
      if (isInviteLink(url)) {
        a.offerInvite(url);
        return;
      }
      const grant = parsePairLink(url);
      if (grant) {
        void signedIn(grant);
        return;
      }
      if (push.onLink(url)) a.io.resume();
    };
    void CapApp.addListener("appUrlOpen", (e) => onUrl(e.url));
    void CapApp.getLaunchUrl().then((l) => {
      if (l?.url) onUrl(l.url);
    });
    void CapApp.addListener("appStateChange", (s) => {
      if (s.isActive) a.foreground();
      else {
        a.background();
        void streams?.close();
      }
    });
    void Network.addListener("networkStatusChange", (s) => {
      connectionType = s.connectionType;
      void a.io.networkChanged();
    });
  },
});

void app;
