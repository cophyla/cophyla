// Synthesize reference clips with known text: English through the two SAPI voices, Turkish
// through espeak-ng. 16 kHz mono PCM in out/clips/, ground truth in out/clips/truth.json.
//   bun 00-clips.ts
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('out/clips', { recursive: true });

const english: Record<string, string> = {
  en_short: 'What time is the meeting tomorrow afternoon?',
  en_long: 'Start a new session in the orchestrator repository, run the test suite, and tell me which tests fail. If the failures are in the protocol package, open a pull request with a fix.',
  en_names: 'The daemon is called cophylad, the brain is called Cophyla, and the phone app is the controller.',
};
const turkish: Record<string, string> = {
  tr_short: 'Yarın öğleden sonra toplantı saat kaçta?',
  tr_long: 'Yeni bir oturum başlat, testleri çalıştır ve hangi testlerin başarısız olduğunu söyle.',
};

const truth: Record<string, { text: string; language: string; voice: string }> = {};
const toWav16 = (raw: string, out: string) =>
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out]);

for (const [id, text] of Object.entries(english)) {
  for (const voice of ['Microsoft David Desktop', 'Microsoft Zira Desktop']) {
    const tag = voice.split(' ')[1].toLowerCase();
    const raw = `out/clips/${id}.${tag}.raw.wav`;
    const path = `out/clips/${id}.${tag}.wav`;
    if (!existsSync(path)) {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
        `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('${voice}'); $s.SetOutputToWaveFile('${raw}'); $s.Speak('${text.replace(/'/g, "''")}'); $s.Dispose()`], { encoding: 'utf8' });
      if (r.status !== 0) console.log(r.stderr);
      toWav16(raw, path);
    }
    truth[`${id}.${tag}`] = { text, language: 'en', voice: tag };
  }
}
for (const [id, text] of Object.entries(turkish)) {
  const raw = `out/clips/${id}.espeak.raw.wav`;
  const path = `out/clips/${id}.espeak.wav`;
  if (!existsSync(path)) {
    // espeak-ng takes UTF-8 on the command line only through a file on Windows.
    writeFileSync('out/clips/_tmp.txt', text, 'utf8');
    const r = spawnSync('espeak-ng', ['-v', 'tr', '-s', '150', '-w', raw, '-f', 'out/clips/_tmp.txt'], { encoding: 'utf8' });
    if (r.status !== 0) console.log(r.stderr);
    toWav16(raw, path);
  }
  truth[`${id}.espeak`] = { text, language: 'tr', voice: 'espeak' };
}

writeFileSync('out/clips/truth.json', JSON.stringify(truth, null, 2));
console.log(Object.keys(truth).length, 'clips in out/clips');
