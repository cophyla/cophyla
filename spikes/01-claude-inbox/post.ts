// Post a message into a live Claude Code session's inbox from an outside process.
// Runs unchanged under Bun and Node 22:  bun post.ts <session-name> "text" [--no-auth] [--extra '{"k":"v"}']
import { connect } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [name, text, ...flags] = process.argv.slice(2);
const noAuth = flags.includes('--no-auth');
const extraAt = flags.indexOf('--extra');
const extra = extraAt >= 0 ? JSON.parse(flags[extraAt + 1]) : {};
const holdMs = Number(flags[flags.indexOf('--hold') + 1] || 0) || 2500;

const dir = join(homedir(), '.claude', 'sessions');
const files = readdirSync(dir);
const entry = files
  .filter((f) => /^\d+\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  .find((s) => s.name === name);
if (!entry) throw new Error(`no live session named ${name}`);

// Guard rail for the spike: only ever write to sessions the spike itself started.
if (!/^spike-/.test(entry.name)) throw new Error('refusing: not a spike session');

const keyFile = files.find((f) => f.startsWith(`${entry.pid}.`) && f.endsWith('.key'));
const { peerToken } = JSON.parse(readFileSync(join(dir, keyFile!), 'utf8'));

const runtime = typeof (globalThis as any).Bun !== 'undefined' ? `bun ${(globalThis as any).Bun.version}` : `node ${process.version}`;
console.log(`[${runtime}] target pid=${entry.pid} status=${entry.status} pipe=${entry.messagingSocketPath.slice(0, 30)}…`);

const t0 = Date.now();
const sock = connect(entry.messagingSocketPath);
sock.setEncoding('utf8');
sock.on('connect', () => {
  console.log(`connected in ${Date.now() - t0} ms`);
  if (!noAuth) sock.write(JSON.stringify({ type: 'auth', token: peerToken }) + '\n');
  sock.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text }, ...extra }) + '\n');
  setTimeout(() => sock.end(), holdMs);
});
sock.on('data', (d) => console.log('← ' + String(d).trimEnd()));
sock.on('error', (e) => { console.log('socket error:', (e as any).code, e.message); process.exitCode = 1; });
sock.on('close', () => console.log(`closed after ${Date.now() - t0} ms`));
