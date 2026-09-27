// The default view's message parts (model.ts): a run of text and refs is one flow with a slot where each
// ref's chip goes, so the chip sits in its sentence; a quote stands apart and ends the run. A
// chip whose words may be cut short says them whole in its title.

import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@cophyla/protocol";
import { chipTitle, CHIP_CHARS, parts, slot } from "../views/default/model.ts";

const file = (path: string, line?: number): Extract<ContentBlock, { type: "ref" }> => ({ type: "ref", file: { node: "node_1", path, ...(line ? { line } : {}) } });

describe("view default blocks", () => {
  test("a ref between words is a slot in one flow, and a quote starts the next", () => {
    const plan = file("C:/site/plan.md", 5);
    const notes = file("C:/site/notes.md");
    const blocks: ContentBlock[] = [{ type: "text", text: "According to " }, plan, { type: "text", text: ", what's next is:" }, { type: "quote", text: "1. Ship it" }, notes, { type: "text", text: " has more." }];
    const out = parts(blocks);
    expect(out.map((p) => p.type)).toEqual(["flow", "quote", "flow"]);
    expect(out[0]).toEqual({ type: "flow", text: `According to ${slot(0)}, what's next is:`, refs: [plan] });
    expect(out[2]).toEqual({ type: "flow", text: `${slot(0)} has more.`, refs: [notes] });
  });

  test("text split by nothing is one text, and refs in a row keep their order", () => {
    const out = parts([{ type: "text", text: "Two " }, { type: "text", text: "parts " }, file("a.md"), file("b.md")]);
    expect(out).toEqual([{ type: "flow", text: `Two parts ${slot(0)}${slot(1)}`, refs: [file("a.md"), file("b.md")] }]);
  });

  test("a chip's title says its words whole only when they may be cut short", () => {
    expect(chipTitle("plan.md:5", "Show it in Files")).toBe("Show it in Files");
    const long = "claude: Fix the build failure in the payments service";
    expect(long.length).toBeGreaterThan(CHIP_CHARS);
    expect(chipTitle(long, "Open its tab")).toBe(`${long}\nOpen its tab`);
    expect(chipTitle(long, "")).toBe(long);
  });
});
