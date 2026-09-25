# Spike 10: the STT and TTS engines on this machine

Date: 2026-09-20. Machine: Windows 11, i7-13700K (8 P-cores + 8 E-cores, 24 threads), RTX 4080
16 GB, 64 GB RAM. Bun 1.3.14, Node 22.22.2, sherpa-onnx-node 1.13.8, Python 3.11 (uv),
torch 2.6.0+cu124, chatterbox-tts 0.1.7. Microphone: Brio 101.

Question: do the engines in the voice table of [architecture.md](../../docs/architecture.md)
run here in the placement the table names, and at what cost? Nemotron 3.5 ASR Streaming
0.6B INT8 and Silero VAD through sherpa-onnx in-process; Chatterbox Turbo with a cloned voice
in the `tts-py` sidecar; Kokoro on the CPU.

**Answer: yes to all four, with two things the design must carry.** The STT streams partials
under Bun and Node at 35 % of one core while it runs. Turbo on the 4080 speaks a short line
in under a second and needs 3.7 GB of VRAM at peak, not the 5–7 GB the research doc feared.
Both are three times slower when Windows schedules them on the E-cores, which it did for the
TTS sidecar and once for Kokoro; **inference processes must pin themselves to the
performance cores.** And ORT's thread pool spins between chunks: with 2 threads the STT
costs 156 % of a core unless spinning is turned off, after which 2 threads cost the same 35 %
as one.

## Results

### STT: Nemotron 3.5 ASR Streaming 0.6B, INT8, 560 ms chunks, in-process

| | Bun | Node |
|---|---|---|
| Load | 1.0 s, RSS +735 MB | 1.3 s, +716 MB |
| Decode per 560 ms chunk, 2 threads | p50 93 ms, p95 106 ms | p50 93 ms |
| Decode per chunk, 1 thread / 4 threads | 151 ms / 64 ms | – |
| Real-time factor, 2 threads | 0.17–0.19 | 0.17 |
| First partial | 720 ms into the audio | same |
| Paced at real time, mic → VAD → STT, 2 threads | **35 % of one core**, 840 MB | – |
| Same, ORT spinning left on | 156 % (2 threads), 411 % (4) | – |
| Same, pinned to the E-cores | 255–305 ms per chunk, RTF 0.5 | – |

Word error rate on synthesized clips with known text, language pinned and auto-detected
(identical in every case):

| Clip | Voice | WER | Note |
|---|---|---|---|
| "What time is the meeting tomorrow afternoon?" | SAPI David, Zira | 0 | |
| 33-word instruction with "orchestrator", "protocol package", "pull request" | SAPI David / Zira / neural Guy | 0 / 0.03 / 0 | Zira: "pull" → "poll" |
| "The daemon is called orchd, the brain is called Orchid…" | SAPI David, Zira | 0.12 | "daemon" → "damon", "orchd" → "orched"; the names it cannot know |
| Turkish, 12 words | neural Emel | 0 | auto-detect picked Turkish |
| Turkish, 6 words | neural Ahmet | 0.17 | "öğleden" → "öleden" |
| Turkish, both sentences | espeak-ng | 1.0 | empty output: espeak's Turkish is not speech to this model |
| Shipped `test_wavs` in de, es, fr, ar, ja, ko, uk, vi, zh | | readable | at 22.05, 24 and 44.1 kHz; sherpa resamples when told the real rate |

Partials arrive one chunk at a time and grow monotonically; a word is never retracted in
these clips. Punctuation and capitals come with the text. The 24 kHz Chatterbox output read
back through the STT scored WER 0 on a 78-word paragraph and 0.02–0.05 on the others, so the
two engines agree with each other (`04-roundtrip.ts`).

**A person at the desk** (`02-stt-live.ts`, Brio webcam mic a metre away, mic RMS in the tens):
the user ran the 90 s test with the six sentences in English and Turkish and reported that
the utterances came back correctly; the run was stopped before the JSON summary was written,
so the per-utterance timings are not on file. A clip through the speakers at 8 % volume,
mic RMS 31, came back word for word. The first attempt heard nothing at all, for a reason
that has nothing to do with the model: finding 10.

