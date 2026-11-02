// The composer's slash commands, pure: how a line is read, what the palette offers, and which
// model names `/model` lists by harness.

import { describe, expect, test } from "bun:test";
import { matchSlash, paletteOpen, parseSlash, sendLine, SLASH_COMMANDS } from "../views/default/slash.ts";

describe("slash commands", () => {
  test("a line is read as a command with its arguments", () => {
    expect(parseSlash("/model opus")).toEqual({ name: "model", args: "opus" });
    expect(parseSlash("  /Resume  ")).toEqual({ name: "resume", args: "" });
    expect(parseSlash("/compact keep the tests")).toEqual({ name: "compact", args: "keep the tests" });
  });

  test("text that is not a command is not read as one", () => {
    expect(parseSlash("hello /model")).toBeUndefined();
    expect(parseSlash("/")).toBeUndefined();
    expect(parseSlash("/ model")).toBeUndefined();
    expect(parseSlash("/1x")).toBeUndefined();
  });

  test("the palette opens on a partial name and closes once an argument is typed", () => {
    expect(paletteOpen("/")).toBe(true);
    expect(paletteOpen("/mo")).toBe(true);
    expect(paletteOpen("/model ")).toBe(false);
    expect(paletteOpen("fix /mo")).toBe(false);
  });

  test("the palette lists prefix matches first, then words that contain the typed text", () => {
    expect(matchSlash("/").map((c) => c.name)).toEqual(SLASH_COMMANDS.map((c) => c.name));
    expect(matchSlash("/co").map((c) => c.name)[0]).toBe("compact");
    expect(matchSlash("/compact").map((c) => c.name)).toEqual(["compact"]);
    expect(matchSlash("/c").map((c) => c.name).slice(0, 2)).toEqual(["compact", "clear"]);
    expect(matchSlash("/limit").map((c) => c.name)).toEqual(["usage"]);
    expect(matchSlash("/zzz")).toEqual([]);
  });

  test("a sent command is typed as the user would type it", () => {
    expect(sendLine("model", "opus")).toBe("/model opus");
    expect(sendLine("clear")).toBe("/clear");
  });

  test("only clear discards the conversation, so only it asks first", () => {
    expect(SLASH_COMMANDS.filter((c) => c.destructive).map((c) => c.name)).toEqual(["clear"]);
  });
});
