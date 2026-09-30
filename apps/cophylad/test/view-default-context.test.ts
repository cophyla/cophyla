// The default view's Context overlay, its parts that need no page (model.ts): the head's tokens
// per tier, and the brain's messages a block at a time, each labelled by whose it is and what
// kind: text, a tool call with its input, a result as the model reads it, a picture.

import { describe, expect, test } from "bun:test";
import { contextBlocks, contextTokenWords } from "../views/default/model.ts";

describe("view default context", () => {
  test("the head says each tier's tokens, then the total", () => {
    expect(contextTokenWords({ situation: 420, working: 3100.4, loaded: 0, log: 61, total: 3581 })).toBe("situation 420 · log 61 · working 3,100 · loaded 0 · 3,581 tokens");
  });

  test("messages a block at a time: text as it is (none when empty), a call with its input, a result or its stub, a picture by kind", () => {
    const blocks = contextBlocks([
      { role: "user", content: [{ type: "text", text: "what is open?" }] },
      { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "c1", name: "tasks", input: { action: "List" } }] },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "c1", content: "[r4 collapsed: tasks List. Say context expand r4 to see it again.]" },
          { type: "tool_result", toolUseId: "c2", content: "no such task", isError: true },
          { type: "image", mime: "image/jpeg", base64: "AAAA" },
        ],
      },
      { role: "assistant", content: [{ type: "tool_use", id: "c3", name: "agents", input: undefined }, { type: "text", text: "" }] },
    ]);
    expect(blocks).toEqual([
      { role: "user", label: "user", text: "what is open?" },
      { role: "assistant", label: "assistant", text: "Looking." },
      { role: "assistant", label: "assistant · calls tasks", text: '{\n  "action": "List"\n}' },
      { role: "user", label: "user · result", text: "[r4 collapsed: tasks List. Say context expand r4 to see it again.]" },
      { role: "user", label: "user · result, an error", text: "no such task" },
      { role: "user", label: "user · picture", text: "[image/jpeg]" },
      { role: "assistant", label: "assistant · calls agents", text: "{}" },
    ]);
    expect(contextBlocks([])).toEqual([]);
  });
});
