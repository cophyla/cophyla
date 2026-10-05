// Every schema has at least one fixture that parses, every fixture names a schema, every
// object fixture is still accepted with a field the schema does not know, and the invalid
// fixtures are rejected.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { registry } from "../src/index.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const read = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

type AnySchema = z.ZodType;
interface Case {
  path: string;
  schema: AnySchema;
  examples: unknown[];
}

const cases: Case[] = [];
const add = (path: string, schema: AnySchema, examples: unknown) => {
  if (!Array.isArray(examples)) throw new Error(`fixture ${path} must be an array of examples`);
  cases.push({ path, schema, examples });
};

// --- collect ---------------------------------------------------------------------------

const rpc = read("rpc.json") as Record<string, unknown>;
for (const [name, schema] of Object.entries(registry.rpc)) add(`rpc.${name}`, schema, rpc[name]);

const entities = read("entities.json") as Record<string, unknown>;
for (const [name, schema] of Object.entries(registry.entities)) add(`entities.${name}`, schema, entities[name]);

const cap = read("capability.json") as {
  hello: unknown;
  events: Record<string, unknown>;
  requests: Record<string, { params: unknown; results: unknown }>;
  notices: Record<string, unknown>;
  signals: Record<string, unknown>;
  brain: Record<string, { params: unknown; results: unknown }>;
};
add("capability.hello", registry.capability.hello, cap.hello);
for (const [name, schema] of Object.entries(registry.capability.events)) add(`capability.events.${name}`, schema, cap.events[name]);
for (const [name, def] of Object.entries(registry.capability.requests)) {
  add(`capability.requests.${name}.params`, def.params, cap.requests[name]?.params);
  add(`capability.requests.${name}.result`, def.result, cap.requests[name]?.results);
}
for (const [name, schema] of Object.entries(registry.capability.notices)) add(`capability.notices.${name}`, schema, cap.notices[name]);
for (const [name, schema] of Object.entries(registry.capability.signals)) add(`capability.signals.${name}`, schema, cap.signals[name]);
for (const [name, def] of Object.entries(registry.capability.brain)) {
  add(`capability.brain.${name}.params`, def.params, cap.brain[name]?.params);
  add(`capability.brain.${name}.result`, def.result, cap.brain[name]?.results);
}

const cli = read("client.json") as {
  requests: Record<string, { params: unknown; results: unknown }>;
  signals: Record<string, unknown>;
  notifications: Record<string, unknown>;
};
for (const [name, def] of Object.entries(registry.client.requests)) {
  add(`client.requests.${name}.params`, def.params, cli.requests[name]?.params);
  add(`client.requests.${name}.result`, def.result, cli.requests[name]?.results);
}
for (const [name, schema] of Object.entries(registry.client.signals)) add(`client.signals.${name}`, schema, cli.signals[name]);
for (const [name, schema] of Object.entries(registry.client.notifications)) add(`client.notifications.${name}`, schema, cli.notifications[name]);

const hk = read("hooks.json") as Record<string, { event: unknown; response: unknown }>;
for (const [harness, def] of Object.entries(registry.hooks)) {
  add(`hooks.${harness}.event`, def.event, hk[harness]?.event);
  add(`hooks.${harness}.response`, def.response, hk[harness]?.response);
}

const sl = read("server-link.json") as {
  requests: Record<string, { params: unknown; results: unknown }>;
  inbound: Record<string, { params: unknown; results: unknown }>;
  frames: Record<string, unknown>;
  auth: Record<string, { params: unknown; results: unknown }>;
};
for (const [name, def] of Object.entries(registry.serverLink.requests)) {
  add(`serverLink.requests.${name}.params`, def.params, sl.requests[name]?.params);
  add(`serverLink.requests.${name}.result`, def.result, sl.requests[name]?.results);
}
for (const [name, def] of Object.entries(registry.serverLink.inbound)) {
  add(`serverLink.inbound.${name}.params`, def.params, sl.inbound[name]?.params);
  add(`serverLink.inbound.${name}.result`, def.result, sl.inbound[name]?.results);
}
for (const [name, schema] of Object.entries(registry.serverLink.frames)) add(`serverLink.frames.${name}`, schema, sl.frames[name]);
for (const [name, def] of Object.entries(registry.serverLink.auth)) {
  add(`serverLink.auth.${name}.params`, def.params, sl.auth[name]?.params);
  add(`serverLink.auth.${name}.result`, def.result, sl.auth[name]?.results);
}

