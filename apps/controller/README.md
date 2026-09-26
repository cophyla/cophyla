# controller

The phone app, in two forms of one code: a page the node itself serves, over TLS on the
controller listener, opened in the phone's browser; and the same page inside a native shell
(Capacitor), which adds what a browser cannot do — a socket that pins the node's key, a
tunnel through the server relay when the LAN is out of reach, views kept in the app's own
storage, and asks that arrive as push notifications whose buttons answer them. It is the
only client with a microphone and a speaker, so every voice conversation runs through one,
and it hears its own wake word: nothing leaves the phone until it does.

```
bun run apps/controller/scripts/build.ts           # dist/: the page the node serves (LAN only)
bun run apps/controller/scripts/build.ts --native  # dist-native/: the page the shell wraps (relay on)
bun run apps/controller/scripts/dev-serve.ts       # a fake node on http://127.0.0.1:4819; pairing code 123456; the wake word the phone's
bun test apps/controller
bun run release:controller [--debug]               # the APK (apps/installer/scripts/release-controller.ts)
```

`dist/` is what `stage-platform.ts` copies into a release and what `api/static.ts` serves; a
checkout that has not built it gets one line saying so. `dist-native/` is copied into the
Android and iOS projects by `cap sync` and never committed.

## The three screens

| Screen | When | What it does |
|---|---|---|
| **pair** | no credential stored | a name and the six-digit code the desktop app is showing; the native app also takes the node's address (`host:port`, port 4818 unless said). `pair.claim` spends the code for a token — and, when the node is signed in to a plan with the relay, for relay access. Below it, a field for an invite the desktop made for this phone (`cophyla-invite:…`, or the `cophyla://invite?i=…` link its QR code holds, which opens the app here): the screen names the node it is from and asks Join or Cancel, and `invite.redeem` spends it for a token, the access the desktop gave, and relay access minted for this phone |
| **gate** | paired, not started | one Start button. Browsers only let a page start an `AudioContext` from a user gesture, so in the browser the microphone cannot open before this. The app skips it — its web view lets audio start without a gesture, so it starts the microphone as soon as it is paired and open — and shows it only when that failed (the microphone refused, the audio held back for four seconds), with the reason |
| **main** | started | the view in its frame, and under it one thin bar: at the left the menu button, which shows and hides the view's rail (`host.menu`); in the middle push-to-talk, a slim pill whose microphone takes the status dot's colours and whose words are Hold to talk, or what it waits on (offline, connecting…) or what the conversation is doing (listening, thinking, speaking); at the right a speaker icon that mutes and a ⋯ menu — the whole status line (with `(relay)` when the tunnel carries the link), Listen for the wake word (a switch), Forget this phone |

The phone listens for the wake word the whole time it is open, and hears it itself: a
worker runs openWakeWord on ONNX Runtime's wasm build over the microphone, and only once it
hears one of the node's wake words ("Cophyla", "Hey Phyla") does the page send `voice.wake` and the audio after it, until the node
stops listening. The menu's switch turns that off, and the page remembers the off
(`cophyla.controller.listen` in its storage) until it is turned back on. Push-to-talk skips the
wake word: hold it, speak, release. Either way the frames go up as `voice.audio` and the
answer comes back the same way. A node that cannot hand the phone the word — an older one,
or one configured with a head this build does not carry — gets the microphone streamed while
the phone listens and detects the word itself, as before; so does any node when the worker
fails. With the wake word off on the node the status line says so, and only the button sends
audio.

The view is the node's default, the same one the desktop app shows. At a phone's width it lays
itself out for one: the chat or the selected session takes the full width, and the rail —
the sessions, the node, account and phone cards, as on the desk — slides in over it from
the bar's menu button and goes once a tab is picked or the pane is tapped. An older app
with no menu button gets the view's own, in a thin bar at the top.

## Layout

