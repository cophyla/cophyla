// Step 5: drive the sidecar the way `sidecars` would: spawn server.py with a port, poll /health
// until it answers, then time a streamed request from Bun: first byte, each sentence chunk, total.
//   bun 05-tts-client.ts [--keep] [--affinity=0-15|--affinity=]   (also under node; --keep leaves the server running)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = 8321;
const keep = process.argv.includes('--keep');
const affinity = process.argv.find((a) => a.startsWith('--affinity='))?.slice(11) ?? '0-15';
const runtime = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;
mkdirSync('out/tts', { recursive: true });

const t0 = performance.now();
// Absolute path: with a `cwd`, libuv on Windows resolves a relative executable against that cwd.
const child = spawn(resolve('tts-py/.venv/Scripts/python.exe'), ['server.py', '--port', String(PORT), ...(affinity ? ['--affinity', affinity] : [])], { cwd: 'tts-py', stdio: ['ignore', 'pipe', 'pipe'] });
child.on('error', (e) => { console.log('spawn failed:', e.message); process.exit(1); });
child.stdout.on('data', (d) => process.stdout.write(`  [tts-py] ${d}`));
child.stderr.on('data', (d) => { const s = String(d); if (/error|Traceback/i.test(s)) process.stderr.write(`  [tts-py!] ${s}`); });

// Health poll: the sidecar module's readiness check.
let health: unknown;
for (;;) {
  try { health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json(); break; }
  catch { if (child.exitCode !== null) { console.log('server exited', child.exitCode); process.exit(1); } await new Promise((r) => setTimeout(r, 250)); }
}
const readyMs = Math.round(performance.now() - t0);
console.log(`${runtime}: sidecar healthy after ${readyMs} ms`, health);

// Loopback only: the same port on a LAN address must refuse.
let lanRefused = 'not checked';
try {
  const ifaces = (await import('node:os')).networkInterfaces();
  const lan = Object.values(ifaces).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (lan) { try { await fetch(`http://${lan}:${PORT}/health`, { signal: AbortSignal.timeout(1500) }); lanRefused = `NO: ${lan}:${PORT} answered`; } catch { lanRefused = `yes (${lan}:${PORT} refused)`; } }
} catch { /* no LAN */ }
console.log(`loopback binding holds: ${lanRefused}`);

const texts: Record<string, string> = {
  short: 'Done. The tests pass on all three platforms.',
  medium: 'Three tests failed in the protocol package, all in the fixture round-trip. The schema for voice.speak gained a field that the fixtures do not carry yet. I can add it and rerun, or open a pull request with the change.',
  quote: 'Session claude-2 says: [breath] all forty tests green, ready to merge. That was its last line before it stopped.',
};
const results: Record<string, unknown> = {};
for (const [name, input] of Object.entries(texts)) {
  const t = performance.now();
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input, response_format: 'pcm' }) });
  const sr = Number(res.headers.get('x-sample-rate'));
  const chunks: { atMs: number; bytes: number }[] = [];
  const parts: Uint8Array[] = [];
  const reader = res.body!.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push({ atMs: Math.round(performance.now() - t), bytes: value.length });
    parts.push(value);
  }
  const total = Math.round(performance.now() - t);
  const bytes = parts.reduce((a, p) => a + p.length, 0);
  const audioMs = Math.round((bytes / 2 / sr) * 1000);
  // Chunks may arrive coalesced; the first byte's arrival is what the phone would start playing at.
  const row = { chars: input.length, firstByteMs: chunks[0]?.atMs, totalMs: total, audioMs, rtf: +(total / audioMs).toFixed(3), chunks: chunks.length, sr };
  results[name] = row;
  console.log(name, row);
  const pcm = Buffer.concat(parts.map((p) => Buffer.from(p)));
  writeFileSync(`out/tts/client-${name}.raw`, pcm);
}
// And the whole-clip form, for the doc's "a whole clip at once" comparison.
{
  const t = performance.now();
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: texts.medium, response_format: 'wav' }) });
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync('out/tts/client-medium.wav', buf);
  results['medium-wav'] = { totalMs: Math.round(performance.now() - t), bytes: buf.length };
  console.log('medium-wav', results['medium-wav']);
}
writeFileSync(`out/tts/05-tts-client.${runtime.split(' ')[0]}.json`, JSON.stringify({ runtime, readyMs, health, lanRefused, results }, null, 2));

if (!keep) { child.kill(); console.log('server stopped'); }
else console.log(`server left running on 127.0.0.1:${PORT}, pid ${child.pid}`);
process.exit(0);
