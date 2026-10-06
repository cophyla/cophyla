# installer

The first install and every release after it. Two things live here: the **launcher crate**
(`src-tauri/`), a small Rust program the Tauri bundler packages (`Cophyla.exe`,
`Cophyla.app`, `/usr/bin/Cophyla`) with the staged version directory and the bundled brain as
resources; and the **release scripts** (`scripts/`, Bun) that stage a platform version, sign
what must be signed, write the signed release entries, build the package, keep the static
feed and publish it. Each OS builds its own archive, brain and package with the same
scripts.

The **root** holds the pointers, the versions and the brain seed; the **launcher** is the
one thing that never moves. On Windows they are the same directory. On macOS and Linux the
launcher is a sealed package and the root lives in the user's data directory, seeded from
the package at first start.

| | Windows | macOS | Linux |
|---|---|---|---|
| Launcher | `%LOCALAPPDATA%\Cophyla\Cophyla.exe` | `/Applications/Cophyla.app` (`com.fareaststudios.cophyla.launcher`, `LSUIElement`: no Dock icon) | `/usr/bin/Cophyla` from the `.deb` |
| Root | the launcher's directory | `~/Library/Application Support/Cophyla/` | `$XDG_DATA_HOME/cophyla` (`~/.local/share/cophyla`) |
| Seed | none: NSIS writes the root | `Cophyla.app/Contents/Resources/seed/` | `/usr/lib/Cophyla/seed/` |
| Shell in `versions/<v>/` | `cophyla-ui.exe` | `Cophyla.app/Contents/MacOS/cophyla-ui` (`com.fareaststudios.cophyla.desktop`, a bundle per version) | `cophyla-ui` |
| Runtime | `bun.exe` | `bun` | `bun` |
| Package | `Cophyla_<v>_x64-setup.exe` | `Cophyla_<v>_aarch64.dmg` | `Cophyla_<v>_amd64.deb` (`.AppImage` optional) |

`COPHYLA_INSTALL_DIR` overrides the root everywhere. The names are defined once in
`apps/cophylad/src/update/platform.ts` and the Rust constants are pinned equal to them by
`apps/ui/test/manifest.test.ts`.

```
<root>/
  Cophyla.exe                Windows only: the launcher, the Start Menu shortcut's target (AUMID com.fareaststudios.cophyla.desktop)
  current | previous | staged   pointer files, one version each; the launcher owns the first two, cophylad writes staged
  launcher                   the launcher's own path, written at every start; the shell relaunches through it
  launcher.log
  bin/tether[.exe]           the tether command: cophylad keeps it a copy of the tether it runs, on the user's PATH on Windows and linked from ~/.local/bin elsewhere
  brain/brain[.exe], brain/release.json   the bundled brain seed, verified before every spawn
  versions/<v>/
     release.json            the signed platform entry: with the shell, the mark of a complete version
     cophyla-ui.exe | Cophyla.app/ | cophyla-ui  the desktop shell (apps/ui)
     bun[.exe]               the runtime cophylad runs on
     bin/tether[.exe]        the pseudo-terminal host sessions run in; cophylad runs a copy of it from its data folder
     cophylad/apps/cophylad/{package.json,src,views,models,node_modules} hoisted production install, no harness binaries, no models/voice
     cophylad/apps/controller/dist/ the phone app cophylad serves on the controller listener
     cophylad/sidecars/tts-py/     the speech sidecar's sources and locks; its environment is built on the node
     icons/
```