| File | Holds |
|---|---|
| `src/app.ts` | the app: `boot(platform)` wires pairing, the link, the view host, voice (`@cophyla/voicehost`'s `VoiceHost`: the microphone, the wake word, the speaker) and the screens over what a platform supplies |
| `src/main.ts` | the browser entry: the page's own socket back to the origin that served it, views staged by the node under a ticket, the credential in the page's storage. LAN only (`connect-src 'self'`) |
| `src/native.ts` | the Capacitor entry: the pinned native socket, the relay transport, views written to the app's storage, push registration and deep links, the phone's background and network signals |
| `src/link-core.ts` | the link, shaped as the `TauriIo` the shared view host expects: `pair.claim`, `invite.redeem` and `hello` said for itself (`redeem` races an invite's pinned LAN addresses, with their head start, against its relay peer, then says hello on the same LAN socket or comes back through the relay on the phone's own access), backoff while visible, closed while hidden, the transport chooser (LAN first, the relay when the LAN cannot be reached, the LAN tried again every minute and on a network change), `relay.info` asked for on a LAN hello that finds the access missing |
| `src/transport.ts` | the two transports behind one `Duplex`: a WebSocket to the LAN listener, and a `PeerSession` from `@cophyla/relay` to the server's `/ws/relay` — the E2E tunnel the node's daemon is the other end of; and two used once each, the account sign-in's pairing tunnel and an invite's own relay peer, keyed from the invite's secret |
| `src/pairing.ts` | the credential — token, controller, name, LAN URLs, relay access, the node's address and key — in the page's storage or the app's preferences, and parsing a typed code, an address or an invite (`parseInviteLink`: a computer's invite, one run out or one with no way to its node is refused with a word for the user; `inviteLanNodes` the addresses to pin); beside it, the listen switch's off |
| `src/native/native-io.ts` | the LAN leg over the Kotlin socket plugin: pinned by the node's key learned at pairing; a key that changed is refused with `pin_mismatch`, never accepted on the quiet |
| `src/native/push.ts` | the device token sent as `push.register` until the node took it; `cophyla://ask/<id>/<option>` links answered as `ask.answer` once the link is up, dropped after a minute |
| `src/native/stage.ts` | views written under `Data/views/<id>/<version>/` from `view.get`, a content policy put into the entry page, older versions pruned |
| `src/native/storage.ts`, `src/native/platform.ts` | the credential store over `@capacitor/preferences`; the platform check and file URLs |
| `src/remote.ts` | `host.open`: the remote-desktop page in a same-origin frame in the browser, links and invites opened outside |
| `chooser.css` (built) | the look of the view picker `host.chooseView` opens, which is `@cophyla/viewhost`'s own; the build copies it beside `controller.css`, since the page's policy refuses inline styles |
| `src/chrome.ts` | what the page shows, as a value: the screen, the status line and the talk button's words, which controls are live, and where frames go — `streaming`, `detecting` (voicehost's `route`), the screen kept awake. Pure |
| `src/ui.ts` | the elements, rendering a `Chrome` and turning taps into calls; the menu button passed to the view, the ⋯ menu opening and closing |
| `src/index.html`, `src/controller.css` | the page itself |
| `android/` | the committed Android project: `MainActivity.kt` (the plugin registered, the microphone granted to the page once `RECORD_AUDIO` is), `ViewFiles.kt` (the staged views served to their frame with `Access-Control-Allow-Origin` and the node's types, which Capacitor's file server does not give), `CophylaSocketPlugin.kt` (an OkHttp socket trusting one self-signed leaf by its key), `AskMessagingService.kt` (a data-only push → a notification with up to three buttons). `google-services.json`, `local.properties` and the build output are gitignored |
| `ios/` | the scaffold from `cap add ios`, untouched and unbuilt until a Mac and an Apple Developer account exist |
| `capacitor.config.json` | `com.fareaststudios.cophyla`, web dir `dist-native`, the `https` scheme |

## What holds

- **The token lives with the page.** In the browser it is in the page's storage; in the app
  it is in the app's preferences, outside the web view. Either way it is this one phone's,
  and the desktop revokes it with `controller.revoke`. A `hello` refused as `denied` drops
  it, so a revoked phone goes back to the pair screen instead of retrying forever.
- **The page never says `hello` for a view.** The view host runs exactly as it does in the
  desktop app: the same `Bridge`, the same scope check, the same sandboxed frame. The one
  difference is where the files come from — the browser gets a ticket the node serves them
  under (`view.stage`); the app asks for the files (`view.get`) and keeps them itself, since
  a node reached through the relay has no origin to serve from.
- **Pairing is the LAN's.** `pair.claim` is refused over the relay; the relay access comes
  out of the claim, and the node's key is learned by the socket that made it. From then on
  the LAN socket accepts only that key. An invite brings the key with it: its LAN addresses
  are pinned to the hash it carries from the first socket, and through the relay only the
  invite's own peer redeems it, over a tunnel keyed from its secret. A view may not send
  `invite.redeem`.
