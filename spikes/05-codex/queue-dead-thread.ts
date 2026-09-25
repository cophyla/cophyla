// What happens to a message queued for a thread that is not live in any process?
// Adds one to the finished `codex exec` thread, lists it, then deletes it again (cleanup).
//   bun queue-dead-thread.ts <threadId>
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
const CODEX = join(homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
const threadId = process.argv[2];
const child = spawn(CODEX, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
const pending = new Map<number, (m: any) => void>(); let id = 1;
createInterface({ input: child.stdout }).on('line', (l) => { try { const m = JSON.parse(l); if (m.id && pending.has(m.id)) pending.get(m.id)!(m); else if (m.method?.startsWith('thread/')) console.log('notif', m.method, JSON.stringify(m.params)); } catch {} });
const call = (method: string, params: unknown) => new Promise<any>((ok) => { const i = id++; pending.set(i, ok); child.stdin.write(JSON.stringify({ id: i, method, params }) + '\n'); });
await call('initialize', { clientInfo: { name: 'cophylaspike', version: '0.0.1' }, capabilities: { experimentalApi: true } });
const add = await call('thread/queue/add', { threadId, clientUserMessageId: 'cophyla-dead-1', input: [{ type: 'text', text: 'DEAD-THREAD: should never run' }] });
console.log('add ->', JSON.stringify(add.result ?? add.error));
await new Promise((r) => setTimeout(r, 12_000)); // longer than the idle pickup we saw on a live thread
const list = await call('thread/queue/list', { threadId });
console.log('after 12s list ->', JSON.stringify(list.result ?? list.error));
const qid = add.result?.queuedSubmission?.id;
if (qid) {
  const schemaGuess = await call('thread/queue/delete', { threadId, queuedSubmissionId: qid });
  console.log('delete ->', JSON.stringify(schemaGuess.result ?? schemaGuess.error));
  const after = await call('thread/queue/list', { threadId });
  console.log('final list ->', JSON.stringify(after.result ?? after.error));
}
child.kill(); process.exit(0);
