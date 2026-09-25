// Step 5: capture ~5 s from the microphone by four routes and report whether the samples are real.
//   bun 05-capture.ts winmm        bun:ffi -> winmm.dll, default device           (Bun only)
//   bun 05-capture.ts pvrecorder   @picovoice/pvrecorder-node native addon, default device
//   bun 05-capture.ts audify       audify (RtAudio/WASAPI) native addon, default device
//   bun 05-capture.ts ffmpeg ["Device name"]   ffmpeg child process, DirectShow, s16le on stdout
// The native-addon and ffmpeg routes also run under node.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { rms, writeWav16 } from './wakeword.ts';

const require = createRequire(import.meta.url);
const route = process.argv[2] ?? 'winmm';
const SECONDS = 5;
const WANT = 16000 * SECONDS;
const runtime = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;
mkdirSync('out', { recursive: true });

const parts: Int16Array[] = [];
let got = 0;
let firstChunkMs = -1;
const t0 = performance.now();
const push = (s: Int16Array) => {
  if (firstChunkMs < 0) firstChunkMs = performance.now() - t0;
  parts.push(s);
  got += s.length;
};
const until = (done: () => boolean, timeoutMs: number) =>
  new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (done() || performance.now() - t0 > timeoutMs) { clearInterval(t); resolve(); }
    }, 20);
  });

let detail: Record<string, unknown> = {};

if (route === 'winmm') {
  const { listDevices, startCapture } = await import('./capture-winmm.ts');
  detail.devices = listDevices();
  const cap = startCapture(push);
  await until(() => got >= WANT, 8000);
  cap.stop();
  detail.overruns = cap.overruns;
} else if (route === 'pvrecorder') {
  const { PvRecorder } = require('@picovoice/pvrecorder-node');
  detail.devices = PvRecorder.getAvailableDevices();
  const rec = new PvRecorder(1280, -1); // frame length, -1 = default device
  rec.start();
  detail.selected = rec.getSelectedDevice();
  while (got < WANT && performance.now() - t0 < 8000) push(Int16Array.from(await rec.read()));
  rec.stop();
  rec.release();
} else if (route === 'audify') {
  const { RtAudio, RtAudioFormat, RtAudioApi } = require('audify');
  const rt = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
  const id = rt.getDefaultInputDevice();
  const dev = rt.getDevices().find((d: any) => d.id === id) ?? rt.getDevices()[id];
  detail.selected = dev?.name;
  detail.nativeRates = dev?.sampleRates;
  rt.openStream(null, { deviceId: id, nChannels: 1, firstChannel: 0 }, RtAudioFormat.RTAUDIO_SINT16, 16000, 1280,
    'cophyla-spike', (pcm: Buffer) => push(new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))), null);
  rt.start();
  await until(() => got >= WANT, 8000);
  rt.stop();
  rt.closeStream();
} else if (route === 'ffmpeg') {
  let name = process.argv[3];
  if (!name) {
    const list = spawnSync('ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8' }).stderr;
    name = [...list.matchAll(/"([^"]+)" \(audio\)/g)].map((m) => m[1])[0];
  }
  detail.selected = name;
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-audio_buffer_size', '50',
    '-i', `audio=${name}`, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let carry = Buffer.alloc(0);
  ff.stdout.on('data', (d: Buffer) => {
    const b = Buffer.concat([carry, d]);
    const even = b.length - (b.length % 2);
    push(new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + even)));
    carry = b.subarray(even);
  });
  let err = '';
  ff.stderr.on('data', (d) => { err += d; });
  await until(() => got >= WANT, 10000);
  ff.kill();
  if (err) detail.stderr = err.trim().slice(0, 300);
} else {
  throw new Error(`unknown route ${route}`);
}

const wall = (performance.now() - t0) / 1000;
const all = new Int16Array(got);
let o = 0;
for (const p of parts) { all.set(p, o); o += p.length; }
let peak = 0;
for (let i = 0; i < all.length; i++) peak = Math.max(peak, Math.abs(all[i]));
writeFileSync(`out/cap-${route}.wav`, writeWav16(all));

console.log(JSON.stringify({
  route, runtime, samples: got, seconds: +(got / 16000).toFixed(2), wallSeconds: +wall.toFixed(2),
  firstChunkMs: +firstChunkMs.toFixed(0), chunks: parts.length,
  rms: +rms(all).toFixed(1), peak, allZero: peak === 0, ...detail,
}, null, 2));
process.exit(0); // native addons may hold the event loop open
