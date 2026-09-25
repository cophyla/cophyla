# Spikes

Date: 2026-09-17, spikes 10–13 added 2026-09-20, spike 14 on 2026-09-21, spike 15 on 2026-09-23, spikes 16 and 17 on 2026-09-24. Windows 11, Claude Code 2.1.274, Codex CLI 0.153.4,
Bun 1.3.14, Node 22.22.2, Rust 1.98.1, Tauri 2.11.5, sherpa-onnx-node 1.13.8.
Throwaway code that tests the assumptions under `architecture.md`
and the agent-messaging proposal before any of it is built. Each
folder has its own README with commands, results and what was not verified.

Every Claude and Codex session used here was started by the spike in a PTY
([`_pty/`](_pty/tui-server.mjs)), on the cheapest model, in a `target/` folder. No live user
session was written to, and nothing under `~/.claude` or `~/.codex` was edited.

## Results

| Spike | Question | Answer |
|---|---|---|
| [01-claude-inbox](01-claude-inbox/README.md) | Can an outside Bun process inject a turn into a live Claude session over the Windows named pipe? | **Yes**, idle and mid-turn, from Bun and Node. No ack on the wire. **Sessions in bypass mode hold the message** for approval in their own terminal unless `crossSessionInbound` is `accept`. |
| [02-permission-hook](02-permission-hook/README.md) | Can a phone answer a terminal permission prompt, minutes later? | **Yes**, tested to 12 minutes. The terminal prompt stays live alongside. Default hook timeout is 600 s. A terminal answer leaves the hook hanging, so cophylad has to detect it. |
| [03-hook-coexistence](03-hook-coexistence/README.md) | Can cophylad's hooks sit beside emdash's? | **Yes.** Side finding: emdash's installed hooks are broken under Claude Code on Windows and leak ~700 characters into every prompt. |
| [04-voice](04-voice/README.md) | Can cophylad on Bun capture the mic and run the wake word in-process? | **Yes to both.** ~5 % of one core, ~40 MB. `onnxruntime-node` cannot live inside a `bun build --compile` executable. |
| [05-codex](05-codex/README.md) | Can cophylad discover and inject into Codex threads the user opened? | **Yes, by a different route than the docs say.** There is no shared daemon on Windows; cophylad runs its own `codex app-server --stdio` and calls `thread/queue/add`. Idle pickup takes up to ~10 s. |
| [06-agent-messaging](06-agent-messaging/README.md) | Does the agent-messaging shape work end to end? | **Yes.** Claude → `cophyla` MCP → router → Codex and back, caller identified on both legs. Channels work too, but need a keypress at launch. |
| [07-tauri](07-tauri/README.md) | Does the Tauri 2 shell behave the way the architecture describes, and can this machine build it? | **Yes to the shape, twice wrong on isolation.** Window, tray, close-to-tray, notifications, launch at login, child process and the NSIS bundler all work. But app commands are callable from every web view until `build.rs` declares them, and host and view share one origin, so a view reads the host's `localStorage` and cookies. |
| [08-acp](08-acp/README.md) | Can cophylad start Claude Code and Codex sessions through their ACP adapters on Windows and read status and asks off the stream? | **Yes**, under Node and Bun. The ACP session id is the harness's own id for both, `session/prompt` blocks for the turn, `session/cancel` ends it in milliseconds, and `PermissionRequest` does fire in the spawned Claude session. Token counts come back per turn. Codex can surface an approval after the prompt has already returned. |
| [10-stt-tts](10-stt-tts/README.md) | Do the STT and TTS engines of the voice table run here, in their placement, and at what cost? | **Yes.** Nemotron 3.5 streaming through sherpa-onnx-node in-process under Bun and Node: 93 ms per 560 ms chunk, partials from 720 ms in, WER 0 on clean English and Turkish, a person at the desk transcribed correctly, 35 % of a core while it runs. Chatterbox Turbo in the `tts-py` sidecar on the 4080: 3.7 GB VRAM peak, RTF 0.27, first audio in 0.4–1.2 s per sentence. Kokoro in-process on the CPU at RTF 0.2–0.4. **Two costs the design must carry:** ORT's thread pool spins (a whole core per extra thread until `allow_spinning` is off), and on a hybrid Intel CPU Windows parks inference on the E-cores, three times slower, unless the process pins itself to the P-cores. Also: pvrecorder returns silence for frames under 1024 samples here. |
| [11-wake-room](11-wake-room/README.md) | Does a phrase spoken in the room fire the classifier, and how often do they fire on their own over hours? | **Yes, and almost never.** Speakers at 8–14 % into a webcam mic: 0.998 on "hey jarvis" (7 of 8), 0.93–0.99 on "hey live kit", 1.00 on "alexa"; a voice in the room 0.97 and 0.80. Over 5.4 h of read speech, 0–0.19 fires an hour at 0.5 and none at 0.7. **The stock `hey_jarvis` is a "jarvis" detector:** "say jarvis" 0.999, "jarvis" alone 0.99, "hey jargon" 0.98; the livekit head stayed ≤ 0.38 on every near miss. Both pipelines cost 6.4 % of a core. The 6 h room run is still going. |
| [12-phone-mic](12-phone-mic/README.md) | Can a phone browser on the LAN capture 16 kHz mono, stream it to the node and hear speech back? | **Yes, on Android Chrome, the whole loop.** The self-signed certificate passes by hand and `wss://` follows; `getUserMedia` gives 48 kHz mono with AEC, noise suppression and AGC on, and Chrome runs the `AudioContext` at the 16 kHz asked for. 96 s of audio at exactly 16,000 samples/s with no loss over Wi-Fi (gaps to 0.4 s, absorbed). The wake word fired 4 of 4 from the phone mic at 0.94–0.997, questions came back as text while spoken, the spoken reply reached the phone 0.8–1.4 s after each final, push-to-talk worked. The stream ends with the page hidden. iOS untested. |
| [13-metrics](13-metrics/README.md) | Can cophylad sample every process, the machine and the GPU without a shell, cheaper than a harness session, and can a node find the primary by UDP broadcast? | **Yes, with the cost measured.** One `NtQuerySystemInformation` call through `bun:ffi` returns 780 processes with CPU time, parent, name and working set, offsets verified against cophylad's own row — but it is ~12 ms of kernel time on this machine because the class carries every thread, so a 1 s sample is 1.6–1.9 % of one core, level with two idle Claude Code sessions; at 2 s (the default view's rate) 0.8 %, at 15 s noise. `/proc` in WSL: 0.2 ms. NVML: under 1 ms, but per-process VRAM is `NOT_AVAILABLE` on WDDM. `node:dgram` with `reuseAddr`: two sockets on 4819 in one process both hear a broadcast, and a query from WSL reaches the host listener through the vEthernet adapter. |
| [14-remote](14-remote/README.md) | Can cophylad set up Apollo over its API, pair moonlight-qt and moonlight-web without anyone seeing Apollo's web UI, stream into a window and into a browser page framed under another, and hand the brain one frame without a host? | **Yes, all of it.** Apollo 0.4.6 wants a login cookie (no Basic auth), replaces its whole config on `POST` and applies it on `/api/restart`, has no pending-PIN list (post blind every 500 ms; accepted 2 s after `moonlight pair` spawns), and pairs every client after the first with `view\|list` only, so cophylad grants input and launch through `/api/clients/update`. `/serverinfo` says `FREE` even while streaming; `connected` in the client list is the signal. moonlight-qt streams this desktop in a window 7.9 s after spawn at 9.6 % of a core on the host and 6.4 % on the viewer; `moonlight list` is the paired check; the process lingers after `quit`. moonlight-web behind a ticket → cookie → header proxy: WebSocket transport 60 fps, 0.3 % dropped over 150 s, framed under a same-origin page; WebRTC 2.4 s to the first frame but wants UDP 40000–40010 open. Defender's AMSI blocks the obvious capture script; capture → scale → `Save(Jpeg)` passes in ~0.5 s. Gemini takes a `functionResponse` and an image in one content; 1092 tokens per image at any width. |
| [15-pty-host](15-pty-host/README.md) | Can a Rust host that owns the PTY type into an interactive Claude Code session as the user, and can a terminal window attach to that session? | **Yes.** A turn typed through the host (bracketed paste, 300 ms, Enter) is stored as `origin: {kind: "human"}`, `promptSource: "typed"`; over the messaging pipe the same text is a peer message with `isMeta`. `/clear` typed this way changed the session id 0.6 s later. In plan mode, the CLI's own "Yes, clear context" row, pressed by key (the digit, then Enter), built the plan in the same terminal. The session started with no window attached: the host answered ConPTY's cursor-position request from its `vt100` screen model, and the trust dialog was answered with Down, then Enter. A window attached from `cmd /c start`, detached, and reattached from `conhost` with a repaint. Keys typed by hand through the attach client are not checked yet. |
| [16-webrtc](16-webrtc/README.md) | Can cophylad hold a WebRTC data channel under Bun, and how often does a phone reach a home node directly? | **Yes to the first; to the second, from some networks.** libdatachannel under Bun on Windows and Linux: 0.1 % of a core for an idle channel, 230 connect/close cycles with no leak, a changed DTLS fingerprint fails the connection from either side. werift, the pure-TypeScript library, is too slow (276 messages/s at a full core). A phone reached the node from a NAT that keeps its ports, and from a sequential symmetric NAT once the node predicted the next ports, 3 of 3 across two phones, at RTT 10–17.5 ms against ~260 ms through the relay. From a mobile carrier whose NAT picks random ports from more than one public address, 0 of 5, prediction included. **A direct path is an upgrade, not a replacement:** TURN or the relay carries the rest. |
| [17-net](17-net/README.md) | Can the node's helper be built on the sans-IO `rtc` crate, one UDP port for every peer, and do the loopback stream page, Bun's TCP pause and moonlight-web's ICE-server script work the way milestone 16 needs? | **Yes, with the send window kept small.** `rtc` talks to Chromium and to itself on one shared port, opens in 180–335 ms and names the path. Its SCTP recovers a lost burst only on a timer with a 1 s floor, so the helper keeps at most 128 KiB unacknowledged per peer: node → phone then runs at 10.5–11.1 MB/s on a 19 ms path, level with libdatachannel; phone → node stays at 0.7–0.8 MB/s, left as known. A loopback page's cookie must not be `Secure`, since WebKit drops that one over `http://127.0.0.1`. Bun's `pause()` holds a socket's reads, and a Rust `Command` runs a `.cmd`. Early candidates must wait for their offer. The firewall prompt, the router's mapping from Windows and the Android web view wait for a run with the user. |