### VAD: Silero through sherpa-onnx, in-process

Loads with the STT, 512-sample windows, 4 % of one core on its own. It closed the utterance
0.7 s after the clip ended in spike 12's end-to-end run. Not exercised on real speech here.

### TTS: Chatterbox Turbo, `tts-py` sidecar

Bench (`tts-py/bench.py`), CUDA, process pinned to the P-cores:

| | Result |
|---|---|
| Load from the Hugging Face cache | 8.8 s |
| VRAM after load / peak over a 25 s paragraph | 2.7 GB / 3.7 GB |
| Clone from a 11 s reference clip | 10.5 s the first time (CUDA warm-up inside), 2 s after |
| Short line, 44 chars → 3.4 s of audio | 0.9 s, RTF 0.29 |
| Medium, 216 chars → 13.5 s | 3.5 s, RTF 0.26 |
| Paragraph, 441 chars → 25.5 s | 6.6 s, RTF 0.26 |
| Paragraph sentence by sentence | first sentence ready in 0.55 s, all six in 7.4 s |
| Same on the CPU, short line only | 5.3 s for 3 s of audio, RTF 1.8, 4 GB RSS; the doc's 48 s was a weaker CPU |

`generate()` is not streaming: every speech token first, then one vocoder pass. Time to first
audio therefore comes from splitting on sentences in the sidecar, and it scales with the
length of the first sentence.

Through the sidecar (`tts-py/server.py` spawned by `05-tts-client.ts` from Bun, OpenAI-shaped
`POST /v1/audio/speech`, chunked PCM, one chunk per sentence):

| | Result |
|---|---|
| Spawn → `/health` answers | 12.6 s (load, clone, one warm-up line) |
| `127.0.0.1` binding | the same port on the LAN address refuses |
| Short line, first byte / total | 377 ms / 1.1 s for 3.4 s of audio |
| Medium, 3 sentences | first byte 1.15 s (a 74-char first sentence), total 3.4 s for 12.7 s |
| Quote with a `[breath]` tag | first byte 1.26 s, total 2.0 s for 7.4 s |
| Whole clip as WAV instead | 3.4 s for the medium text: no faster, just later |

Every sentence chunk arrives well ahead of playback: ~1.1 s of work per ~4.2 s of speech.

**The E-core finding.** The first bench ran at RTF 0.27; the next two at 0.7, in the same
process, same GPU, nothing else on the card. `tts-py/stages.py` splits `generate()`: the T3
token loop went from ~100 tokens/s to 36 (25 tokens = 1 s of audio) whenever the Python
thread sat on an E-core. The loop is launch-bound, thousands of tiny kernels, so the CPU
core's speed is the GPU's speed. Affinity to logical CPUs 0–15 restores it every time; high
priority alone gives 47 tokens/s. The server takes `--affinity 0-15`.

### TTS on the CPU: Kokoro 82M through sherpa-onnx-node, in-process

`06-kokoro.ts`, `kokoro-en-v0_19` (fp32, 11 voices, 24 kHz), Bun, ORT spinning off.

| | Placed by Windows | Pinned to P-cores, 2 threads | P-cores, 4 threads |
|---|---|---|---|
| Load | 0.76 s, +405 MB RSS | | |
| RTF, short / medium / paragraph | 1.2 / 1.03 / 1.03 | 0.45 / 0.37 / 0.37 | 0.28 / 0.22 / 0.22 |
| First chunk (per-sentence callback) | 1.4 s / 4.2 s / 2.0 s | 0.44 / 1.5 / 0.7 s | 0.28 / 0.9 / 0.4 s |
| Cores busy while generating | 1.7 | 1.8 | 3.2 |

