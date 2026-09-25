// Step 4: the TTS output back through the STT. If Nemotron reads Chatterbox's speech back with a
// low WER, the cloned voice is intelligible, without anyone listening. Also a timing check of
// what the controller would hear: 24 kHz audio resampled by sherpa on the way in.
//   bun 04-roundtrip.ts
import { createRecognizer, sherpa, streamClip, wer } from './stt.ts';

const texts: Record<string, string> = {
  short: 'Done. The tests pass on all three platforms.',
  medium: 'Three tests failed in the protocol package, all in the fixture round-trip. The schema for voice.speak gained a field that the fixtures do not carry yet. I can add it and rerun, or open a pull request with the change.',
  paragraph: 'Here is where things stand. The Windows build is green and the installer was rehearsed at version zero point one point two. On Linux the same tree builds under WSL, and the daemon survives a shell restart. The Mac is still pending: it needs a signing identity before the notarized package can be tested. Nothing in the audit log shows a request that bypassed the gate. [chuckle] The only surprise was the wake word firing on the word travis.',
};
const rec = createRecognizer({ numThreads: 2 });
for (const [name, text] of Object.entries(texts)) {
  for (const file of [`out/tts/${name}.cuda.wav`, ...(name === 'paragraph' ? ['out/tts/paragraph-sentences.cuda.wav'] : [])]) {
    const wave = sherpa.readWave(file);
    const r = streamClip(rec, wave.samples, { language: 'en', sampleRate: wave.sampleRate });
    const w = wer(text.replace(/\[[a-z]+\]/g, ''), r.text);
    console.log(`${file} (${wave.sampleRate} Hz, ${(r.audioMs / 1000).toFixed(1)} s): WER ${w.wer} (${w.errors}/${w.words})`);
    console.log(`  ${r.text}`);
  }
}
