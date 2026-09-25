# @cophyla/voicehost

A client's side of voice, once for the two clients that have a microphone and a speaker:
the phone (`apps/controller`) and the desktop app's host page (`apps/ui/host`). It captures
16 kHz mono, listens for the node's wake words itself in a worker, sends frames up as
`voice.audio` only once it heard a word or while the button (or the desktop's talk key) is
held, and plays the replies through a jitter buffer, each acked with `voice.played`. The
host keeps what is its own — the link, the page, the controls — and hands `VoiceHost` the
frames from the node and the link's changes.

| File | Holds |
|---|---|
| `src/voicehost.ts` | `VoiceHost`: the audio, the detector and where each frame goes (`route`: up to the node, into the wake word, both, or nowhere), the `voice.wakeword` negotiation on every connect, `voice.wake` followed by the frames from 160 ms before the word fired (`lead`, for the recogniser: the next word often starts before the word fires) and those the worker was still scoring, `voice.ptt`, listening and mute, the background and a remote desktop standing it down; `view` is what a host shows, `wakeState`/`audioState` what a test reads |
| `src/audio.ts` | two `AudioContext`s: capture through the worklet at 16 kHz, and playback at the device's rate through `PlaybackQueue`, the jitter buffer (target, underruns, the played report), flushed when the node stops speaking |
| `src/worklet.ts`, `src/chunk.ts` | the capture worklet and the resampling behind it: whatever rate the device gives → 16 kHz mono, 640-sample frames, carried across callbacks |
| `src/opus.ts` | Opus through WebCodecs both ways, when the web view has it: the microphone's 40 ms frames as two 20 ms packets, the speech decoded in order |
| `src/pcm.ts`, `src/uplink.ts` | base64 of little-endian int16; each frame up numbered, and shed rather than queued behind a backed-up link |
| `src/wake/bundled.ts` | the files a build carries under `wake/` — the two feature models, one keyword head per phrase, onnxruntime-web's wasm — with their sha256 pins |
| `src/wake/worker.ts` | the module worker: `onnxruntime-web/wasm` on one thread with the bytes the page sent, `@cophyla/wake`'s `WakePipeline` over the frames with every head the node named, `wake {score, seq, head}` when one fires, stats every ten seconds |
| `src/wake/detector.ts` | the page's side of it: the files fetched (and checked and cached where the host says), the worker started and fed copies of the frames, configured with the node's answer (`headsOf`) |
| `src/wake/cache.ts` | the phone's browser page's IndexedDB copy of the files, keyed by sha256 |
| `src/wake/state.ts` | where the word is detected and whether the client just heard it, as a reducer: the node's answer, the three-second wait for `listening`. Pure |
| `src/wake/ring.ts` | the last sixteen numbered frames, so the lead-in and the ones captured while the worker scored the word follow `voice.wake` up |
| `build.ts` | `buildVoiceAssets(outDir)`: the worklet, the worker and the checked `wake/` files with their NOTICE, beside a host page's own bundle |

## Testing

`test/voicehost.test.ts` covers the parts over fakes: 16 and 48 kHz chunking with the carry,
clamping, PCM on the wire, playback scheduling, the jitter target and the played report, the
flush, frames shed on a backed-up link, the Opus fallback, the wake word's reducer, the frame
ring, and the detector over a fake worker (the files fetched, pinned, cached and handed over,
a mismatch refused, a worker that fails, several heads configured).
`packages/wake/test/parity.live.test.ts` holds the worker's runtime to the node's, chunk by
chunk, when the wake model is present.
