// The real Gemini API, skipped without `GEMINI_API_KEY`: one completion with a declared tool
// that the prompt forces, then the tool_result round trip, so the REST field names the fake
// assumes (thoughtSignature, functionCall, functionResponse, usageMetadata, finishReason) are
// confirmed against the service, and so is the schema subset it accepts for a declaration.
// Costs two tiny calls on the fast tier.
//
//   GEMINI_API_KEY=… bun test apps/cophylad/test/llm-gemini.live.test.ts

import { describe, expect, test } from "bun:test";
import type { LlmComplete, LlmDelta } from "@cophyla/protocol";
import { parseConfig } from "../src/config/load.ts";
import { Llm } from "../src/llm/index.ts";
import { silentLogger } from "../src/log.ts";

const KEY = process.env["GEMINI_API_KEY"];

describe.skipIf(!KEY)("gemini live", () => {
  const llm = new Llm({ config: parseConfig("").providers, log: silentLogger, env: { GEMINI_API_KEY: KEY } });
  const tools = [
    {
      name: "files",
      description: "Read a file. Always call this before answering a question about a file.",
      // with the keywords zod emits for `.positive()` and `.record()`, which cleanSchema must fold or strip
      schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["Read"] },
          path: { type: "string" },
          lines: { type: "integer", exclusiveMinimum: 0, description: "How many lines" },
          args: { type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "string" } },
        },
        required: ["action", "path"],
        additionalProperties: false,
      },
    },
  ];

  test(
    "a forced tool call streams, carries a signature, and its result is understood",
    async () => {
      const deltas: LlmDelta[] = [];
      const first: LlmComplete = {
        model: { tier: "fast" },
        system: "You are terse. You must call the files tool with action Read on the path the user names before answering; never answer from memory.",
        messages: [{ role: "user", content: [{ type: "text", text: "What is the first line of notes.md? Read it with the tool." }] }],
        tools,
        maxTokens: 300,
      };
      const r = await llm.complete(first, { onDelta: (d) => deltas.push(d) });
      expect(r.stopReason).toBe("tool_use");
      const call = r.content.find((b) => b.type === "tool_use");
      expect(call).toBeDefined();
      expect(call!.type === "tool_use" && call!.name).toBe("files");
      expect(deltas.some((d) => d.type === "tool_use")).toBe(true);
      expect(r.usage.in).toBeGreaterThan(0);
      expect(r.model).toContain("gemini");

      const follow: LlmComplete = {
        ...first,
        messages: [
          ...first.messages,
          { role: "assistant", content: r.content },
          { role: "user", content: [{ type: "tool_result", toolUseId: (call as { id: string }).id, content: "1\tThe quick brown fox." }] },
        ],
      };
      const r2 = await llm.complete(follow);
      expect(r2.stopReason).toBe("end");
      const text = r2.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      expect(text.toLowerCase()).toContain("fox");
    },
    60_000,
  );
});
