# @cophyla/wake

openWakeWord's streaming pipeline, once for both places the wake word runs: the node, on
`onnxruntime-node`, for a controller that streams its microphone; and the phone, on
`onnxruntime-web`'s wasm build in a worker, for a controller that hears the word itself. It
imports neither runtime: the sessions and the tensor constructor are the few members both
have, taken as structural types, so the node's load order (`onnxruntime-node` before
sherpa-onnx, `apps/cophylad/src/voice/runtime.ts`) is untouched and the phone's bundle carries
no native code.

| File | Holds |
|---|---|
| `src/pipeline.ts` | `WakePipeline`: 16 kHz int16 in, 80 ms chunks (`CHUNK`, with 30 ms of earlier audio so the mel frames line up) through `melspectrogram.onnx`, 76-frame windows of 32 mel bins through `embedding_model.onnx`, the last 16 embeddings through every keyword head — one per phrase, each with its own threshold and patience (the chunks in a row it must score at or over it before it fires; one when absent) — and a `WakeScore` out: the first head that fired, or the best score when none did; nothing scored until 16 chunks have filled the window; `reset()` starts over. The shared models are `WakeModels`; a head's input scale is `int16` or `unit`, and the features are computed once per scale the heads use |

The models come from the `wake-openwakeword` model release (`apps/cophylad/scripts/fetch-models.ts
--voice`); the node loads them in `apps/cophylad/src/voice/openwakeword.ts`, and the phone and
the desktop app carry their own copies under `wake/` (`packages/voicehost/src/wake/`). The
heads Cophyla trained itself are in `heads/`, with how they were made.

`test/pipeline.test.ts` runs the pipeline over fake sessions: several heads at their own
thresholds, the first to fire, a patient head firing only on a run and a reset forgetting one,
the features shared by a scale and computed again for another.

## Testing

`test/parity.live.test.ts` runs the phone's entry point — `onnxruntime-web/wasm`, one thread,
no proxy, the wasm's bytes handed over — against `onnxruntime-node` over the recorded phrase
and question in `apps/cophylad/test/fixtures/audio/`: every chunk's score within 10⁻³ (it is about
10⁻⁷), the same first chunk over 0.7, the phrase firing and the question not. It is skipped
without the model:

```
bun run apps/cophylad/scripts/fetch-models.ts --voice --only wake-openwakeword
bun test packages/wake
```
