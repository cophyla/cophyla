// Command-hook shim: forward the hook event on stdin to cophylad, print cophylad's answer as the
// hook's stdout. Prints nothing else, so nothing leaks into the session's context.
import { request } from 'node:http';

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (body += d));
process.stdin.on('end', () => {
  const req = request(
    { host: '127.0.0.1', port: Number(process.env.COPHYLA_HOOK_PORT ?? 4810), path: '/hooks/claude', method: 'POST', headers: { 'content-type': 'application/json', 'x-cophyla-via': 'command-shim' } },
    (res) => { let out = ''; res.on('data', (d) => (out += d)); res.on('end', () => { process.stdout.write(out); process.exit(0); }); },
  );
  // cophylad not running must never break the user's session: exit 0 with no output = no opinion.
  req.on('error', () => process.exit(0));
  req.end(body);
});
