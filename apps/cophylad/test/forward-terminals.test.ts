// Where the brain's terminal requests go on the primary: a first prompt to the node whose
// terminal it names, or here; the terminal list with the mirrors' rows merged in, one row per id.
// And the ask before the brain types a first prompt into a CLI of the user's.

import { describe, expect, test } from "bun:test";
import type { Terminal } from "@cophyla/protocol";
import { promptAsk } from "../src/brain-link/methods.ts";
import { merges, routeOf } from "../src/nodes/forward.ts";
import type { ForwardHost } from "../src/nodes/forward.ts";

const row = (id: string, node: string, extra: Partial<Terminal> = {}): Terminal => ({ id, node, host: "h", argv0: "pwsh.exe", cwd: "C:\\D\\Unreal", cols: 120, rows: 32, status: "running", windows: 0, startedAt: 1, ...extra });

const host = {
  selfId: () => "node_a",
  ownerOfTerminal: (id: string) => (id === "t-b" ? "node_b" : undefined),
  mirrorTerminals: () => [row("t-b", "node_b", { harness: "codex" })],
} as unknown as ForwardHost;

describe("the brain's terminal requests on the primary", () => {
  test("a first prompt goes to the node whose terminal it names, or runs here", () => {
    expect(routeOf("terminal.prompt", { terminal: "t-b", text: "x" }, host)).toEqual({ kind: "node", node: "node_b" });
    expect(routeOf("terminal.prompt", { terminal: "t-a", text: "x" }, host)).toEqual({ kind: "local" });
  });

  test("the list is this node's rows and the mirrors', one per id", async () => {
    expect(routeOf("terminal.list", {}, host)).toEqual({ kind: "merge" });
    const merged = (await merges["terminal.list"]!({ terminals: [row("t-a", "node_a"), row("t-b", "node_b")] }, {}, host)) as { terminals: Terminal[] };
    expect(merged.terminals.map((t) => t.id)).toEqual(["t-a", "t-b"]);
  });
});

describe("the ask before the brain types a first prompt into a waiting CLI", () => {
  test("names the CLI and its folder, and carries the prompt", () => {
    expect(promptAsk({ terminal: "t-b", text: "Look into the Unreal MCP" }, row("t-b", "node_b", { harness: "codex" }))).toEqual({ title: "Give the Codex CLI in Unreal its first prompt?", detail: "Look into the Unreal MCP" });
    expect(promptAsk({ terminal: "t-x", text: "hi" }, undefined)).toEqual({ title: "Give the CLI in terminal t-x its first prompt?", detail: "hi" });
  });
});
