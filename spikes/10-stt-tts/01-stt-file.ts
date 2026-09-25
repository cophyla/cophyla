// Step 1: Nemotron 3.5 streaming over files, fed in 80 ms chunks. Prints load time, memory, the
// partials as they changed (how far into the audio, wall clock), real-time factor per clip, WER
// against the synthesized truth, and the shipped multilingual clips with language auto-detect.
//   bun 01-stt-file.ts [threads=2]        (also under node)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRecognizer, MODEL_DIR, rssMB, sherpa, streamClip, wer } from './stt.ts';

const threads = Number(process.argv[2] ?? 2);
const runtime = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;
console.log(`${runtime}, ${threads} thread(s)`);

const rss0 = rssMB();
const t0 = performance.now();
const rec = createRecognizer({ numThreads: threads });
const loadMs = Math.round(performance.now() - t0);
console.log(`model loaded in ${loadMs} ms, rss ${rss0} -> ${rssMB()} MB\n`);

const report: Record<string, unknown> = { runtime, threads, loadMs, rssAfterLoadMB: rssMB(), clips: [] as unknown[] };

// --- synthesized clips with known text -------------------------------------------------
const truth: Record<string, { text: string; language: string }> = existsSync('out/clips/truth.json')
  ? JSON.parse(readFileSync('out/clips/truth.json', 'utf8')) : {};
for (const [id, t] of Object.entries(truth)) {
  const wave = sherpa.readWave(`out/clips/${id}.wav`);
  if (wave.sampleRate !== 16000) throw new Error(`${id}: ${wave.sampleRate} Hz`);
  // Once with the language pinned, once on auto-detect.
  for (const language of [t.language, undefined]) {
    const r = streamClip(rec, wave.samples, { language });
    const w = wer(t.text, r.text);
    console.log(`${id} [${language ?? 'auto'}]  ${r.audioMs} ms audio, ${r.wallMs} ms wall, RTF ${r.rtf}, ${r.decodes} decodes p50 ${r.decodeMs.p50} / p95 ${r.decodeMs.p95} / max ${r.decodeMs.max} ms`);
    console.log(`  ref: ${t.text}`);
    console.log(`  hyp: ${r.text}`);
    console.log(`  WER ${w.wer} (${w.errors}/${w.words}); first partial at ${r.partials[0]?.audioMs ?? '-'} ms of audio; ${r.partials.length} partials`);
    for (const p of r.partials) console.log(`    ${String(p.audioMs).padStart(5)} ms  "${p.text}"`);
    (report.clips as unknown[]).push({ id, language: language ?? 'auto', ...r, wer: w });
  }
}

// --- shipped multilingual clips, auto-detect ---------------------------------------------
console.log('\nshipped test_wavs, auto language:');
for (const f of ['de', 'es', 'fr', 'ar', 'ja', 'ko', 'uk', 'vi', 'zh']) {
  const wave = sherpa.readWave(`${MODEL_DIR}/test_wavs/${f}.wav`);
  const r = streamClip(rec, wave.samples, { sampleRate: wave.sampleRate });
  console.log(`  ${f} (${wave.sampleRate} Hz): RTF ${r.rtf}  "${r.text}"`);
  (report.clips as unknown[]).push({ id: `shipped/${f}`, language: 'auto', text: r.text, rtf: r.rtf, audioMs: r.audioMs, decodeMs: r.decodeMs });
}
report.rssEndMB = rssMB();
console.log(`\nrss at end ${rssMB()} MB`);
writeFileSync(`out/01-stt-file.${threads}t.${runtime.split(' ')[0]}.json`, JSON.stringify(report, null, 2));
