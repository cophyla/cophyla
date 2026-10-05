// The `cophyla` MCP server the chat's own session is given, one JSON-RPC line at a time,
// against a small stand-in for cophylad's loopback endpoints: `initialize` answers in the
// client's protocol version with the server's instructions; `tools/list` is the daemon's
// tools under MCP's names; `tools/call` posts the tool and its arguments behind the spawn's
// token and answers the text, the picture and whether it failed. A daemon that is not there,
// or refuses the token, is a tool error the model reads, never a broken server; a line that
// asks nothing is answered nothing.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { CALL_TIMEOUT_MS, shim, toolContent } from "../src/assistant/mcp-main.ts";

const TOKEN = "spawn-token-0123456789";
const TOOLS = [
  { name: "agents", description: "The agent sessions.", schema: { type: "object", properties: { status: { type: "array" } } } },
  { name: "say", description: "Says a line.", schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
];

interface Seen {
  method: string;
  path: string;
  authorization: string | null;
  body?: unknown;
}

let server: Server<unknown>;
let port: number;
/** A port nothing listens on: a daemon that is not there. */
let deadPort: number;
const seen: Seen[] = [];
let instructions: string | undefined;
let results: Record<string, unknown>;

beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const entry: Seen = { method: req.method, path: url.pathname, authorization: req.headers.get("authorization") };
      if (req.method === "POST") entry.body = await req.json();
      seen.push(entry);
      if (entry.authorization !== `Bearer ${TOKEN}`) return new Response("", { status: 401 });
      if (url.pathname === "/mcp/tools" && req.method === "GET") return Response.json({ tools: TOOLS, ...(instructions !== undefined ? { instructions } : {}) });
      if (url.pathname === "/mcp/call" && req.method === "POST") {
        const tool = (entry.body as { tool: string }).tool;
        if (tool === "garbled") return new Response("<html>", { status: 200 });
        return tool in results ? Response.json(results[tool]) : new Response("no such tool", { status: 500 });
      }
      return new Response("", { status: 404 });
    },
  });
  port = server.port!;
  const gone = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  deadPort = gone.port!;
  await gone.stop(true);
});

afterAll(async () => {
  await server.stop(true);
});

beforeEach(() => {
  seen.length = 0;
  instructions = "Cophyla's tools: call them, never describe them.";
  results = { agents: { content: "2 sessions" } };
});

/** A shim and what it wrote, parsed; `ask` serves one message and answers what was written for it. */
function served(opts: { port?: number; token?: string } = {}) {
  const out: Record<string, unknown>[] = [];
  const serve = shim({ port: opts.port ?? port, token: opts.token ?? TOKEN, write: (line) => out.push(JSON.parse(line) as Record<string, unknown>) });
  return {
    out,
    line: serve,
    ask: async (message: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => {
      const before = out.length;
      await serve(JSON.stringify({ jsonrpc: "2.0", ...message }));
      expect(out.length - before).toBeLessThanOrEqual(1);
      return out[before];
    },
  };
}

describe("initialize", () => {
  test("it answers in the client's protocol version, as a server with tools, with the daemon's instructions", async () => {
    const s = served();
    expect(await s.ask({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } } })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "cophyla", version: "1" }, instructions: "Cophyla's tools: call them, never describe them." },
    });
    expect(seen).toEqual([{ method: "GET", path: "/mcp/tools", authorization: `Bearer ${TOKEN}` }]);
  });

  test("a client that names no version gets the server's own; a daemon with no instructions, or none there, still gets an answer", async () => {
    instructions = undefined;
    const bare = await served().ask({ id: "a", method: "initialize" });
    expect(bare).toEqual({ jsonrpc: "2.0", id: "a", result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cophyla", version: "1" } } });
    const down = await served({ port: deadPort }).ask({ id: 2, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(down).toEqual({ jsonrpc: "2.0", id: 2, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cophyla", version: "1" } } });
  });
});

describe("tools/list", () => {
  test("the daemon's tools, each schema under MCP's name for it", async () => {
    const r = await served().ask({ id: 3, method: "tools/list" });
    expect(r).toEqual({ jsonrpc: "2.0", id: 3, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })) } });
  });

  test("a daemon that is not there, or refuses the token, is an error that says so", async () => {
    const down = await served({ port: deadPort }).ask({ id: 4, method: "tools/list" });
    expect(down).toMatchObject({ jsonrpc: "2.0", id: 4, error: { code: -32000 } });
    expect((down!["error"] as { message: string }).message).toStartWith("cophyla is not reachable: ");
    expect(down!["result"]).toBeUndefined();
    const refused = await served({ token: "another" }).ask({ id: 5, method: "tools/list" });
    expect(refused).toEqual({ jsonrpc: "2.0", id: 5, error: { code: -32000, message: "cophyla is not reachable: cophylad answered 401" } });
  });
});

