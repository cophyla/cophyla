// Shared: both kinds of classifier over one microphone stream, and the default microphone.
// Reuses the streaming pipeline from spike 04 unchanged; two instances because openWakeWord heads
// take int16-range audio and the livekit head takes -1..1.
import { createRequire } from 'node:module';
import { WakeWord } from '../04-voice/wakeword.ts';

const require = createRequire(import.meta.url);
const { PvRecorder } = require('@picovoice/pvrecorder-node');

const MODELS = '../04-voice/models';

export async function createHeads() {
  const oww = await WakeWord.create([
    { name: 'hey_jarvis', path: `${MODELS}/hey_jarvis_v0.1.onnx` },
    { name: 'alexa', path: `${MODELS}/alexa_v0.1.onnx` },
  ], 'int16', MODELS);
  const lk = await WakeWord.create([{ name: 'hey_livekit', path: `${MODELS}/hey_livekit.onnx` }], 'unit', MODELS);
  return {
    names: ['hey_jarvis', 'alexa', 'hey_livekit'],
    // One merged score row per 80 ms chunk.
    async feed(samples: Int16Array): Promise<Record<string, number>[]> {
      const [a, b] = await Promise.all([oww.feed(samples), lk.feed(samples)]);
      return a.map((row, i) => ({ ...row, ...(b[i] ?? { hey_livekit: 0 }) }));
    },
  };
}

/** Default microphone at 16 kHz mono, 80 ms frames, through a callback. */
export function openMic(frameLength = 1280) {
  const mic = new PvRecorder(frameLength, -1);
  mic.start();
  return {
    device: mic.getSelectedDevice() as string,
    read: () => mic.read() as Promise<Int16Array>,
    close() { mic.stop(); mic.release(); },
  };
}

export function rms(s: Int16Array) {
  let acc = 0;
  for (let i = 0; i < s.length; i++) acc += s[i] * s[i];
  return Math.sqrt(acc / s.length);
}

export function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
