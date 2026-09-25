// A stand-in child for the stdio JSON-RPC tests: answers `echo` with its params, `slow` after
// a delay (or never, when `ms` is 0), `fail` with a protocol error, `ask` by sending the parent
// a request of its own and answering with what came back, `exit` by exiting with the code
// given. Notifications named `ping` are echoed back as `pong`. Writes synchronously, as the
// other fakes do.

import { writeSync } from "node:fs";
import { createInterface } from "node:readline";

const send = (m: unknown) => writeSync(1, JSON.stringify(m) + "\n");

let n = 0;
const pending = new Map<number, (v: unknown) => void>();

process.stderr.write("echo-rpc ready\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const id = m["id"];
  const method = m["method"];
  const params = (m["params"] ?? {}) as Record<string, unknown>;
  if (typeof method !== "string") {
    // A response to one of ours.
    const p = pending.get(id as number);
    if (p) {
      pending.delete(id as number);
      p(m["error"] !== undefined ? { error: m["error"] } : { result: m["result"] });
    }
    return;
  }
  if (id === undefined || id === null) {
    if (method === "ping") send({ jsonrpc: "2.0", method: "pong", params });
    return;
  }
  switch (method) {
    case "echo":
      send({ jsonrpc: "2.0", id, result: params });
      return;
    case "slow": {
      const ms = Number(params["ms"] ?? 0);
      if (ms > 0) setTimeout(() => send({ jsonrpc: "2.0", id, result: { slept: ms } }), ms);
      return;
    }
    case "fail":
      send({ jsonrpc: "2.0", id, error: { code: -32004, message: "nope", data: { code: "not_found", message: "nope", retryable: false } } });
      return;
    case "ask": {
      const reqId = ++n;
      pending.set(reqId, (answer) => send({ jsonrpc: "2.0", id, result: { answer } }));
      send({ jsonrpc: "2.0", id: reqId, method: String(params["method"] ?? "question"), params: params["params"] ?? {} });
      return;
    }
    case "exit":
      send({ jsonrpc: "2.0", id, result: {} });
      setTimeout(() => process.exit(Number(params["code"] ?? 0)), 20);
      return;
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown ${method}` } });
  }
});
