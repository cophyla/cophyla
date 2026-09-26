// How a reply is cut for an engine that makes each piece whole before any of it plays: the
// first sentence alone, a long first sentence at its first clause, later pieces growing with
// what is already queued, lines as sentences, and never a word lost or split.

import { describe, expect, test } from "bun:test";
import { FIRST_PIECE, GROWTH, MAX_PIECE, speechPieces } from "../src/voice/pieces.ts";

const words = (s: string) => s.replace(/[.]/g, "").split(/\s+/).filter(Boolean);

describe("speech pieces", () => {
  test("the first sentence goes alone, however short the next", () => {
    expect(speechPieces("I didn't quite catch that. Could you repeat or clarify what you need?")).toEqual([
      "I didn't quite catch that.",
      "Could you repeat or clarify what you need?",
    ]);
  });

  test("a first sentence too short to say alone waits for the next clause", () => {
    const pieces = speechPieces("No, my mistake. The agent moved past that and is actively running commands in the editor right now, trying to inspect Geometry Script functions and check logs.");
    expect(pieces[0]).toBe("No, my mistake.");
    expect(pieces.every((p) => p.length <= MAX_PIECE)).toBe(true);
    expect(pieces.length).toBeGreaterThanOrEqual(2);
  });

  test("a long sentence is cut at its clauses, and later pieces grow with what is queued", () => {
    const text =
      "You have four active sessions running right now. In orchestrator, one is setting up your wake words and speech tools; in Faircase, two are running, one temporarily removing an MCP for Codex and another running the local stack; and in Source, the agent is finishing the Perforce sync so it can continue on villager gathering.";
    const pieces = speechPieces(text);
    expect(pieces[0]).toBe("You have four active sessions running right now.");
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    // The second may be no longer than the first can cover while it plays.
    expect(pieces[1]!.length).toBeLessThanOrEqual(Math.max(FIRST_PIECE, pieces[0]!.length * GROWTH));
    expect(words(pieces.join(" "))).toEqual(words(text));
  });

  test("a sentence with no clause to cut at stays whole, up to the longest piece", () => {
    const one = "The agent working on the villager gathering system is still waiting for your approval to close the Unreal Editor so it can rebuild the project.";
    expect(speechPieces(`${one} Meanwhile, your desktop is running low on memory.`)).toEqual([one, "Meanwhile, your desktop is running low on memory."]);
    const endless = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const cut = speechPieces(endless);
    expect(cut.every((p) => p.length <= MAX_PIECE)).toBe(true);
    expect(cut.join(" ")).toBe(`${endless}.`);
  });

  test("a line is a sentence: one left open is closed, and lines are not run together", () => {
    expect(speechPieces("Three things are running\nthe build\nthe tests for the gather system")).toEqual(["Three things are running.", "the build. the tests for the gather system."]);
  });

  test("abbreviations and numbers do not end a sentence", () => {
    expect(speechPieces("Version 3.5 is out, e.g. on the beta channel. It fixes the relay.")).toEqual(["Version 3.5 is out, e.g. on the beta channel.", "It fixes the relay."]);
  });

  test("nothing to say is no pieces", () => {
    expect(speechPieces("")).toEqual([]);
    expect(speechPieces(" \n ")).toEqual([]);
    expect(speechPieces("Sure.")).toEqual(["Sure."]);
  });
});