At every start the launcher syncs the seed into the root where there is one (an empty root
gets `versions/<v>`, `brain` and `current`; a reinstalled newer package is copied and
`staged`; a newer bundled brain replaces the older one; macOS copies lose their quarantine
attribute), rotates `staged` into `current` (the old current becomes `previous`), starts
`versions/<current>/<shell>` with `COPHYLA_INSTALL_DIR`, `COPHYLA_PLATFORM_DIR` and
`COPHYLA_LAUNCHER` (on Unix in its own process group, since launchd ends a login item's group
when the item exits), and rolls the pointer back if the shell exits with a failure within
ten seconds, marking the version `.broken`. On macOS a launcher run from the disk image or,
still quarantined, from where it was downloaded (a read-only volume, or macOS's
`AppTranslocation` copy) starts nothing and asks the user to move the app to Applications:
its path would go into the `launcher` file and the login item, and be gone by the next
start. `Cophyla --rollback` does the same on request;
`--wait-pid <n>` waits for a running shell first (the shell relaunches through the launcher
so the single instance is released).

## Prerequisites

Everywhere: Rust (`~/.cargo/bin`; the scripts add it to PATH), the Tauri CLI from the
workspace (`bunx tauri`), `gh` logged in for publishing. Nothing in `stage/` or
`src-tauri/target/` is committed. In a git worktree, `Cargo.lock` is the checkout's own and
may be missing the launcher: `cargo update -p cophyla-launcher --offline` writes it back
without touching the network.

- **Windows.** NSIS as the CLI installs it under `%LOCALAPPDATA%\tauri\NSIS`, `signtool.exe`
  from a Windows SDK, `tar.exe` from Windows.
- **macOS** (Apple Silicon; `macos-x64` is the same pipeline on an Intel Mac). Xcode command
  line tools (`codesign`, `xattr`, `hdiutil`), Homebrew `jq` for the probes. The bundler's
  own variables carry the identity: `APPLE_SIGNING_IDENTITY` (plus `APPLE_CERTIFICATE` and
  `APPLE_CERTIFICATE_PASSWORD` to import one), `APPLE_ID` + `APPLE_PASSWORD` +
  `APPLE_TEAM_ID` (or `APPLE_API_KEY`…) to notarize. Unset, everything is signed ad-hoc and
  not notarized, which runs on the building Mac and is where the pipeline stands until a
  Developer ID exists.
- **Linux** (Ubuntu 24.04, or WSL with WSLg for the build). `build-essential curl git unzip
  pkg-config libssl-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
  libxdo-dev libgtk-3-dev patchelf`, plus `xdotool wmctrl` for `session.focus`, `dunst` or a
  desktop for notifications. The AppImage target also fetches linuxdeploy at build.

## Keys and certificates: never in the tree

- **Release key** (Ed25519). `bun run apps/installer/scripts/keygen.ts` writes
  `%USERPROFILE%\.cophyla-release\release.key` (refusing a path inside the repository) and prints
  the public half for `RELEASE_KEYS` in `apps/cophylad/src/update/keys.ts`. Move the private key
  offline; the scripts read `COPHYLA_RELEASE_KEY` or that path. A list of keys ships, so a
  rotation adds the next key before releases switch to it.
- **Code-signing certificate.** `sign.ts` reads `COPHYLA_SIGN_PFX` + `COPHYLA_SIGN_PASSWORD`, or
  `COPHYLA_SIGN_THUMBPRINT` for a certificate in the user's store or on a token. Until the real
  certificate exists, a self-signed test certificate drives the same pipeline:
  `New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Cophyla Dev"` exported to
  `%USERPROFILE%\.cophyla-release\test.pfx`. Windows shows SmartScreen's "unrecognised app" for
  it; the real certificate drops in through the same variables.

What is signed, per OS, through the one `sign.ts` fed by the environment:

- **Windows.** The launcher, the installer, the uninstaller and the NSIS plugins by the
  bundler through `signCommand` → `sign.ts`; the shell by `stage-platform.ts`; the brain by
  `release-brain.ts`. `bun.exe` carries Oven's signature.
