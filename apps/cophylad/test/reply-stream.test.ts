// The provisional reply is request-owned: only the owner's deltas stream; `begin` retracts a
// leftover placeholder; a tool-use or error end retracts; `<silent/>` retracts and swallows
// the rest; `reset` retracts and drops late deltas; `restart` retracts on a failover; `take`
// hands the id over once the owner has ended with text only.

import { describe, expect, test } from "bun:test";
import { Bus } from "../src/bus.ts";
import { ReplyStream } from "../src/brain-link/stream.ts";

type Note = { kind: "delta"; message: string; text: string } | { kind: "retract"; message: string };

function setup() {
  const bus = new Bus();
  const notes: Note[] = [];
  bus.on("chat.delta", (d) => notes.push({ kind: "delta", message: d.message, text: d.delta.type === "text" ? d.delta.text : "" }));
  bus.on("chat.retract", (r) => notes.push({ kind: "retract", message: r.message }));
  let t = 1_758_196_800_000;
  const stream = new ReplyStream(bus, () => t++);
  return { stream, notes };
}

describe("ReplyStream", () => {
  test("nothing streams without an owner, and only the owner's deltas stream", () => {
    const { stream, notes } = setup();
    stream.push("1", "archive summary");
    expect(notes).toEqual([]);
    stream.begin("2");
    stream.push("1", "not mine");
    stream.push("2", "Hello");
    expect(notes).toEqual([{ kind: "delta", message: stream.current!, text: "Hello" }]);
  });

  test("a text-only end keeps the id for take, which hands it over once", () => {
    const { stream, notes } = setup();
    stream.begin("1");
    stream.push("1", "Done.");
    const id = stream.current;
    stream.end("1", { ok: true });
    expect(stream.take()).toBe(id);
    expect(stream.take()).toBeUndefined();
    expect(notes.filter((n) => n.kind === "retract")).toEqual([]);
  });

  test("take leaves a reply that is still streaming alone", () => {
    const { stream } = setup();
    stream.begin("1");
    stream.push("1", "Wor");
    const id = stream.current;
    expect(stream.take()).toBeUndefined();
    expect(stream.current).toBe(id);
  });

  test("begin retracts a placeholder no ui.say took", () => {
    const { stream, notes } = setup();
    stream.begin("1");
    stream.push("1", "unsaid");
    const first = stream.current!;
    stream.end("1", { ok: true });
    stream.begin("2");
    expect(notes.at(-1)).toEqual({ kind: "retract", message: first });
    expect(stream.current).toBeUndefined();
    stream.push("2", "next");
    expect(stream.current).not.toBe(first);
  });

  test("a step that ended in tool calls, or in an error, retracts its text", () => {
    const { stream, notes } = setup();
    stream.begin("1");
    stream.push("1", "Reading.");
    const a = stream.current!;
    stream.end("1", { ok: true, toolUse: true });
    expect(notes.at(-1)).toEqual({ kind: "retract", message: a });
    expect(stream.take()).toBeUndefined();

    stream.begin("2");
    stream.push("2", "Half a");
    const b = stream.current!;
    stream.end("2", { ok: false });
    expect(notes.at(-1)).toEqual({ kind: "retract", message: b });
    expect(stream.take()).toBeUndefined();
  });

  test("an end with nothing streamed retracts nothing", () => {
    const { stream, notes } = setup();
    stream.begin("1");
    stream.end("1", { ok: false });
    stream.begin("2");
    stream.push("2", "   \n");
    stream.end("2", { ok: true, toolUse: true });
    expect(notes).toEqual([]);
  });

  test("a silent tag retracts what streamed and swallows the rest of the request", () => {
    const { stream, notes } = setup();
    stream.begin("1");
    stream.push("1", "Hmm ");
    const id = stream.current!;
    stream.push("1", "<sil");
    stream.push("1", "ent/> but more");
    stream.push("1", " and more");
    expect(notes).toEqual([
      { kind: "delta", message: id, text: "Hmm " },
      { kind: "retract", message: id },
    ]);
    stream.end("1", { ok: true });
    expect(stream.take()).toBeUndefined();
    // The next reply streams again.
    stream.begin("2");
    stream.push("2", "Back");
    expect(notes.at(-1)).toMatchObject({ kind: "delta", text: "Back" });
  });

  test("reset retracts and drops the owner's late deltas", () => {
    const { stream, notes } = setup();
    stream.begin("1");
    stream.push("1", "Interrupted");
    const id = stream.current!;
    stream.reset();
    expect(notes.at(-1)).toEqual({ kind: "retract", message: id });
    stream.push("1", " late");
    stream.end("1", { ok: true });
    expect(notes.length).toBe(2);
    expect(stream.take()).toBeUndefined();
  });

  test("restart on a failover retracts, and the next route streams on a new id", () => {
    const { stream, notes } = setup();
    stream.begin("1");
    stream.push("1", "first route");
    const a = stream.current!;
    stream.restart("1");
    expect(notes.at(-1)).toEqual({ kind: "retract", message: a });
    stream.push("1", "second route");
    const b = stream.current!;
    expect(b).not.toBe(a);
    stream.end("1", { ok: true });
    expect(stream.take()).toBe(b);
    // Another request's restart touches nothing.
    stream.restart("9");
    expect(notes.filter((n) => n.kind === "retract").length).toBe(1);
  });

  test("tags are stripped as before: quotes dropped whole, refs dropped, other text kept", () => {
    const { stream, notes } = setup();
    stream.begin("1");
    stream.push("1", 'See <quote request="r1">secret');
    stream.push("1", " words</quo");
    stream.push("1", "te> and <ref session=\"s\"/>that <b>");
    expect(notes.map((n) => (n.kind === "delta" ? n.text : "")).join("")).toBe("See  and that <b>");
  });
});
