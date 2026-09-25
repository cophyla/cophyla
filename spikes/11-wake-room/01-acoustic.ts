// Step 1: the acoustic path. Each clip is played through the speakers while the microphone runs
// through both wake-word pipelines; the peak score per classifier during the clip is the result.
// Nothing is mixed digitally. The mic RMS during playback says whether the room heard it at all.
//   bun 01-acoustic.ts [repeats=2] [only=<substring of a clip id>]
// Speaker volume is whatever Windows is set to; the README records it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readWav16 } from '../04-voice/wakeword.ts';
import { createHeads, openMic, rms, stamp } from './wake.ts';

const repeats = Number(process.argv[2] ?? 2);
const only = process.argv[3] ?? '';
const clips: { id: string; phrase: string; path: string }[] = [
  { id: 'hey_jarvis/edge-guy', phrase: 'hey_jarvis', path: 'out/hey_jarvis.edge-guy.wav' },
  { id: 'hey_jarvis/edge-jenny', phrase: 'hey_jarvis', path: 'out/hey_jarvis.edge-jenny.wav' },
  { id: 'hey_jarvis/sapi-david', phrase: 'hey_jarvis', path: '../04-voice/out/clips/hey_jarvis.MicrosoftDavidDesktop.wav' },
  { id: 'hey_jarvis/sapi-zira', phrase: 'hey_jarvis', path: '../04-voice/out/clips/hey_jarvis.MicrosoftZiraDesktop.wav' },
  { id: 'hey_livekit/edge-guy', phrase: 'hey_livekit', path: 'out/hey_livekit.edge-guy.wav' },
  { id: 'hey_livekit/sapi-zira', phrase: 'hey_livekit', path: '../04-voice/out/clips/hey_livekit.MicrosoftZiraDesktop.wav' },
  { id: 'alexa/edge-guy', phrase: 'alexa', path: 'out/alexa.edge-guy.wav' },
  { id: 'near_miss/edge-jenny', phrase: 'negative', path: 'out/near_miss.edge-jenny.wav' },
  { id: 'near_miss/edge-guy', phrase: 'negative', path: 'out/near_miss.edge-guy.wav' },
  { id: 'near_miss/espeak', phrase: 'negative', path: '../04-voice/out/clips/neg_near_miss.espeak.wav' },
  { id: 'sentence/edge-guy', phrase: 'negative', path: '../10-stt-tts/out/clips/en_long.edge.wav' },
  // One phrase per clip, to see which near miss fires.
  ...['hey_travis', 'hey_jargon', 'hey_service', 'hey_marvin', 'say_jarvis', 'jarvis_alone', 'hey_jarvis_sentence'].map((id) => ({ id: `nm/${id}`, phrase: 'negative', path: `out/nm_${id}.wav` })),
].filter((c) => existsSync(c.path) && c.id.includes(only));

const heads = await createHeads();
const mic = openMic();
// Which devices Windows will use, at what volume, muted or not: the README needs this next to the scores.
const audio = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'audio-defaults.ps1'], { encoding: 'utf8' }).stdout.trim();
console.log(audio);
console.log(`mic "${mic.device}", ${clips.length} clips x ${repeats}\n`);

// The mic runs continuously; each trial marks a window and takes the peak inside it.
let window: { peak: Record<string, number>; level: number[] } | null = null;
let stopped = false;
const pump = (async () => {
  while (!stopped) {
    const frame = await mic.read();
    const rows = await heads.feed(frame);
    if (window) {
      window.level.push(rms(frame));
      for (const row of rows) for (const n of heads.names) window.peak[n] = Math.max(window.peak[n] ?? 0, row[n]);
    }
  }
})();

const play = (path: string) => new Promise<void>((done) => {
  const p = spawn('powershell.exe', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${resolve(path)}').PlaySync()`]);
  p.on('exit', () => done());
});

// Silence baseline first: the room with nothing played.
window = { peak: {}, level: [] };
await new Promise((r) => setTimeout(r, 3000));
const baseline = { level: Math.round(window.level.reduce((a, b) => a + b, 0) / window.level.length), peak: { ...window.peak } };
console.log(`room baseline: mic rms ${baseline.level}, peaks ${JSON.stringify(baseline.peak)}\n`);

const results: Record<string, unknown>[] = [];
for (const clip of clips) {
  const { sampleRate, samples } = readWav16(readFileSync(clip.path));
  const seconds = samples.length / sampleRate;
  for (let i = 0; i < repeats; i++) {
    window = { peak: {}, level: [] };
    await play(clip.path);
    await new Promise((r) => setTimeout(r, 1200)); // let the 2 s embedding window catch the tail
    const level = Math.round(Math.max(...window.level));
    const row = { at: stamp(), clip: clip.id, phrase: clip.phrase, seconds: +seconds.toFixed(2), micPeakRms: level, ...Object.fromEntries(heads.names.map((n) => [n, +(window!.peak[n] ?? 0).toFixed(3)])) };
    results.push(row);
    const hit = clip.phrase !== 'negative' ? (row as any)[clip.phrase] >= 0.5 : heads.names.some((n) => (row as any)[n] >= 0.5);
    console.log(`${clip.id.padEnd(24)} #${i + 1}  mic ${String(level).padStart(5)}  jarvis ${row.hey_jarvis.toFixed(3)}  alexa ${row.alexa.toFixed(3)}  livekit ${row.hey_livekit.toFixed(3)}  ${clip.phrase === 'negative' ? (hit ? 'FALSE ACCEPT' : 'quiet') : (hit ? 'detected' : 'MISSED')}`);
    window = null;
    await new Promise((r) => setTimeout(r, 800));
  }
}
stopped = true;
await pump.catch(() => {});
mic.close();
writeFileSync(`out/01-acoustic${only ? '.' + only.replace(/[^a-z_]/g, '') : ''}.json`, JSON.stringify({ at: stamp(), audio, mic: mic.device, baseline, results }, null, 2));
process.exit(0);
