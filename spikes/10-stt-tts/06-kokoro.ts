// Step 6: Kokoro 82M through sherpa-onnx-node, in-process on the CPU, as the fallback for a machine
// with no GPU. Load time, RTF per sentence, and time to first chunk through the streaming callback.
//   bun 06-kokoro.ts [threads=2]     (also under node)
import { mkdirSync, writeFileSync } from 'node:fs';
import { pct, rssMB, sherpa } from './stt.ts';

const threads = Number(process.argv[2] ?? 2);
const runtime = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;
mkdirSync('out/tts', { recursive: true });
const rss0 = rssMB();
const t0 = performance.now();
const tts = new sherpa.OfflineTts({
  model: {
    kokoro: { model: 'models/kokoro-en-v0_19/model.onnx', voices: 'models/kokoro-en-v0_19/voices.bin', tokens: 'models/kokoro-en-v0_19/tokens.txt', dataDir: 'models/kokoro-en-v0_19/espeak-ng-data' },
    numThreads: threads, provider: 'cpu:models/ort-nospin.cfg', debug: 0,
  },
  maxNumSentences: 1,
});
const loadMs = Math.round(performance.now() - t0);
console.log(`${runtime}, ${threads} thread(s): Kokoro loaded in ${loadMs} ms, ${tts.numSpeakers} voices, ${tts.sampleRate} Hz, rss ${rss0} -> ${rssMB()} MB`);

const texts: Record<string, string> = {
  short: 'Done. The tests pass on all three platforms.',
  medium: 'Three tests failed in the protocol package, all in the fixture round-trip. The schema for voice.speak gained a field that the fixtures do not carry yet. I can add it and rerun, or open a pull request with the change.',
  paragraph: 'Here is where things stand. The Windows build is green and the installer was rehearsed at version zero point one point two. On Linux the same tree builds under WSL, and the daemon survives a shell restart. The Mac is still pending: it needs a signing identity before the notarized package can be tested. Nothing in the audit log shows a request that bypassed the gate. The only surprise was the wake word firing on the word travis.',
};
const report: Record<string, unknown> = { runtime, threads, loadMs };
const cpu0 = process.cpuUsage();
const tAll = performance.now();
for (const [name, text] of Object.entries(texts)) {
  // Synchronous whole-text generation.
  const t = performance.now();
  const audio = tts.generate({ text, generationConfig: new sherpa.GenerationConfig({ sid: 0, speed: 1.0 }) });
  const wall = performance.now() - t;
  const audioMs = (audio.samples.length / audio.sampleRate) * 1000;
  sherpa.writeWave(`out/tts/kokoro-${name}.wav`, { samples: audio.samples, sampleRate: audio.sampleRate });
  // Streaming: sherpa calls back per sentence; the first callback is the time to first audio.
  const chunks: number[] = [];
  const t2 = performance.now();
  await tts.generateAsync({ text, generationConfig: new sherpa.GenerationConfig({ sid: 0, speed: 1.0 }), onProgress: () => { chunks.push(Math.round(performance.now() - t2)); return true; } });
  const row = { chars: text.length, wallMs: Math.round(wall), audioMs: Math.round(audioMs), rtf: +(wall / audioMs).toFixed(3), streamed: { firstChunkMs: chunks[0], chunks: chunks.length, totalMs: Math.round(performance.now() - t2) } };
  report[name] = row;
  console.log(name, row);
}
const wallAll = (performance.now() - tAll) / 1000;
const cpu = process.cpuUsage(cpu0);
report.cpuCoresWhileGenerating = +(((cpu.user + cpu.system) / 1e6) / wallAll).toFixed(2);
report.rssEndMB = rssMB();
console.log(`cores busy while generating: ${report.cpuCoresWhileGenerating}, rss ${rssMB()} MB`);
writeFileSync(`out/tts/06-kokoro.${runtime.split(' ')[0]}.json`, JSON.stringify(report, null, 2));
