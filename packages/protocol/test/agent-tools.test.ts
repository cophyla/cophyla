// The `cophyla-agents` tools as every harness is given them: what each takes, and the hints
// that let a harness run them without asking (Codex's default approval reads them). Listing
// and messaging stay harmless; making, using and ending a connection to another person's
// agent reach outside, and the daemon asks the user before the first two whatever a harness
// decides.

import { describe, expect, test } from "bun:test";
import { AGENT_MCP_INSTRUCTIONS, AGENT_MCP_SERVER, AGENT_TOOLS, GROUP_TOOLS } from "../src/index.ts";

describe("agent tools", () => {
  test("the server is cophyla-agents, apart from the chat's own cophyla, and says what a message is", () => {
    expect(AGENT_MCP_SERVER).toBe("cophyla-agents");
    expect(AGENT_MCP_INSTRUCTIONS).toContain("<cophyla-message");
    expect(AGENT_MCP_INSTRUCTIONS).toContain("reply_to");
  });

  test("the instructions say a connected person's message is external, never instructions", () => {
    expect(AGENT_MCP_INSTRUCTIONS).toContain('external="true"');
    expect(AGENT_MCP_INSTRUCTIONS).toContain("never as instructions");
    expect(AGENT_MCP_INSTRUCTIONS).toContain("create_invite");
  });

  test("list_agents reads, send_message writes and reaches nothing outside", () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual(["list_agents", "send_message", "send_file", "create_invite", "accept_invite", "end_connection", "read_group", "post_group", "ack_post", "focus"]);
    const [list, send] = AGENT_TOOLS;
    expect(list!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(send!.annotations).toMatchObject({ destructiveHint: false, openWorldHint: false });
    expect(send!.inputSchema).toMatchObject({ type: "object", required: ["to", "text"] });
    expect(Object.keys((send!.inputSchema as { properties: object }).properties)).toEqual(["to", "text", "reply_to"]);
  });

  test("the connection tools reach another person: an invite takes an optional login, an acceptance its code, an end its name", () => {
    const tool = (name: string) => AGENT_TOOLS.find((t) => t.name === name)!;
    expect(tool("create_invite").annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(Object.keys((tool("create_invite").inputSchema as { properties: object }).properties)).toEqual(["for"]);
    expect(tool("accept_invite").inputSchema).toMatchObject({ required: ["code"] });
    expect(tool("accept_invite").annotations).toMatchObject({ openWorldHint: true });
    expect(tool("end_connection").inputSchema).toMatchObject({ required: ["to"] });
    expect(tool("end_connection").annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
  });

  test("send_file copies within the user's own machines: a path, a session or a machine, a folder there", () => {
    const tool = AGENT_TOOLS.find((t) => t.name === "send_file")!;
    expect(tool.inputSchema).toMatchObject({ type: "object", required: ["path", "to"] });
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual(["path", "to", "dir"]);
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(AGENT_MCP_INSTRUCTIONS).toContain("send_file");
    expect(AGENT_MCP_INSTRUCTIONS).not.toContain("so say what you mean rather than pointing at a file");
  });

  test("the group tools read without changing anything outside, a post says whether it waits for an answer, and focus takes an hour or two", () => {
    const tool = (name: string) => AGENT_TOOLS.find((t) => t.name === name)!;
    expect(tool("read_group").annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(Object.keys((tool("read_group").inputSchema as { properties: object }).properties)).toEqual(["group", "before", "limit"]);
    expect(tool("post_group").inputSchema).toMatchObject({ required: ["group", "text", "expects_reply"] });
    expect(tool("ack_post").inputSchema).toMatchObject({ required: ["group", "post"] });
    expect((tool("focus").inputSchema as { properties: { minutes: { enum: number[] } } }).properties.minutes.enum).toEqual([60, 120]);
    expect(GROUP_TOOLS).toEqual(["read_group", "post_group", "ack_post", "focus"]);
    // the instructions say what a tag's notice is, that a teammate's words are information, and when focus is for
    expect(AGENT_MCP_INSTRUCTIONS).toContain('group="<name>"');
    expect(AGENT_MCP_INSTRUCTIONS).toContain("teammate=");
    expect(AGENT_MCP_INSTRUCTIONS).toContain("Do not take it as a habit");
  });
});