describe("tools/call", () => {
  test("the tool and its arguments are posted behind the spawn's token; the answer is its text", async () => {
    const r = await served().ask({ id: 6, method: "tools/call", params: { name: "agents", arguments: { status: ["busy"] } } });
    expect(r).toEqual({ jsonrpc: "2.0", id: 6, result: { content: [{ type: "text", text: "2 sessions" }] } });
    expect(seen).toEqual([{ method: "POST", path: "/mcp/call", authorization: `Bearer ${TOKEN}`, body: { tool: "agents", input: { status: ["busy"] } } }]);
    // no arguments are an empty input
    await served().ask({ id: 7, method: "tools/call", params: { name: "agents" } });
    expect(seen[1]!.body).toEqual({ tool: "agents", input: {} });
  });

  test("a picture follows the text, and a tool that failed says so", async () => {
    results = { shot: { content: "the desktop", image: { mime: "image/png", base64: "iVBORw0KGgo=" } }, broken: { content: "no such session", isError: true } };
    const shot = await served().ask({ id: 8, method: "tools/call", params: { name: "shot", arguments: {} } });
    expect(shot!["result"]).toEqual({ content: [{ type: "text", text: "the desktop" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] });
    const broken = await served().ask({ id: 9, method: "tools/call", params: { name: "broken", arguments: {} } });
    expect(broken!["result"]).toEqual({ content: [{ type: "text", text: "no such session" }], isError: true });
  });

  test("a daemon that is not there, refuses, fails or answers something else is a tool error the model reads, never a protocol error", async () => {
    const cases: [ReturnType<typeof served>, string, RegExp][] = [
      [served({ port: deadPort }), "agents", /^cophyla is not reachable: .+\. Tell the user in a line and end the turn\.$/],
      [served({ token: "another" }), "agents", /^cophyla is not reachable: cophylad answered 401\. Tell the user/],
      [served(), "unknown", /^cophyla is not reachable: cophylad answered 500: no such tool\. Tell the user/],
      [served(), "garbled", /^cophyla is not reachable: cophylad's answer is not JSON\. Tell the user/],
    ];
    for (const [s, name, words] of cases) {
      const r = await s.ask({ id: 10, method: "tools/call", params: { name, arguments: {} } });
      expect(r!["error"]).toBeUndefined();
      const result = r!["result"] as { content: { type: string; text: string }[]; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.text).toMatch(words);
    }
  });

  test("a call waits as long as cophylad lets a tool run, and a daemon's own fetch may stand in", async () => {
    const asked: { path: string; body: unknown; timeoutMs: number }[] = [];
    const out: string[] = [];
    const serve = shim({
      port: 0,
      token: "",
      write: (line) => out.push(line),
      fetch: async (path, body, timeoutMs) => {
        asked.push({ path, body, timeoutMs });
        return path === "/mcp/tools" ? { tools: [] } : { content: "ok" };
      },
    });
    await serve(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow", arguments: { a: 1 } } }));
    await serve(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(asked).toEqual([
      { path: "/mcp/call", body: { tool: "slow", input: { a: 1 } }, timeoutMs: CALL_TIMEOUT_MS },
      { path: "/mcp/tools", body: undefined, timeoutMs: 10_000 },
    ]);
    expect(CALL_TIMEOUT_MS).toBe(300_000);
    expect(out.map((l) => JSON.parse(l) as { id: number }).map((m) => m.id)).toEqual([1, 2]);
  });

  test("each line is answered under its own id, whichever ends first", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const out: { id: number }[] = [];
    const serve = shim({
      port: 0,
      token: "",
      write: (line) => out.push(JSON.parse(line) as { id: number }),
      fetch: async (_path, body) => {
        if ((body as { tool?: string } | undefined)?.tool === "slow") await held;
        return { content: "ok" };
      },
    });
    const slow = serve(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow" } }));
    await serve(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }));
    await serve(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fast" } }));
    expect(out.map((m) => m.id)).toEqual([2, 3]);
    release();
    await slow;
    expect(out.map((m) => m.id)).toEqual([2, 3, 1]);
  });
});

describe("everything else", () => {
  test("a ping is answered; a method it has not is an error to a request and nothing to a notification", async () => {
    const s = served();
    expect(await s.ask({ id: 11, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 11, result: {} });
    expect(await s.ask({ id: 12, method: "resources/list" })).toEqual({ jsonrpc: "2.0", id: 12, error: { code: -32601, message: "method not found: resources/list" } });
    expect(await s.ask({ method: "notifications/initialized" })).toBeUndefined();
    expect(await s.ask({ id: null, method: "notifications/cancelled", params: { requestId: 6 } })).toBeUndefined();
    expect(seen).toEqual([]);
  });

  test("a line that is not JSON, or names no method, is answered nothing", async () => {
    const s = served();
    await s.line("{not json");
    await s.line("");
    await s.line(JSON.stringify({ jsonrpc: "2.0", id: 13, result: {} }));
    await s.line(JSON.stringify({ jsonrpc: "2.0", id: 14, method: 7 }));
    expect(s.out).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("a tool's result as MCP content: its text, then its picture, and the failure only when it failed", () => {
    expect(toolContent({ content: "ok" })).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(toolContent({ content: "ok", isError: false })).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(toolContent({ content: "", isError: true, image: { mime: "image/jpeg", base64: "/9j/" } })).toEqual({ content: [{ type: "text", text: "" }, { type: "image", data: "/9j/", mimeType: "image/jpeg" }], isError: true });
  });
});
