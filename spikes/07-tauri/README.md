# Spike 07: the Tauri 2 shell

Date: 2026-09-17. Windows 11 Pro 10.0.26200, Rust 1.98.1 / cargo 1.98.1
(`stable-x86_64-pc-windows-msvc`), tauri 2.11.5, wry 0.55.1, tao 0.35.3, WebView2 runtime
153.0.4234.32, Visual Studio Community 2022 17.14 for the MSVC linker, Node 22.22.2.

Rust was not installed on this machine before today; the licence and language decision
listed that as a follow-up. This spike installs it and then tests, one by one, the claims
`architecture.md` makes about the desktop shell. The run is scripted on a timer
([`app/src-tauri/src/main.rs`](app/src-tauri/src/main.rs)), so nothing here depends on a human
clicking. Findings are written by the Rust side to `out/rust.jsonl`, and by the two web pages
to a loopback HTTP collector ([`collector.mjs`](collector.mjs)) that stands in for cophylad's
client protocol — the only channel a view is supposed to have.

**Verdict: the shell shape holds, and two of its claims are wrong as written. A view does not
get the host's native APIs, but it does get the host's commands unless `build.rs` declares
them, and it shares a web origin with the host, so it can read the host's `localStorage` and
cookies.**

## Toolchain install

`rustup-init.exe -y --default-toolchain stable --profile default --no-modify-path`, then
`%USERPROFILE%\.cargo\bin` appended to the user `Path` in the registry as an `ExpandString`.
No admin rights were needed. Everything else Tauri wants on Windows was already here: the
MSVC toolchain from VS Community 2022, the Windows 10/11 SDKs, and the WebView2 runtime that
ships with Windows 11. Nothing else was installed.

| Step | Time |
|---|---|
| Cold `cargo build` (≈500 crates, `-j 12`) | 2 m 40 s across two attempts |
| `cargo build --release` | 1 m 30 s |
| `npx tauri build` (NSIS, including downloading NSIS 3.11) | 54 s |
| `target/` on disk afterwards | 3.9 GB |

Builds were capped at 12 of 24 logical cores.

## Results

