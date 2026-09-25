// Step 3: false accepts over hours of real speech, digitally. LibriSpeech dev-clean (5.4 h of
// read audiobooks, 40 speakers, none of them saying the wake phrases) runs through the same three
// classifiers as a continuous stream, file after file. This gives the models' own false-accept
// rate on speech; the room run (02) adds the microphone and the acoustic path on top.
//   bun 03-offline-hours.ts [maxHours=6]
// Needs models/LibriSpeech/dev-clean (see README). Decodes FLAC through ffmpeg.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHeads } from './wake.ts';

const maxHours = Number(process.argv[2] ?? 6);
const root = 'models/LibriSpeech/dev-clean';
const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f.endsWith('.flac')) files.push(p); } };
walk(root);
files.sort();
console.log(`${files.length} files`);

const heads = await createHeads();
const THRESH = [0.3, 0.5, 0.7, 0.9];
const fires: Record<string, Record<number, number>> = Object.fromEntries(heads.names.map((n) => [n, Object.fromEntries(THRESH.map((t) => [t, 0]))]));
const armed: Record<string, Record<number, boolean>> = Object.fromEntries(heads.names.map((n) => [n, Object.fromEntries(THRESH.map((t) => [t, true]))]));
const top: { file: string; head: string; score: number }[] = [];
let seconds = 0;
const t0 = performance.now();
for (const [i, file] of files.entries()) {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '16000', '-'], { maxBuffer: 1 << 26 });
  const pcm = new Int16Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength >> 1);
  seconds += pcm.length / 16000;
  for (const row of await heads.feed(pcm)) {
    for (const n of heads.names) {
      const s = row[n];
      for (const t of THRESH) {
        if (s >= t && armed[n][t]) { armed[n][t] = false; fires[n][t]++; }
        else if (s < 0.1) armed[n][t] = true;
      }
      if (s >= 0.3) { top.push({ file: file.replace(root + '\\', ''), head: n, score: +s.toFixed(3) }); }
    }
  }
  if (i % 200 === 0) console.log(`  ${i}/${files.length}  ${(seconds / 3600).toFixed(2)} h  fires@0.5 ${heads.names.map((n) => `${n}=${fires[n][0.5]}`).join(' ')}`);
  if (seconds / 3600 >= maxHours) break;
}
const hours = seconds / 3600;
const summary = {
  hours: +hours.toFixed(2), files: files.length, wallSeconds: Math.round((performance.now() - t0) / 1000),
  perHour: Object.fromEntries(heads.names.map((n) => [n, Object.fromEntries(THRESH.map((t) => [t, +(fires[n][t] / hours).toFixed(2)]))])),
  fires, worst: top.sort((a, b) => b.score - a.score).slice(0, 20),
};
console.log(JSON.stringify(summary, null, 2));
writeFileSync('out/03-offline-hours.json', JSON.stringify(summary, null, 2));
