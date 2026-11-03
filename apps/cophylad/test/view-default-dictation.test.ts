// Dictation in the default view, DOM-free: where the words go in a field (at the caret, over a
// selection, kept apart from the words around them by a space), the words as they grow, what a
// terminal is given (one line, no Enter), and dictated words kept out of the chat's ghost of a
// voice message on its way.

import { describe, expect, test } from "bun:test";
import type { Client } from "@cophyla/protocol";
import { grown, spliceAt, spliced, TAP_MS, tapped, terminalWords } from "../views/default/dictation.ts";
import { apply, heardText, initialState } from "../views/default/model.ts";
import type { HostReady } from "../views/default/model.ts";

describe("the talk button pressed", () => {
  test("let go at once it was tapped, and listens on; held a while, its release ends it", () => {
    expect([tapped(0), tapped(120), tapped(TAP_MS - 1)]).toEqual([true, true, true]);
    expect([tapped(TAP_MS), tapped(1800)]).toEqual([false, false]);
    // a clock that went back says nothing of a tap
    expect(tapped(-5)).toBe(false);
  });
});

describe("dictated words in a field", () => {
  test("into an empty field, the words alone, the caret after them", () => {
    expect(spliced(spliceAt("", 0, 0), "run the tests")).toEqual({ value: "run the tests", caret: 13 });
  });

  test("after words already typed, a space between; before words that follow, a space after", () => {
    const s = spliceAt("please  now", 6, 6);
    expect(spliced(s, "run the tests")).toEqual({ value: "please run the tests  now", caret: 20 });
    const end = spliceAt("please", 6, 6);
    expect(spliced(end, "run the tests").value).toBe("please run the tests");
    const start = spliceAt("then stop", 0, 0);
    expect(spliced(start, "run the tests")).toEqual({ value: "run the tests then stop", caret: 13 });
  });

  test("over a selection, which the words replace", () => {
    expect(spliced(spliceAt("fix the bug today", 4, 11), "the login bug").value).toBe("fix the login bug today");
  });

  test("no words, or only spaces: the field as it was", () => {
    const s = spliceAt("draft", 5, 5);
    expect(spliced(s, "")).toEqual({ value: "draft", caret: 5 });
    expect(spliced(s, "   ").value).toBe("draft");
  });

  test("a caret past the end, or a selection the wrong way round, stays inside the field", () => {
    expect(spliced(spliceAt("ab", 9, 9), "c").value).toBe("ab c");
    expect(spliced(spliceAt("abcd", 3, 1), "x").value).toBe("abc x d");
  });

  test("the words as they grow: what is kept of the last, then what follows", () => {
    let words = grown("", { text: "What is the" });
    words = grown(words, { text: " status", from: 11 });
    expect(words).toBe("What is the status");
    expect(grown(words, { text: "state", from: 12 })).toBe("What is the state");
  });

  test("a terminal is given one line, so nothing is entered", () => {
    expect(terminalWords("  list the\nfiles\r\nhere  ")).toBe("list the files here");
  });
});

describe("dictated words in the model", () => {
  const CLIENT: Client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind: "ui", scopes: ["chat", "voice"], via: "direct", audio: { in: true, out: true }, connectedAt: 1 };
  const READY: HostReady = { client: CLIENT, node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV", protocolVersion: 1, platformVersion: "0.22.4", view: { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin" }, scopes: ["chat", "voice"], talk: true };

  test("are not shown at the chat's end as a message on its way: they are typed where the user writes", () => {
    const state = initialState();
    apply(state, { type: "host.ready", params: READY });
    apply(state, { type: "host.state", params: { connected: true } });
    apply(state, { type: "voice.state", params: { state: "listening", client: CLIENT.id } });
    apply(state, { type: "voice.partial", params: { client: CLIENT.id, text: "run the tests", dictate: true } });
    expect(state.heard).toBeUndefined();
    expect(heardText(state)).toBe("");
    // the same words not dictated are
    apply(state, { type: "voice.partial", params: { client: CLIENT.id, text: "run the tests" } });
    expect(heardText(state)).toBe("run the tests");
  });
});
