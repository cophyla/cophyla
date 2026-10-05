// The chat's own session's way in, on the loopback listener alone. `/mcp/tools` and
// `/mcp/call` are what its `cophyla` MCP server calls, behind the token of the spawn the
// session runs under: the tools the brain declares, and one call the brain runs. A call may
// take minutes, so its request is given no idle timeout. `/hooks/assistant-part-N` is what
// the hooks installed beside the session's start and its prompt call, behind the hook token:
// each only carries a further part of what the first hook's answer began (see
// `assistant/context.ts`), and answers `{}` when there is none, because a session must never
// break on cophylad's account.

import type { Server } from "bun";
import type { LlmTool, ToolCallResult } from "@cophyla/protocol";
import { PART_HOOK } from "../assistant/claude.ts";
import type { Logger } from "../log.ts";
import { isLoopback, tokenMatches } from "./hooks.ts";

export interface AssistantIngress {
  /** The token of the spawn the session runs under; none while no session runs. */
  mcpToken(): string | undefined;
  /** The token the session's hooks carry. */
  hookToken: string;
  tools(): Promise<{ tools: LlmTool[]; instructions?: string }>;
  call(tool: string, input: unknown): Promise<ToolCallResult>;
  /** The further part `n` of what the session is told at its start or beside a prompt. */
  part(body: unknown, n: number): Promise<unknown>;
}

export type AssistantRoute = { kind: "tools" } | { kind: "call" } | { kind: "part"; n: number };

const PART = new RegExp(`^/hooks/${PART_HOOK}(\\d)$`);

/** Which of the session's endpoints a path names, if any. */
export function assistantRoute(pathname: string): AssistantRoute | undefined {
  if (pathname === "/mcp/tools") return { kind: "tools" };
  if (pathname === "/mcp/call") return { kind: "call" };
  const part = PART.exec(pathname);
  return part ? { kind: "part", n: Number(part[1]) } : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function handleAssistant(req: Request, server: Server<unknown>, route: AssistantRoute, ingress: AssistantIngress, log: Logger): Promise<Response> {
  const ip = server.requestIP(req)?.address;
  if (!isLoopback(ip)) {
    log.warn("refused: not loopback", { route: route.kind, ip });
    return new Response("", { status: 403 });
  }
  if (route.kind === "part") {
    if (req.method !== "POST") return new Response("", { status: 405 });
    if (!tokenMatches(req.headers.get("authorization"), ingress.hookToken)) return new Response("", { status: 401 });
    try {
      return json((await ingress.part(await req.json(), route.n)) ?? {});
    } catch (e) {
      log.warn("a further part of the session's context was not served", { error: e instanceof Error ? e.message : String(e) });
      return json({});
    }
  }
  const token = ingress.mcpToken();
  if (token === undefined || !tokenMatches(req.headers.get("authorization"), token)) {
    log.warn("refused: not the session's token", { route: route.kind });
    return new Response("", { status: 401 });
  }
  if (route.kind === "tools") {
    if (req.method !== "GET") return new Response("", { status: 405 });
    try {
      return json(await ingress.tools());
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 503 });
    }
  }
  if (req.method !== "POST") return new Response("", { status: 405 });
  let body: { tool?: unknown; input?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response("the body is not JSON", { status: 400 });
  }
  if (typeof body.tool !== "string" || body.tool === "") return new Response("no tool named", { status: 400 });
  // A call may be held on a slow capability for minutes: past the server's idle timeout.
  server.timeout(req, 0);
  return json(await ingress.call(body.tool, body.input ?? {}));
}
