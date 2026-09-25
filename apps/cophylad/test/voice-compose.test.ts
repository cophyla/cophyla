// Composing a reply for the ear: the lead-in a quote gets from its own source, what a
// reference is read out as, and the markdown that is stripped because it renders on screen
// and is noise in a speaker. Pure: no engines, no daemon.

import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@cophyla/protocol";
import { composeSpeech, leadIn, plain, refWords } from "../src/voice/compose.ts";

const names = {
  session: (id: string) => (id === "sess_1" ? "orchestrator" : undefined),
  task: (id: string) => (id === "task_1" ? "Check the deploy" : undefined),
  thread: (id: string) => (id === "thr_1" ? "the gate tests" : undefined),
  ask: (id: string) => (id === "ask_1" ? "Allow session.spawn?" : undefined),
};

describe("plain", () => {
  test("strips what a model writes for a screen", () => {
    expect(plain("## Heading\nsome **bold** and `code` and *slanted*")).toBe("Heading\nsome bold and code and slanted");
    expect(plain("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
    expect(plain("see [the plan](C:/x/plan.md) for more")).toBe("see the plan for more");
    expect(plain("- one\n- two")).toBe("one\ntwo");
    // A star inside a word is not emphasis.
    expect(plain("2*3 and a_b_c")).toBe("2*3 and a_b_c");
  });
});

describe("lead-ins", () => {
  test("name where a quote came from", () => {
    // A file's path is the node's own, so the separator is this platform's.
    expect(leadIn({ kind: "file", node: "node_1", path: process.platform === "win32" ? "C:\\D\\orchestrator\\.docs\\architecture.md" : "/d/orchestrator/.docs/architecture.md" })).toBe("From architecture.md:");
    expect(leadIn({ kind: "memory", name: "meeting-tomorrow" })).toBe("From memory meeting-tomorrow:");
    expect(leadIn({ kind: "thread", thread: "thr_1" })).toBe("From the thread:");
    expect(leadIn({ kind: "session", session: "sess_1" }, names)).toBe("From the agent in orchestrator:");
    expect(leadIn({ kind: "session", session: "sess_9" }, names)).toBe("From the agent in a session:");
    expect(leadIn(undefined)).toBe("Quote:");
  });

  test("a reference is read as the name of what it points at", () => {
    const ref = (b: Partial<Extract<ContentBlock, { type: "ref" }>>) => refWords({ type: "ref", ...b }, names);
    expect(ref({ session: "sess_1" })).toBe("orchestrator");
    expect(ref({ session: "sess_9" })).toBe("the agent");
    expect(ref({ task: "task_1" })).toBe("Check the deploy");
    expect(ref({ thread: "thr_1" })).toBe("the gate tests");
    expect(ref({ ask: "ask_1" })).toBe("Allow session.spawn?");
    expect(ref({ file: { node: "node_1", path: "/home/me/notes/plan.md" } })).toBe("plan.md");
    expect(ref({ audit: "aud_1" })).toBe("an audit entry");
    expect(ref({})).toBeUndefined();
  });
});

describe("composeSpeech", () => {
  test("puts the lead-in before the quote and leaves the text as it stands", () => {
    const text = composeSpeech(
      [
        { type: "text", text: "It is at half past three." },
        { type: "quote", text: "Tomorrow's meeting is at 15:30 in the blue room", source: { kind: "memory", name: "meeting" } },
      ],
      names,
    );
    expect(text).toBe("It is at half past three. From memory meeting: Tomorrow's meeting is at 15:30 in the blue room.");
  });

  test("an unresolved quote is announced as one, and audio blocks are skipped", () => {
    expect(composeSpeech([{ type: "quote", text: "the old plan", unresolved: true }])).toBe("Quote: the old plan.");
    expect(composeSpeech([{ type: "audio" }, { type: "text", text: "done" }])).toBe("done");
  });

  test("a reference is spoken as a name, not an id", () => {
    const text = composeSpeech([{ type: "text", text: "Started" }, { type: "ref", session: "sess_1" }, { type: "text", text: "on it." }], names);
    expect(text).toBe("Started orchestrator on it.");
    expect(text).not.toContain("sess_");
  });

  test("nothing worth saying composes to nothing", () => {
    expect(composeSpeech([])).toBe("");
    expect(composeSpeech([{ type: "text", text: "   " }])).toBe("");
  });

  test("a quote that already ends in a stop is not given another", () => {
    expect(composeSpeech([{ type: "quote", text: "It failed!", source: { kind: "thread", thread: "thr_1" } }])).toBe("From the thread: It failed!");
  });
});