Nothing tested invalidates the architecture. Several details in it are wrong or missing, below.

## Where the docs carry this

The design docs state these results as design, without the test detail, which stays here.
The design docs are kept private.

| Doc | What it takes from the spikes |
|---|---|
| `architecture.md` | desktop app: what the shell must do so a view stays untrusted — declare every app command in the app manifest, and keep secrets out of web storage because host and view share an origin. Also that the asset origin is `http://tauri.localhost`, and that cophylad survives the shell exiting. sessions: the Codex row (cophylad's own app-server, `thread/queue/add`, the current hook set) and the delivery rules for both harnesses (no ack, receipts, the bypass hold, Codex pickup). voice: the `capture` stage and the per-model input scale. Hook ingress: http hooks, the command fallback, the timeout, and how an ask closes after a terminal answer. Packaging: cophylad ships as Bun plus source, not a compiled executable. |
| `session-control-survey.md` | 2a and 2b as verified from outside processes; section 3 rewritten for Codex on Windows; the recommendation. |
| `agent-messaging.md` | caller identity from `_meta.threadId` and `CLAUDE_CODE_SESSION_ID`; `delivered` only on a receipt; cophylad-assigned Codex aliases; channels work but block at launch; its list of what is still untested. |
| `entities.md` | open question 6: Codex token counts come from the rollout file; open question 5: ACP agents report tokens per turn. |
| `livekit-wakeword.md` | shared feature models, input scaling, the cost of inference, the compiled-executable limit. To take from spike 11: the acoustic scores, the near-rhyme exposure of the stock openWakeWord head against the livekit head, 0.7 as the threshold, and the test set a custom phrase must pass. |
| `speech-to-text-parakeet.md`, `text-to-speech-chatterbox-turbo.md` | to take from spike 10: measured load, memory, RTF and first-audio numbers on this machine replacing the quoted ones; the per-stream language option; the ORT spinning config; the `setuptools<81` pin for Perth; Kokoro in-process as the CPU engine. |
| `architecture.md` | to take from spike 10: under `voice` and `sidecars`, CPU affinity to performance cores for inference processes on hybrid CPUs and absolute paths for spawned executables; Kokoro placed in-process; the 80 ms capture frame. From spike 12: the controller as a web app needs a certificate the phone trusts (a CA the installer makes, a tailnet, or a native app), ask for a 16 kHz `AudioContext` and keep a resampler for browsers that refuse, keep the phone's AEC/NS/AGC on, never wake the brain on an empty utterance, and a web controller listens only while its page is open. |
| `license-and-language-decision.md` | the Rust toolchain follow-up is done on this machine; Rust stayed limited to the generated shell, as the decision assumed. |
| `architecture.md`, `milestones.md` | from spikes 16 and 17: `direct` (a helper on one UDP port, port prediction, TURN as the fallback, the send window per peer) and the loopback stream page's cookie without `Secure`. |

## Still untested

macOS for everything, Linux beyond WSL. Sunshine (Apollo is tested; the fallback is written
against the shared API). Two machines on a real LAN (spike 13 ran the node link's discovery
between the host and WSL, milestone 9's two-node runs are two homes on this machine and WSL,
and spike 14 streamed this desktop to itself). Proxy peers. A custom-trained wake phrase, and
the room false-accept rate over a full day (spike 11's run is going). iOS Safari for the web
controller, and a phone listening with its screen off. The lock screen and a UAC prompt under
a remote stream; Artemis from the `art://` link.

## Left behind

- The Rust toolchain: `rustup` with `stable-x86_64-pc-windows-msvc` in `~/.rustup` and
  `~/.cargo`, and `%USERPROFILE%\.cargo\bin` appended to the user `Path`. `spike 07`'s
  `target/` holds 3.9 GB; `cargo clean` in `spikes\07-tauri\app\src-tauri` frees it.
- Codex history: five small threads with cwd under `spikes\05-codex\target` or
  `spikes\06-agent-messaging\target`. `codex delete <id>` removes them.
- Claude transcripts for the spike sessions under `~/.claude/projects/C--D-orchestrator-spikes-*`.
- Spike 10: `tts-py/.venv` (5.2 GB), Chatterbox Turbo weights in `~/.cache/huggingface`
  (1.7 GB), `models/` (770 MB). Spike 11: `models/LibriSpeech` (337 MB), `out/snippets/` with
  room audio around each wake event. Spike 12: a self-signed certificate in `out/`.
- Spike 14: Apollo (service `ApolloService`, `C:\Program Files\Apollo`, web credentials
  `cophyla` / `out/host-creds.json`, `sunshine_name = cophyla-spike`, one paired client
  `spike-web`) and moonlight-qt (a host entry in `HKCU\Software\Moonlight Game Streaming
  Project\Moonlight\hosts`) installed; `out/moonlight-web/` (72 MB); inbound firewall rules
  for `streamer.exe` under the spike path. `winget uninstall` both and delete the registry
  key to undo.
- Spike 15: `C:\D\scratch-pty\` and its trust entry in the account profile's
  `.claude.json`; transcripts under that profile's `projects/C--D-scratch-pty-work/` and
  `projects/C--D-orchestrator-spikes-15-pty-host-out-work/`; one plan file under its `plans/`.
- Spike 17: a copy of `apps/net` and its build at `~/m16-net` in WSL.
- `out/`, `models/`, `.venv/` and `node_modules/` inside the spike folders are gitignored.
