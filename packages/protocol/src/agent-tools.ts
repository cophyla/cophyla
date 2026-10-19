// The `cophyla-agents` MCP server's words, defined once in `agent-tools.json`: its name, the
// instructions every session is given with it, and its tools: listing and messaging the
// user's other sessions, and making, using and ending a connection to another user's. The
// native shim (`apps/mcp`) embeds the same file, to answer a session started while the daemon
// is down; cophylad serves it otherwise.

import definition from "../agent-tools.json";

export type AgentToolName = "list_agents" | "send_message" | "create_invite" | "accept_invite" | "end_connection";

export interface AgentTool {
  name: AgentToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

/** The server's name in every harness's configuration; the chat's own session's is `cophyla`. */
export const AGENT_MCP_SERVER = definition.server;
/** What the server tells a session at `initialize`: the envelope, and what a message may and may not do. */
export const AGENT_MCP_INSTRUCTIONS = definition.instructions;
export const AGENT_TOOLS = definition.tools as AgentTool[];
