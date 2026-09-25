# Spike 04: microphone capture and wake word in-process under Bun

Date: 2026-09-17. Machine: Windows 11, Bun 1.3.14, Node 22.22.2, onnxruntime-node 1.30.0,
RTX 4080 (unused: everything here ran on the CPU, one thread). Default microphone: Brio 101.

Question: can cophylad, on Bun on Windows, capture the microphone at 16 kHz mono and run
openWakeWord / livekit-wakeword inference in-process, cheaply enough to leave on?

**Answer: yes to both.** One caveat is about packaging, not about running: a
`bun build --compile` executable cannot carry onnxruntime-node (see "Packaging").

## Results

| # | Test | Bun 1.3.14 | Node 22.22 |
|---|---|---|---|
| 1 | `onnxruntime-node` loads and runs all five models | works | works |
| 1 | `onnxruntime-web` (wasm, 1 thread) as the fallback | works, 3.2 ms per chunk, 255 MB RSS | not run |
| 2 | TypeScript streaming pipeline: mel → embedding → classifier | works | works |
| 2 | `hey_livekit.onnx` from livekit-wakeword in the same pipeline, unchanged | works | not run |
| 3 | Scores match the Python reference (`openwakeword` 0.6.0) | worst per-frame difference 1.25e-6 over 15 clips × 2 classifiers | not run |
| 5 | Capture: `bun:ffi` → `winmm.dll` waveIn, default device | works, 0 overruns | n/a (Bun only) |
| 5 | Capture: `@picovoice/pvrecorder-node` 1.2.9 | works | works |
| 5 | Capture: `audify` 1.10.1 (RtAudio, WASAPI) | works | works |
| 5 | Capture: `ffmpeg -f dshow` child process, s16le on stdout | works | not run |
| 6 | Live loop, microphone → scores, 30 s | works: 0 overruns, worst lag 5.4 ms | n/a |
| – | Same code inside `bun build --compile` with onnxruntime-node | **segfault** | n/a |
| – | `bun:ffi` capture and pvrecorder inside `bun build --compile` | work | n/a |

### Cost of always-on inference (step 4)

Single-threaded sessions (`intraOpNumThreads: 1`, `interOpNumThreads: 1`), 80 ms chunks.

| Run | Real-time factor | Per chunk p50 / p95 / p99 | CPU, paced at real time | RSS |
|---|---|---|---|---|
| Bun, 1 classifier | 0.0139 (72× real time) | 1.00 / 1.86 / 2.29 ms | 4.5 % of one core | 93 MB |
| Bun, 3 classifiers | 0.0171 | 1.28 / 2.10 / 2.51 ms | 7.2 % of one core | 99 MB |
| Node, 1 classifier | 0.0129 | 1.00 / 1.23 / 1.33 ms | 4.6 % of one core | 94 MB |
| Bun, live microphone + 1 classifier, 30 s | – | worst arrival-to-score lag 5.4 ms | 5.0 % of one core | 98 MB |
| Bun idle, same 80 ms timer, no inference | – | – | 0.3 % | 50 MB |

5 % of one core is about 0.2 % of this 24-thread machine. The models add roughly 35–45 MB on
top of an idle Bun process. `session.run` is asynchronous, so the JS thread is not blocked
while ORT works.

### Clip scores (step 3)

Synthesized with the two installed SAPI voices and espeak-ng, 16 kHz mono, 2 s of faint noise in
front. Peak score per clip, classifier fed at its own training scale:

| Clip | `hey_jarvis` | `alexa` | `hey_livekit` |
|---|---|---|---|
| "hey jarvis" × 3 voices | 0.995 – 0.999 | ≤ 0.001 | ≤ 0.08 |
| "alexa" × 3 voices | ≤ 0.001 | 0.89 – 1.00 | ≤ 0.16 |
| "hey live kit" × 3 voices | ≤ 0.004 | ≤ 0.003 | 0.976 – 0.985 |
| "what time is the meeting tomorrow afternoon" | ≤ 0.012 | ≤ 0.002 | ≤ 0.023 |
| "hey jargon, hey service, hey travis" | **0.47 – 0.97** | 0.000 | ≤ 0.17 |