No Python, no GPU, no cloning; one of eleven stock voices. A fallback that works on a
machine without a card, but not the product's voice. Chatterbox Nano is not in the pip
package and was not tested.

## Findings

1. **`sherpa-onnx-node` 1.13.8 carries everything for STT, VAD and CPU TTS** as one native
   addon with prebuilt Windows binaries: streaming Nemotron, Silero, Kokoro. It loads under
   Bun and Node with no flags. Its `onnxruntime.dll` ships inside the package, which is the
   packaging problem spike 04 hit with `onnxruntime-node` solved from the other side; whether
   it survives `bun build --compile` was not tried, and cophylad does not compile anyway.
2. **ORT spins.** `numThreads: 2` costs a whole extra core of busy-wait between chunks.
   sherpa-onnx forwards ORT session config from a file named in the provider string:
   `provider: 'cpu:models/ort-nospin.cfg'` with
   `SessionConfig.session.intra_op.allow_spinning=0` (`inter_op` too). With that, 2 threads
   cost 35 % of a core and decode 40 % faster than one.
3. **Hybrid CPUs need affinity.** Windows put the TTS sidecar and once the Kokoro process on
   E-cores, three times slower. The STT runs landed on P-cores by luck; forced onto E-cores
   they were three times slower too. Nothing in the design mentions this. `sidecars` should
   set the affinity of what it spawns, and cophylad's own inference threads need the same on
   this class of CPU. macOS and Linux schedulers were not examined.
4. **Language for the STT is a per-stream option** (`stream.setOption('language', 'tr')`) and
   auto-detect got every clip right, including Turkish. The locale form `tr-TR` also works.
5. **Give sherpa the real sample rate.** It resamples internally. Feeding 44.1 kHz audio as
   16 kHz produced silence, not garbage, which looked like a broken language path until the
   rate was checked.
6. **`resemble-perth` imports `pkg_resources`**, which setuptools 81+ no longer ships and
   a uv venv does not have at all; chatterbox then constructs `None()` at load. The sidecar's
   environment pins `setuptools<81`. Every Chatterbox output carries that watermark.
7. **libuv resolves a relative executable against the child's `cwd` on Windows.** `spawn`
   with `cwd: 'tts-py'` and a path starting `tts-py/` fails with an asynchronous `error`
   event and no exit code; the health poll then waits forever. `sidecars` spawns absolute paths
   and listens for `error`.
8. **A file named `profile.py` next to the sidecar shadows the stdlib `profile`** that torch
   imports through `cProfile`. The sidecar folder must not contain one.
9. **espeak-ng is not a stand-in for a speaker** beyond English. Its Turkish produced nothing
   from the model; a neural voice produced WER 0.
