// Does the receiver send anything back to a `from` that is shaped like an inbox address?
// Also exercises a named-pipe *server* under Bun, which cophylad will need for its own endpoints.
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const BS = String.fromCharCode(92);
const pipe = [BS + BS + '.', 'pipe', 'LOCAL', `cc-msg-${randomBytes(16).toString('hex')}`].join(BS);

const server = createServer((c) => {
  console.log('inbound connection on our pipe');
  c.setEncoding('utf8');
  c.on('data', (d) => console.log('← ' + String(d).trimEnd().slice(0, 400)));
});
server.on('error', (e) => { console.log('listen error', (e as any).code, e.message); process.exit(1); });
server.listen(pipe, () => {
  console.log('listening on', pipe.slice(0, 34) + '…');
  const text = process.argv[3] ?? 'SPIKE-RCPT: reply with the single word PONG-R.';
  const r = spawnSync('bun', ['post.ts', process.argv[2], text, '--extra', JSON.stringify({ from: pipe, msg_id: 'spike-rcpt' })], { encoding: 'utf8' });
  console.log(r.stdout.trim().split('\n').pop());
  setTimeout(() => { server.close(); process.exit(0); }, 8000);
});