The openWakeWord `hey_jarvis` model fires on near-miss phrases. That is the weakness the
livekit classifier and its adversarial negatives are meant to fix; it was not tested here for
a custom phrase.

The live loop with the "hey jarvis" clip mixed digitally into real microphone samples detected
it once, at 0.981. **Not verified:** acoustic detection (a person or a speaker saying the
phrase into the microphone). No sound was played in the room.

## Findings

1. **onnxruntime-node loads under Bun on Windows** with no flags. Bun blocks its postinstall
   script, which does not matter on Windows: the CPU and DirectML binaries ship in the package.
2. **livekit-wakeword and openWakeWord share the feature models byte for byte.**
   `melspectrogram.onnx` and `embedding_model.onnx` have identical SHA-256 in both projects.
   Classifiers from both take `[1, 16, 96]` and return one score. One pipeline serves both.
3. **The two projects scale the audio differently.** openWakeWord feeds int16-range values
   to the mel model; livekit-wakeword divides by 32768 first (training and inference). On
   these clips either scale detects, but scores move at the margin (espeak "alexa": 0.89 at
   the right scale, 0.51 at the wrong one). Scale is a per-classifier setting, and running
   classifiers of both kinds means two mel and embedding passes.
4. **livekit's own Python listener is about 16× more expensive than it needs to be.** It
   recomputes all 16 embeddings over a 2 s window every 80 ms. The streaming port here
   computes one embedding per chunk and keeps a rolling window. Read from their source, not
   benchmarked.
5. **Inference needs no Python.** The note in `livekit-wakeword.md` about WSL2 applies to
   training only.
6. **`bun:ffi` to `winmm.dll` worked at the first attempt.** `WAVE_MAPPER` gives the user's
   default device and Windows converts to 16 kHz mono, so there is no device name to configure
   and no resampler to write. Buffers are polled (`CALLBACK_NULL`), so no native thread calls
   into JS. Buffers are allocated with `calloc` from `ucrtbase.dll` so they cannot move.
7. **DirectShow has no "default device".** The ffmpeg route needs a device name, takes
   ~700 ms to deliver the first samples (150–230 ms for the in-process routes) and costs a
   process. It is a fallback only.
8. **The erasable-syntax rule bit once.** A constructor parameter property in `wakeword.ts`
   ran under Bun and failed under Node with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Turn on
   `erasableSyntaxOnly` from the first commit.

## Packaging

`bun build --compile` embeds `onnxruntime_binding.node` and extracts it at run time without
its sibling `onnxruntime.dll`. Windows then resolves the import to
`C:\Windows\System32\onnxruntime.dll`, which is version 1.17 and ships with the OS. The
binding asks for API version 30, gets nothing (`The requested API version [30] is not
available, only API versions [1, 17] are supported`) and Bun segfaults at address 0x18.

Workarounds tried inside a compiled executable, all failed on Bun 1.3.14:

| Attempt | Result |
|---|---|
| `--external onnxruntime-node` | `Cannot find package 'onnxruntime-node' from 'B:/~BUN/root/live.exe'` |
| `createRequire` with an absolute path to `dist/index.js` on disk | `Cannot find package 'onnxruntime-common'` from that file |
| `onnxruntime-web` (wasm) | `Cannot find module './ort-wasm-simd-threaded.mjs'` |

`bun:ffi` capture and the pvrecorder addon both work inside a compiled executable. Not
tried: loading `onnxruntime.dll` by full path with `bun:ffi` before the binding loads, or
calling the ORT C API through `bun:ffi` directly.

## Recommendation for the architecture

- **Keep the wake word in-process in `voice`, as `architecture.md` says.** It costs about
  5 % of one core and 40 MB.
