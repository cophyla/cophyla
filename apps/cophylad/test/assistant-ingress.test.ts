// The chat's own session's way in, on a real loopback listener: `/mcp/tools` and `/mcp/call`
// answer only a request that carries the token of the spawn the session runs under, and none
// while no session runs; the tools are the brain's, a call names its tool and is handed on
// with its input; `/hooks/assistant-part-N` answers only the hook token, hands the hook's body
// and the part's number on, and answers `{}` whatever goes wrong, since a session must never
// break on cophylad's account. Nothing is answered to an address that is not loopback.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { LlmTool, ToolCallResult } from "@cophyla/protocol";
import { assistantRoute, handleAssistant } from "../src/api/assistant.ts";
import type { AssistantIngress } from "../src/api/assistant.ts";
import { silentLogger } from "../src/log.ts";

const MCP_TOKEN = "spawn-token-0123456789";
const HOOK_TOKEN = "hook-token-9876543210";
const TOOLS: LlmTool[] = [{ name: "agents", description: "The agent sessions.", schema: { type: "object", properties: {} } }];

/** What the ingress was asked, and what it answers next. */
const seen = { tools: 0, calls: [] as { tool: string; input: unknown }[], parts: [] as { body: unknown; n: number }[] };
let token: string | undefined;
let toolsAnswer: () => Promise<{ tools: LlmTool[]; instructions?: string }>;
let callAnswer: ToolCallResult;
let partAnswer: () => Promise<unknown>;

const ingress: AssistantIngress = {
  mcpToken: () => token,
  hookToken: HOOK_TOKEN,
  tools: () => {
    seen.tools++;
    return toolsAnswer();
  },
  call: async (tool, input) => {
    seen.calls.push({ tool, input });
    return callAnswer;
  },
  part: (body, n) => {
    seen.parts.push({ body, n });
    return partAnswer();
  },
};

let server: Server<unknown>;
let origin: string;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const route = assistantRoute(new URL(req.url).pathname);
      return route ? handleAssistant(req, srv, route, ingress, silentLogger) : new Response("", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
});

beforeEach(() => {
  seen.tools = 0;
  seen.calls.length = 0;
  seen.parts.length = 0;
  token = MCP_TOKEN;
  toolsAnswer = async () => ({ tools: TOOLS, instructions: "Cophyla's tools." });
  callAnswer = { content: "2 sessions" };
  partAnswer = async () => ({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "part two" } });
});

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("the paths", () => {
  test("the two MCP endpoints and a further part's hook are the session's; nothing else is", () => {
    expect(assistantRoute("/mcp/tools")).toEqual({ kind: "tools" });
    expect(assistantRoute("/mcp/call")).toEqual({ kind: "call" });
    expect(assistantRoute("/hooks/assistant-part-1")).toEqual({ kind: "part", n: 1 });
    expect(assistantRoute("/hooks/assistant-part-3")).toEqual({ kind: "part", n: 3 });
    for (const path of ["/", "/mcp", "/mcp/", "/mcp/tools/", "/mcp/call/x", "/hooks/claude", "/hooks/assistant-part-", "/hooks/assistant-part-12", "/hooks/assistant-part-x", "/hooks/assistant-part-1/", "/x/hooks/assistant-part-1"]) {
      expect(assistantRoute(path)).toBeUndefined();
    }
  });
});

describe("who is answered", () => {
  test("an address that is not loopback is refused before anything is read", async () => {
    const far = { requestIP: () => ({ address: "192.168.1.20", family: "IPv4", port: 50000 }), timeout() {} } as unknown as Server<unknown>;
    for (const route of [{ kind: "tools" }, { kind: "call" }, { kind: "part", n: 1 }] as const) {
      const req = new Request("http://192.168.1.9/x", { method: route.kind === "tools" ? "GET" : "POST", headers: bearer(route.kind === "part" ? HOOK_TOKEN : MCP_TOKEN), ...(route.kind === "tools" ? {} : { body: "{}" }) });
      const res = await handleAssistant(req, far, route, ingress, silentLogger);
      expect(res.status).toBe(403);
    }
    expect(seen).toEqual({ tools: 0, calls: [], parts: [] });
  });

  test("the MCP endpoints answer the spawn's token alone: none, another, or the hook token is 401", async () => {
    for (const headers of [{}, bearer("another-token-0123456789"), bearer(HOOK_TOKEN), { authorization: MCP_TOKEN }, { authorization: `Basic ${MCP_TOKEN}` }] as Record<string, string>[]) {
      expect((await fetch(`${origin}/mcp/tools`, { headers })).status).toBe(401);
      expect((await post("/mcp/call", { tool: "agents" }, headers)).status).toBe(401);
    }
    expect(seen).toEqual({ tools: 0, calls: [], parts: [] });
  });

  test("while no session runs there is no token, and nothing is answered whatever the request carries", async () => {
    token = undefined;
    for (const headers of [{}, bearer(MCP_TOKEN), bearer("undefined"), { authorization: "Bearer " }] as Record<string, string>[]) {
      expect((await fetch(`${origin}/mcp/tools`, { headers })).status).toBe(401);
      expect((await post("/mcp/call", { tool: "agents" }, headers)).status).toBe(401);
    }
    expect(seen).toEqual({ tools: 0, calls: [], parts: [] });
  });

  test("a further part answers the hook token alone, not the spawn's", async () => {
    for (const headers of [{}, bearer(MCP_TOKEN), bearer("another")] as Record<string, string>[]) {
      expect((await post("/hooks/assistant-part-1", { hook_event_name: "SessionStart" }, headers)).status).toBe(401);
    }
    expect(seen.parts).toEqual([]);
    // and it needs no session's token to be there
    token = undefined;
    expect((await post("/hooks/assistant-part-1", { hook_event_name: "SessionStart" }, bearer(HOOK_TOKEN))).status).toBe(200);
  });
});

