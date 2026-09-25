// Hosts one node-pty terminal under Node for a test that runs under Bun, where node-pty's
// child loses its terminal on Linux (SIGHUP before the first byte) and typed input is
// unreliable. Newline-delimited JSON on stdio: the parent sends {op: "spawn"|"write"|"kill"},
// the broker answers {ev: "spawned"|"data"|"exit"|"error"}. Started by pty.ts; not a test.

import { createInterface } from "node:readline";

const pty = await import("@lydell/node-pty");
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
let child;

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  try {
    if (msg.op === "spawn") {
      child = pty.spawn(msg.file, msg.args, { name: msg.name ?? "xterm-256color", cols: msg.cols, rows: msg.rows, cwd: msg.cwd, env: msg.env });
      child.onData((data) => send({ ev: "data", data }));
      child.onExit((e) => {
        send({ ev: "exit", exitCode: e.exitCode, signal: e.signal });
        setTimeout(() => process.exit(0), 100);
      });
      send({ ev: "spawned", pid: child.pid });
    } else if (msg.op === "write") {
      child?.write(msg.data);
    } else if (msg.op === "kill") {
      try {
        child?.kill();
      } catch {
        // already gone
      }
      setTimeout(() => process.exit(0), 100);
    }
  } catch (e) {
    send({ ev: "error", message: e instanceof Error ? e.message : String(e) });
  }
});

process.stdin.on("end", () => {
  try {
    child?.kill();
  } catch {
    // already gone
  }
  process.exit(0);
});
