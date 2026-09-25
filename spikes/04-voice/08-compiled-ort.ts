// Packaging check: can a `bun build --compile` executable use onnxruntime-node?
// Embedding the addon segfaults (its onnxruntime.dll sibling is not extracted with it), and
// --external resolves against the virtual B:/~BUN root. Loading it by absolute path from a
// node_modules folder shipped beside the executable is the variant tested here.
//   bun build --compile 08-compiled-ort.ts --outfile out/ort-abs.exe && ./out/ort-abs.exe
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const beside = join(dirname(process.execPath), '..', 'node_modules', 'onnxruntime-node', 'dist', 'index.js');
const ort = createRequire(join(dirname(process.execPath), 'x.js'))(beside);
const s = await ort.InferenceSession.create(join(dirname(process.execPath), '..', 'models', 'melspectrogram.onnx'),
  { intraOpNumThreads: 1, interOpNumThreads: 1 });
const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', new Float32Array(1760), [1, 1760]) });
console.log('compiled exe ran onnxruntime-node from disk:', JSON.stringify(out[s.outputNames[0]].dims));