- **macOS.** `codesign --options runtime --entitlements entitlements.plist` (Bun's set:
  JIT, unsigned executable memory, no executable-page protection, no library validation)
  on plain Mach-O files: the runtime and every Mach-O under cophylad's `node_modules`
  (`sign.ts --tree`) by `stage-platform.ts`, the brain by `release-brain.ts`. The shell
  bundle, the launcher bundle and the DMG are signed (and notarized and stapled, once the
  variables are set) by the Tauri bundler from the same `APPLE_*` environment; the shell
  bundle with `entitlements-shell.plist` (the web view's microphone, and Apple Events for
  `session.focus` and `tether open`). The launcher starts the shell with its
  responsibility disclaimed (`src-tauri/src/spawn_mac.rs`), so macOS asks for the
  microphone, Automation and the local network in the shell's name, under its bundle's
  usage texts, and not the launcher's, which declares none and exits ten seconds in. The
  identity is `APPLE_SIGNING_IDENTITY`, ad-hoc (`-`) when unset. A Developer ID signature
  is timestamped by Apple's server or the signing fails (notarization refuses one without),
  unless `COPHYLA_SIGN_UNSTAMPED=1` says the build is never to be notarized.
- **Linux.** Nothing; the `.deb` is what it is.

The phone's web viewer on a Mac: upstream's moonlight-web publishes no macOS build, so
`scripts/build-moonlight-web.ts` (on an Apple Silicon Mac, with `brew install openssl@3`) clones
the tag `remote/manifest.ts` pins, builds its frontend and its two binaries (upstream's npm and
cargo build scripts run, on the nightly it pins), checks they link only the system's libraries,
and writes `stage/moonlight-web/moonlight-web-aarch64-apple-darwin.tar.gz` in upstream's
layout, with the GPL's text and a `SOURCE` note. It prints the `WEB_ASSETS` entry the archive
takes once published (it is GPL: the source offer goes with it); until then `[remote]
web_server` names the unpacked `package/web-server`. Built on 2026-09-28: 14,639,235 bytes,
the frontend identical to upstream's Linux release, healthy under cophylad's sidecar.

Files under `stage/` are hashed by a release entry, so `sign.ts` leaves them as they are
unless called with `--staged`: the bundler would otherwise re-sign every executable it
bundles and break the bundled brain's hash.

## Release recipe

The platform version has one source, `apps/cophylad/package.json`; `version.ts --check` fails
when the shell's and launcher's manifests disagree, `version.ts --set <v>` writes them all.

The same commands on each OS; the names follow the host (`platform-<v>-<os>-<arch>.tar.gz`,
`brain-<v>-<os>-<arch>[.exe]`, the package of the table above).

```
# a platform release: stage/versions/<v>, stage/out/platform-<v>-<os>-<arch>.tar.gz, both release.json files
bun run apps/installer/scripts/release-platform.ts            # shell build (release; a bundle on macOS), stage, pack, sign-release

# a brain release, from the brain repository beside this one (its build emits dist/brain[.exe])
bun run apps/installer/scripts/release-brain.ts               # bun run build, sign, stage/out copy, sign-release into brain/dist

# the first-install package: the staged version, stage/current, and the brain seed
bun run apps/installer/scripts/stage-brain.ts --from brain/dist   # or --feed, to bundle the newest published brain
bun run apps/installer/scripts/build-installer.ts [--appimage]    # overlay + tauri build --config; stage/out/Cophyla_<v>_…

# a model release, once per model, from the directory fetch-models.ts --voice wrote: the wake word's
# and the VAD's only; a speech engine's model is never released, a node installs it from its makers
bun run apps/cophylad/scripts/fetch-models.ts --voice --only wake-openwakeword,vad-silero   # apps/cophylad/models/voice/<name>/, pinned by sha256
bun run apps/installer/scripts/release-model.ts --name vad-silero      # stage/out/model-<name>-<v>.tar.gz + its entry

# the feed: every target's entries, copied from the other machines' stage/out into this one
bun run apps/installer/scripts/feed.ts --add stage/out/*.release.json
bun run apps/installer/scripts/serve-feed.ts                  # LAN feed for a clean machine; --only platform@0.1.0,model/vad-silero@1.0.0 to hold entries back
bun run apps/installer/scripts/publish.ts --release platform@<v> --release brain@<v> --release model/vad-silero@1.0.0 --installer --feed --yes
```

