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
| `src/bridge.ts` | one view's share of that connection: validates each frame, refuses `hello`, unknown methods and anything outside the view's scopes, remaps ids, and narrows the notifications the view hears; `host.ready` says what the host has of its own (`menu`, the phone's bar; `talk`, a microphone and no talk button, so the view draws one) |
| `src/snapshot.ts` | the daemon's picture as the host last saw it — live sessions, workspaces, nodes and their desktops, open tasks and asks, the latest `voice.state`, a voice setup in progress, the account — replayed to a view that mounts later, since cophylad sends them once after `hello` |
| `src/viewhost.ts` | loads the default view into a sandboxed frame, runs a `Bridge` over it, and reloads it when a reconnect or `view.changed` finds a new version |
| `src/chooser.ts`, `src/chooser.css` | the view picker a view opens with `host.chooseView`: a layer over the frame listing `view.list`, where picking one sets the node's default and loads it. Each host page links the stylesheet (`@cophyla/viewhost/chooser.css`), since the controller's policy refuses inline styles |
| `src/settings.ts`, `src/settings.css` | the host's settings a view opens with `host.settings`: a layer over the frame whose Voice section, on a host with a microphone of its own (`VoiceSettings`, the desktop app's), shows what voice is doing, listening for the node's wake words and speaking replies as switches, the talk key and a retry for a refused microphone, and whose Agents section shows, per machine, each harness's usual account (Automatic, naming the one cophylad picks, or a profile) and each profile's sign-in state, usage (`profile.limits`) and, for Claude, the mode and flags sessions start with and where they came from, saved with `profile.update`. `settingsRows` and `SettingsModel` are DOM-free; `SettingsPanel` draws them. Linked like the picker's (`@cophyla/viewhost/settings.css`) |
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
scope check — is the same code in both.

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
- `hello` is the host's, always. A view asking for it gets `denied` before the frame reaches
  the daemon.
