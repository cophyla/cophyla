# ui

The desktop app: a Tauri 2 shell around one web view. It holds no product logic. The native
side keeps the client-protocol credential and the connection to cophylad, starts cophylad when
none is listening and never stops it, serves views to a sandboxed frame, puts asks on OS
notifications, and lives in the tray when the window is closed. The host page it loads is a
multiplexer between that native side and the view.

```
$env:PATH += ";$HOME\.cargo\bin"; $env:CARGO_BUILD_JOBS = 12   # Windows, one-off per shell
cd apps/ui
bun run dev             # builds the host page, then `tauri dev`; starts cophylad on ~/.cophyla
bun run build           # `tauri build --no-bundle`: target/release/cophyla-ui.exe; apps/installer packages it
bun test                # the host page's units and the command-manifest check
```

Prerequisites: Rust stable and Bun, which the shell runs cophylad with; then per OS. Windows:
the MSVC toolchain and the WebView2 runtime (spike 07 lists the versions). macOS: the Xcode
command line tools (`xcode-select --install`). Linux (Ubuntu 24.04): `libwebkit2gtk-4.1-dev
libayatana-appindicator3-dev librsvg2-dev libxdo-dev libgtk-3-dev patchelf`, and `xdotool`
or `wmctrl` at run time for `session.focus`. A cold `cargo build` takes about three minutes
at `-j 12`; `target/` is gitignored and reaches 3.5 GB. Pointing `CARGO_TARGET_DIR` at spike
07's `target/` reuses its compiled crates and brings the first build under a minute.

`bun run dev` passes `--no-dev-server`, so the host page is embedded exactly as in a build
and served from `http://tauri.localhost`; a change under `host/` needs `bun run build:host`
and a rebuild. Two things `tauri dev` does that the app itself never does: it restarts the
app when `src-tauri/` changes by killing the app's whole process tree, cophylad included, and
it takes that tree down when the dev session ends the same way. Run the built exe to see
cophylad outlive the app.

## Layout

| Path | What |
|---|---|
| `src-tauri/` | the Rust shell: `main.rs` composition, `cophylad.rs` the link and the spawn, `install.rs` installed mode, `views.rs` the `view` protocol, `commands.rs` the five app commands, `notify.rs` toasts and the AUMID, `stream.rs` a remote desktop's window, `links.rs` a clicked link in the system browser, `voice.rs` the microphone grant and the talk key, `tray.rs` |
| `src-tauri/commands.txt` | the app manifest's command list, read by `build.rs` |
| `src-tauri/capabilities/host.json` | what the `host` window may call; the only capability file |
| `host/` | the host page: `main.ts`, `voice.ts`, `index.html`, `host.css`, `inliner.ts` — the shell's half, the rest is `@cophyla/viewhost`, whose view picker's `chooser.css` the build copies beside them, and `@cophyla/voicehost`, whose worklet, wake worker and `wake/` files it copies too |
| `scripts/build-host.ts` | bundles `host/` into `dist/`, which is `frontendDist` |
| `test/` | `bun test`: the shell's own host modules over fakes, and the manifest check |

`connection.ts`, `snapshot.ts`, `bridge.ts`, `viewhost.ts` and `notify.ts` moved to
[`packages/viewhost`](../../packages/viewhost) in milestone 8, because the controller needs
the same host and a phone is not a Tauri window. What stays here is what only the shell has:
the Tauri IPC that carries frames to and from the native side, the toast plumbing, the
`srcdoc` fallback, and `main.ts` wiring the three together. Staging a view is the one seam
the shared host leaves open — the shell serves it from the `view` protocol, the controller
asks the node for a ticket — so a change to how a view is isolated is made in both.

## Environment

| Variable | Effect |
|---|---|
| `COPHYLA_HOME` | the user data directory, `~/.cophyla` by default; the shell reads `config.toml` `[api]` and `data/client.token` from it and starts cophylad on it |
| `COPHYLAD_COMMAND`, `COPHYLAD_ARGS` | what to run when cophylad is not listening; by default `bun run <repo>/apps/cophylad/src/main.ts --home <home>` from a checkout, `<version dir>\bun.exe run <version dir>\cophylad\apps\cophylad\src\main.ts --home <home>` when installed |
| `COPHYLA_INSTALL_DIR`, `COPHYLA_PLATFORM_DIR` | set by the launcher: the install directory and this version's directory; the shell derives them from its own path when absent, and passes them to cophylad |
| `RUST_LOG` | the shell's own log level on stderr, `info` by default |
| `--hidden` | start with the window hidden, in the tray; launch at login passes it |

cophylad's stdout and stderr go to `<home>/data/cophylad.log`. The shell starts cophylad only when a
connection is refused, at most once every 15 s, so a daemon the user started is found, not
duplicated. A second launch of the app focuses the first.

## Installed mode