`COPHYLA_SIGN_*` (Windows) or `APPLE_*` (macOS) must be in the environment of every step that
signs. The `release.json` entry signs everything but `url`, so the same entry serves the
LAN feed (`serve-feed.ts` rewrites the URL) and GitHub; `sign-release.ts --target
<os>-<arch>` signs an artifact built on another machine. The brain is fetched at build:
`stage-brain.ts --feed` downloads and verifies the newest stable brain from the public feed;
`--from` takes a local build. The brain is built on each host (or cross-built with
`bun build --compile --target` and passed through `release-brain.ts --skip-build` on the
host that signs it).

A **model** is the third component, and the one that is not per target: it is bytes a voice
stage loads, so its entry carries no `os`, no `arch` and no protocol range, and `feed.ts
--add` puts it into every target's file of its channel. One model is one GitHub release,
`model-<name>-v<version>`, with the one archive `model-<name>-<version>.tar.gz` as its
asset. The daemon fetches a model the first time a stage that needs it is turned on and
unpacks it under `~/.cophyla/data/models/<name>/<version>/`, checking every file against the
`manifest.json` inside the archive; it never ships in the platform archive. Only the
platform's own voice models are released so, the wake word's and the VAD's: a speech
engine's (Moonshine, Whisper, Nemotron, Piper, Kokoro, Supertonic) is never published by Cophyla, and neither is
sherpa-onnx, the runtime they run on, whose native library carries espeak-ng (GPL-3.0). A
node installs an engine from its makers — the npm registry, the k2-fsa releases, Hugging Face,
pinned by hash in `apps/cophylad/src/voice/catalog.ts` — when its user asks, after the app
has shown the licences, and `release-model.ts` and `stage-platform.ts` refuse to carry any
of it. Re-cutting the same bytes under a new version is `release-model.ts --name <n>
--version <v>`; otherwise the version is the manifest's.

The **speech sidecar** ships as sources and locks only (`sidecars/tts-py/`, a few hundred
kilobytes). Its Python environment is about 5 GB and its weights about 2 GB, both built on
the node the first time the `chatterbox` stage is turned on, resumable step by step. No
release and no installer ever carries them.

Sizes seen at 0.13.0: a version directory is 290 MB (8.1k files; the runtime 94 MB, cophylad's
tree 165 MB with onnxruntime's 65 MB and the embedding model's 33 MB in it, the controller app
21 MB, the shell 19 MB), its archive 121 MB, the brain 95 MB (the runtime is inside), the
installer 120 MB (NSIS LZMA over the stage; ~5 minutes, most of it the compression). The
platform's voice models beside it: openwakeword 5 MB, silero 0.5 MB. What a node installs for a
speech engine: the runtime 9–14 MB, Moonshine Tiny 30 MB, Moonshine Base 111 MB, Whisper Base
208 MB, Piper 82 MB, Supertonic 129 MB, Kokoro 320 MB, Nemotron 475 MB, each a download from
its makers.

## Clean-machine run (Windows Sandbox)

`Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All`
once, as administrator, then reboot. `bun run apps/installer/scripts/sandbox.ts` writes
`stage/cophyla.wsb` (maps `stage/out` read-only, networking on, a logon script that writes the
sandbox's `~\.cophyla\config.toml` with `[update] feed = "http://<host ip>:8790"`,
`allow_insecure_feed = true` and a one-minute check); the host runs `serve-feed.ts` on
`0.0.0.0:8790` (open TCP 8790 in the firewall for the sandbox's network). Keep one sandbox
session open for a whole run: it resets on close. The model key goes into the sandbox's
config by hand, never into `stage/out`.

The acceptance run, in the order that works (a rollback consumes `previous`, so the manual
rollback comes before the broken-release check). Rehearsed on the build machine on
2026-09-19 against a scratch `COPHYLA_HOME` and the feed on loopback: every step below behaved
as written, except the tether command's checks in steps 1 and 9, which are newer; the sandbox
repeats it on a machine that never had Bun, Rust or a checkout.

1. **Install.** Host: `serve-feed.ts --only platform@0.1.0,brain@0.1.1`. Sandbox: run
   `out\Cophyla_0.1.0_x64-setup.exe` (SmartScreen "Run anyway" with the test certificate;
   the WebView2 bootstrapper if the runtime is missing). `%LOCALAPPDATA%\Cophyla` has the
   layout above with `current = 0.1.0`; the Start Menu shortcut's `System.AppUserModel.ID`
   is `com.fareaststudios.cophyla.desktop`; the app opens; `~\.cophyla\data\cophylad.log` shows `listening`,
   `brain verified {origin: bundled}` and `brain up … 0.1.1`; the feed log shows exactly
   `GET /stable/windows-x64.json`. `cophylad.log` also shows `tether command in place` and
   `tether command's folder added to the user's PATH`; a terminal opened afterwards answers
   `tether --version`, and `tether run -- cmd` from it starts a session `tether ls` lists.
2. **Milestones 1–3.** Paste the model key into the sandbox's `config.toml`
   (`[providers.gemini] api_key`), install Claude Code and log in, restart the app from the
   Start Menu: an attached terminal session appears, `session.send` delivers, a permission
   prompt is answered from the toast; chat quotes a session under a source chip; "make a
   change in <workspace>" starts an agent, its ask reaches the queue, a question is answered
   meanwhile, the result is reported on idle.
3. **Update.** Host: restart `serve-feed.ts` without `--only`. Within a minute `cophylad.log`
   shows `platform staged 0.1.1` and `brain staged 0.1.2`, then `applying brain release
   … auto`, `brain release promoted`, `brain verified {origin: installed}`, `brain up …
   0.1.2`, and `staged platform waits: a desktop app is attached`. The tray shows "Restart
   to update 0.1.1"; the host status line says so. Click it: `cophylad.log` ends with `platform
   release applies at the next start; stopping`, `launcher.log` shows the wait for the old
   shell, `rotated: current 0.1.1, previous 0.1.0` and `0.1.1 running`; the app is back,
   sessions and chat still there, hello `platformVersion 0.1.1`, cophylad running from
   `versions\0.1.1\bun.exe`.
4. **Drops.** Host: serve a feed copy with one signature byte flipped on `brain@0.1.2` and a
   `platform@0.1.1` entry signed with `--protocol 2-2` (`sign-release.ts` on a copy of the
   archive). `update.check` (or the next minute) logs `release dropped {reason: "bad
   signature"}` and `release dropped {reason: "protocol range 2-2 excludes 1"}`; nothing is
   staged.
5. **Refused brain.** Quit the app, flip one byte of `~\.cophyla\data\brain\current\brain.exe`,
   start it again: `brain refused {reason: "hash"}`, `brain release rolled back {now:
   "bundled"}`, `brain up … 0.1.1` (the seed; `previous` when an earlier release was
   installed). The next good check stages 0.1.2 again with fresh bytes.
6. **Manual rollback.** Quit the app; `Cophyla.exe --rollback`: `launcher.log` shows `rolled
   back to 0.1.0 on request`, `current = 0.1.0`, `versions\0.1.1\.broken`; the shell 0.1.0
   connects to the still-running daemon 0.1.1, which logs `platform release applies at the
   next start; stopping {current: 0.1.0, running: 0.1.1}` and stops; the shell starts cophylad
   0.1.0, which prunes `versions\0.1.1` and remembers it (`kv update/broken`), and the feed's
   0.1.1 is never staged again.
7. **Broken release.** Quit the app; make `versions\0.1.2\cophyla-ui.exe` a program that
   exits non-zero (`where.exe` does), add any `release.json`, write `staged = 0.1.2`; start
   from the Start Menu: `launcher.log` shows `rotated: current 0.1.2`, `start failed`,
   `rolled back to 0.1.0; 0.1.2 marked broken`, `0.1.0 running`.
8. **Toast.** The permission toast in step 2 is titled "Cophyla" with the icon.
9. **Uninstall.** Quit the app, keep a `tether run -- cmd` open, uninstall from Settings →
   Apps: `%LOCALAPPDATA%\Cophyla` keeps only `bin\tether.exe`, which that terminal still runs;
   the user's `Path` (`HKCU\Environment`) has lost `Cophyla\bin` and nothing else, and is
   still an expandable string.

## Clean-machine run (Linux)

Build in WSL Ubuntu 24.04 (WSLg gives it a display for the `session.focus` and hook checks
from an `xterm`); accept in a fresh Ubuntu desktop VM (Hyper-V), where the tray, the
notification buttons and the login entry need a real session. The host serves the feed with
`serve-feed.ts --host 0.0.0.0`; the VM's `~/.cophyla/config.toml` is what
`sandbox.ts --print-config --host <host ip>` prints, plus the model key. PL1, PL2, PL4 and
PL5 were run in WSL on 2026-09-19 against a scratch home and the feed on loopback
(spikes/09-unix/README.md has the transcript); PL3 waits for the desktop VM.

- **PL1, the package.** `dpkg -I Cophyla_<v>_amd64.deb` shows the `Depends` of
  tauri.conf.json; `dpkg -c` lists `/usr/bin/Cophyla`, `/usr/lib/Cophyla/seed/{versions/<v>,
  brain,current}` and `/usr/share/applications/Cophyla.desktop` with
  `StartupWMClass=cophyla-ui` (read the generated file before trusting the template).
- **PL2, first start.** `sudo dpkg -i` (then `apt-get -f install` for the depends); start
  Cophyla from the launcher menu: `~/.local/share/cophyla` has the layout above with
  `current = <v>` and the `launcher` file naming `/usr/bin/Cophyla`, `launcher.log` shows
  `seeded <v> … first start`, the shell runs from `versions/<v>/cophyla-ui` and cophylad from
  `versions/<v>/bun` (`ps -o cmd`), a second start is a no-op (`launcher.log` without a
  seed line). A newer `.deb` installed over it logs `seeded … package reinstalled` and
  `rotated: current <v+1>`.
- **PL3, desktop.** The tray icon through AppIndicator with Open, Launch at login, Quit; a
  permission ask is a notification titled Cophyla with the options as buttons, and a button
  answers it; close hides the window and the tray shows it again; Launch at login writes
  `~/.config/autostart/Cophyla.desktop` (`Exec=/usr/bin/Cophyla --hidden`) and the next login
  starts the tray without a window. `session.focus` from the view raises the `xterm` that
  runs a session (`xdotool` in PATH); a session in a terminal that is not an X window is
  `not_found`.
- **PL4, updates.** Steps 3 to 7 of the Windows run with the paths of the table: the
  platform is staged through `tar`, "Restart to update" relaunches through `/usr/bin/Cophyla`
  (`COPHYLA_LAUNCHER`), the pointers rotate, the staged brain runs with mode `0755`, a broken
  version rolls back with `.broken`, bad signature and protocol range are dropped and
  logged.
- **PL5, uninstall.** `dpkg -r cophyla` removes the package; the root under `~/.local/share`
  stays (the user's data), and a reinstall seeds nothing new while `current` is at or above
  the package's version.
- **PL6, AppImage** (only if kept): `build-installer.ts --appimage`, the image runs on a
  non-Ubuntu distribution with `libwebkit2gtk-4.1` installed and seeds from
  `$APPDIR/usr/lib/Cophyla/seed`.

## Clean-machine run (macOS)

Build on the Mac (`uname -m` says `arm64`); accept as a second, clean macOS user account
on the same machine, with the dev account serving the feed on loopback
(`serve-feed.ts --host 127.0.0.1`; the acceptance config from
`sandbox.ts --print-config --host 127.0.0.1`). The prerequisites above; a signing identity
is optional until it exists. PM1 to PM6 were rehearsed on the build account on 2026-09-28
against a scratch `COPHYLA_HOME` and `COPHYLA_INSTALL_DIR` (spikes/09-unix/README.md has the
run); the clean account, notarization and the microphone remain. Two things a script needs:
the DMG carries the licence, so `hdiutil attach` is answered (`yes | PAGER=cat hdiutil
attach -nobrowse …`); and `open --env` hands the app the caller's whole environment, so a
start as the Finder makes it is `env -i HOME=… USER=… SHELL=… TMPDIR=…
PATH=/usr/bin:/bin:/usr/sbin:/sbin open -n --env COPHYLA_HOME=… Cophyla.app`.

- **PM1, the package.** `Cophyla_<v>_aarch64.dmg` holds `Cophyla.app` with
  `Contents/Resources/seed/{versions/<v>,brain,current}`, `LSUIElement` and
  `CFBundleIdentifier com.fareaststudios.cophyla.launcher` in its Info.plist (`plutil -p`); the shell inside
  `seed/versions/<v>/Cophyla.app` has `com.fareaststudios.cophyla.desktop` and `NSAppleEventsUsageDescription`.
- **PM2, signatures.** `codesign --verify --deep --strict` and `spctl -a -t exec -vv` on the
  launcher, the DMG and the nested shell: ad-hoc signatures verify and `spctl` rejects them
  (expected until a Developer ID exists); with an identity set, both pass and
  `stapler validate` succeeds on the DMG.
- **PM3, the runtime under the hardened runtime.** The staged `bun` and the compiled brain,
  signed with the entitlements, start: the brain answers `hello`.
- **PM4, first start.** Drag to Applications, open from the Finder: no Dock icon for the
  launcher, then the shell's own Dock icon and menu bar item (`com.fareaststudios.cophyla.desktop`);
  `~/Library/Application Support/Cophyla` has the layout above with `current = <v>` and the
  `launcher` file naming `/Applications/Cophyla.app/Contents/MacOS/Cophyla`; cophylad runs from
  `versions/<v>/bun`; the shell survives the launcher's exit (its own process group);
  `mdfind "kMDItemCFBundleIdentifier == 'com.fareaststudios.cophyla.desktop'"` lists only the shells under
  `versions/` (a duplicate `Cophyla.app` in Spotlight is the cue to rename the shell bundle
  file, one constant). Close removes the Dock entry; a click on the app in the Finder or the
  tray brings the window back; Cmd+Q hides.
- **PM5, desktop.** The `UNUserNotificationCenter` prompt says Cophyla; a permission ask is
  a notification with the options as buttons (the long-look: hover, then Options) and a
  button answers it. `session.focus` on a Claude session in Terminal asks for Automation on
  System Events once, then raises Terminal; denied, it is `unsupported` and the log names
  System Settings › Privacy & Security › Automation. Launch at login writes
  `~/Library/LaunchAgents/com.fareaststudios.cophyla.launcher.plist` and the next login starts the tray
  without a window.
- **PM6, updates.** Steps 3 to 7 of the Windows run with the paths of the table: the
  platform is staged through `tar` and loses its quarantine attribute, "Restart to update"
  relaunches through `COPHYLA_LAUNCHER`, the pointers rotate, the staged brain runs with mode
  `0755`, a broken version rolls back with `.broken`, bad signature and protocol range are
  dropped and logged.

## Probes (2026-09-19, Windows 11, Tauri CLI 2.11.4, tauri-utils 2.9.3, Bun 1.3.14)

| # | Question | Result |
|---|---|---|
| P1 | Does `tauri build` bundle a launcher crate that does not use Tauri? | Not without a `tauri` dependency: the CLI passes `--features tauri/custom-protocol` and cargo refuses. With `tauri = { version = "2", default-features = false }` (unused, ~1 min compile) it builds; `mainBinaryName: "Cophyla"` renames the binary; `bundle.resources` with directory sources keeps the tree (one `File /oname=…` per file); `SetLnkAppUserModelId` puts `com.fareaststudios.cophyla.desktop` on the shortcut (read back with `System.AppUserModel.ID`); the four hook macros are inserted; the uninstaller removes what it installed and the hooks the rest. The CLI rewrites the launcher's Cargo.toml line to add `features = []`; the tree carries that form. |
| P2 | Does cophylad run from a hoisted production install without optional dependencies and without the workspace? | Yes: `bun install --production --omit=optional --linker=hoisted` in a copy whose package.json drops the `workspace:` link, plus `packages/protocol` copied to `node_modules/@cophyla/protocol`, 54 MB, no module missing; `hello` answers; `claude-agent-acp` initialises with `CLAUDE_CODE_EXECUTABLE` set and `codex-acp` with `CODEX_PATH` set (cophylad sets both from the discovered profile; without them the adapters fall back to vendored binaries that are not shipped). |
| P3 | Does a Bun-compiled brain survive Authenticode? | Yes: `bun build --compile --minify --windows-hide-console --windows-icon --windows-title --windows-version` gives a 95 MB exe; signed with signtool it still answers `hello` with `brainVersion 0.1.1`. |
| P4 | Can the Windows Sandbox reach a `Bun.serve` on the host? | Pending: the feature was not enabled on this machine (needs an administrator and a reboot). The whole acceptance sequence was rehearsed on the build machine instead, against a scratch home and the feed on loopback (below). |
| P5 | Does a self-signed test certificate drive signtool? | Yes: `signtool sign /fd SHA256 /f test.pfx /p … /tr http://timestamp.digicert.com /td SHA256` signs and timestamps; `verify /pa` fails only on the untrusted root, as expected. |

Found while building: the bundler re-signs every bundled executable whose signature does
not verify (the test certificate's), in place in the stage; `sign.ts` now leaves staged
files alone. `Bun.TOML.parse` returns `{}` for a file starting with a byte-order mark
(PowerShell's `Set-Content -Encoding utf8` writes one), so cophylad and the shell strip it.

## Layout

| Path | Role |
|---|---|
| `src-tauri/src/main.rs` | the launcher: arguments, wait for the previous shell, rotate or roll back, start the shell, watch it, roll back on failure, `launcher.log` |
| `src-tauri/src/layout.rs` | pointers, completeness, `.broken`, `rotate`, `rollback`; `cargo test -j 12` over temp directories |
| `src-tauri/tauri.conf.json`, `hooks.nsh`, `LICENSE.txt`, `frontend/` | the bundle: identity, NSIS per-user install, the four hooks, the licence page, the page the bundler insists on |
| `scripts/lib.ts` | paths, `run`, the version rule, signtool and release-key discovery |
| `scripts/keygen.ts`, `sign.ts`, `sign-release.ts` | the release key, Authenticode, the signed entry |
| `scripts/version.ts` | one version everywhere |
| `scripts/stage-platform.ts`, `pack-platform.ts`, `release-platform.ts` | a platform version directory and its archive |
| `scripts/release-brain.ts`, `stage-brain.ts` | a brain release; the seed the installer bundles |
| `scripts/release-model.ts` | one voice model packed and signed: `model-<name>-<v>.tar.gz`, no target, every target's feed file |
| `scripts/build-installer.ts` | the overlay and `tauri build --config` |
| `scripts/feed.ts`, `serve-feed.ts`, `publish.ts`, `sandbox.ts` | the static feed, its LAN server, GitHub, the sandbox configuration |
