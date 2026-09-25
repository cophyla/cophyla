// Step 1: does onnxruntime-node (N-API addon) load and run under this runtime?
// Run with: bun 01-ort-load.ts   and   node 01-ort-load.ts
import * as ort from 'onnxruntime-node';

const runtime = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;
const opts = { intraOpNumThreads: 1, interOpNumThreads: 1, executionProviders: ['cpu'] };

for (const f of ['melspectrogram', 'embedding_model', 'hey_jarvis_v0.1', 'alexa_v0.1', 'hey_livekit']) {
  const s = await ort.InferenceSession.create(`models/${f}.onnx`, opts);
  const meta = (names: readonly string[], md: any) =>
    names.map((n, i) => `${n}${JSON.stringify(md?.[i]?.shape ?? md?.[i]?.dims ?? '?')}`).join(', ');
  console.log(`${f}: in ${meta(s.inputNames, (s as any).inputMetadata)} -> out ${meta(s.outputNames, (s as any).outputMetadata)}`);
}

// One real inference: 1760 samples (80 ms + 30 ms context) through the mel model.
const mel = await ort.InferenceSession.create('models/melspectrogram.onnx', opts);
for (const n of [1280, 1760, 16000, 32000]) {
  const out = await mel.run({ [mel.inputNames[0]]: new ort.Tensor('float32', new Float32Array(n), [1, n]) });
  console.log(`mel(${n} samples) -> dims ${JSON.stringify(out[mel.outputNames[0]].dims)}`);
}
console.log(`OK under ${runtime}, onnxruntime-node loaded`);
