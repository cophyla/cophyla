// Writes every schema in the registry as JSON Schema under packages/protocol/schema/, for
// processes that are not TypeScript: the Rust side of the desktop shell, the server, tests
// in other languages. Run with `bun run schema` from the repository root.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { registry } from "../src/index.ts";

const OUT = join(import.meta.dir, "..", "schema");
rmSync(OUT, { recursive: true, force: true });

let count = 0;
const emit = (path: string[], schema: z.ZodType) => {
  const dir = join(OUT, ...path.slice(0, -1));
  mkdirSync(dir, { recursive: true });
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any", io: "input" });
  writeFileSync(join(dir, `${path[path.length - 1]}.json`), JSON.stringify(json, null, 2) + "\n");
  count++;
};

for (const [name, schema] of Object.entries(registry.rpc)) emit(["rpc", name], schema);
for (const [name, schema] of Object.entries(registry.entities)) emit(["entities", name], schema);
emit(["capability", "hello"], registry.capability.hello);
for (const [name, schema] of Object.entries(registry.capability.events)) emit(["capability", "events", name], schema);
for (const [name, def] of Object.entries(registry.capability.requests)) {
  emit(["capability", "requests", name, "params"], def.params);
  emit(["capability", "requests", name, "result"], def.result);
}
for (const [name, schema] of Object.entries(registry.capability.notices)) emit(["capability", "notices", name], schema);
for (const [name, def] of Object.entries(registry.client.requests)) {
  emit(["client", "requests", name, "params"], def.params);
  emit(["client", "requests", name, "result"], def.result);
}
for (const [name, schema] of Object.entries(registry.client.signals)) emit(["client", "signals", name], schema);
for (const [name, schema] of Object.entries(registry.client.notifications)) emit(["client", "notifications", name], schema);
for (const [harness, def] of Object.entries(registry.hooks)) {
  emit(["hooks", harness, "event"], def.event);
  emit(["hooks", harness, "response"], def.response);
}
for (const [name, def] of Object.entries(registry.serverLink.requests)) {
  emit(["server-link", "requests", name, "params"], def.params);
  emit(["server-link", "requests", name, "result"], def.result);
}
for (const [name, def] of Object.entries(registry.serverLink.inbound)) {
  emit(["server-link", "inbound", name, "params"], def.params);
  emit(["server-link", "inbound", name, "result"], def.result);
}
for (const [name, schema] of Object.entries(registry.serverLink.frames)) emit(["server-link", "frames", name], schema);
for (const [name, def] of Object.entries(registry.serverLink.auth)) {
  emit(["server-link", "auth", name, "params"], def.params);
  emit(["server-link", "auth", name, "result"], def.result);
}
for (const [name, def] of Object.entries(registry.nodeLink.requests)) {
  emit(["node-link", "requests", name, "params"], def.params);
  emit(["node-link", "requests", name, "result"], def.result);
}
for (const [name, schema] of Object.entries(registry.nodeLink.frames)) emit(["node-link", "frames", name], schema);
emit(["invite", "body"], registry.invite.body);
for (const [name, def] of Object.entries(registry.relayPeer.requests)) {
  emit(["relay", "requests", name, "params"], def.params);
  emit(["relay", "requests", name, "result"], def.result);
}
for (const [name, schema] of Object.entries(registry.relayPeer.frames)) emit(["relay", "frames", name], schema);

console.log(`wrote ${count} schemas to ${OUT}`);