10. **`@picovoice/pvrecorder-node` returns silence for frames under 1024 samples on this
    machine.** 512 and 640 deliver zeros on time, every read; 1024, 1280 and 1600 deliver audio.
    A first live run asked for 512 (Silero's window) and heard a person speaking for 90 s as
    nothing; the same device through spike 04's `winmm` route and through pvrecorder at 1280
    was fine. Capture at 80 ms and cut the VAD windows in code. Not tested on other machines
    or other devices' native rates.

## Recommendation for the architecture

- **Keep the table as it is.** STT and VAD in-process through sherpa-onnx-node, 2 threads,
  spinning off; Chatterbox Turbo in `tts-py`; Kokoro through the same sherpa-onnx-node as the
  CPU engine, in-process, no sidecar needed for it.
- **Add to `sidecars`:** CPU affinity as part of the spawn spec, and absolute executable
  paths. Add to `voice`: the ORT session config file next to each model, and P-core affinity
  for cophylad's inference threads on hybrid CPUs.
- **The sidecar contract holds:** spawn, `/health`, loopback, port from the parent, streamed
  PCM per sentence. 12.6 s from spawn to ready means `tts-py` starts with the stage, not with
  the first `voice.speak`.
- **Budget:** while a conversation runs, the node spends ~35 % of a core on STT plus the GPU
  for TTS; between conversations the STT costs nothing and the wake word 5 % (spike 04). Idle
  memory: ~750 MB for the STT model held loaded, 2.7 GB VRAM for the sidecar held warm.
- **Doc edits.** `architecture.md`: the affinity and spinning notes under `voice` and
  `sidecars`; Kokoro placed in-process. `text-to-speech-chatterbox-turbo.md`: measured VRAM
  and CPU numbers replace the quoted ones; the `setuptools` pin. `speech-to-text-parakeet.md`:
  verified on this machine, the language option, the spinning config.

## Not verified

- The live run's numbers (partial timing, VAD closes) for a human voice; only the result was
  reported. Whether the 0.7 s VAD silence splits a sentence with a mid-sentence pause.
- Long utterances (over 30 s), overlapping speakers, a noisy room.
- macOS and Linux for all of it; Metal or CUDA for the STT (not needed).
- The GPU path on a card with less memory, or with a game running.
- `bun build --compile` with sherpa-onnx-node.
- Chatterbox Nano, Multilingual, and a cloned voice from a real recording (the reference clip
  here was a neural TTS voice).

## Files and commands

Run from this folder. `bun install` first; models in `models/` (gitignored, 770 MB):

```
cd models
curl -sSLO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11.tar.bz2
tar xjf sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11.tar.bz2
curl -sSLO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx
curl -sSLO https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2 && tar xjf kokoro-en-v0_19.tar.bz2
```

| File | What it does | Command |
|---|---|---|
| `stt.ts` | recognizer, VAD, the chunked feeder with partial timing, WER | imported |
| `00-clips.ts` | synthesizes the English (SAPI) and Turkish (espeak) clips with known text | `bun 00-clips.ts` |
| `01-stt-file.ts` | streams every clip, WER, RTF, partial timing, the shipped multilingual wavs | `bun 01-stt-file.ts [threads]` |
| `02-stt-live.ts` | microphone → VAD → STT paced live; paced CPU cost | `bun 02-stt-live.ts [seconds] [threads] [language]` |
| `04-roundtrip.ts` | the TTS output back through the STT | `bun 04-roundtrip.ts` |
| `05-tts-client.ts` | spawns the sidecar, health poll, loopback check, streamed requests timed | `bun 05-tts-client.ts [--keep] [--affinity=0-15]` |
| `06-kokoro.ts` | Kokoro in-process, sync and streamed | `bun 06-kokoro.ts [threads]` |
| `tts-py/server.py` | the sidecar: `/health`, `/v1/audio/speech` (pcm per sentence, or wav) | `.venv/Scripts/python server.py --port 8321 --affinity 0-15` |
| `tts-py/bench.py` | Turbo load, clone, three texts, per-sentence; `cpu` or `cuda` | `.venv/Scripts/python bench.py cuda` |
| `tts-py/stages.py` | T3 / S3Gen / watermark time per call; `pcores`, `high` | `.venv/Scripts/python stages.py pcores` |
| `models/ort-nospin.cfg` | the ORT session entries that stop the busy-wait | referenced from `stt.ts` |

The neural clips (`*.edge.wav`) came from `uvx edge-tts` (Microsoft's neural voices over the
network; a few test sentences were sent). The Python side:

```
cd tts-py
uv venv --python 3.11 .venv
uv pip install --python .venv/Scripts/python.exe --index https://download.pytorch.org/whl/cu124 --index-strategy unsafe-best-match chatterbox-tts fastapi "uvicorn[standard]" soundfile psutil "setuptools<81"
```

5.2 GB in `.venv` (gitignored), 1.7 GB of Turbo weights in `~/.cache/huggingface`. `out/`
holds the clips, the synthesized speech and the JSON reports; gitignored. To pin a Bun
process to the P-cores from outside: `$p = Start-Process bun -ArgumentList ... -PassThru;
$p.ProcessorAffinity = 0xFFFF`.
