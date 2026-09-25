// Block until the named spike session's registry status is idle (or timeout).
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const [name, ms = '90000'] = process.argv.slice(2);
const dir = join(homedir(), '.claude', 'sessions');
const end = Date.now() + Number(ms);
const read = () => readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return {}; } }).find((s) => s.name === name);
let last = '';
while (Date.now() < end) {
  const s = read()?.status;
  if (s !== last) { console.log(new Date().toISOString().slice(11, 23), s); last = s; }
  if (s === 'idle') process.exit(0);
  await new Promise((r) => setTimeout(r, 500));
}
console.log('timeout'); process.exit(1);
