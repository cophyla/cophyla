// Fallback check: onnxruntime-web (WebAssembly, no native addon) under Bun.
// Not needed today because onnxruntime-node loads under Bun; kept as the escape hatch.
import * as ort from 'onnxruntime-web';
import { readFileSync } from 'node:fs';

ort.env.wasm.numThreads = 1;
const t0 = performance.now();
const mel = await ort.InferenceSession.create(readFileSync('models/melspectrogram.onnx'), { executionProviders: ['wasm'] });
const emb = await ort.InferenceSession.create(readFileSync('models/embedding_model.onnx'), { executionProviders: ['wasm'] });
const head = await ort.InferenceSession.create(readFileSync('models/hey_jarvis_v0.1.onnx'), { executionProviders: ['wasm'] });
const loadMs = performance.now() - t0;

const audio = Float32Array.from({ length: 1760 }, () => (Math.random() - 0.5) * 2000);
const lat: number[] = [];
for (let i = 0; i < 200; i++) {
  const s = performance.now();
  await mel.run({ [mel.inputNames[0]]: new ort.Tensor('float32', audio, [1, 1760]) });
  await emb.run({ [emb.inputNames[0]]: new ort.Tensor('float32', new Float32Array(76 * 32), [1, 76, 32, 1]) });
  await head.run({ [head.inputNames[0]]: new ort.Tensor('float32', new Float32Array(16 * 96), [1, 16, 96]) });
  if (i >= 20) lat.push(performance.now() - s);
}
lat.sort((a, b) => a - b);
console.log(JSON.stringify({
  runtime: typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`,
  binding: 'onnxruntime-web wasm, 1 thread', loadMs: +loadMs.toFixed(0),
  perChunkMs: { p50: +lat[Math.floor(lat.length / 2)].toFixed(2), p95: +lat[Math.floor(lat.length * 0.95)].toFixed(2) },
  realTimeFactor: +(lat[Math.floor(lat.length / 2)] / 80).toFixed(4),
  rssMB: Math.round(process.memoryUsage().rss / 2 ** 20),
}));
