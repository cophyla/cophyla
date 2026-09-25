// Shared: the Nemotron 3.5 streaming recognizer through sherpa-onnx-node, and a feeder that
// pushes audio in controller-sized chunks and records when each partial changed.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const sherpa = require('sherpa-onnx-node');

// Paths hang off this file, not the working directory: spike 12 imports this from its own folder.
export const HERE = dirname(fileURLToPath(import.meta.url));
export const MODEL_DIR = join(HERE, 'models/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11');
export const VAD_MODEL = join(HERE, 'models/silero_vad.onnx');
const NOSPIN = join(HERE, 'models/ort-nospin.cfg');
export const SAMPLE_RATE = 16000;

export type Recognizer = {
  createStream(): Stream;
  isReady(s: Stream): boolean;
  decode(s: Stream): void;
  isEndpoint(s: Stream): boolean;
  reset(s: Stream): void;
  getResult(s: Stream): { text: string; tokens: string[]; timestamps: number[] };
};
export type Stream = {
  acceptWaveform(o: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(): void;
  setOption(k: string, v: string): void;
};

/** `spin: false` hands ORT a config file that turns off the thread pool's busy-wait, which otherwise
 *  costs a full core per extra thread while the stream idles between chunks. */
export function createRecognizer(opts: { numThreads?: number; endpoint?: boolean; debug?: boolean; spin?: boolean } = {}): Recognizer {
  return new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 128 },
    modelConfig: {
      transducer: {
        encoder: `${MODEL_DIR}/encoder.int8.onnx`,
        decoder: `${MODEL_DIR}/decoder.int8.onnx`,
        joiner: `${MODEL_DIR}/joiner.int8.onnx`,
      },
      tokens: `${MODEL_DIR}/tokens.txt`,
      numThreads: opts.numThreads ?? 2,
      provider: opts.spin ? 'cpu' : `cpu:${NOSPIN}`,
      debug: opts.debug ? 1 : 0,
    },
    decodingMethod: 'greedy_search',
    // sherpa's own endpoint rules, as an alternative to Silero.
    enableEndpoint: opts.endpoint ? 1 : 0,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
  });
}

export type Partial = { audioMs: number; wallMs: number; decodeMs: number; text: string };

/** Feed a whole clip in `chunkMs` steps, decoding whenever the model has enough. Returns every
 *  point where the text changed, with the audio position (how much the "user" had spoken) and the
 *  wall clock, plus the time each decode call took. */
export function streamClip(
  rec: Recognizer,
  samples: Float32Array,
  opts: { chunkMs?: number; language?: string; tailMs?: number; sampleRate?: number } = {},
) {
  // Audio at another rate is passed through as is: sherpa resamples to the model's 16 kHz.
  const sr = opts.sampleRate ?? SAMPLE_RATE;
  const chunk = Math.round(sr * ((opts.chunkMs ?? 80) / 1000));
  const stream = rec.createStream();
  if (opts.language) stream.setOption('language', opts.language);
  const partials: Partial[] = [];
  const decodeTimes: number[] = [];
  let last = '';
  const t0 = performance.now();
  let fed = 0;
  const pump = (audioMs: number) => {
    while (rec.isReady(stream)) {
      const d0 = performance.now();
      rec.decode(stream);
      decodeTimes.push(performance.now() - d0);
      const text = rec.getResult(stream).text;
      if (text !== last) {
        partials.push({ audioMs, wallMs: +(performance.now() - t0).toFixed(1), decodeMs: +decodeTimes.at(-1)!.toFixed(1), text });
        last = text;
      }
    }
  };
  for (let i = 0; i < samples.length; i += chunk) {
    stream.acceptWaveform({ samples: samples.subarray(i, Math.min(i + chunk, samples.length)), sampleRate: sr });
    fed = Math.min(i + chunk, samples.length);
    pump(Math.round((fed / sr) * 1000));
  }
  const tail = new Float32Array(Math.round(sr * ((opts.tailMs ?? 600) / 1000)));
  stream.acceptWaveform({ samples: tail, sampleRate: sr });
  stream.inputFinished();
  pump(Math.round((samples.length / sr) * 1000));
  const wallMs = performance.now() - t0;
  const audioMs = (samples.length / sr) * 1000;
  return {
    text: last,
    partials,
    audioMs: Math.round(audioMs),
    wallMs: +wallMs.toFixed(1),
    rtf: +(wallMs / audioMs).toFixed(4),
    decodes: decodeTimes.length,
    decodeMs: pct(decodeTimes),
  };
}

export function pct(xs: number[]) {
  if (!xs.length) return { p50: 0, p95: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1);
  return { p50: q(0.5), p95: q(0.95), max: +s.at(-1)!.toFixed(1) };
}

/** Word error rate: Levenshtein over lowercased words with punctuation stripped. */
export function wer(ref: string, hyp: string) {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);
  const r = norm(ref), h = norm(hyp);
  const d: number[][] = Array.from({ length: r.length + 1 }, (_, i) => [i, ...new Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return { errors: d[r.length][h.length], words: r.length, wer: r.length ? +(d[r.length][h.length] / r.length).toFixed(3) : 0 };
}

export function int16ToFloat(s: Int16Array) {
  const f = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) f[i] = s[i] / 32768;
  return f;
}

/** Silero VAD as the utterance boundary, 512-sample (32 ms) windows. */
export function createVad(opts: { minSilence?: number } = {}) {
  return new sherpa.Vad({
    sileroVad: { model: VAD_MODEL, threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: opts.minSilence ?? 0.6, windowSize: 512, maxSpeechDuration: 30 },
    sampleRate: SAMPLE_RATE, numThreads: 1, debug: 0,
  }, 60);
}

export function rssMB() {
  return Math.round(process.memoryUsage().rss / 2 ** 20);
}
