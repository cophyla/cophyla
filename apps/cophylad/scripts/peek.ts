// Connects to a running cophylad and prints what it sees: profiles, sessions and workspaces.
//   bun run apps/cophylad/scripts/peek.ts [--home <dir>] [--port <n>] [--events <sessionId>]
// The token is read from <home>/data/client.token; the port from <home>/config.toml unless given.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { request } from "@cophyla/protocol";
import type { RpcMessage } from "@cophyla/protocol";
import { loadConfig, paths, resolveHome } from "../src/config/load.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { home: { type: "string" }, port: { type: "string" }, events: { type: "string" } },
  strict: true,
});

const p = paths(resolveHome(values.home));
const config = loadConfig(p, { writeDefault: false });
const port = values.port !== undefined ? Number(values.port) : config.api.port;
const token = readFileSync(p.clientToken, "utf8").trim();
const url = `ws://${config.api.host}:${port}/ws/client`;

const ws = new WebSocket(url);
let seq = 0;
const pending = new Map<number, (m: RpcMessage) => void>();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(String(ev.data)) as RpcMessage;
  if ("id" in m && m.id !== null && !("method" in m)) pending.get(m.id as number)?.(m);
});
const call = (method: string, params: unknown = {}) =>
  new Promise<unknown>((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => ("error" in m ? reject(new Error(m.error.message)) : resolve((m as { result: unknown }).result)));
    ws.send(JSON.stringify(request(id, method, params)));
  });

await new Promise<void>((resolve, reject) => {
  ws.addEventListener("open", () => resolve());
  ws.addEventListener("error", () => reject(new Error(`cannot reach ${url}`)));
});
await call("hello", { token, kind: "controller", name: "peek", audio: { in: false, out: false } });
for (const method of ["profile.list", "session.list", "workspace.list"]) {
  console.log(`\n== ${method}`);
  console.log(JSON.stringify(await call(method, {}), null, 2));
}
if (values.events) {
  console.log(`\n== session.history ${values.events}`);
  console.log(JSON.stringify(await call("session.history", { id: values.events, limit: 20 }), null, 2));
}
ws.close();