| Claim in `architecture.md` | Result |
|---|---|
| Tauri 2 gives the window and the system web view | **Yes.** WebView2 153.0.4234.32, UA `Chrome/153.0.0.0 … Edg/153.0.0.0`. Nothing bundled, nothing downloaded at runtime. |
| Loaded from files, "never a page in a browser and never fetched from a URL" | **True in substance, wrong in wording.** Assets are compiled into the binary, but they are served to the web view over an internal protocol at `http://tauri.localhost`. `location.protocol` is `http:`. See [origin](#host-and-view-share-one-origin). |
| Closing the window leaves the app in the tray, with no taskbar entry, cophylad running | **Yes.** `CloseRequested` → `prevent_close()` → `hide()`. `EnumWindows` over the process afterwards shows the host window as `visible=False`, so it holds no taskbar button, while the process and the tray icon live on. |
| Tray | **Yes**, built programmatically from a raw RGBA image, no icon file needed at runtime. |
| Asks arrive as OS notifications | **Yes, but the toast is attributed to the wrong app.** See [notifications](#an-unbundled-build-sends-notifications-under-the-launching-processs-name). |
| Launch at login | **Yes**, `tauri-plugin-autostart` writes `HKCU\…\CurrentVersion\Run` with no admin prompt, and `disable()` removes the value cleanly. Verified by reading the key while the app held it. |
| It starts the local cophylad | **Yes**, and the child outlives it. A `node` child spawned by the shell was still running minutes after the shell exited — Windows does not reap it. If the shell should ever take cophylad down with it, that needs a Job object; the architecture wants the opposite, so plain `Command::spawn` is right. |
| Its own updater stays off | **Yes by omission.** The updater is a separate crate; not adding `tauri-plugin-updater` means no update path and no `.sig` artifacts in the bundle. Nothing has to be switched off. |
| Its bundler builds the first-install packages | **Yes.** `cophyla-spike07_0.1.0_x64-setup.exe`, 1.89 MB, from a 9.04 MB binary. Signing was not tested. |
| **"A view never reaches a native API: Tauri grants those per web view"** | **Half true, and the half that fails is the dangerous one.** Core and plugin commands are denied by the ACL. App commands are not, until `build.rs` declares them. And capabilities say nothing about the web origin. |

## App commands are outside the ACL until you declare them

`capabilities/host.json` lists `"windows": ["host"]`. The view window is deliberately absent,
which should mean it holds no permission at all.

Round 1 used a bare `tauri_build::build()` in `build.rs`. The view was correctly refused the
core window API:

```
window.setTitle    denied -> window.set_title not allowed.
                             Permissions associated with this command: core:window:allow-set-title
```

and was handed both of the app's own commands anyway:

```
invoke host_ping   *** ALLOWED -> pong-from-rust ***
invoke record_cmd  *** ALLOWED ***
```

`record_cmd` writes to the spike's log, so the untrusted page's call is sitting in round 1's
own evidence file, written through the host's command:

```
{"at":"1789672959.667","data":{},"step":"view_tried_record","who":"rust"}
```

A command defined with `#[tauri::command]` and registered in `generate_handler!` is reachable
from **every** web view in the app unless it is registered with the ACL, which happens only if
the build script names it:

```rust
tauri_build::try_build(
    tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["host_ping", "record_cmd"]),
    ),
)
```

Round 2, with that build script and `allow-host-ping` / `allow-record-cmd` granted to the host
window only, denies all three:

```
invoke host_ping   denied -> Command host_ping not allowed by ACL
invoke record_cmd  denied -> Command record_cmd not allowed by ACL
window.setTitle    denied -> Command plugin:window|set_title not allowed by ACL
```

The host window kept all three. So the isolation the architecture describes is real, but it is
opt-in per command and silent when you forget: a new `#[tauri::command]` added later, without a
matching entry in the app manifest, is exposed to every view on the machine with no warning at
build time. **The shell needs a test that fails when an app command is missing from the
manifest.**

## Host and view share one origin

Both pages load from `http://tauri.localhost`. Capabilities are scoped by window *label*, and
the web origin is not part of that. In round 2 the host page stored what a shell would
plausibly store:

```js
localStorage.setItem("cophyla.session.token", "HOST-ONLY-SECRET-abc123");
document.cookie = "cophyla_session=HOST-ONLY-COOKIE-xyz789; path=/";
```

The view window, holding no capability whatsoever, read both:

```
host localStorage   *** READABLE -> HOST-ONLY-SECRET-abc123 ***
host cookie         *** READABLE -> cophyla_session=HOST-ONLY-COOKIE-xyz789 ***
```

This is ordinary same-origin behaviour, not a Tauri bug, and it defeats the sentence "a view
the harness wrote acts through the client protocol and the gate like anyone else" if the host
page keeps anything in web storage. The gate is enforced in cophylad, which is fine; the leak is
the *credential* for reaching cophylad.

What it means for the shell:

- **The host page must keep no secret in `localStorage`, `sessionStorage`, IndexedDB or a
  cookie.** A client-protocol token belongs in the Rust side, with the host page asking for
  work through a command the view cannot call.
- If views must be isolated from each other as well as from the host, they need distinct
  origins. Tauri can serve a webview from a different origin, which is untested here.
- `fetch` to loopback worked from the view, as intended, and the spike disabled CSP
  (`"csp": null`) to keep the test simple. Production needs a real CSP, and it has to permit
  the client-protocol origin.

One thing the view could **not** do: escape the asset root. `fetch("/../src-tauri/tauri.conf.json")`
normalised back to the app's own asset and returned `index.html` with status 200, not the config
file.

## An unbundled build sends notifications under the launching process's name

`notification()…show()` returned `Ok(())` and a toast did appear, titled **"Windows PowerShell"**
— the process that launched the exe — with the app's own title as the body
(`out/shot-1-windows-open.png`, bottom right). A Windows toast is attributed by
AppUserModelID, which an unbundled exe does not have, so it inherits one. This affects dev runs
and any "run the exe directly" path, not necessarily an installed build, where the installer's
Start Menu shortcut carries the ID. **Untested:** whether the NSIS install registers it
correctly, which needs running the installer.

## Unverified

- macOS and Linux, for all of the above.
- Installing the NSIS package, so: notification identity, launch at login and the tray for a
  real installed build.
- Code signing and notarization, and the `updater` artifacts the signed release feed will need.
- Loading a view from `~/.cophyla/views/` rather than the embedded asset dir. The spike put the
  view's files inside `frontendDist`; how bytes fetched with `view.get` reach a web view
  (custom protocol, `data:` URL, or a written temp dir) is a separate question, and it decides
  whether views can be given separate origins.
- View-to-view isolation, and whether a second origin is available per web view.
- The tray icon was created successfully but could not be positively identified in the
  notification area in either screenshot; Windows 11 hides new tray icons in the overflow by
  default. Whether the shell can promote itself out of the overflow is unknown.
- Sidecars, `skipTaskbar`, multi-webview windows, and starting the real cophylad rather than a
  `node` stand-in.

## Running it again

```
node collector.mjs                       # loopback collector on 127.0.0.1:8777
cd app && npx tauri build                # or: cd app/src-tauri && cargo run
app/src-tauri/target/release/cophyla-spike07.exe
```

The app exits on its own after about 18 seconds. `out/` holds `rust.jsonl`, `web.jsonl`, the
round 1 files and the screenshots; it is gitignored. The run touches the `Run` registry key
only in round 1's version of `main.rs`, and puts it back.
