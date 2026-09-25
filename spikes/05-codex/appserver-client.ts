// Speak the Codex app-server protocol from Bun: spawn our own `codex app-server` on stdio
// (there is no shared daemon or control socket on Windows), then list threads and queue a
// message into a thread that is live in ANOTHER process (the user's TUI).
//
//   bun appserver-client.ts <threadId> [message]
//
// Wire format: newline-delimited JSON-RPC 2.0 (the "jsonrpc" field is optional on this server).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const CODEX = join(homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
const [threadId, message] = process.argv.slice(2);
if (!threadId) { console.error('usage: bun appserver-client.ts <threadId> [message]'); process.exit(2); }

const t0 = Date.now();
const ms = () => `+${Date.now() - t0}ms`;
const child = spawn(CODEX, ['app-server', '--stdio', '-c', 'check_for_update_on_startup=false'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => process.stderr.write(`[app-server stderr] ${String(d).slice(0, 300)}\n`));

let nextId = 1;
const pending = new Map<number, (m: any) => void>();
const notifications: any[] = [];
createInterface({ input: child.stdout }).on('line', (line) => {
  let m: any; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
  if (m.method) { notifications.push(m); console.log(ms(), 'notif', m.method, JSON.stringify(m.params ?? {}).slice(0, 160)); }
});

function call(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 30_000);
    pending.set(id, (m) => { clearTimeout(timer); m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const notify = (method: string, params?: unknown) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

try {
  const init = await call('initialize', {
    clientInfo: { name: 'cophylaspike', title: 'cophyla spike', version: '0.0.1' },
    capabilities: { experimentalApi: !process.env.NO_EXP }, // thread/queue/* is rejected without this (NO_EXP=1 proves it)
  });
  console.log(ms(), 'initialize ->', JSON.stringify(init).slice(0, 300));
  notify('initialized');

  // Without experimentalApi the queue methods should be refused; prove the gate exists later
  // with a second process if needed. Here: list, read, queue.
  const list = await call('thread/list', { limit: 5, cwd: undefined });
  console.log(ms(), `thread/list -> ${list.data.length} rows (first page); spike thread present:`,
    list.data.some((t: any) => t.id === threadId));
  const mine = list.data.find((t: any) => t.id === threadId);
  if (mine) console.log(ms(), 'thread row:', JSON.stringify({ id: mine.id, cwd: mine.cwd, status: mine.status, source: mine.source, threadSource: mine.threadSource, name: mine.name, path: mine.path, canAcceptDirectInput: mine.canAcceptDirectInput, model: mine.model }));

  const loaded = await call('thread/loaded/list', {});
  console.log(ms(), 'thread/loaded/list (threads loaded in OUR app-server) ->', JSON.stringify(loaded.data));

  const read = await call('thread/read', { threadId, includeTurns: false });
  console.log(ms(), 'thread/read status:', JSON.stringify(read.thread?.status), 'turns:', read.thread?.turns?.length);

  if (process.env.NO_EXP) console.log(ms(), 'thread/queue/list without experimentalApi ->', await call('thread/queue/list', { threadId }).catch((e) => String(e)));

  if (message) {
    const clientUserMessageId = `cophyla-${randomUUID()}`;
    const added = await call('thread/queue/add', { threadId, clientUserMessageId, input: [{ type: 'text', text: message }] });
    console.log(ms(), 'thread/queue/add ->', JSON.stringify(added), 'at', new Date().toISOString());
    const q = await call('thread/queue/list', { threadId });
    console.log(ms(), 'thread/queue/list ->', JSON.stringify(q).slice(0, 400));
  }
} catch (e) {
  console.error(ms(), 'ERROR', String(e));
} finally {
  child.stdin.end();
  setTimeout(() => { child.kill(); process.exit(0); }, 1500);
}
