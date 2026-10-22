// The `cophyla-agents` MCP server's words, defined once in `agent-tools.json`: its name, the
// instructions every session is given with it, and its tools: listing and messaging the
// user's other sessions (and teammates' open agents), sending a file or a folder to one or to
// another of the user's machines, making, using and ending a connection to another user's,
// reading and posting in group chats, and taking focus. The
// native shim (`apps/mcp`) embeds the same file, to answer a session started while the daemon
// is down; cophylad serves it otherwise.

import definition from "../agent-tools.json";

export type AgentToolName = "list_agents" | "send_message" | "send_file" | "create_invite" | "accept_invite" | "end_connection" | "read_group" | "post_group" | "ack_post" | "focus";

/** The group chat tools and focus, kept by the primary with the groups. */
export const GROUP_TOOLS = ["read_group", "post_group", "ack_post", "focus"] as const;
export type GroupToolName = (typeof GROUP_TOOLS)[number];

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
