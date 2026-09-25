// Step 3b: score identical audio with this TypeScript pipeline and with the reference
// Python package (openwakeword 0.6.0 in .venv), then compare frame by frame.
// Run with: bun 04-crosscheck.ts   (needs 02-clips.ts to have run, and the .venv)
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { WakeWord, readWav16, writeWav16 } from './wakeword.ts';

mkdirSync('out/xcheck', { recursive: true });
const heads = [
  { name: 'hey_jarvis_v0.1', path: 'models/hey_jarvis_v0.1.onnx' },
  { name: 'alexa_v0.1', path: 'models/alexa_v0.1.onnx' },
];

const ours: Record<string, Record<string, number[]>> = {};
for (const file of readdirSync('out/clips').filter((f) => f.endsWith('.wav') && !f.includes('.raw.'))) {
  const { samples } = readWav16(readFileSync(`out/clips/${file}`));
  // Deterministic padding so both sides see the same bytes: 2 s silence, clip, 1 s silence.
  const padded = new Int16Array(32000 + samples.length + 16000);
  padded.set(samples, 32000);
  writeFileSync(`out/xcheck/${file}`, writeWav16(padded));
  const ww = await WakeWord.create(heads, 'int16');
  const rows = await ww.feed(padded);
  ours[file] = Object.fromEntries(heads.map((h) => [h.name, rows.map((r) => r[h.name])]));
}
writeFileSync('out/xcheck/ours.json', JSON.stringify(ours));

const py = spawnSync('.venv/Scripts/python.exe', ['04-crosscheck.py'], { encoding: 'utf8' });
if (py.status !== 0) { console.error(py.stderr); process.exit(1); }
const ref: typeof ours = JSON.parse(readFileSync('out/xcheck/ref.json', 'utf8'));

const table: Record<string, Record<string, string>> = {};
let worst = 0;
for (const [file, byHead] of Object.entries(ours)) {
  for (const [head, scores] of Object.entries(byHead)) {
    const r = ref[file][head];
    const n = Math.min(scores.length, r.length);
    let maxDiff = 0;
    for (let i = 30; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(scores[i] - r[i])); // skip both warm-ups
    worst = Math.max(worst, maxDiff);
    (table[file] ??= {})[`${head} ts`] = Math.max(...scores).toFixed(4);
    table[file][`${head} py`] = Math.max(...r).toFixed(4);
    table[file][`${head} maxΔ`] = maxDiff.toExponential(1);
  }
}
console.table(table);
console.log('worst per-frame difference after warm-up:', worst.toExponential(2));
