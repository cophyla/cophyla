// Spike 12: a phone browser's microphone as the controller's. HTTPS + WSS on the LAN with a
// self-signed certificate; the page streams 16 kHz mono int16 over the socket, and this process
// runs the node side of the voice pipeline over that stream: wake word -> VAD -> streaming STT,
// then the reply as speech back over the same socket from the tts-py sidecar of spike 10.
//   bun server.ts [--tts] [--port 8443]
// Open https://<LAN ip>:8443/ on the phone, accept the certificate warning, tap Start.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { WakeWord } from '../04-voice/wakeword.ts';
import { createRecognizer, createVad, int16ToFloat, type Recognizer, type Stream } from '../10-stt-tts/stt.ts';

const PORT = process.argv.includes('--port') ? Number(process.argv[process.argv.indexOf('--port') + 1]) : 8443;
const WANT_TTS = process.argv.includes('--tts');
const TTS_PORT = 8321;
mkdirSync('out', { recursive: true });
const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal && i.address.startsWith('192.'))?.address ?? '0.0.0.0';

// --- engines, shared by every connection (one phone at a time in this spike) ------------------
const MODELS = '../04-voice/models';
const oww = await WakeWord.create([{ name: 'hey_jarvis', path: `${MODELS}/hey_jarvis_v0.1.onnx` }], 'int16', MODELS);
const lk = await WakeWord.create([{ name: 'hey_livekit', path: `${MODELS}/hey_livekit.onnx` }], 'unit', MODELS);
const rec: Recognizer = createRecognizer({ numThreads: 2 });
const vad = createVad({ minSilence: 0.7 });
console.log('engines loaded');