Installed, the shell is `<root>/versions/<v>/cophyla-ui.exe` (`Cophyla.app/Contents/MacOS/
cophyla-ui` on macOS, `cophyla-ui` on Linux) and the Start Menu shortcut, the launch agent or
the desktop entry points at the launcher: `Cophyla.exe` beside `versions\` on Windows,
`/Applications/Cophyla.app` or `/usr/bin/Cophyla` elsewhere, where the root is the user's data
directory (see [apps/installer](../installer/README.md)). The shell learns the root from
`COPHYLA_INSTALL_DIR`/`COPHYLA_PLATFORM_DIR` or its own path (four levels up inside the macOS
bundle), and the launcher from `COPHYLA_LAUNCHER`, then the root's `launcher` file, then a
launcher beside the root. Two rules make an update land: before starting cophylad, if another
version waits (cophylad wrote `staged`, or the launcher already moved `current` past this one),
the shell relaunches through `<launcher> --wait-pid <self>` instead and exits, so the
launcher rotates the pointers and starts the current version; and while connected to a
daemon whose `platformVersion` is not this shell's, or while `current` names another
version, it sends `update.apply {component: platform}` and again every minute, so the
daemon stops when idle and the first rule takes over. A staged platform the daemon reports
in `update.state` puts "Restart to update <v>" in the tray. Launch at login registers the launcher with `--hidden` (through `auto-launch`:
the value `Cophyla` under the Run key, the launch agent `~/Library/LaunchAgents/
com.fareaststudios.cophyla.launcher.plist`, the entry `~/.config/autostart/Cophyla.desktop`), so the entry
survives updates; from a checkout it registers this executable; the item is disabled when no
launcher is known. On Unix cophylad and a relaunched launcher get their own process group, so
launchd ending the shell's group at login never takes the daemon with it. On macOS the Dock
icon is there while the window is: closing the window hides both, a click on the app in the
Finder or the Dock (`Reopen`) shows them again, and Cmd+Q hides. Notifications take their
icon from `versions/<v>/icons/`.

## How a view is isolated

The host page never holds the token: the shell says `hello` itself and pumps frames to the
page as `cophylad:frame` events; the page sends through `cophylad_send`, which refuses `hello`.
The page fetches a view with `view.get` on that connection and hands its files to
`view_stage`; the shell serves them from memory at
`http://view.localhost/<id>/<version>/<path>` to the `host` webview only, with
`Content-Security-Policy: default-src 'none'; script-src http://view.localhost; style-src
http://view.localhost 'unsafe-inline'; img-src http://view.localhost data:; font-src
http://view.localhost; connect-src 'none'; frame-ancestors http://tauri.localhost; base-uri
'none'; form-action 'none'`, `Access-Control-Allow-Origin: *` (a module script from an opaque
origin is a CORS fetch) and `X-Content-Type-Options: nosniff`. The page loads the entry in
`<iframe sandbox="allow-scripts allow-forms">`, so the document has an opaque origin: no
storage, no cookies, no IPC, and by its CSP no network and nowhere for a form to submit to
(`allow-forms` only lets a form's `submit` event fire; without it Chromium drops the
submission first, and the view's Send and Answer never run). It talks to the host by `postMessage` in the
`cophyla.view/1` envelope; `bridge.ts` validates each request, refuses `hello` and unknown
methods with `unsupported`, refuses methods outside the manifest's `scopes` with `denied`,
remaps ids into `v<instance>-<n>`, forwards on the host's connection and restores the ids on
the way back. A signal (a frame with a method and no id, `chat.typing` today) is forwarded
unchanged when its scope is among the view's, dropped otherwise; nothing comes back for it.
Notifications reach the view only within its scopes. The snapshot cache replays the latest
`session.state`, `workspace.state`, open `ask.state` and open `task.state` to a view mounted
later; the chat itself the view loads with `chat.load`. When the link comes back after a
reconnect the mounted view is readied at once and `view.list` is asked once more: a default
whose `version` (a hash of its files) moved, or that moved to another view, is loaded again,
so a view edited under a restarted daemon shows without relaunching the app. A `view.changed`
from cophylad (a view's files edited under `~/.cophyla/views`, or the default moved by
`view.setDefault`) does the same while the app runs: the notices of one edit are gathered
for a moment, one `view.list` decides, and the mounted frame is replaced only once the new
files are fetched and staged, so a view half written keeps the old one on screen.

### Probe results (Windows 11, WebView2 153, tauri 2.11.5)

Measured before any host code was written, with a probe view staged by the shell:

- A frame on `http://view.localhost` renders; a module script served as `text/javascript`
  with `Access-Control-Allow-Origin: *` runs, and `import "./lib.ts"` inside it resolves.
- `postMessage` works both ways; the host sees `event.origin === "null"`, the frame sees
  `http://tauri.localhost`.
- In the frame: `localStorage` and `document.cookie` throw (`SecurityError`, sandboxed);
  `fetch` to `http://ipc.localhost`, to `http://127.0.0.1:4817`, to the host's own assets and
  to the internet all fail (`TypeError: Failed to fetch`, the CSP); a `WebSocket` to cophylad
  errors. Tauri's init script is injected into the frame, so `__TAURI_INTERNALS__` exists
  there, but `invoke` never resolves: the IPC fetch is blocked, and the `postMessage`
  fallback never reaches the process (no command ran, no record was written). A frame cannot
  call a command, declared or not.
- `on_navigation` does not see a frame's navigation; the host CSP's `frame-src
  http://view.localhost` is what keeps a frame from navigating elsewhere.

The `srcdoc` fallback (`host/inliner.ts`) is kept and tested for a platform where a
custom-protocol frame does not load. Its limits: the document inherits the host's CSP, so
inlined scripts and styles need the host's per-launch nonce, and a module cannot import
another file.

## The command manifest

Spike 07 found that a `#[tauri::command]` registered in `generate_handler!` is callable from
every web view unless the app manifest names it, and nothing warns. `build.rs` declares the
commands from `commands.txt`; `test/manifest.test.ts` fails when the Rust sources,
`generate_handler!`, `commands.txt` and the `allow-*` grants in `capabilities/` disagree,
when a grant goes to any window but `host`, when the host CSP lacks `frame-src
http://view.localhost`, or when an updater plugin appears in `Cargo.toml`. Adding a command
means adding it in all four places, and the test says which one was missed.

## Voice

The app has a microphone and a speaker, as the phone does, through the same
`@cophyla/voicehost`: the host page (`host/voice.ts`) captures 16 kHz mono from launch, hears
the node's wake words itself in a worker ("Hey Jarvis", "Cophyla" and "Hey Phyla" by default:
the ones `[voice] wake_model` names on the node), sends audio to cophylad only after a word
or while the talk key or the view's talk button is held, and plays the spoken replies. It
keeps running while the window is hidden in the tray, so a wake word works with the app out
of sight. The hello says what the page has (`audio: {in, out, codecs, played}`), passed to
the shell with `cophylad_attach`, which says it in every hello from then on.

