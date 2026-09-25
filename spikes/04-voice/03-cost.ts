// Step 4: what does always-on wake-word inference cost?
//   A. throughput: 60 s of audio pushed through as fast as one thread allows -> real-time factor
//   B. paced: one 80 ms chunk every 80 ms for 30 s -> CPU % of one core, RSS
// Single-threaded ORT sessions (intraOp=1, interOp=1). Run with: bun 03-cost.ts  |  node 03-cost.ts
import { readFileSync, existsSync } from 'node:fs';
import { WakeWord, readWav16, CHUNK, type Scale } from './wakeword.ts';

const runtime = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;
const nHeads = Number(process.argv[2] ?? 1);
const pacedSeconds = Number(process.argv[3] ?? 30);
const scale: Scale = 'int16';
const allHeads = [
  { name: 'hey_jarvis', path: 'models/hey_jarvis_v0.1.onnx' },
  { name: 'alexa', path: 'models/alexa_v0.1.onnx' },
  { name: 'hey_livekit', path: 'models/hey_livekit.onnx' },
];
const heads = allHeads.slice(0, nHeads);

// Speech-like input: loop a synthesized clip if 02-clips.ts has run, else noise.
const clipPath = 'out/clips/neg_sentence.MicrosoftDavidDesktop.wav';
const source = existsSync(clipPath)
  ? readWav16(readFileSync(clipPath)).samples
  : Int16Array.from({ length: 16000 * 3 }, () => Math.round((Math.random() - 0.5) * 4000));
const chunkAt = (i: number) => {
  const out = new Int16Array(CHUNK);
  for (let j = 0; j < CHUNK; j++) out[j] = source[(i * CHUNK + j) % source.length];
  return out;
};

const rssBefore = process.memoryUsage().rss;
const ww = await WakeWord.create(heads, scale);
const rssLoaded = process.memoryUsage().rss;
for (let i = 0; i < 25; i++) await ww.feed(chunkAt(i)); // warm-up

// A. throughput
const audioSeconds = 60;
const nChunks = Math.round((audioSeconds * 16000) / CHUNK);
const lat: number[] = [];
const t0 = performance.now();
for (let i = 0; i < nChunks; i++) {
  const s = performance.now();
  await ww.feed(chunkAt(i));
  lat.push(performance.now() - s);
}
const wall = (performance.now() - t0) / 1000;
lat.sort((a, b) => a - b);
const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(2);

// B. paced
const cpu0 = process.cpuUsage();
const p0 = performance.now();
let i = 0;
let late = 0;
await new Promise<void>((resolve) => {
  const tick = async () => {
    const due = p0 + i * 80;
    if (performance.now() - due > 80) late++;
    await ww.feed(chunkAt(i++));
    if (i * 0.08 >= pacedSeconds) return resolve();
    setTimeout(tick, Math.max(0, p0 + i * 80 - performance.now()));
  };
  tick();
});
const pacedWall = (performance.now() - p0) / 1000;
const cpu = process.cpuUsage(cpu0);
const cpuSeconds = (cpu.user + cpu.system) / 1e6;

console.log(JSON.stringify({
  runtime,
  classifiers: heads.map((h) => h.name),
  throughput: {
    audioSeconds, wallSeconds: +wall.toFixed(2), realTimeFactor: +(wall / audioSeconds).toFixed(4),
    perChunkMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: lat[lat.length - 1].toFixed(2) },
  },
  paced: {
    seconds: +pacedWall.toFixed(1), chunks: i, lateChunks: late,
    cpuSeconds: +cpuSeconds.toFixed(2), cpuPercentOfOneCore: +((cpuSeconds / pacedWall) * 100).toFixed(1),
  },
  memoryMB: {
    rssBeforeModels: +(rssBefore / 2 ** 20).toFixed(0),
    rssAfterLoad: +(rssLoaded / 2 ** 20).toFixed(0),
    rssEnd: +(process.memoryUsage().rss / 2 ** 20).toFixed(0),
  },
}, null, 2));
