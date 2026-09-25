// Step 2+3: synthesize positive and negative clips with the TTS already on this box
// (Windows SAPI voices and espeak-ng), resample to 16 kHz mono, and run them through the
// TypeScript pipeline. Prints the peak score per clip per classifier.
// Run with: bun 02-clips.ts        (also runs under node 22)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { WakeWord, readWav16, type Scale } from './wakeword.ts';

mkdirSync('out/clips', { recursive: true });

const phrases: Record<string, string> = {
  hey_jarvis: 'hey jarvis',
  alexa: 'alexa',
  hey_livekit: 'hey live kit',
  neg_sentence: 'what time is the meeting tomorrow afternoon',
  neg_near_miss: 'hey jargon, hey service, hey travis',
};

// --- synthesis -------------------------------------------------------------------------
const sapiVoices = spawnSync('powershell.exe', ['-NoProfile', '-Command',
  'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | % { $_.VoiceInfo.Name }',
], { encoding: 'utf8' }).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
console.log('SAPI voices:', sapiVoices.join(' | ') || '(none)');

const clips: { id: string; phrase: string; voice: string; path: string }[] = [];
for (const [phrase, text] of Object.entries(phrases)) {
  for (const voice of sapiVoices) {
    const tag = voice.replace(/[^A-Za-z]/g, '');
    const raw = `out/clips/${phrase}.${tag}.raw.wav`;
    const path = `out/clips/${phrase}.${tag}.wav`;
    if (!existsSync(path)) {
      spawnSync('powershell.exe', ['-NoProfile', '-Command',
        `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('${voice}'); $s.SetOutputToWaveFile('${raw}'); $s.Speak('${text}'); $s.Dispose()`]);
      spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', path]);
    }
    clips.push({ id: `${phrase}/${tag}`, phrase, voice: tag, path });
  }
  const raw = `out/clips/${phrase}.espeak.raw.wav`;
  const path = `out/clips/${phrase}.espeak.wav`;
  if (!existsSync(path)) {
    spawnSync('espeak-ng', ['-v', 'en-us', '-s', '150', '-w', raw, text]);
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', path]);
  }
  clips.push({ id: `${phrase}/espeak`, phrase, voice: 'espeak', path });
}

// --- scoring ---------------------------------------------------------------------------
// 2 s of faint noise in front (fills the 16-embedding window), 1 s behind.
function pad(samples: Int16Array): Int16Array {
  const out = new Int16Array(32000 + samples.length + 16000);
  for (let i = 0; i < out.length; i++) out[i] = Math.round((Math.random() - 0.5) * 40);
  for (let i = 0; i < samples.length; i++) out[32000 + i] += samples[i];
  return out;
}

const heads = [
  { name: 'hey_jarvis', path: 'models/hey_jarvis_v0.1.onnx' },
  { name: 'alexa', path: 'models/alexa_v0.1.onnx' },
  { name: 'hey_livekit', path: 'models/hey_livekit.onnx' },
];

const table: Record<string, Record<string, string>> = {};
for (const scale of ['int16', 'unit'] as Scale[]) {
  for (const clip of clips) {
    if (!existsSync(clip.path)) { console.log('missing', clip.path); continue; }
    const { sampleRate, samples } = readWav16(readFileSync(clip.path));
    if (sampleRate !== 16000) throw new Error(`${clip.path}: ${sampleRate} Hz`);
    const ww = await WakeWord.create(heads, scale); // fresh state per clip
    const rows = await ww.feed(pad(samples));
    const peak: Record<string, number> = {};
    for (const r of rows) for (const [k, v] of Object.entries(r)) peak[k] = Math.max(peak[k] ?? 0, v);
    table[clip.id] ??= {};
    for (const [k, v] of Object.entries(peak)) table[clip.id][`${k}@${scale}`] = v.toFixed(3);
  }
}
console.table(table);
writeFileSync('out/clip-scores.json', JSON.stringify(table, null, 2));
