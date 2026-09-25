// Step 2: live microphone -> Silero VAD -> Nemotron streaming, paced at real time. Partials print
// while you speak; the VAD closing an utterance prints the final line, as the brain would get it as
// a user.message. Also reports the paced CPU cost and how far behind the audio each decode was.
//   bun 02-stt-live.ts [seconds=30] [threads=2] [language] [--gain N]     (also under node)
// --gain multiplies the samples before VAD and STT, for a quiet microphone; the level line shows
// the mic's own RMS and peak every second so silence is visible.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, createRecognizer, createVad, int16ToFloat, pct, rssMB } from './stt.ts';

const require = createRequire(import.meta.url);
const { PvRecorder } = require('@picovoice/pvrecorder-node');

const seconds = Number(process.argv[2] ?? 30);
const threads = Number(process.argv[3] ?? 2);
const language = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : undefined;
const gain = process.argv.includes('--gain') ? Number(process.argv[process.argv.indexOf('--gain') + 1]) : 1;
const runtime = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;

const rec = createRecognizer({ numThreads: threads, endpoint: true });
const vad = createVad({ minSilence: 0.7 });
const rssLoaded = rssMB();

// 1280 samples = 80 ms. Not 512: on this machine pvrecorder returns silence for frames under 1024
// (512 and 640 tried; 1024, 1280, 1600 work). The Silero windows are cut from the 80 ms frames below.
const mic = new PvRecorder(1280, -1);
let carry = new Float32Array(0);
mic.start();
console.log(`${runtime}, ${threads} thread(s), mic "${mic.getSelectedDevice()}", gain x${gain}, ${seconds} s. Speak.\n`);

let stream = rec.createStream();
if (language) stream.setOption('language', language);
let last = '';
let speaking = false;
let speechStartedAt = 0;
const decodeMs: number[] = [];
const lagMs: number[] = [];       // audio captured but not yet decoded, at each decode
const finals: { t: number; text: string; speechMs: number; closeToFinalMs: number }[] = [];
let captured = 0;
const t0 = performance.now();
const cpu0 = process.cpuUsage();
const line = (s: string) => process.stdout.write(`\r${s.padEnd(140).slice(0, 140)}`);
let secRms = 0, secPeak = 0, secN = 0, lastLevelAt = 0;
const levels: { t: number; rms: number; peak: number }[] = [];

const deadline = t0 + seconds * 1000;
while (performance.now() < deadline) {
  const raw = Int16Array.from(await mic.read());
  for (let i = 0; i < raw.length; i++) { const v = raw[i]; secRms += v * v; secN++; if (Math.abs(v) > secPeak) secPeak = Math.abs(v); }
  if (performance.now() - lastLevelAt > 1000) {
    const lv = { t: Math.round((performance.now() - t0) / 1000), rms: Math.round(Math.sqrt(secRms / Math.max(1, secN))), peak: secPeak };
    levels.push(lv); secRms = 0; secPeak = 0; secN = 0; lastLevelAt = performance.now();
    if (!last) line(`  t=${lv.t}s  mic rms ${lv.rms}  peak ${lv.peak}${lv.peak < 500 ? '  (quiet)' : ''}`);
  }
  const frame = int16ToFloat(raw);
  if (gain !== 1) for (let i = 0; i < frame.length; i++) frame[i] = Math.max(-1, Math.min(1, frame[i] * gain));
  captured += frame.length;
  const audioMs = (captured / 16000) * 1000;
  // VAD takes 512-sample windows; keep the remainder for the next frame.
  const joined = new Float32Array(carry.length + frame.length); joined.set(carry); joined.set(frame, carry.length);
  let off = 0;
  for (; off + 512 <= joined.length; off += 512) vad.acceptWaveform(joined.subarray(off, off + 512));
  carry = joined.slice(off);
  // Everything goes to the recognizer; VAD decides where an utterance ends.
  stream.acceptWaveform({ samples: frame, sampleRate: 16000 });
  while (rec.isReady(stream)) {
    const d0 = performance.now();
    rec.decode(stream);
    decodeMs.push(performance.now() - d0);
    lagMs.push(performance.now() - t0 - audioMs + 0); // negative = ahead of real time (never), positive = behind
    const text = rec.getResult(stream).text;
    if (text !== last) { last = text; line(`  … ${text}`); }
  }
  if (!speaking && vad.isDetected()) { speaking = true; speechStartedAt = performance.now(); }
  // Silero closed an utterance: what it heard is in front(); the recognizer's text is the final.
  while (!vad.isEmpty()) {
    const seg = vad.front();
    vad.pop();
    const closed = performance.now();
    // Give the model the trailing silence it already has, then read the final.
    while (rec.isReady(stream)) rec.decode(stream);
    const text = rec.getResult(stream).text.trim();
    const speechMs = Math.round((seg.samples.length / 16000) * 1000);
    finals.push({ t: +((closed - t0) / 1000).toFixed(1), text, speechMs, closeToFinalMs: Math.round(performance.now() - closed) });
    process.stdout.write(`\r  ${' '.repeat(138)}\r`);
    console.log(`[${finals.at(-1)!.t} s] user.message (${speechMs} ms of speech, endpoint=${rec.isEndpoint(stream)}): ${text || '(empty)'}`);
    rec.reset(stream);
    last = '';
    speaking = false;
  }
}
mic.stop();
mic.release();

const wall = (performance.now() - t0) / 1000;
const cpu = process.cpuUsage(cpu0);
const summary = {
  runtime, threads, language: language ?? 'auto', gain, micLevelPerSecond: levels, wallSeconds: +wall.toFixed(1), capturedSeconds: +(captured / 16000).toFixed(1),
  utterances: finals.length, finals,
  decodes: decodeMs.length, decodeMs: pct(decodeMs), behindRealTimeMs: pct(lagMs),
  cpuPercentOfOneCore: +((((cpu.user + cpu.system) / 1e6) / wall) * 100).toFixed(1),
  rssLoadedMB: rssLoaded, rssEndMB: rssMB(),
};
console.log('\n' + JSON.stringify(summary, null, 2));
writeFileSync(join(HERE, `out/02-stt-live.${runtime.split(' ')[0]}.json`), JSON.stringify(summary, null, 2));
process.exit(0);
