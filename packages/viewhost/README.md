# @cophyla/viewhost

The host side of a view, shared by the desktop app and the controller. A view is a frontend
that speaks the client protocol over its host's connection, and the host is what makes that
safe: it owns the socket, loads the view into a sandboxed frame, and lets through only what
the view's manifest asks for. That job is the same on a Tauri window and on a phone in a
browser, so it lives here rather than twice.

Everything is DOM-free except `ViewHost`, which owns the frame, and `ViewChooser` and
`SettingsPanel`, which draw the picker and the settings over it, and every dependency is
injected, so the tests run under `bun test` with no browser.

| File | Holds |
|---|---|
| `src/connection.ts` | the link to cophylad: frames and link state in, a request/response API out, ids in the `h<n>` namespace. The transport is injected (`TauriIo`), so the shell can put the socket on its native side and the controller can hold it in the page |
| `src/bridge.ts` | one view's share of that connection: validates each frame, refuses `hello`, unknown methods and anything outside the view's scopes, remaps ids, and narrows the notifications the view hears; `host.ready` says what the host has of its own (`menu`, the phone's bar; `talk`, a microphone and no talk button, so the view draws one; `filePaths`, it says where files dropped from the desktop are, through `host.filePaths`; `docFrame`, where it serves the document frame a view runs an HTML file's scripts in); a host that says `talk` says `host.mic` when its microphone goes off or comes back, with why, and again after `host.ready` while it is off; a host with a microphone says `host.recording` when it starts or stops recording an utterance and `host.levels` meanwhile, to a view with the voice scope alone, and `host.recording` again after `host.ready` while it records |
| `src/snapshot.ts` | the daemon's picture as the host last saw it — live sessions, workspaces, nodes and their desktops, open tasks and asks, the latest `voice.state`, the words of this client's utterance so far (`voice.partial`, kept whole and replayed whole), a voice setup in progress, the account, the brain's turn while it runs (`chat.progress`) — replayed to a view that mounts later, since cophylad sends them once after `hello` |
| `src/viewhost.ts` | loads the default view into a sandboxed frame, runs a `Bridge` over it, and reloads it when a reconnect or `view.changed` finds a new version; `recording` and `levels` pass the host's microphone on to the view mounted, and to one mounted while it records |
| `src/chooser.ts`, `src/chooser.css` | the view picker a view opens with `host.chooseView`: a layer over the frame listing `view.list`, where picking one sets the node's default and loads it. Each host page links the stylesheet (`@cophyla/viewhost/chooser.css`), since the controller's policy refuses inline styles |
| `src/settings.ts`, `src/settings.css` | the host's settings a view opens with `host.settings`: a layer over the frame whose first section, Listening for, lists what wakes Cophyla besides the user's messages (`listener.list`: each listener's why, what it listens on, how it tells and its fires) with a Remove (`listener.remove`), and says only the user's messages do when there is none; whose Voice section, on a host with a microphone of its own (`VoiceSettings`, the desktop app's), shows what voice is doing, listening for the node's wake words and speaking replies as switches, the talk key, the microphone it listens on (the system's default or one picked, `micOptions`), why it is not the one picked, and a retry for a refused microphone; on every host it holds the node's engines — the one that transcribes and the one that reads replies out with its voice and the speed it reads at (`voice.settings`, `voice.configure`), where each choice came from with a Reset, Hear it (`voice.preview`), for an online engine where it goes first, Cophyla cloud or the user's own key (`sttRoute`, `ttsRoute`), and the Gemini and DeepInfra keys by where each comes from and its last four characters, with a field to give one and a Clear for one given here (`account.apiKey`; what is typed leaves the page once it is sent), and for a local engine not installed its licences as links and Install with its size (`voice.install`), read again each second while an engine loads or installs — and whose Agents section shows, per machine, each harness's usual account (Automatic, naming the one cophylad picks, or a profile) and each profile's sign-in state, usage (`profile.limits`) and, for Claude, the mode and flags sessions start with and where they came from, saved with `profile.update`. `settingsRows`, `speechRow`, `sttRow`, `listenerLine` and `SettingsModel` are DOM-free; `SettingsPanel` draws them. Linked like the picker's (`@cophyla/viewhost/settings.css`) |
| `src/notify.ts` | open asks on OS notifications, their options as buttons, answered on the host's own connection |

## The two seams

**The transport.** `Connection` takes a `TauriIo`: `invoke(cmd, args)`, `listen(event, cb)`.
The desktop app fills it with the real Tauri bridge, so the credential and the socket stay on
the native side and the page never holds either. The controller fills it with a WebSocket it
owns, because a browser page has no native side — and refuses `hello` and `pair.claim` on
that path, so the only thing that can say them is the page's own code.

**Staging.** `ViewHost` is given a `stage(manifest)` that returns the base URL its frame
loads from. The shell writes the files and serves them from its `view` custom protocol; the
controller calls `view.stage` and the node serves them under a ticket with the same
content-security policy. Everything between — the opaque origin, the `postMessage` line, the
scope check — is the same code in both. Staging also says where the host serves the document
frame (`docFrame`: the shell's `doc` scheme, the node's `/doc/frame.html`, the phone's copy
beside the staged view), which the bridge hands the view in `host.ready`.

## What holds

- The frame has `sandbox="allow-scripts allow-forms"` and no `allow-same-origin`, so its
  document runs on an opaque origin: no IPC, no web storage, and no network of its own by its
  own CSP. `allow-forms` is what lets a form's `submit` event fire at all (Chromium drops the
  submission before the event without it); the CSP's `form-action 'none'` keeps the
  submission from going anywhere. Messages are accepted only from that frame's window and
  posted only to it.
- A view's `scopes` narrow the connection's, never widen them. A manifest that lists none
  lets the view send nothing.
- `host.chooseView` needs no scope: the picker is the host's and what is picked there is the
  user's doing. Every view must offer a control that asks for it, since a view without one
  leaves the user no way to another.
- `host.settings` needs none either, for the same reason, and every view must offer it beside
  Change view: the settings are the user's, and the frame is all they see.
- `host.openLink` needs none: it opens a web page the user clicked (a URL in a terminal) in
  their browser, and only that. The bridge lets through an http or https URL with a host and
  no credentials in it (`webLink`), and `ViewHost` only while the page has the user's
  activation, which a click in the frame gives it for a few seconds, so a view cannot open
  pages nobody clicked. A host without the seam answers `unsupported`.
- `host.savePrefs` needs none: it keeps `{ prefs }`, a plain object of at most 8 KB as JSON
  (`viewPrefs`), in the host page's storage under the view's id, and `host.ready` hands it
  back as `prefs`. It is how a view without web storage of its own remembers how the user
  left it on this device; one view never sees another's.
- `host.filePaths` needs none: it says where the files just dropped on the view from the
  desktop are, which a web page knows only by name. The view sends `{ names }`, the dropped
  `File`s' names (1 to 4096 of them, none empty, longer than 1024 or with a slash or NUL:
  `droppedNames`), and gets `{ paths }` in the names' order; the shell answers only for a
  drop it saw pass into the page under five seconds ago, of as many files, each name one of
  its paths' own, and hands a drop over once. Where the page saw no names, since WebKitGTK
  (Linux) shows it no dropped file at all, the view sends no `names` and the Linux shell
  answers every path of that fresh drop, in its order; any other shell refuses a request
  without names. `filePaths` in `host.ready` says the host has
  it (the desktop app); a host without the seam answers `unsupported`. In WebView2 (Windows)
  the view asks the shell itself instead, past the bridge, since WebView2 grants a dropped
  file to the process of the frame it was dropped on alone and the host page could not hand
  it on: it posts `{ cophyla: "cophyla.filePaths", id }` with the `File`s through
  `chrome.webview.postMessageWithAdditionalObjects`, and the shell answers its frame with
  `{ cophyla: "cophyla.filePaths", id, paths }` (apps/ui/src-tauri/src/dropped.rs).
- The document frame (`@cophyla/protocol`'s `docframe.ts`) is the one page a view may frame:
  a page each host serves on an origin the view's policy names, under a policy of its own
  (`sandbox allow-scripts`, scripts inline and from `data:`, no `connect-src`, frames, forms
  or base), which writes the HTML its framer posts it over itself, once. A page's scripts run
  there and reach nothing; its messages reach neither the view's bridge, which hears only the
  view's parent, nor `ViewHost`, which hears only the view's frame. A host that serves none
  names none, and the view draws an HTML file with its scripts off.
- `hello` is the host's, always. A view asking for it gets `denied` before the frame reaches
  the daemon.
