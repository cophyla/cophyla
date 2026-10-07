// The `cophyla-agents` tools as every harness is given them: two, with what each takes, and
// the hints that let a harness run them without asking (Codex's default approval reads them).

import { describe, expect, test } from "bun:test";
import { AGENT_MCP_INSTRUCTIONS, AGENT_MCP_SERVER, AGENT_TOOLS } from "../src/index.ts";

describe("agent tools", () => {
  test("the server is cophyla-agents, apart from the chat's own cophyla, and says what a message is", () => {
    expect(AGENT_MCP_SERVER).toBe("cophyla-agents");
    expect(AGENT_MCP_INSTRUCTIONS).toContain("<cophyla-message");
    expect(AGENT_MCP_INSTRUCTIONS).toContain("reply_to");
  });

  test("list_agents reads, send_message writes and reaches nothing outside", () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual(["list_agents", "send_message"]);
    const [list, send] = AGENT_TOOLS;
    expect(list!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(send!.annotations).toMatchObject({ destructiveHint: false, openWorldHint: false });
    expect(send!.inputSchema).toMatchObject({ type: "object", required: ["to", "text"] });
    expect(Object.keys((send!.inputSchema as { properties: object }).properties)).toEqual(["to", "text", "reply_to"]);
  });
});
