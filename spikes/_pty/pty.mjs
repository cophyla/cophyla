// Test scaffolding shared by the spikes: run an interactive TUI (claude, codex) inside a
// ConPTY so a script can watch the screen and type into it. Runs under Node, not Bun.
import pty from '@lydell/node-pty';
import { appendFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CLAUDE = join(homedir(), '.local', 'bin', 'claude.exe');
export const CODEX = join(homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');

// Good enough for reading a TUI: drop CSI/OSC sequences, keep the text.
export function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/[ \t]+/g, ' ');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function spawnTui(file, args, { cwd, env, cols = 140, rows = 45, rawLog } = {}) {
  // A nested session must not inherit this session's identity or messaging socket.
  const clean = { ...process.env, ...env };
  for (const k of Object.keys(clean)) {
    if (/^CLAUDE_CODE_/.test(k) || ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'].includes(k)) delete clean[k];
  }
  const p = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: clean });
  let buf = '';
  if (rawLog) writeFileSync(rawLog, '');
  p.onData((d) => {
    buf += d;
    if (buf.length > 400_000) buf = buf.slice(-200_000);
    if (rawLog) appendFileSync(rawLog, d);
  });
  let exited = null;
  p.onExit((e) => { exited = e; });

  return {
    pid: p.pid,
    get exited() { return exited; },
    write: (s) => p.write(s),
    // Type text, then press Enter as a separate write so the TUI does not treat it as a paste.
    async submit(text, gapMs = 400) { p.write(text); await sleep(gapMs); p.write('\r'); },
    text: (tail = 6000) => stripAnsi(buf).slice(-tail),
    mark: () => buf.length,
    since: (mark) => stripAnsi(buf.slice(mark)),
    async waitFor(re, timeoutMs = 60_000, fromMark = 0) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const m = stripAnsi(buf.slice(fromMark)).match(re);
        if (m) return m;
        if (exited) throw new Error(`process exited (${exited.exitCode}) before ${re}`);
        await sleep(250);
      }
      throw new Error(`timeout waiting for ${re}\n--- screen tail ---\n${stripAnsi(buf).slice(-1500)}`);
    },
    kill() { try { p.kill(); } catch {} },
  };
}
