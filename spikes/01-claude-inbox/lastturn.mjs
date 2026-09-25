// Print the origin + first line of the last N user turns of a spike session's transcript.
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const [name, n = '3'] = process.argv.slice(2);
const sdir = join(homedir(), '.claude', 'sessions');
const entry = readdirSync(sdir).filter((f) => /^\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(sdir, f), 'utf8'))).find((s) => s.name === name);
const slug = entry.cwd.replace(/[^A-Za-z0-9]/g, '-');
const file = join(homedir(), '.claude', 'projects', slug, `${entry.sessionId}.jsonl`);
const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.type === 'user' || l.type === 'assistant');
for (const l of rows.slice(-Number(n))) {
  const c = l.message?.content;
  const text = typeof c === 'string' ? c : c.map((b) => b.text ?? `[${b.type}]`).join(' ');
  console.log(`${l.type.padEnd(9)} origin=${JSON.stringify(l.origin ?? null)} mode=${l.permissionMode ?? ''} :: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
}
console.log(`registry status=${entry.status}`);