- **Add a `capture` stage in front of the wake word** in the voice pipeline, behind the same
  engine interface as the other stages. `architecture.md` names no source for node-side audio.
  Suggested engines: `pvrecorder` as the default (Apache-2.0, no access key, prebuilt for
  Windows, macOS, Linux and Raspberry Pi, delivers 16 kHz mono int16, default device, loads
  under Bun and inside a compiled executable; spike 10 found it returns silence for frame
  lengths under 1024 on this machine, so ask for 1280 and slice smaller windows in code); `winmm` over `bun:ffi` as the Windows engine
  with no dependency; `ffmpeg` as the last resort. macOS and Linux capture were not tested.
- **Use `onnxruntime-node` for ORT**, single-threaded. Keep `onnxruntime-web` as the escape
  hatch; it is 3× slower and uses 2.5× the memory, which is still far inside real time.
- **Do not plan on a single compiled cophylad executable that contains ORT.** Ship cophylad as the
  Bun runtime plus its source tree and `node_modules`, or run the wake word and STT as a child
  started with plain `bun` under `sidecars`. The design already allows either placement per
  stage. This affects the installer, and it is the same for Parakeet if it runs through
  onnxruntime-node.
- **Store the input scale with each wake-word model** (`int16` or `unit`) in `~/.cophyla/audio/`
  next to the ONNX file. A model trained with livekit-wakeword is `unit`.
- **Doc edits.** `architecture.md`: the capture stage and the packaging constraint.
  `livekit-wakeword.md`: findings 2–5, and that "ONNX models also load in openWakeWord
  unchanged" holds for the tensor contract but not for the input scale.

## Not verified

- Acoustic wake-word detection, false-accept rate over hours of real room audio, and any
  custom-trained phrase.
- Capture on macOS and Linux, and under another user session or a locked screen.
- Capture while another application holds the microphone in exclusive mode.
- Whether the throughput numbers hold on a weak machine; this is a 24-thread desktop.
- GPU or DirectML execution. It was not needed.

## Files and commands

Run from this folder. `bun install` first; models go in `models/` (see below).

| File | What it does | Command |
|---|---|---|
| `01-ort-load.ts` | loads every model, prints tensor shapes and mel frame counts | `bun 01-ort-load.ts`, `node 01-ort-load.ts` |
| `wakeword.ts` | the streaming pipeline, plus WAV read/write helpers | imported |
| `02-clips.ts` | synthesizes clips (SAPI, espeak-ng, ffmpeg) and prints peak scores at both scales | `bun 02-clips.ts` |
| `04-crosscheck.ts`, `04-crosscheck.py` | same audio through this pipeline and the Python reference | `bun 04-crosscheck.ts` |
| `03-cost.ts` | throughput, paced CPU and RSS; args: classifier count, paced seconds | `bun 03-cost.ts 1 30` |
| `capture-winmm.ts` | `bun:ffi` → winmm capture | imported |
| `05-capture.ts` | 5 s capture by route, reports RMS and peak | `bun 05-capture.ts winmm\|pvrecorder\|audify\|ffmpeg` |
| `06-live.ts` | microphone → wake word, live | `bun 06-live.ts 10 [--inject]` |
| `07-ort-wasm.ts` | onnxruntime-web fallback | `bun 07-ort-wasm.ts` |
| `08-compiled-ort.ts` | the failing compiled-executable case | see the header comment |

Models (gitignored, 5.3 MB):

```
cd models
for f in melspectrogram embedding_model hey_jarvis_v0.1 alexa_v0.1; do
  curl -sSLO https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/$f.onnx; done
curl -sSLO https://raw.githubusercontent.com/livekit/livekit-wakeword/main/examples/resources/hey_livekit.onnx
```

The Python cross-check needs `python -m venv .venv && .venv/Scripts/python -m pip install
openwakeword` (364 MB with scipy and scikit-learn; gitignored; safe to delete).
`audify` needs `bun pm trust audify` to fetch its prebuilt binary.

The room-audio captures were deleted after the run. `out/` still holds the synthesized TTS
clips and the score JSON; it is gitignored.