- **The relay carries ciphertext.** The tunnel is `@cophyla/relay`'s: ephemeral keys agreed
  through the server, the key of the phone's grant, which only the phone and the node hold,
  and records the server routes by peer and cannot read. What the phone sends over it is the
  same client protocol it sends on the LAN, and the node's gate and audit see it the same
  way.
- **It listens while it is open, and only then.** In front, the microphone is on unless the
  menu's switch turned it off. Hidden — or, in the app, in the background — the socket
  closes and the microphone stops: a phone in a pocket is not a microphone. An ask that opens
  while the app sleeps reaches it as a push instead.
- **Speech is dropped on a barge-in.** The playback queue is flushed the moment `voice.state`
  leaves `speaking`, so talking over the answer stops it on the phone as well as on the node.
  The phone's wake word keeps running while a reply is spoken, and a word over it flushes the
  queue at once.
- **Nothing goes up while the room is quiet.** In phone mode a frame goes to the worker and
  no further; it goes up once the worker heard the word, while the node's state for this
  phone is `listening` (whatever the switch says, so the node is never left waiting), or
  while the button is held. The worker gets a copy of each frame and never the page's own.
- **The wake files are the build's.** They are checked against their pins when the build
  copies them, and again on arrival in the browser page, which keeps them in IndexedDB
  because Chromium caches nothing from a page behind a self-signed certificate. Nothing of
  them crosses the protocol.

## Building the app

The Android project is pinned to what builds today: Capacitor 6, SDK 34, JDK 17, Kotlin 1.9.
`android/local.properties` names the SDK (`sdk.dir=…`, gitignored) when `ANDROID_HOME` does
not; `JAVA_HOME` (or `COPHYLA_JAVA_HOME`) names the JDK. The Firebase project's
`google-services.json` goes into `android/app/` and is never committed; without it a debug
build still pairs and relays but receives no push. A release is signed with
`~/.cophyla-release/controller.jks` named by `COPHYLA_ANDROID_KEYSTORE` and
`COPHYLA_ANDROID_KEYSTORE_PASSWORD` (`COPHYLA_ANDROID_KEY_ALIAS`, `COPHYLA_ANDROID_KEY_PASSWORD` when
they differ), and lands in `apps/installer/stage/out/cophyla-controller-<v>.apk` — a GitHub
release asset beside the platform's, not a feed entry. `adb install -r` puts either build on
a phone with USB debugging.

The microphone, the wake word and the speaker are `packages/voicehost`, which the desktop
app's host page runs too. Both builds carry its assets: the capture worklet, the wake word's
worker, and the wake word under `wake/` (about 20 MB; `wake/NOTICE.txt` names the licences),
which voicehost's `buildVoiceAssets` takes from `apps/cophylad/models/voice/wake-openwakeword/`,
running `fetch-models.ts --voice --only wake-openwakeword` first when they are missing, and
the wasm from `onnxruntime-web`, and fails when any file differs from its pin in
voicehost's `src/wake/bundled.ts`.

## Testing

`test/controller.test.ts` covers the parts over fakes: the credential round trip, the listen
switch's default and its remembered off, code parsing, every screen and flag `chrome.ts`
produces (the app's start with no gate included, and `streaming`, `detecting` and the wake
lock across every mode, voice state, button and pending word), and what `host.open` lets
through. Voice's own parts — chunking, playback, the uplink, Opus, the wake word's reducer,
ring and detector — are tested in `packages/voicehost`.
`test/link-core.test.ts` drives the link over fake transports: claim → store → `hello`, a
denied `hello` dropping the credential, backoff and the pause/resume cycle, the LAN falling
to the relay and back, `relay.info` filling a missing access, the relay's 4401 dropping it, and
an invite redeemed on its pinned LAN address or, the LAN silent past its head start, on its
relay peer, a spent one and one cut off settled once, and none on a phone paired already.
`test/controller.test.ts` also reads invites back from their text and their link, and refuses
the rest. `test/transport.test.ts` opens both transports against fakes.
`test/native.test.ts` covers the native pieces: the pin recorded at pairing and a mismatch
refused without a retry, registration replayed until acknowledged, deep links (percent-encoded
option ids included) answered or dropped after a minute, and staging — per-version files, the
policy put in once, pruning, the base URL. The page itself is driven by hand against
`dev-serve.ts`, which serves the built app and a stub view under the same frame policy the
real listener uses, tells the page to hear the wake word itself and plays a turn out on
`voice.wake`; `localhost` is a secure context, so the microphone works there with no
certificate and no phone. Chromium's `--use-file-for-fake-audio-capture=<wav>` plays a clip
into the page's microphone. The app is driven on a phone.
