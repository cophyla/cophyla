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
| `src/pipeline.ts` | `WakePipeline`: 16 kHz int16 in, 80 ms chunks (`CHUNK`, with 30 ms of earlier audio so the mel frames line up) through `melspectrogram.onnx`, 76-frame windows of 32 mel bins through `embedding_model.onnx`, the last 16 embeddings through the keyword head, the peak score out; nothing scored until 16 chunks have filled the window; `reset()` starts over. The shared models are `WakeModels`, a head's input scale `int16` or `unit` |

The models come from the `wake-openwakeword` model release (`apps/cophylad/scripts/fetch-models.ts
--voice`); the node loads them in `apps/cophylad/src/voice/openwakeword.ts`, and the controller
carries its own copies under `wake/` (`apps/controller/src/wake/`).

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
