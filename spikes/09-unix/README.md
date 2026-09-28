# Spike 09: the Unix side

Date: 2026-09-19. What milestone 5 could not verify on the Windows build machine, and the
probes that verify it on the two other platforms: WSL Ubuntu 24.04 (with WSLg) for Linux,
the user's Apple Silicon Mac for macOS. The code under test is the real tree, not a copy;
these are the questions, the commands and the answers, kept here so the docs state only the
results. The Linux column is filled from WSL as the build runs; the macOS column is filled
by the user running [`mac-probes.sh`](mac-probes.sh) and the two spikes below and pasting
the output back.

## Questions

| # | Question | Linux (WSL) | macOS |
|---|---|---|---|
| U1 | Does node-pty deliver input and output under Bun? | **No**: the pty child is hung up (`signal 1`) before its first byte under Bun 1.4.2; Node 22 delivers both. The harness driver hosts node-pty under a Node broker. Under Bun on Windows the input side fails the same way ("Socket is closed"). | **No**, as on Linux (2026-09-28, Bun 1.3.14, macOS 14.5 arm64): under Bun no byte and no exit; Node 22 delivers both (`PTY_OK`). The harness's Node broker covers it; the product runs sessions in tether. |
| U2 | The POSIX Claude registry: which fields carry the process start, and how is the socket path shaped? | pending (needs a Claude login in WSL) | **Answered** (Claude 2.1.283): `procStart` is a date string (`Mon Sep 28 14:03:12 2026`), `pidDomain: "darwin"` (absent before ~2.1.26x), `messagingSocketPath` `/tmp/cc-socks/<pid>.sock` (entries from ≤2.1.222 have `null` and no key file); `<pid>.<64hex>.key` mode 0600. `registry.ts` reads it as is: the Claude harness tests pass on the Mac (below). |
| U3 | Where does a macOS Claude login live, and does a second `CLAUDE_CONFIG_DIR` login get its own Keychain item? | n/a | **Half**: no `.credentials.json`; the login is the Keychain item `Claude Code-credentials`, found by `security find-generic-password -s` without a prompt. A second `CLAUDE_CONFIG_DIR` login waits for one to exist on the Mac. |
| U4 | Does the Codex binary report the sh `command` (not `commandWindows`) in `hooks/list` on Unix, and what is the trust key path? | **Yes** (codex 0.155.1): `hooks/list` reports the sh form, `sourcePath` is the hooks file, the grant writes `hooks.state."<home>/hooks.json:<event>:0:0".trusted_hash` and a re-list says `trusted`. | pending (`bun test apps/cophylad/test/codex-hooks-trust.test.ts`) |
| U5 | Is a terminal `codex` on Unix hosted by the shared daemon? | pending (`ps -eo pid,ppid,comm \| grep codex` with a terminal `codex` open; `ls ~/.codex/app-server-control/`) | pending (`mac-probes.sh` U5) |
| U6 | Does `session.focus` raise an `xterm` under WSLg, and report `not_found` for a Windows Terminal session? | pending (D3, needs a Claude login in WSL) | **Yes** (2026-09-28, the installed app): `session.focus` on a Claude session in Terminal raised Terminal in 3.4 s, through the libproc table (root's `login` included since) and System Events, in the shell's name. The denied path is not rerun. |
| U7 | Do Bun-built binaries run under the hardened runtime with `entitlements.plist`? | n/a | **Yes**: the staged `bun`, tether and the compiled brain, ad-hoc signed with `--options runtime` and Bun's entitlements, start; the brain answers `hello` and the daemon runs from the version folder. |
| U8 | Does `notify-rust`'s `preview-macos-un` backend show buttons and return the action id from an ad-hoc-signed bundle? | n/a | **Yes**: from the ad-hoc-signed shell bundle a permission ask showed as a notification with its options (hover, Options), and the button answered it (`option: allow, by: user`). |
| U9 | Does the `.deb` carry the seed, the desktop entry and the depends the config says? | **Yes**: `/usr/bin/Cophyla`, `/usr/lib/Cophyla/seed/{versions/0.1.1,brain,current}`, `Cophyla.desktop` with `StartupWMClass=cophyla-ui` and `Categories=Development;`, `Depends: libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0` (the bundler adds the last two itself), 85 MB; the AppImage (149 MB) has the same tree under `$APPDIR/usr`. | n/a |
| U10 | Does Tauri 2.11 notarize and staple the DMG from `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` alone? | n/a | open until a Developer ID exists (the DMG itself is left unsigned by an ad-hoc build) |
| U11 | Does the update mechanism run on Linux from the package? | **Yes**, the whole PL2/PL4/PL5 sequence in WSL on 2026-09-19 (below). | **Yes**, PM4–PM6 on 2026-09-28 (below). |
| U12 | Does the host's navigation handler see the view frame's load? | **Yes** on WebKitGTK (and WKWebView, by wry's source): the frame's `http://view.localhost` load was refused until the view origin was allowed; WebView2 never showed it. | **Yes** in practice: the view frame loads and the host page works in the installed app. |

## The Linux run (WSL Ubuntu 24.04, 2026-09-19)

`wsl-pl4-build.sh` built platform 0.1.1 + brain 0.1.2 with the deb, then platform 0.1.2 +
brain 0.1.3 from a temporary version bump; `wsl-pl4-run.sh` served them from loopback and
drove the installed app with a scratch `COPHYLA_HOME` (both scripts outside the tree, in the
build machine's scratch directory). What happened, in order:

1. `dpkg -i`, `/usr/bin/Cophyla --hidden`: `launcher.log` says `seeded brain 0.1.2 (was
   none)`, `seeded 0.1.1 … first start`, `0.1.1 running`; the shell and the daemon each in
   their own process group; cophylad from `versions/0.1.1/bun`, `brain verified {origin:
   bundled}`, brain up; the feed saw exactly `GET /stable/linux-x64.json`. The shell takes
   ~12 s to its first log line under WSLg (software rendering); a second start seeds nothing.
2. The feed grew: `platform staged {version: 0.1.2}`, brain 0.1.3 downloaded, `brain release
   promoted`, `brain verified {origin: installed}`, brain 0.1.3 up with mode `0755`;
   `staged platform waits: a desktop app is attached`.
3. `update.apply {platform}` over the client socket (the tray's path): `platform release
   applies at the next start; stopping`, `launcher.log`: `pid … exited after 100ms`,
   `rotated: current 0.1.2, previous 0.1.1`, `0.1.2 running`; cophylad 0.1.2 up, relaunched
   through `COPHYLA_LAUNCHER` = `/usr/bin/Cophyla`.
4. A feed with a flipped signature byte on brain 0.1.3 and platform 0.1.2 re-signed with
   `--protocol 2-2`: `release dropped {reason: "bad signature"}` and `{reason: "protocol
   range 2-2 excludes 1"}`, nothing staged (`feed.ts --add` itself refuses the bad entry).
5. One byte flipped in `data/brain/current/brain`, restart: `brain refused {reason: hash}`,
   `brain release rolled back {now: bundled}`, brain 0.1.2 up.
6. `Cophyla --rollback`: `rolled back to 0.1.1 on request`; the shell 0.1.1 asks the daemon
   0.1.2 to stop (`… stopping {current: 0.1.1}`), cophylad 0.1.1 starts and prunes 0.1.2.
7. A `versions/0.1.3` whose shell exits 3, `staged = 0.1.3`: `rotated: current 0.1.3`,
   `start failed`, `rolled back to 0.1.1; 0.1.3 marked broken`, `0.1.1 running`.
8. `dpkg -r cophyla` removes `/usr/bin/Cophyla` and `/usr/lib/Cophyla` and leaves the root;
   the same package installed again seeds nothing.

Not covered in WSL, which has no tray host and no notification daemon on its session bus:
the AppIndicator, the notification buttons and the login entry (PL3) wait for the desktop VM.

## The macOS run (Apple Silicon, macOS 14.5, 2026-09-28)

Built on the Mac from this tree with a throwaway release key (the real one is offline; its
public half was trusted for the run only and removed after) and the test fake brain compiled
as the brain (`bun build --compile`), then accepted on the build account with a scratch
`COPHYLA_HOME` and `COPHYLA_INSTALL_DIR`, hooks kept out of `~/.claude`, and the feed on
loopback. The app was started as the Finder starts it: `open` under `env -i` with launchd's
bare PATH (`open --env` alone hands over the caller's whole environment). The DMG carries a
licence, so a scripted `hdiutil attach` answers it (`yes | PAGER=cat hdiutil attach …`).

1. PM1: the DMG holds `Cophyla.app` (`com.fareaststudios.cophyla.launcher`, `LSUIElement`)
   with `seed/{versions/0.12.0,brain,current}`; the nested shell is
   `com.fareaststudios.cophyla.desktop` with its usage texts. PM2: `codesign --verify --deep
   --strict` passes on both bundles, `spctl` rejects them (ad-hoc, as expected).
2. PM4: `launcher.log` seeds the brain and 0.12.0, starts the shell and exits; the shell runs
   with launchd as its parent in a group of its own, cophylad from `versions/0.12.0/bun` with
   the login shell's PATH ("the login environment taken"), `tether` linked into
   `~/.local/bin` and on PATH, the bundled brain verified and up, nine live Claude sessions
   discovered. Closing the window hides it and the Dock icon, the tray icon and a reopen from
   the Finder bring both back, Cmd+Q hides (the process stays).
3. PM5: the launch agent is written at the first run (`--hidden`); a permission ask came as a
   notification whose button answered it; `session.focus` raised Terminal.
4. PM6: the feed grew to platform 0.12.1 and brain 0.1.1: staged through `tar` with no
   quarantine attribute and the bundle's signature intact, the brain applied by itself
   (promoted, verified `installed`, up 0.1.1, mode 0755); `update.apply {platform}` stopped
   the daemon, the launcher waited for the old shell, rotated to 0.12.1 and started it. A bad
   signature and a protocol range 2-2 were dropped; a flipped byte in the installed brain was
   refused on its next start and the bundled one took over; `--rollback` went back to 0.12.0,
   whose shell stopped the 0.12.1 daemon, which pruned 0.12.1 and never staged it again; a
   0.12.2 whose shell exits 3 was marked `.broken` and rolled back.

Found on the way, and fixed: the daemon froze at start (a session's folder in `~/Desktop`
read synchronously while macOS waited on its privacy prompt), `entitlements-net.plist`
failed every signing (a double hyphen in an XML comment), the stage carried onnxruntime's
library twice, and the Mac-only gaps the scope listed. `.docs/macos-scope.md` has the list.

Not covered: a second, clean macOS account; the microphone (voice was off); the Automation
denial path; notarization and stapling, which wait for a Developer ID.

## The Windows side, after the change

Platform 0.1.2 was built on Windows from this tree with the test certificate
(`platform-0.1.2-windows-x64.tar.gz`, `Cophyla_0.1.2_x64-setup.exe`, the brain 0.1.2 entry)
and rehearsed against a scratch root and home on 2026-09-19: the launcher writes the
`launcher` file beside the pointers, the shell runs cophylad from the shipped `bun.exe`, the
bundled brain verifies and comes up, and a relaunch through `Cophyla.exe --wait-pid <shell>`
waits for the old shell and starts the new one. The feed under `stage/feed/stable/` holds
`windows-x64.json` and `linux-x64.json` at 0.1.2; `macos-arm64.json` follows the Mac build.

## Where the docs carry this

The session-control survey §2a (U2), §2d (U3), §3 (U5); `architecture.md`
"update" and `session.focus` (U6); `apps/installer/README.md` runbooks PL1–PL6 and PM1–PM6.
