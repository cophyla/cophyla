// Step 2: the false-accept run. Leaves the three classifiers on the room microphone for hours during
// normal use, logs every score above 0.3 with a timestamp, and keeps a 3 s snippet of every event
// at or above 0.5 so a human can hear what fired. Say the wake phrase at any time to see a true
// detection logged the same way; those are told apart by ear afterwards.
//   bun 02-listen.ts [hours=4]
// Writes out/listen.jsonl (events), out/listen-summary.json (updated every minute) and
// out/snippets/*.wav. The mic audio itself is never written except those snippets.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { writeWav16 } from '../04-voice/wakeword.ts';
import { createHeads, openMic, rms, stamp } from './wake.ts';

const hours = Number(process.argv[2] ?? 4);
const LOG = 0.3, KEEP = 0.5, FIRE = 0.5;
mkdirSync('out/snippets', { recursive: true });
writeFileSync('out/listen.jsonl', '');

const heads = await createHeads();
const mic = openMic();
console.log(`${stamp()}  listening on "${mic.device}" for ${hours} h; log >= ${LOG}, snippet >= ${KEEP}\n`);

// Ring of the last 3 s of audio for snippets.
const ring = new Int16Array(1280 * 38); // ~3 s, a whole number of 80 ms frames
let ringPos = 0;
const snapshot = () => { const out = new Int16Array(ring.length); out.set(ring.subarray(ringPos)); out.set(ring.subarray(0, ringPos), ring.length - ringPos); return out; };

const t0 = performance.now();
const cpu0 = process.cpuUsage();
const armed: Record<string, boolean> = Object.fromEntries(heads.names.map((n) => [n, true]));
const counts: Record<string, { logged: number; fired: number }> = Object.fromEntries(heads.names.map((n) => [n, { logged: 0, fired: 0 }]));
let frames = 0;
let loud = 0; // frames with speech-level energy, to say how much of the run had sound in the room
let quiet = 0;
let lastSummary = 0;

const summarize = () => {
  const h = (performance.now() - t0) / 3.6e6;
  const cpu = process.cpuUsage(cpu0);
  const s = {
    at: stamp(), hoursRun: +h.toFixed(3), mic: mic.device, frames,
    roomWithSoundPercent: +((loud / Math.max(1, loud + quiet)) * 100).toFixed(1),
    perHour: Object.fromEntries(heads.names.map((n) => [n, { logged: counts[n].logged, fired: counts[n].fired, firedPerHour: +(counts[n].fired / Math.max(h, 1e-6)).toFixed(2) }])),
    cpuPercentOfOneCore: +((((cpu.user + cpu.system) / 1e6) / ((performance.now() - t0) / 1000)) * 100).toFixed(1),
    rssMB: Math.round(process.memoryUsage().rss / 2 ** 20),
  };
  writeFileSync('out/listen-summary.json', JSON.stringify(s, null, 2));
  return s;
};

const deadline = t0 + hours * 3.6e6;
while (performance.now() < deadline) {
  const frame = await mic.read();
  frames++;
  ring.set(frame, ringPos); ringPos = (ringPos + frame.length) % ring.length;
  const level = rms(frame);
  if (level > 200) loud++; else quiet++;
  for (const row of await heads.feed(frame)) {
    for (const n of heads.names) {
      const score = row[n];
      if (score >= LOG && armed[n]) {
        armed[n] = false;
        counts[n].logged++;
        const fired = score >= FIRE;
        if (fired) counts[n].fired++;
        const ev = { at: stamp(), t: +((performance.now() - t0) / 1000).toFixed(1), head: n, score: +score.toFixed(3), fired, micRms: Math.round(level) };
        appendFileSync('out/listen.jsonl', JSON.stringify(ev) + '\n');
        console.log(`${ev.at}  ${n.padEnd(11)} ${ev.score.toFixed(3)} ${fired ? 'FIRED' : 'near'}  mic ${ev.micRms}`);
        if (score >= KEEP) {
          // Wait one more second of audio so the snippet holds the whole phrase, then write it.
          const name = `out/snippets/${ev.at.replace(/[: ]/g, '-')}.${n}.${ev.score.toFixed(2)}.wav`;
          setTimeout(() => writeFileSync(name, writeWav16(snapshot())), 1000);
        }
      } else if (score < 0.1) armed[n] = true;
    }
  }
  if (performance.now() - lastSummary > 60_000) { lastSummary = performance.now(); const s = summarize(); process.stdout.write(`  [${s.at}] ${s.hoursRun} h, sound ${s.roomWithSoundPercent}%, fired ${heads.names.map((n) => `${n}=${counts[n].fired}`).join(' ')}, cpu ${s.cpuPercentOfOneCore}%\n`); }
}
mic.close();
await new Promise((r) => setTimeout(r, 1500));
console.log('\n' + JSON.stringify(summarize(), null, 2));
process.exit(0);