describe("the tools and a call", () => {
  test("GET /mcp/tools is the tools the brain declares, with what their server says of itself", async () => {
    const res = await fetch(`${origin}/mcp/tools`, { headers: bearer(MCP_TOKEN) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ tools: TOOLS, instructions: "Cophyla's tools." });
    expect(seen.tools).toBe(1);
    expect((await post("/mcp/tools", {}, bearer(MCP_TOKEN))).status).toBe(405);
  });

  test("a brain that cannot list them is a 503 with why", async () => {
    toolsAnswer = async () => {
      throw new Error("the brain is not running");
    };
    const res = await fetch(`${origin}/mcp/tools`, { headers: bearer(MCP_TOKEN) });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("the brain is not running");
  });

  test("POST /mcp/call hands the tool and its input on and answers the result; no input is an empty one", async () => {
    callAnswer = { content: "a picture", isError: true, image: { mime: "image/png", base64: "AAAA" } };
    const res = await post("/mcp/call", { tool: "agents", input: { status: ["busy"] } }, bearer(MCP_TOKEN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(callAnswer);
    expect((await post("/mcp/call", { tool: "tasks" }, bearer(MCP_TOKEN))).status).toBe(200);
    expect(seen.calls).toEqual([
      { tool: "agents", input: { status: ["busy"] } },
      { tool: "tasks", input: {} },
    ]);
  });

  test("a call that names no tool, or is not JSON, is a 400 and nothing is run; a GET is not a call", async () => {
    for (const body of [{}, { input: { a: 1 } }, { tool: "" }, { tool: 7 }]) {
      const res = await post("/mcp/call", body, bearer(MCP_TOKEN));
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("no tool named");
    }
    const bad = await post("/mcp/call", "{not json", bearer(MCP_TOKEN));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe("the body is not JSON");
    expect((await fetch(`${origin}/mcp/call`, { headers: bearer(MCP_TOKEN) })).status).toBe(405);
    expect(seen.calls).toEqual([]);
  });
});

describe("a further part", () => {
  test("the hook's body and the part's number are handed on, and the answer is the hook's", async () => {
    const body = { hook_event_name: "UserPromptSubmit", session_id: "3f0c", prompt_id: "p1", prompt: "what is open?" };
    const res = await post("/hooks/assistant-part-2", body, bearer(HOOK_TOKEN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "part two" } });
    expect(seen.parts).toEqual([{ body, n: 2 }]);
    expect((await fetch(`${origin}/hooks/assistant-part-2`, { headers: bearer(HOOK_TOKEN) })).status).toBe(405);
  });

  test("with nothing to carry, a module that throws, or a body that is not JSON, the answer is {}", async () => {
    partAnswer = async () => undefined;
    const none = await post("/hooks/assistant-part-1", { hook_event_name: "SessionStart" }, bearer(HOOK_TOKEN));
    expect([none.status, await none.json()]).toEqual([200, {}]);
    partAnswer = async () => {
      throw new Error("the module went");
    };
    const thrown = await post("/hooks/assistant-part-1", { hook_event_name: "SessionStart" }, bearer(HOOK_TOKEN));
    expect([thrown.status, await thrown.json()]).toEqual([200, {}]);
    const before = seen.parts.length;
    const bad = await post("/hooks/assistant-part-1", "{not json", bearer(HOOK_TOKEN));
    expect([bad.status, await bad.json()]).toEqual([200, {}]);
    expect(seen.parts.length).toBe(before);
  });
});