- **The microphone** is granted to the host page without a prompt and to nothing else
  (`voice.rs`): WebView2's `PermissionRequested` on Windows, WebKitGTK's `permission-request`
  on Linux, both for the app's own origin only; on macOS WebKit asks the system with the text
  in `Info.plist`. Windows' own privacy switch for desktop apps still applies; a refused
  microphone shows in Settings with a retry.
- **Audio from launch**: WebView2 is started with `--autoplay-policy=no-user-gesture-required`
  (with wry's own flags repeated, since the argument replaces them). Where there is no such
  switch the page starts its audio at the first click the view passes up.
- **The talk key**, Ctrl+Alt+Space unless the user sets another in Settings, is a global
  shortcut (`tauri-plugin-global-shortcut`): held anywhere on the desktop it is push-to-talk,
  told to the page as `voice:ptt {down}`. The page keeps the choice and registers it with
  `ptt_shortcut` at every start; a key another app holds is refused with a word.
- **The talk button** is the view's: `host.ready` says `talk`, and the default view draws a
  microphone beside Send that holds `voice.ptt` while pressed.
- **Settings → Voice** shows what voice is doing, listening for the wake words and speaking
  the replies as switches (kept in the page's storage), and the talk key.

`window.__cophylaWake` and `window.__cophylaVoice` show where the wake word and the audio
stand, for Playwright over WebView2's debugger (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
--remote-debugging-port=…`, plus `--use-fake-device-for-media-stream
--use-file-for-fake-audio-capture=<wav>` for a microphone that plays a file).

## Notifications

An open ask a person may answer becomes an OS notification with its options as buttons; a
button answers it through the host's connection, the body shows the window; an ask that
takes several options at once gets no buttons. The action ids are `<ask>|<option>` on every
platform. An ask that opens while the window has the focus gets none, since the view shows
it, and when the window gets the focus every notification still up is taken down: the
toasts are cleared from the app's history on Windows, closed by id over D-Bus on Linux, and
removed from the delivered ones on macOS. An ask settled anywhere (answered in the terminal,
the view or the phone, expired, cancelled) takes its own down the same way through
`dismiss_ask`, and so does one that cophylad leaves out of its replay after a reconnect: the
Windows toast is tagged with the ask id. Windows: a WinRT toast, attributed by AppUserModelID: the process sets
`com.fareaststudios.cophyla.desktop` before any window and registers it under
`HKCU\Software\Classes\AppUserModelId` with the display name and icon, best-effort, so a
dev run says "Cophyla" rather than the name of the shell that launched it; milestone 4's
installer shortcut carries the same id. Linux: `org.freedesktop.Notifications` over D-Bus
through `notify-rust`, with the app name, the desktop entry and the icon, buttons where the
desktop shows actions (GNOME, KDE, dunst). macOS: `UNUserNotificationCenter` through
`notify-rust`'s `preview-macos-un` backend, which needs a code-signed bundle with an
identifier, so a dev run from a checkout gets `unsupported`; the installed app asks for
permission once at start, and the buttons sit under the notification's Options.
