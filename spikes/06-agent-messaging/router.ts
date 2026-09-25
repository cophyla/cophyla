// A minimal `cophylad.messages`: directory, caller identity, envelope, limits, delivery and an
// audit line per message. Inbound uses each harness's native path (Claude inbox pipe, Codex
// thread/queue/add); outbound arrives from the cophyla MCP shim.   bun router.ts
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PORT = 4811;
const SPIKE_CWD = /06-agent-messaging/i; // guard rail: only sessions the spike started are addressable
const CODEX = join(homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
const SESSIONS = join(homedir(), '.claude', 'sessions');

mkdirSync('out', { recursive: true });
const audit = (o: object) => { const row = { at: new Date().toISOString(), ...o }; appendFileSync('out/audit.jsonl', JSON.stringify(row) + '\n'); console.log(JSON.stringify(row)); };

// ---- Claude side -------------------------------------------------------------------------
type ClaudeEntry = { pid: number; name: string; cwd: string; status: string; sessionId: string; messagingSocketPath: string };
function claudeSessions(): ClaudeEntry[] {
  return readdirSync(SESSIONS).filter((f) => /^\d+\.json$/.test(f))
    .map((f) => { try { return JSON.parse(readFileSync(join(SESSIONS, f), 'utf8')); } catch { return null; } })
    .filter((s): s is ClaudeEntry => !!s && SPIKE_CWD.test(s.cwd));
}
function postToClaude(entry: ClaudeEntry, from: string, text: string): Promise<string> {
  const keyFile = readdirSync(SESSIONS).find((f) => f.startsWith(`${entry.pid}.`) && f.endsWith('.key'))!;
  const { peerToken } = JSON.parse(readFileSync(join(SESSIONS, keyFile), 'utf8'));
  return new Promise((resolve) => {
    const s = connect(entry.messagingSocketPath, () => {
      s.write(JSON.stringify({ type: 'auth', token: peerToken }) + '\n');
      s.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text }, from }) + '\n');
      setTimeout(() => { s.end(); resolve('queued'); }, 300); // the inbox sends no ack; see 01-claude-inbox
    });
    s.on('error', (e: any) => resolve(`refused:${e.code}`));
  });
}

// ---- Codex side: our own app-server on stdio (no shared daemon on Windows) ----------------
const codex = spawn(CODEX, ['app-server', '--stdio', '-c', 'check_for_update_on_startup=false'], { stdio: ['pipe', 'pipe', 'ignore'] });
let rpcId = 1;
const waiting = new Map<number, (m: any) => void>();
createInterface({ input: codex.stdout! }).on('line', (l) => { try { const m = JSON.parse(l); if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); } } catch {} });
const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
  const id = rpcId++;
  const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 20_000);
  waiting.set(id, (m) => { clearTimeout(t); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); });
  codex.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
await rpc('initialize', { clientInfo: { name: 'cophyla-router-spike', title: 'cophyla router spike', version: '0.0.1' }, capabilities: { experimentalApi: true } });
codex.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');

type CodexThread = { id: string; cwd: string; name?: string };
async function codexThreads(): Promise<CodexThread[]> {
  const r = await rpc('thread/list', { limit: 25 });
  return r.data.filter((t: any) => SPIKE_CWD.test(t.cwd ?? ''));
}
// thread.name defaults to the first prompt's text, which is useless as an address.
const codexName = (t: CodexThread) => `codex-${t.id.slice(-8)}`;

// ---- directory + caller identity ----------------------------------------------------------
type Agent = { name: string; harness: 'claude' | 'codex'; status?: string; cwd: string; ref: ClaudeEntry | CodexThread };
async function directory(): Promise<Agent[]> {
  return [
    ...claudeSessions().map((s) => ({ name: s.name, harness: 'claude' as const, status: s.status, cwd: s.cwd, ref: s })),
    ...(await codexThreads()).map((t) => ({ name: codexName(t), harness: 'codex' as const, cwd: t.cwd, ref: t })),
  ];
}

function processParents(): Map<number, { ppid: number; name: string }> {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return new Map(JSON.parse(r.stdout).map((p: any) => [p.ProcessId, { ppid: p.ParentProcessId, name: p.Name }]));
}

