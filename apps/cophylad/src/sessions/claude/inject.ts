// Injects a user turn into a live Claude Code session over its messaging pipe: an auth line
// with the peer token, then the user line. Nothing ever comes back; the receipt is the
// UserPromptSubmit hook or the transcript row. Both frames are built before connecting,
// because a connection idle for 30 s is closed.

import { connect } from "node:net";

export const CLAUDE_INJECT_FROM = "cophylad";

export interface InjectOptions {
  /** How long to keep the connection open after writing, so the receiver reads both lines. */
  holdMs?: number;
  connectTimeoutMs?: number;
  from?: string;
}

export function claudeFrames(token: string, text: string, from = CLAUDE_INJECT_FROM): string {
  return JSON.stringify({ type: "auth", token }) + "\n" + JSON.stringify({ type: "user", message: { role: "user", content: text }, from }) + "\n";
}

export function injectClaude(pipePath: string, token: string, text: string, opts: InjectOptions = {}): Promise<void> {
  const frames = claudeFrames(token, text, opts.from);
  const holdMs = opts.holdMs ?? 300;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const sock = connect(pipePath);
    const timer = setTimeout(() => {
      sock.destroy();
      done(new Error(`timed out connecting to ${pipePath}`));
    }, connectTimeoutMs);
    sock.on("connect", () => {
      sock.write(frames, (err) => {
        if (err) {
          sock.destroy();
          done(err);
          return;
        }
        setTimeout(() => {
          sock.end();
          done();
        }, holdMs);
      });
    });
    sock.on("error", (err) => done(err));
  });
}
