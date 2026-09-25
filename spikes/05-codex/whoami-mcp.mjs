// Minimal stdio MCP server (newline-delimited JSON-RPC, no SDK) with one tool, `whoami`.
// Every lifecycle step is appended to out/whoami.jsonl so the spike can see who spawned it,
// how many copies exist, and what the tools/call request carries.
import { appendFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'out'), { recursive: true });
const LOG = join(here, 'out', 'whoami.jsonl');
const log = (o) => appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...o }) + '\n');

function parentChain() {
  // One CIM query, then walk up in JS.
  const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const rows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { maxBuffer: 64 * 1024 * 1024 }).toString());
  const byPid = new Map(rows.map((r) => [r.ProcessId, r]));
  const chain = [];
  let pid = process.pid;
  for (let i = 0; i < 12 && byPid.has(pid); i++) {
    const r = byPid.get(pid);
    chain.push({ pid: r.ProcessId, name: r.Name, cmd: (r.CommandLine || '').slice(0, 220) });
    pid = r.ParentProcessId;
  }
  return chain;
}

const interestingEnv = () => Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => /CODEX|THREAD|SESSION|CONVERSATION|TURN|MCP/i.test(k))
  .map(([k, v]) => [k, /TOKEN|KEY|SECRET|AUTH/i.test(k) ? '<masked>' : String(v).slice(0, 160)]));

log({ ev: 'spawned', ppid: process.ppid, cwd: process.cwd(), argv: process.argv.slice(2), env: interestingEnv() });
try { log({ ev: 'chain', chain: parentChain() }); } catch (e) { log({ ev: 'chain-error', error: String(e) }); }

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return log({ ev: 'bad-json', line: line.slice(0, 200) }); }
  log({ ev: 'rx', method: msg.method, id: msg.id, params: msg.params });
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'cophylaspike', version: '0.0.1' },
      instructions: 'Spike server. Call whoami when asked.',
    } });
  }
  if (msg.method === 'tools/list') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{
      name: 'whoami',
      description: 'Report which process is calling. Pass the nonce you were given.',
      inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'] },
      annotations: { readOnlyHint: true },
    }] } });
  }
  if (msg.method === 'tools/call') {
    let chain = []; try { chain = parentChain(); } catch {}
    log({ ev: 'call', name: msg.params?.name, arguments: msg.params?.arguments, _meta: msg.params?._meta, chain });
    return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `pid=${process.pid} ppid=${process.ppid}` }] } });
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
process.stdin.on('end', () => { log({ ev: 'stdin-end' }); process.exit(0); });
