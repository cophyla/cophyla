<p align="center"><img src="Assets/Cophyla_icon_large.png" alt="" width="128"></p>

# Cophyla

Cophyla (say "ko-FILL-uh") gives you one place to see and drive every AI coding session on your
machines. Claude Code, Codex and the others keep running in their own terminals, where you
started them. Cophyla watches them and puts every prompt that waits on you, from any machine, in
front of you: on the desktop, on your phone, or spoken aloud. It starts new sessions for you,
answers from the phone, and hands you a terminal or the whole screen of any of your machines.

A brain talks to you about the work: what each session is doing, what finished, what needs you.
The chat with it runs in an agent session of your own, on your Claude Code or Codex plan, with
no shell and no way to write files. It acts only through this platform, and every action it asks
for crosses a gate and lands in an audit you can read. The platform is open (Apache-2.0) and runs
without the brain; the brain is a separate, closed package.

## Building

tether, the pseudo-terminal host the daemon runs sessions in, is a project of its own and a
submodule here, so clone with it:

```
git clone --recursive https://github.com/cophyla/cophyla.git
cd cophyla
bun install
bun test                # every package
bun run typecheck
bun run cophylad        # the daemon, on ~/.cophyla
bun run ui              # the desktop app, which starts the daemon itself (needs Rust)
```

A clone made without `--recursive` gets tether with `git submodule update --init`. Bun 1.3
and Node 22 run the TypeScript unmodified; the desktop app, the launcher, tether and
cophyla-net need Rust, and the phone app needs the Android SDK (see
[apps/controller](apps/controller/README.md)).

| Path | What |
|---|---|
| `packages/protocol` | the entities and the four protocols as schemas, with fixtures |
| `packages/viewhost` | the host side of a view — the connection, the sandboxed frame, the scope check — shared by the desktop app and the controller |
| `packages/relay` | the end-to-end tunnel both ends of a server relay share |
| `packages/wake` | the wake word's streaming pipeline, run by the daemon and by the phone |
| `apps/cophylad` | the daemon, and the built-in views it serves |
| `apps/ui` | the desktop app: a Tauri 2 shell and the host page that loads views |
| `apps/controller` | the phone app the daemon serves over TLS: the same view host, plus the microphone, the wake word and the speaker |
| `apps/installer` | the launcher, the Windows installer and the release scripts: staging, signing, the feed |
| `apps/net` | cophyla-net, the helper that holds direct connections to phones and other nodes |
| `apps/vscode` | the VS Code extension that opens terminals on tether |
| `sidecars/tts-py` | the optional GPU speech engine: sources and locked requirements only, built on the node when the stage is turned on |
| `tether/` | the pseudo-terminal host ([its own repository](https://github.com/FeritMelih/tether)) |
| `spikes/` | the throwaway tests the design rests on |

The design notes the code mentions (`architecture.md`, `entities.md` and the others) are kept
private. The public contract is `packages/protocol`: its schemas define every entity and
protocol.

The editable layer under `~/.cophyla` uses erasable syntax only (`erasableSyntaxOnly` in
`tsconfig.base.json`), so nothing there needs a build step.

## Install and update

The first release, [0.13.0](https://github.com/cophyla/cophyla/releases/tag/platform-v0.13.0),
is a pre-release for Windows on x64. Its installer is signed with a self-signed certificate
until one Windows trusts exists, so SmartScreen warns about it: More info, then Run anyway.
macOS and Linux have no package yet; there Cophyla runs from a checkout (see Building above).

Windows: run `Cophyla_<version>_x64-setup.exe` from the
[releases](https://github.com/cophyla/cophyla/releases). It installs per user into
`%LOCALAPPDATA%\Cophyla`: a fixed launcher, the version directory with the desktop app, the
Bun runtime and the daemon, and the brain. The daemon reads the public release feed on a
schedule (the request names nothing but the channel, OS and architecture), verifies every
entry against the release key shipped in the platform, downloads and checks the newest
platform and brain, and stages them: a brain restarts in place when the daemon is idle; a
platform applies at the next start, from the tray, or by itself when nothing waits and no
desktop app is attached. The previous version stays for rollback, and a version that fails to
start is rolled back by the launcher. `[update]` in `~/.cophyla/config.toml` turns the checks
off or points them elsewhere. Details in [apps/installer](apps/installer/README.md).

## Contributing

Issues and pull requests are welcome. The platform is Apache-2.0; contributions are accepted
under the contributor licence agreement in [CLA.md](CLA.md), see
[CONTRIBUTING.md](CONTRIBUTING.md). The brain is a separate closed package under its own
[end-user licence](https://github.com/cophyla/cophyla/releases); the platform runs without
it.

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
