// The shared-app-server layout (what cophylad gets for threads it spawns itself, and what the
// Unix daemon looks like): ONE app-server process hosting TWO threads. Question: is the MCP
// shim spawned once per app-server or once per thread, and what identifies the calling thread?
//
//   bun appserver-two-threads.ts
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const CODEX = join(homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
const here = import.meta.dir;
const cwd = resolve(here, 'target');
const shim = resolve(here, 'whoami-mcp.mjs').replaceAll('\\', '/');

const child = spawn(CODEX, [
  'app-server', '--stdio',
  '-c', 'check_for_update_on_startup=false',
  '-c', 'projects.c:\\d\\orchestrator.trust_level="trusted"',
  '-c', 'mcp_servers.cophylaspike.command="node"',
  '-c', `mcp_servers.cophylaspike.args=["${shim}"]`,
], { stdio: ['pipe', 'pipe', 'pipe'], cwd });
child.stderr.on('data', (d) => process.stderr.write(`[stderr] ${String(d).slice(0, 200)}\n`));
console.log('app-server pid', child.pid);

const t0 = Date.now();
const ms = () => `+${Date.now() - t0}ms`;
let nextId = 1;
const pending = new Map<number, (m: any) => void>();
const turnDone = new Map<string, () => void>();

createInterface({ input: child.stdout }).on('line', (line) => {
  let m: any; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && !m.method && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
  if (m.method && m.id !== undefined) {
    // Server -> client request (an approval). Log it and decline so nothing runs unattended.
    console.log(ms(), 'SERVER REQUEST', m.method, JSON.stringify(m.params).slice(0, 300));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { decision: 'decline' } }) + '\n');
    return;
  }
  if (m.method === 'item/started' || m.method === 'item/completed') {
    const it = m.params.item;
    if (it.type === 'mcpToolCall') console.log(ms(), m.method, JSON.stringify({ threadId: m.params.threadId, turnId: m.params.turnId, itemId: it.id, server: it.server, tool: it.tool, arguments: it.arguments, status: it.status }));
    if (it.type === 'agentMessage' && m.method === 'item/completed') console.log(ms(), 'agentMessage', m.params.threadId.slice(-6), JSON.stringify(it.text ?? it.content).slice(0, 80));
  } else if (m.method === 'turn/completed') {
    console.log(ms(), 'turn/completed', m.params.threadId.slice(-6), JSON.stringify(m.params.turn?.status ?? ''));
    turnDone.get(m.params.threadId)?.();
  } else if (m.method === 'mcpServer/startupStatus/updated' && /cophylaspike/.test(JSON.stringify(m.params))) {
    console.log(ms(), m.method, JSON.stringify(m.params).slice(0, 200));
  } else if (m.method === 'thread/status/changed') {
    console.log(ms(), m.method, m.params.threadId.slice(-6), JSON.stringify(m.params.status));
  }
});

function call(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((ok, bad) => {
    const timer = setTimeout(() => bad(new Error(`timeout: ${method}`)), 60_000);
    pending.set(id, (m) => { clearTimeout(timer); m.error ? bad(new Error(`${method}: ${JSON.stringify(m.error)}`)) : ok(m.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function runThread(nonce: string) {
  const started = await call('thread/start', { cwd, model: 'gpt-5.6-luna', sandbox: 'read-only', approvalPolicy: 'on-request', config: { model_reasoning_effort: 'low' } });
  const threadId: string = started.thread.id;
  console.log(ms(), 'thread/start ->', threadId, 'source:', JSON.stringify(started.thread.source), 'status:', JSON.stringify(started.thread.status));
  const done = new Promise<void>((r) => turnDone.set(threadId, r));
  await call('turn/start', { threadId, input: [{ type: 'text', text: `call the cophylaspike whoami tool with nonce ${nonce} then reply with the single word done` }] });
  await Promise.race([done, new Promise((r) => setTimeout(r, 90_000))]);
  return threadId;
}

try {
  await call('initialize', { clientInfo: { name: 'cophylaspike', title: 'cophyla spike', version: '0.0.1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
  const a = await runThread('NONCE-shared-A');
  const b = await runThread('NONCE-shared-B');
  const loaded = await call('thread/loaded/list', {});
  console.log(ms(), 'loaded threads:', JSON.stringify(loaded.data));
  console.log('threads', a, b);
} catch (e) {
  console.error(ms(), 'ERROR', String(e));
} finally {
  child.stdin.end();
  setTimeout(() => { child.kill(); process.exit(0); }, 2000);
}
