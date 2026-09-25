// Step 1: a stand-in for the phone. Connects over WSS (self-signed accepted), sends a hello, then
// streams clips at real time in 40 ms int16 chunks: silence, "hey jarvis", a question, silence.
// Prints every message back: wake, partials, final, say, and how much speech audio arrived.
//   bun 01-fake-phone.ts [host=127.0.0.1] [--ptt]     (server.ts must be running)
import { readFileSync, writeFileSync } from 'node:fs';
import { readWav16 } from '../04-voice/wakeword.ts';

const host = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '127.0.0.1';
const usePtt = process.argv.includes('--ptt');
const wav = (p: string) => readWav16(readFileSync(p)).samples;
const silence = (s: number) => new Int16Array(16000 * s);
const script: { name: string; samples: Int16Array }[] = [
  { name: 'silence 2.5 s', samples: silence(2.5) },
  ...(usePtt ? [] : [{ name: 'hey jarvis (edge-jenny)', samples: wav('../11-wake-room/out/hey_jarvis.edge-jenny.wav') }]),
  { name: 'pause 0.4 s', samples: silence(0.4) },
  { name: 'question (edge-guy)', samples: wav('../10-stt-tts/out/clips/en_short.zira.wav') },
  { name: 'silence 3 s', samples: silence(3) },
];

const t0 = performance.now();
const stamp = () => `${((performance.now() - t0) / 1000).toFixed(2).padStart(6)} s`;
const ws = new WebSocket(`wss://${host}:8443/ws`, { tls: { rejectUnauthorized: false } } as never);
ws.binaryType = 'arraybuffer';
let spokenBytes = 0; let firstSpokenAt = 0; let done = false;
const events: unknown[] = [];
ws.onmessage = (ev) => {
  if (typeof ev.data !== 'string') { spokenBytes += ev.data.byteLength; if (!firstSpokenAt) { firstSpokenAt = performance.now(); console.log(`${stamp()}  <- first speech audio chunk (${ev.data.byteLength} bytes)`); } return; }
  const m = JSON.parse(ev.data);
  if (m.type === 'stats') return;
  events.push({ t: +((performance.now() - t0) / 1000).toFixed(2), ...m });
  console.log(`${stamp()}  <- ${m.type} ${m.type === 'transcript' ? (m.final ? `FINAL(${m.why}) "${m.text}"` : `"${m.text}"`) : JSON.stringify({ ...m, type: undefined })}`);
  if (m.type === 'state' && m.state === 'idle' && spokenBytes) done = true;
};
await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = (e) => j(e); });
console.log(`${stamp()}  connected`);
ws.send(JSON.stringify({ type: 'hello', ua: 'fake-phone (bun)', isSecureContext: true, contextSampleRate: 16000 }));

const CHUNK = 640; // 40 ms
for (const part of script) {
  console.log(`${stamp()}  -> ${part.name}`);
  if (usePtt && part.name.startsWith('question')) ws.send(JSON.stringify({ type: 'ptt', active: true }));
  for (let i = 0; i < part.samples.length; i += CHUNK) {
    const chunk = part.samples.subarray(i, Math.min(i + CHUNK, part.samples.length));
    ws.send(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    await new Promise((r) => setTimeout(r, 40));
  }
  if (usePtt && part.name.startsWith('question')) ws.send(JSON.stringify({ type: 'ptt', active: false }));
}
const waitUntil = performance.now() + 15000;
while (!done && performance.now() < waitUntil) await new Promise((r) => setTimeout(r, 100));
console.log(`${stamp()}  speech audio received: ${spokenBytes} bytes = ${Math.round(spokenBytes / 2 / 24)} ms at 24 kHz`);
writeFileSync('out/01-fake-phone.json', JSON.stringify({ usePtt, events, spokenBytes }, null, 2));
ws.close();
process.exit(0);