const nl = read("node-link.json") as {
  requests: Record<string, { params: unknown; results: unknown }>;
  frames: Record<string, unknown>;
};
for (const [name, def] of Object.entries(registry.nodeLink.requests)) {
  add(`nodeLink.requests.${name}.params`, def.params, nl.requests[name]?.params);
  add(`nodeLink.requests.${name}.result`, def.result, nl.requests[name]?.results);
}
for (const [name, schema] of Object.entries(registry.nodeLink.frames)) add(`nodeLink.frames.${name}`, schema, nl.frames[name]);

const rp = read("relay.json") as {
  requests: Record<string, { params: unknown; results: unknown }>;
  frames: Record<string, unknown>;
};
for (const [name, def] of Object.entries(registry.relayPeer.requests)) {
  add(`relayPeer.requests.${name}.params`, def.params, rp.requests[name]?.params);
  add(`relayPeer.requests.${name}.result`, def.result, rp.requests[name]?.results);
}
for (const [name, schema] of Object.entries(registry.relayPeer.frames)) add(`relayPeer.frames.${name}`, schema, rp.frames[name]);

// --- orphan fixtures: names in a fixture file with no schema ---------------------------

const known = new Set(cases.map((c) => c.path));
const orphans: string[] = [];
const check = (path: string) => {
  if (!known.has(path)) orphans.push(path);
};
for (const name of Object.keys(rpc)) check(`rpc.${name}`);
for (const name of Object.keys(entities)) check(`entities.${name}`);
for (const name of Object.keys(cap.events)) check(`capability.events.${name}`);
for (const name of Object.keys(cap.requests)) check(`capability.requests.${name}.params`);
for (const name of Object.keys(cap.notices)) check(`capability.notices.${name}`);
for (const name of Object.keys(cap.brain)) check(`capability.brain.${name}.params`);
for (const name of Object.keys(cli.requests)) check(`client.requests.${name}.params`);
for (const name of Object.keys(cli.signals)) check(`client.signals.${name}`);
for (const name of Object.keys(cli.notifications)) check(`client.notifications.${name}`);
for (const name of Object.keys(hk)) check(`hooks.${name}.event`);
for (const name of Object.keys(sl.requests)) check(`serverLink.requests.${name}.params`);
for (const name of Object.keys(sl.inbound)) check(`serverLink.inbound.${name}.params`);
for (const name of Object.keys(sl.frames)) check(`serverLink.frames.${name}`);
for (const name of Object.keys(sl.auth)) check(`serverLink.auth.${name}.params`);
for (const name of Object.keys(nl.requests)) check(`nodeLink.requests.${name}.params`);
for (const name of Object.keys(nl.frames)) check(`nodeLink.frames.${name}`);
for (const name of Object.keys(rp.requests)) check(`relayPeer.requests.${name}.params`);
for (const name of Object.keys(rp.frames)) check(`relayPeer.frames.${name}`);

// --- tests -----------------------------------------------------------------------------

describe("fixtures", () => {
  test("every fixture names a schema", () => {
    expect(orphans).toEqual([]);
  });

  test("every schema has at least one example", () => {
    const empty = cases.filter((c) => c.examples.length === 0).map((c) => c.path);
    expect(empty).toEqual([]);
  });

  for (const c of cases) {
    describe(c.path, () => {
      c.examples.forEach((example, i) => {
        test(`example ${i} parses`, () => {
          const r = c.schema.safeParse(example);
          if (!r.success) throw new Error(r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("\n"));
        });

        if (example !== null && typeof example === "object" && !Array.isArray(example)) {
          test(`example ${i} with an unknown field is accepted`, () => {
            const withExtra = { ...(example as Record<string, unknown>), "x-unknown-field": { from: "the future" } };
            const r = c.schema.safeParse(withExtra);
            if (!r.success) throw new Error(r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("\n"));
          });
        }
      });
    });
  }
});

describe("invalid fixtures", () => {
  const byPath = new Map(cases.map((c) => [c.path, c.schema]));
  const invalid = read("invalid.json") as { schema: string; why: string; value: unknown }[];
  for (const item of invalid) {
    test(`${item.schema}: ${item.why}`, () => {
      const schema = byPath.get(item.schema);
      if (!schema) throw new Error(`no schema at ${item.schema}`);
      expect(schema.safeParse(item.value).success).toBe(false);
    });
  }
});
