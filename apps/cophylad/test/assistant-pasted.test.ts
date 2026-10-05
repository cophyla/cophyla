// What was pasted into Claude Code's prompt comes back to a hook inside tags of the harness's
// own, and a message of more than a line is pasted: `unpasted` gives the words as they were
// sent, whatever stands round the tags, and leaves alone what is no such tag. A message typed
// into a session is known by its receipt through them: the prompt as the harness hands it
// back is the message whole, tags and line ends aside, never a prompt that merely holds it,
// and once it has landed only the prompt it landed as.

import { describe, expect, test } from "bun:test";
import { Injections, unpasted } from "../src/sessions/injections.ts";
import type { PendingSend } from "../src/sessions/injections.ts";

/** A pasted prompt as Claude Code 2.1.289 hands it to a hook. */
const pasted = (text: string, id = "d39b") => `\n\n<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">\n`;

describe("unpasted", () => {
  test("a prompt with no tags is the prompt, untouched", () => {
    for (const text of ["", "what is open?", "two\nlines", "  kept as it is \n", "a < b and c > d", "<pasted> is a word here"]) expect(unpasted(text)).toBe(text);
  });

  test("what was pasted comes out of its tags as it was sent, its own lines and blanks kept", () => {
    expect(unpasted(pasted("the log says:\n  error: no such file"))).toBe("\n\nthe log says:\n  error: no such file\n");
    expect(unpasted(pasted("one\n\n\n  two\n\tthree")).trim()).toBe("one\n\n\n  two\n\tthree");
    // on one line, and under a closing tag that names no id
    expect(unpasted('<pasted_content id="a1">one line</pasted_content id="a1">')).toBe("one line");
    expect(unpasted('<pasted_content id="a1">\none line\n</pasted_content>')).toBe("one line");
    expect(unpasted('<pasted_content id="Zx_9-b">\n\n</pasted_content id="Zx_9-b">')).toBe("");
  });

  test("words typed round a paste stay where they were, and every paste of several comes out", () => {
    expect(unpasted(`look at this:${pasted("line one\nline two")}and tell me`)).toBe("look at this:\n\nline one\nline two\nand tell me");
    expect(unpasted(`${pasted("first", "a1")}between${pasted("second", "b2")}`)).toBe("\n\nfirst\nbetween\n\nsecond\n");
  });

  test("a tag that is never closed, or closed under another id, is left as it is", () => {
    const open = '<pasted_content id="a1">\nnever closed';
    expect(unpasted(open)).toBe(open);
    const other = '<pasted_content id="a1">\ntext\n</pasted_content id="b2">';
    expect(unpasted(other)).toBe(other);
    // what follows a paste and only looks like one is not taken with it
    expect(unpasted(`${pasted("real", "a1")}</pasted_content id="a1">`)).toBe('\n\nreal\n</pasted_content id="a1">');
  });
});

describe("a typed message and its receipt", () => {
  function injections() {
    const fired: PendingSend[] = [];
    const inj = new Injections({ timeoutMs: 100, now: () => 1000, schedule: () => 0, cancel: () => undefined, onTimeout: (p) => fired.push(p) });
    const typed = (ref: string, text: string, session = "s") => inj.add({ ref, session, harness: "claude", text, body: text, typed: true, at: 1000 });
    return { inj, typed };
  }

  test("a message of several lines is known by its prompt though the harness hands it back as pasted", () => {
    const { inj, typed } = injections();
    const body = "the log says:\n  error: no such file";
    typed("r1", body);
    expect(inj.matchText("s", pasted(body), "p1")?.ref).toBe("r1");
    expect(inj.matchText("s", pasted(body))?.ref).toBe("r1");
    // as it was typed, too, and whatever line ends either side wrote
    expect(inj.matchText("s", body)?.ref).toBe("r1");
    expect(inj.matchText("s", pasted(body).replace(/\n/g, "\r\n"))?.ref).toBe("r1");
    typed("r2", "typed\r\nwith returns");
    expect(inj.matchText("s", pasted("typed\nwith returns"))?.ref).toBe("r2");
  });

  test("it is the prompt whole: one that merely holds the message, pasted or typed, is not its receipt", () => {
    const { inj, typed } = injections();
    typed("r1", "line one\nline two");
    expect(inj.matchText("s", `see:${pasted("line one\nline two")}`)).toBeUndefined();
    expect(inj.matchText("s", pasted("line one\nline two\nline three"))).toBeUndefined();
    expect(inj.matchText("s", pasted("line one"))).toBeUndefined();
    expect(inj.matchText("s", `${pasted("line one\nline two")}${pasted("line one\nline two")}`)).toBeUndefined();
    // and it is its own session's alone
    expect(inj.matchText("another", pasted("line one\nline two"))).toBeUndefined();
  });

  test("once it has landed, only the prompt it landed as is its own: the same words pasted again are the user's", () => {
    const { inj, typed } = injections();
    const body = "line one\nline two";
    const p = typed("r1", body);
    p.promptId = "p1";
    expect(inj.settle("r1", "delivered")?.state).toBe("delivered");
    expect(inj.matchText("s", pasted(body), "p1")?.ref).toBe("r1");
    expect(inj.matchText("s", pasted(body), "p2")).toBeUndefined();
    expect(inj.matchText("s", pasted(body))).toBeUndefined();
  });

  test("of two messages with the same words, the one still waiting is the receipt's", () => {
    const { inj, typed } = injections();
    const body = "line one\nline two";
    const first = typed("r1", body);
    typed("r2", body);
    expect(inj.matchText("s", pasted(body), "p1")?.ref).toBe("r1");
    first.promptId = "p1";
    inj.settle("r1", "delivered");
    expect(inj.matchText("s", pasted(body), "p2")?.ref).toBe("r2");
    // one that got no sign in time is still known by a late receipt
    inj.settle("r2", "unconfirmed");
    expect(inj.matchText("s", pasted(body), "p3")?.ref).toBe("r2");
  });

  test("a message sent over the pipe is still found by its prefixed body inside the prompt that carries it", () => {
    const { inj } = injections();
    inj.add({ ref: "r1", session: "s", harness: "claude", text: "hi", body: "[cophylad]\nhi", at: 1000 });
    expect(inj.matchText("s", "prefix [cophylad]\nhi suffix")?.ref).toBe("r1");
    expect(inj.matchText("s", "hi")).toBeUndefined();
  });
});
