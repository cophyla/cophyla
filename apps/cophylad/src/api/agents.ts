// The agents' MCP ingress: `POST /mcp/agents` on the api's loopback listener, behind the hook
// token, which the shim (`cophyla-mcp`) reads from `hook.json` as the hook shim does. The body
// is `{evidence, message}`: what the shim can tell about the session it runs in, and one
// JSON-RPC message as the session sent it. The answer is the JSON-RPC answer, or 204 for a
// notification. Nothing on the LAN reaches it.

import type { Server } from "bun";
import type { Evidence } from "../agentmsg/caller.ts";
import type { Logger } from "../log.ts";
import { isLoopback, tokenMatches } from "./hooks.ts";

export const AGENTS_PATH = "/mcp/agents";

export interface AgentIngress {
  token: string;
  mcp(evidence: Evidence, message: unknown): Promise<unknown>;
}

const EVIDENCE_ENV = ["CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_PID", "CLAUDE_CODE_SESSION_ID", "TETHER_SESSION"];

/** The evidence as the shim reports it, with anything of the wrong kind left out. */
export function readEvidence(raw: unknown): Evidence {
  const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v !== "" && v.length < 4096 ? v : undefined);
  const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined);
  const out: Evidence = {};
  const harness = str(e["harness"]);
  const profile = str(e["profile"]);
  const nonce = str(e["nonce"]);
  const cwd = str(e["cwd"]);
  const pid = int(e["pid"]);
  const ppid = int(e["ppid"]);
  if (harness !== undefined) out.harness = harness;
  if (profile !== undefined) out.profile = profile;
  if (nonce !== undefined) out.nonce = nonce;
  if (cwd !== undefined) out.cwd = cwd;
  if (pid !== undefined) out.pid = pid;
  if (ppid !== undefined) out.ppid = ppid;
  const env = (e["env"] && typeof e["env"] === "object" ? e["env"] : {}) as Record<string, unknown>;
  const vars: Record<string, string> = {};
  for (const name of EVIDENCE_ENV) {
    const v = str(env[name]);
    if (v !== undefined) vars[name] = v;
  }
  out.env = vars;
  return out;
}

export async function handleAgents(req: Request, server: Server<unknown>, ingress: AgentIngress, log: Logger): Promise<Response> {
  if (req.method !== "POST") return new Response("", { status: 405 });
  const ip = server.requestIP(req)?.address;
  if (!isLoopback(ip)) {
    log.warn("agents' MCP refused: not loopback", { ip });
    return new Response("", { status: 403 });
  }
  if (!tokenMatches(req.headers.get("authorization"), ingress.token)) {
    log.warn("agents' MCP refused: bad token", { ip });
    return new Response("", { status: 401 });
  }
  let body: { evidence?: unknown; message?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response("expected JSON", { status: 400 });
  }
  // A call may wait on another node; the shim bounds it.
  server.timeout(req, 0);
  try {
    const answer = await ingress.mcp(readEvidence(body.evidence), body.message);
    if (answer === undefined) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
  } catch (e) {
    log.error("agents' MCP request failed", { error: e });
    const id = (body.message as { id?: unknown } | undefined)?.id;
    if (id === undefined || id === null) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }), { headers: { "content-type": "application/json" } });
  }
}
