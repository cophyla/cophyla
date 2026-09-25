// Holds one interactive TUI in a PTY and exposes it on loopback, so a spike can be driven
// step by step from the shell:
//   node tui-server.mjs --port 4801 --cwd <dir> --raw out/x.raw -- claude --name spike-x ...
//   curl -s localhost:4801/screen            last screenful, ANSI stripped
//   curl -s localhost:4801/info              {pid, exited}
//   curl -s -XPOST localhost:4801/submit -d 'text'   type text, then Enter
//   curl -s -XPOST localhost:4801/keys -d $'\r'      raw keystrokes
//   curl -s -XPOST localhost:4801/kill
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnTui, CLAUDE, CODEX } from './pty.mjs';

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const opts = argv.slice(0, split);
const cmd = argv.slice(split + 1);
const opt = (name, dflt) => { const i = opts.indexOf(`--${name}`); return i >= 0 ? opts[i + 1] : dflt; };

const port = Number(opt('port', 4801));
const cwd = resolve(opt('cwd', process.cwd()));
const raw = opt('raw');
mkdirSync(cwd, { recursive: true });
if (raw) mkdirSync(dirname(resolve(raw)), { recursive: true });

const file = cmd[0] === 'claude' ? CLAUDE : cmd[0] === 'codex' ? CODEX : cmd[0];
const tui = spawnTui(file, cmd.slice(1), { cwd, rawLog: raw && resolve(raw) });

const body = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b)); });

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (o) => { res.setHeader('content-type', 'text/plain; charset=utf-8'); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
  if (url.pathname === '/screen') return send(tui.text(Number(url.searchParams.get('tail') ?? 3000)));
  if (url.pathname === '/info') return send({ pid: tui.pid, exited: tui.exited });
  if (url.pathname === '/submit') { await tui.submit(await body(req)); return send('ok'); }
  if (url.pathname === '/keys') { tui.write(await body(req)); return send('ok'); }
  if (url.pathname === '/wait') {
    try { const m = await tui.waitFor(new RegExp(url.searchParams.get('re'), 'i'), Number(url.searchParams.get('ms') ?? 60000), url.searchParams.get('fresh') ? tui.mark() : 0); return send(`matched: ${m[0]}`); }
    catch (e) { res.statusCode = 408; return send(String(e.message).slice(0, 2500)); }
  }
  if (url.pathname === '/kill') { tui.kill(); send('killed'); setTimeout(() => process.exit(0), 300); return; }
  res.statusCode = 404; send('?');
}).listen(port, '127.0.0.1', () => console.log(`tui-server pid=${tui.pid} port=${port} cwd=${cwd}`));

setInterval(() => { if (tui.exited) { console.log('child exited', tui.exited); process.exit(0); } }, 1000);
