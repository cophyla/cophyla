// Step 4: what fired? Every snippet the listener kept goes through the streaming STT of spike 10,
// so each wake event gets a transcript next to its score without anyone listening to the audio.
//   bun 04-label-snippets.ts
import { readdirSync, writeFileSync } from 'node:fs';
import { createRecognizer, sherpa, streamClip } from '../10-stt-tts/stt.ts';

const rec = createRecognizer({ numThreads: 2 });
const rows: { file: string; head: string; score: number; heard: string }[] = [];
for (const f of readdirSync('out/snippets').filter((f) => f.endsWith('.wav')).sort()) {
  const m = f.replace(/\.wav$/, '').match(/^(\S+?)\.([a-z_]+)\.([0-9.]+)$/)!;
  const wave = sherpa.readWave(`out/snippets/${f}`);
  const r = streamClip(rec, wave.samples, { language: 'en', sampleRate: wave.sampleRate, tailMs: 800 });
  rows.push({ file: f, head: m[2], score: Number(m[3]), heard: r.text });
  console.log(`${m[1].slice(11)}  ${m[2].padEnd(11)} ${m[3]}  "${r.text}"`);
}
writeFileSync('out/04-labels.json', JSON.stringify(rows, null, 2));
