// Read-only: ask our own app-server which hooks are configured and where they come from.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
const CODEX = join(homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
const child = spawn(CODEX, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
const pending = new Map<number, (m: any) => void>(); let id = 1;
createInterface({ input: child.stdout }).on('line', (l) => { try { const m = JSON.parse(l); if (m.id && pending.has(m.id)) pending.get(m.id)!(m); } catch {} });
const call = (method: string, params: unknown) => new Promise<any>((ok) => { const i = id++; pending.set(i, ok); child.stdin.write(JSON.stringify({ id: i, method, params }) + '\n'); });
await call('initialize', { clientInfo: { name: 'cophylaspike', version: '0.0.1' }, capabilities: { experimentalApi: true } });
const r = await call('hooks/list', { cwds: [resolve(import.meta.dir, 'target')] });
console.log(JSON.stringify(r.result ?? r.error, null, 1).slice(0, 1800));
child.kill(); process.exit(0);
