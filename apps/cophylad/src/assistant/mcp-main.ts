// The `cophyla` MCP server the chat's own agent session is given: a stdio JSON-RPC server, run
// by the daemon's runtime as the harness's child, that hands every `tools/list` and
// `tools/call` to cophylad's loopback `/mcp` endpoints behind the token of this spawn. It
// holds nothing itself: the tools and their words are the brain's, each call is run there and
// crosses the gate as a capability request. No SDK: newline-delimited JSON-RPC is all a stdio
// MCP server needs. A daemon that is not there answers a call as a tool error the model
// reads, so a stopped daemon never breaks the session.

import { request } from "node:http";
import { createInterface } from "node:readline";

/** The longest a call waits: a tool the gate holds on a person answers at once with "held", so this bounds a stuck daemon alone. */
export const CALL_TIMEOUT_MS = 300_000;
const LIST_TIMEOUT_MS = 10_000;
const PROTOCOL = "2025-06-18";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What `/mcp/tools` answers: the tools as the brain declares them, and the server's instructions. */
export interface McpListing {
  tools: { name: string; description: string; schema: Record<string, unknown> }[];
  instructions?: string;
}

/** What `/mcp/call` answers: a tool's text, whether it failed, and a picture when it has one. */
export interface McpCallResult {
  content: string;
  isError?: boolean;
  image?: { mime: string; base64: string };
}

export interface ShimDeps {
  port: number;
  token: string;
  /** One request to cophylad; rejects when it is not there. */
  fetch?: (path: string, body: unknown | undefined, timeoutMs: number) => Promise<unknown>;
  write: (line: string) => void;
}

type Json = Record<string, unknown>;

function post(port: number, token: string, path: string, body: unknown | undefined, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: payload === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
        timeout: timeoutMs,
      },
      (res) => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => (out += d));
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`cophylad answered ${res.statusCode}${out ? `: ${out.slice(0, 300)}` : ""}`));
          try {
            resolve(JSON.parse(out));
          } catch {
            reject(new Error("cophylad's answer is not JSON"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("cophylad did not answer in time")));
    req.on("error", reject);
    req.end(payload);
  });
}

/** A tool's result as MCP content: its text, then its picture. */
export function toolContent(r: McpCallResult): Json {
  const content: Json[] = [{ type: "text", text: r.content }];
  if (r.image) content.push({ type: "image", data: r.image.base64, mimeType: r.image.mime });
  return { content, ...(r.isError ? { isError: true } : {}) };
}

/** Serves one JSON-RPC line; what it answers goes to `write`. */
export function shim(deps: ShimDeps): (line: string) => Promise<void> {
  const call = deps.fetch ?? ((path, body, timeoutMs) => post(deps.port, deps.token, path, body, timeoutMs));
  const out = (o: Json) => deps.write(JSON.stringify(o));
  const listing = async (): Promise<McpListing> => (await call("/mcp/tools", undefined, LIST_TIMEOUT_MS)) as McpListing;
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  return async (line) => {
    let m: { id?: unknown; method?: unknown; params?: Json };
    try {
      m = JSON.parse(line) as typeof m;
    } catch {
      return;
    }
    if (typeof m.method !== "string") return;
    const id = m.id;
    const answers = id !== undefined && id !== null;
    switch (m.method) {
      case "initialize": {
        let instructions: string | undefined;
        try {
          instructions = (await listing()).instructions;
        } catch {
          // The daemon is not there yet: the session's own system prompt says the same, at more length.
        }
        return out({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: typeof m.params?.["protocolVersion"] === "string" ? m.params["protocolVersion"] : PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: "cophyla", version: "1" },
            ...(instructions ? { instructions } : {}),
          },
        });
      }
      case "tools/list": {
        try {
          const tools: McpTool[] = (await listing()).tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema }));
          return out({ jsonrpc: "2.0", id, result: { tools } });
        } catch (e) {
          return out({ jsonrpc: "2.0", id, error: { code: -32000, message: `cophyla is not reachable: ${message(e)}` } });
        }
      }
      case "tools/call": {
        const name = String(m.params?.["name"] ?? "");
        try {
          const r = (await call("/mcp/call", { tool: name, input: m.params?.["arguments"] ?? {} }, CALL_TIMEOUT_MS)) as McpCallResult;
          return out({ jsonrpc: "2.0", id, result: toolContent(r) });
        } catch (e) {
          return out({ jsonrpc: "2.0", id, result: toolContent({ content: `cophyla is not reachable: ${message(e)}. Tell the user in a line and end the turn.`, isError: true }) });
        }
      }
      case "ping":
        return out({ jsonrpc: "2.0", id, result: {} });
      default:
        if (answers) out({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${m.method}` } });
    }
  };
}

if (import.meta.main) {
  const port = Number(process.env["COPHYLA_MCP_PORT"]);
  const token = process.env["COPHYLA_MCP_TOKEN"] ?? "";
  const serve = shim({ port, token, write: (line) => process.stdout.write(line + "\n") });
  // Each line is answered on its own, by its id: a call may take minutes, and a `ping` or a second call behind it must not wait for it.
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim()) void serve(line);
  });
  process.stdin.on("end", () => process.exit(0));
}