// --- the TTS sidecar, optional -----------------------------------------------------------------
let tts = false;
if (WANT_TTS) {
  const py = resolve('../10-stt-tts/tts-py/.venv/Scripts/python.exe');
  const child = spawn(py, ['server.py', '--port', String(TTS_PORT), '--affinity', '0-15'], { cwd: resolve('../10-stt-tts/tts-py'), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write(`  [tts-py] ${d}`));
  child.stderr.on('data', (d) => { const s = String(d); if (/error|Traceback/i.test(s)) process.stderr.write(`  [tts-py!] ${s}`); });
  process.on('exit', () => child.kill());
  (async () => {
    for (;;) { try { await fetch(`http://127.0.0.1:${TTS_PORT}/health`); tts = true; console.log('tts-py ready'); return; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  })();
}

async function speak(text: string, send: (pcm: Uint8Array) => void, onDone: () => void) {
  if (!tts) { onDone(); return; }
  const res = await fetch(`http://127.0.0.1:${TTS_PORT}/v1/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: text, response_format: 'pcm' }) });
  const reader = res.body!.getReader();
  for (;;) { const { value, done } = await reader.read(); if (done) break; send(value); }
  onDone();
}

// --- per-connection state ------------------------------------------------------------------
type State = 'idle' | 'listening' | 'thinking' | 'speaking';
type Conn = {
  id: number; state: State; always: boolean; ptt: boolean;
  stream: Stream; last: string; pending: Int16Array;
  // stats for the last second
  samples: number; chunks: number; bytes: number; lastChunkAt: number; maxGapMs: number; peak: number; sumSq: number; n: number;
  wakePeak: Record<string, number>; decodeMs: number[]; firstChunkAt: number; totalSamples: number; totalChunks: number; hello?: unknown;
  ticker: ReturnType<typeof setInterval>; utteranceStartedAt: number;
};
let nextId = 1;
const log = (line: string) => { const s = `${new Date().toISOString().slice(11, 19)} ${line}`; console.log(s); appendFileSync('out/server.log', s + '\n'); };

function setState(ws: Bun.ServerWebSocket<Conn>, state: State) {
  ws.data.state = state;
  ws.send(JSON.stringify({ type: 'state', state }));
}

function finalize(ws: Bun.ServerWebSocket<Conn>, why: string) {
  const c = ws.data;
  while (rec.isReady(c.stream)) rec.decode(c.stream);
  const text = rec.getResult(c.stream).text.trim();
  const speechMs = Math.round(performance.now() - c.utteranceStartedAt);
  log(`#${c.id} final (${why}, ${speechMs} ms): "${text}"`);
  ws.send(JSON.stringify({ type: 'transcript', text, final: true, why }));
  rec.reset(c.stream);
  c.last = '';
  vad.reset();
  if (!text) { setState(ws, c.always ? 'listening' : 'idle'); return; }
  setState(ws, 'thinking');
  const reply = `You said: ${text}`;
  ws.send(JSON.stringify({ type: 'say', text: reply }));
  if (tts) {
    setState(ws, 'speaking');
    const t = performance.now();
    let first = 0; let bytes = 0;
    speak(reply, (pcm) => { if (!first) first = Math.round(performance.now() - t); bytes += pcm.length; ws.send(pcm); }, () => {
      log(`#${c.id} spoke ${Math.round(bytes / 2 / 24)} ms of audio, first chunk after ${first} ms, all sent after ${Math.round(performance.now() - t)} ms`);
      ws.send(JSON.stringify({ type: 'spoken', firstChunkMs: first, audioMs: Math.round(bytes / 2 / 24) }));
      setState(ws, c.always ? 'listening' : 'idle');
    });
  } else setState(ws, c.always ? 'listening' : 'idle');
}

async function onAudio(ws: Bun.ServerWebSocket<Conn>, buf: Uint8Array) {
  const c = ws.data;
  const now = performance.now();
  if (c.lastChunkAt) c.maxGapMs = Math.max(c.maxGapMs, now - c.lastChunkAt);
  c.lastChunkAt = now;
  if (!c.firstChunkAt) c.firstChunkAt = now;
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
  c.samples += pcm.length; c.chunks++; c.bytes += buf.byteLength; c.totalSamples += pcm.length; c.totalChunks++;
  for (let i = 0; i < pcm.length; i++) { const v = pcm[i]; c.sumSq += v * v; c.n++; if (Math.abs(v) > c.peak) c.peak = Math.abs(v); }

  // Wake word over everything, in 80 ms chunks (the pipeline batches internally).
  const [a, b] = await Promise.all([oww.feed(pcm), lk.feed(pcm)]);
  for (let i = 0; i < a.length; i++) {
    const row = { ...a[i], ...(b[i] ?? {}) };
    for (const [head, score] of Object.entries(row)) {
      c.wakePeak[head] = Math.max(c.wakePeak[head] ?? 0, score);
      if (score >= 0.5 && c.state === 'idle') {
        log(`#${c.id} wake ${head} ${score.toFixed(3)}`);
        ws.send(JSON.stringify({ type: 'wake', head, score: +score.toFixed(3) }));
        rec.reset(c.stream); c.last = ''; vad.reset();
        c.utteranceStartedAt = performance.now();
        setState(ws, 'listening');
      }
    }
  }
  if (c.state !== 'listening') return;

  // Transcribe: VAD and the recognizer share the stream; VAD wants 512-sample windows.
  const f = int16ToFloat(pcm);
  c.stream.acceptWaveform({ samples: f, sampleRate: 16000 });
  const joined = new Float32Array(c.pending.length + pcm.length); joined.set(int16ToFloat(c.pending)); joined.set(f, c.pending.length);
  let off = 0;
  for (; off + 512 <= joined.length; off += 512) vad.acceptWaveform(joined.subarray(off, off + 512));
  c.pending = pcm.slice(pcm.length - (joined.length - off));
  while (rec.isReady(c.stream)) {
    const d0 = performance.now(); rec.decode(c.stream); c.decodeMs.push(performance.now() - d0);
    const text = rec.getResult(c.stream).text;
    if (text !== c.last) { c.last = text; ws.send(JSON.stringify({ type: 'transcript', text, final: false })); }
  }
  if (!vad.isEmpty()) { while (!vad.isEmpty()) vad.pop(); if (!c.ptt) finalize(ws, 'vad'); }
}

const server = Bun.serve<Conn>({
  hostname: '0.0.0.0',
  port: PORT,
  tls: { key: readFileSync('out/key.pem'), cert: readFileSync('out/cert.pem') },
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const id = nextId++;
      const ok = srv.upgrade(req, { data: { id, state: 'idle', always: false, ptt: false, stream: rec.createStream(), last: '', pending: new Int16Array(0), samples: 0, chunks: 0, bytes: 0, lastChunkAt: 0, maxGapMs: 0, peak: 0, sumSq: 0, n: 0, wakePeak: {}, decodeMs: [], firstChunkAt: 0, totalSamples: 0, totalChunks: 0, ticker: 0 as never, utteranceStartedAt: 0 } });
      return ok ? undefined : new Response('upgrade failed', { status: 400 });
    }
    if (url.pathname === '/worklet.js') return new Response(readFileSync(join(import.meta.dir, 'worklet.js')), { headers: { 'content-type': 'text/javascript' } });
    return new Response(readFileSync(join(import.meta.dir, 'page.html')), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
  websocket: {
    open(ws) {
      const c = ws.data;
      log(`#${c.id} connected from ${ws.remoteAddress}`);
      ws.send(JSON.stringify({ type: 'hello', tts, heads: ['hey_jarvis', 'hey_livekit'] }));
      c.ticker = setInterval(() => {
        const stats = {
          type: 'stats', state: c.state, samplesPerSecond: c.samples, chunksPerSecond: c.chunks, bytesPerSecond: c.bytes, maxGapMs: Math.round(c.maxGapMs),
          rms: Math.round(Math.sqrt(c.sumSq / Math.max(1, c.n))), peak: c.peak, wakePeak: Object.fromEntries(Object.entries(c.wakePeak).map(([k, v]) => [k, +v.toFixed(3)])),
          decodeP50Ms: c.decodeMs.length ? Math.round([...c.decodeMs].sort((a, b) => a - b)[c.decodeMs.length >> 1]) : null, tts,
        };
        if (c.samples) appendFileSync('out/stats.jsonl', JSON.stringify({ at: new Date().toISOString(), id: c.id, ...stats }) + '\n');
        ws.send(JSON.stringify(stats));
        c.samples = 0; c.chunks = 0; c.bytes = 0; c.maxGapMs = 0; c.peak = 0; c.sumSq = 0; c.n = 0; c.wakePeak = {}; c.decodeMs = [];
      }, 1000);
    },
    message(ws, msg) {
      const c = ws.data;
      if (typeof msg === 'string') {
        const m = JSON.parse(msg);
        if (m.type === 'hello') { c.hello = m; log(`#${c.id} hello ${JSON.stringify(m)}`); writeFileSync(`out/hello-${c.id}.json`, JSON.stringify(m, null, 2)); }
        else if (m.type === 'ptt') {
          c.ptt = m.active;
          if (m.active && c.state !== 'listening') { rec.reset(c.stream); c.last = ''; vad.reset(); c.utteranceStartedAt = performance.now(); setState(ws, 'listening'); log(`#${c.id} ptt down`); }
          else if (!m.active && c.state === 'listening') { log(`#${c.id} ptt up`); finalize(ws, 'ptt'); }
        }
        else if (m.type === 'always') { c.always = m.on; if (m.on && c.state === 'idle') { rec.reset(c.stream); c.last = ''; vad.reset(); c.utteranceStartedAt = performance.now(); setState(ws, 'listening'); } else if (!m.on && c.state === 'listening' && !c.ptt) setState(ws, 'idle'); log(`#${c.id} always=${m.on}`); }
        else if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: m.t }));
        else if (m.type === 'note') log(`#${c.id} note: ${m.text}`);
        return;
      }
      onAudio(ws, msg as unknown as Uint8Array).catch((e) => log(`#${c.id} audio error ${e}`));
    },
    close(ws) {
      const c = ws.data;
      clearInterval(c.ticker);
      log(`#${c.id} closed after ${c.totalChunks} chunks, ${(c.totalSamples / 16000).toFixed(1)} s of audio`);
    },
  },
});
console.log(`\n  open  https://${lan}:${PORT}/  on the phone (accept the certificate warning)\n  tts sidecar: ${WANT_TTS ? 'starting' : 'off (--tts to enable)'}\n`);
