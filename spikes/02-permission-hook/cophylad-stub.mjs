// Stand-in for cophylad's hook ingress. Logs every hook event; holds PermissionRequest open
// until someone answers it, the way a phone would.
//   node cophylad-stub.mjs [port]
//   GET  /pending                      open permission requests
//   POST /answer   {"behavior":"allow"|"deny","message"?}   answer the oldest one
//   GET  /events                       everything received so far
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';

const port = Number(process.argv[2] ?? 4810);
mkdirSync('out', { recursive: true });
const LOG = 'out/events.jsonl';
const pending = [];
const events = [];
const t0 = Date.now();
const log = (o) => { const row = { t: +((Date.now() - t0) / 1000).toFixed(1), ...o }; events.push(row); appendFileSync(LOG, JSON.stringify(row) + '\n'); console.log(JSON.stringify(row)); };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b)); });

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };

  if (url.pathname === '/hooks/claude') {
    const ev = JSON.parse((await readBody(req)) || '{}');
    const via = req.headers['x-cophyla-via'] ?? 'http-hook';
    log({ in: ev.hook_event_name, via, tool: ev.tool_name, input: ev.tool_input, session: ev.session_id?.slice(0, 8), mode: ev.permission_mode, keys: Object.keys(ev) });
    if (ev.hook_event_name !== 'PermissionRequest') return json({});
    const started = Date.now();
    const entry = { id: pending.length + 1, tool: ev.tool_name, input: ev.tool_input, started };
    const answered = new Promise((resolve) => { entry.resolve = resolve; });
    pending.push(entry);
    res.on('close', () => { if (!entry.done && !res.writableEnded) { entry.done = 'aborted'; log({ aborted: entry.id, afterSec: +((Date.now() - started) / 1000).toFixed(1), note: 'caller hung up before an answer' }); } });
    const decision = await answered;
    entry.done = 'answered';
    log({ answered: entry.id, afterSec: +((Date.now() - started) / 1000).toFixed(1), decision });
    return json({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
  }
  if (url.pathname === '/pending') return json(pending.filter((p) => !p.done).map(({ id, tool, input, started }) => ({ id, tool, input, waitingSec: Math.round((Date.now() - started) / 1000) })));
  if (url.pathname === '/answer') {
    const open = pending.find((p) => !p.done);
    if (!open) { res.statusCode = 409; return json({ error: 'nothing pending' }); }
    open.resolve(JSON.parse(await readBody(req)));
    return json({ ok: open.id });
  }
  if (url.pathname === '/events') return json(events);
  res.statusCode = 404; json({});
}).listen(port, '127.0.0.1', () => console.log(`cophylad-stub on ${port}`));
