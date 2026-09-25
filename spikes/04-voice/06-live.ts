// Step 6: live loop under Bun: default microphone (bun:ffi -> winmm) -> wake-word pipeline.
//   bun 06-live.ts [seconds=10] [--inject]
// --inject mixes the synthesized "hey jarvis" clip into the live microphone samples at t=4 s,
// so the detection path is exercised in real time without anyone speaking and without
// playing sound in the room. It is a digital mix, not an acoustic test.
import { existsSync, readFileSync } from 'node:fs';
import { startCapture } from './capture-winmm.ts';
import { WakeWord, readWav16, rms } from './wakeword.ts';

const seconds = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 10);
const inject = process.argv.includes('--inject');
const THRESHOLD = 0.5;

const ww = await WakeWord.create([{ name: 'hey_jarvis', path: 'models/hey_jarvis_v0.1.onnx' }], 'int16');
const clipPath = 'out/clips/hey_jarvis.MicrosoftDavidDesktop.wav';
const clip = inject && existsSync(clipPath) ? readWav16(readFileSync(clipPath)).samples : null;
if (inject && !clip) console.log('no clip to inject; run 02-clips.ts first');

let captured = 0;
let scored = 0;
let worstLagMs = 0;
let detections = 0;
let armed = true;
let busy = Promise.resolve();
const perSecond: { t: number; rms: number; peakScore: number }[] = [];
let bucket = { level: [] as number[], peak: 0 };
const cpu0 = process.cpuUsage();
const t0 = performance.now();

const cap = startCapture((samples) => {
  const arrived = performance.now();
  if (clip) {
    const at = captured - 4 * 16000; // clip starts 4 s in
    for (let i = 0; i < samples.length; i++) {
      const j = at + i;
      if (j >= 0 && j < clip.length) samples[i] = Math.max(-32768, Math.min(32767, samples[i] + clip[j]));
    }
  }
  captured += samples.length;
  // Inference is serialized behind the capture callback; lag = arrival -> score ready.
  busy = busy.then(async () => {
    for (const row of await ww.feed(samples)) {
      scored++;
      bucket.peak = Math.max(bucket.peak, row.hey_jarvis);
      if (row.hey_jarvis >= THRESHOLD && armed) {
        armed = false;
        detections++;
        console.log(`  DETECTED hey_jarvis score=${row.hey_jarvis.toFixed(3)} at t=${((performance.now() - t0) / 1000).toFixed(2)} s`);
      } else if (row.hey_jarvis < 0.1) armed = true;
    }
    bucket.level.push(rms(samples));
    worstLagMs = Math.max(worstLagMs, performance.now() - arrived);
    if (bucket.level.length >= 12) {
      const t = Math.round((performance.now() - t0) / 1000);
      const level = bucket.level.reduce((a, b) => a + b, 0) / bucket.level.length;
      perSecond.push({ t, rms: +level.toFixed(1), peakScore: +bucket.peak.toFixed(4) });
      console.log(`t=${t}s  mic rms=${level.toFixed(1)}  peak score=${bucket.peak.toFixed(4)}`);
      bucket = { level: [], peak: 0 };
    }
  });
});

await new Promise((r) => setTimeout(r, seconds * 1000));
cap.stop();
await busy;
const wall = (performance.now() - t0) / 1000;
const cpu = process.cpuUsage(cpu0);
console.log(JSON.stringify({
  wallSeconds: +wall.toFixed(2), capturedSeconds: +(captured / 16000).toFixed(2), chunksScored: scored,
  captureOverruns: cap.overruns, worstLagMs: +worstLagMs.toFixed(1), detections, injectedClip: !!clip,
  cpuPercentOfOneCore: +((((cpu.user + cpu.system) / 1e6) / wall) * 100).toFixed(1),
  rssMB: Math.round(process.memoryUsage().rss / 2 ** 20),
}, null, 2));
process.exit(0);