async function resolveCaller(evidence: any, meta: any): Promise<{ agent?: Agent; how: string; chain?: string }> {
  const dir = await directory();
  if (meta?.threadId) { // Codex stamps the thread on every tools/call
    return { agent: dir.find((a) => a.harness === 'codex' && (a.ref as CodexThread).id === meta.threadId), how: `codex _meta.threadId (sandbox=${meta['x-codex-turn-metadata']?.sandbox_mode ?? '?'})` };
  }
  const procs = processParents();
  const chain: string[] = [];
  for (let pid = evidence.pid, hops = 0; pid && hops < 12; pid = procs.get(pid)?.ppid ?? 0, hops++) {
    chain.push(`${procs.get(pid)?.name ?? '?'}:${pid}`);
    const hit = dir.find((a) => a.harness === 'claude' && (a.ref as ClaudeEntry).pid === pid);
    if (hit) return { agent: hit, how: 'claude process-tree walk', chain: chain.join(' < ') };
  }
  return { how: 'unresolved', chain: chain.join(' < ') };
}

// ---- limits (copied from Claude's: rate per sender, identical repeats dropped, hop cap) ----
const recent: { from: string; key: string; at: number }[] = [];
function limited(from: string, to: string, text: string): string | null {
  const now = Date.now();
  while (recent.length && now - recent[0].at > 60_000) recent.shift();
  const key = `${from}>${to}>${text}`;
  if (recent.some((r) => r.key === key)) return 'duplicate';
  if (recent.filter((r) => r.from === from).length >= 10) return 'rate_limited';
  recent.push({ from, key, at: now });
  return null;
}

const channelOutbox: any[] = [];

// ---- ingress from the MCP shim -------------------------------------------------------------
const body = (req: any) => new Promise<any>((r) => { let b = ''; req.on('data', (d: any) => (b += d)); req.on('end', () => r(b ? JSON.parse(b) : {})); });
createServer(async (req, res) => {
  const send = (o: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  const p = await body(req);

  if (req.url === '/mcp/hello') { audit({ event: 'shim.hello', client: p.client, pid: p.evidence?.pid, ppid: p.evidence?.ppid, envKeys: Object.keys(p.evidence?.env ?? {}), channel: p.channel }); return send({}); }

  if (req.url === '/mcp/call') {
    const t0 = Date.now();
    const caller = await resolveCaller(p.evidence, p.meta);
    audit({ event: 'mcp.call', tool: p.tool, caller: caller.agent?.name ?? null, how: caller.how, chain: caller.chain, metaKeys: p.meta ? Object.keys(p.meta) : null, resolveMs: Date.now() - t0 });
    if (!caller.agent) return send({ error: 'caller could not be identified' });

    if (p.tool === 'agents_list') {
      const dir = await directory();
      return send({ you: caller.agent.name, agents: dir.filter((a) => a.name !== caller.agent!.name).map(({ name, harness, status, cwd }) => ({ name, harness, status, cwd })) });
    }
    if (p.tool === 'message_send') {
      const target = (await directory()).find((a) => a.name === p.args.to);
      if (!target) return send({ error: `no agent named ${p.args.to}` });
      const drop = limited(caller.agent.name, target.name, p.args.text);
      if (drop) { audit({ event: 'message.dropped', reason: drop, from: caller.agent.name, to: target.name }); return send({ status: 'refused', reason: drop }); }
      const id = `pmsg_${randomUUID().slice(0, 8)}`;
      const envelope = `<cophyla-message from="${caller.agent.name}" harness="${caller.agent.harness}" node="this-machine" id="${id}"${p.args.replyTo ? ` replyTo="${p.args.replyTo}"` : ''}>\n${p.args.text}\n</cophyla-message>`;
      let status: string;
      if (target.harness === 'claude') status = await postToClaude(target.ref as ClaudeEntry, caller.agent.name, envelope);
      else {
        const added = await rpc('thread/queue/add', { threadId: (target.ref as CodexThread).id, clientUserMessageId: `cophyla-${id}`, input: [{ type: 'text', text: envelope }] });
        status = added ? 'queued' : 'refused';
      }
      audit({ event: 'message.routed', id, from: caller.agent.name, to: target.name, via: target.harness === 'claude' ? 'inbox pipe' : 'thread/queue/add', status, chars: p.args.text.length });
      return send({ id, status });
    }
    return send({ error: 'unknown tool' });
  }

  if (req.url === '/mcp/notify') { audit({ event: 'shim.notify', method: p.method, params: p.params }); return send({}); }
  if (req.url === '/mcp/channel-poll') return send({ notifications: channelOutbox.splice(0) });
  if (req.url === '/channel-permission') { channelOutbox.push({ method: 'notifications/claude/channel/permission', params: { request_id: p.request_id, behavior: p.behavior } }); return send({ ok: true }); }
  if (req.url === '/channel-push') { channelOutbox.push({ content: p.content, meta: p.meta ?? {} }); return send({ ok: true }); }
  if (req.url === '/directory') return send(await directory());
  res.statusCode = 404; send({});
}).listen(PORT, '127.0.0.1', () => console.log(`router on ${PORT}`));

process.on('SIGINT', () => { codex.kill(); process.exit(0); });
