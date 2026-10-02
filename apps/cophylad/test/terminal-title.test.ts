// A terminal's title as the views are told it: the spinner an agent CLI turns before its words
// is off (Codex's braille, Claude Code's halves and ✳), and what a title says otherwise stays,
// a path's `~/` and a `[1]` with it. A linked node on an older build tells every frame of its
// spinner: the primary takes the spinner off, and a row that only spun goes no further.

import { afterEach, describe, expect, test } from "bun:test";
import type { Terminal } from "@cophyla/protocol";
import { plainRow, plainTitle } from "../src/sessions/tether/title.ts";
import { sleep, waitFor } from "./helpers.ts";
import { rogueLink, startPrimary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Rogue } from "./nodes-helpers.ts";

describe("a plain title", () => {
  test("the spinner before the words is off", () => {
    expect(plainTitle("⠦ Define swordsmanship animations | UnrealEngine")).toBe("Define swordsmanship animations | UnrealEngine");
    expect(plainTitle("◑ casaturca agent")).toBe("casaturca agent");
    expect(plainTitle("✳ Improve the context overlay")).toBe("Improve the context overlay");
    expect(plainTitle("  ◐  spending")).toBe("spending");
    expect(plainTitle("⠋")).toBe("");
  });

  test("a title with no spinner stays as it is", () => {
    for (const title of ["~/code/app", "/usr/bin/bash", "[1] build", "(venv) PS C:\\work", "C:\\WINDOWS\\system32\\cmd.exe", "  indented", "fix ◐ later", "① first"]) {
      expect(plainTitle(title)).toBe(title);
    }
  });

  test("a row keeps the words, and has no title when only a spinner was there", () => {
    const row: Terminal = { id: "t1", node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV", host: "h", argv0: "codex", cwd: "C:\\x", cols: 80, rows: 24, title: "⠙ build", status: "running", windows: 0, startedAt: 1 };
    expect(plainRow(row)).toEqual({ ...row, title: "build" });
    expect(plainRow({ ...row, title: "⠙" })).not.toHaveProperty("title");
    const plain = { ...row, title: "build" };
    expect(plainRow(plain)).toBe(plain);
  });
});

describe("a linked node's rows", () => {
  let primary: Primary | undefined;
  let rogue: Rogue | undefined;

  afterEach(async () => {
    rogue?.close();
    await stopAll(primary?.d);
    primary = undefined;
    rogue = undefined;
  });

  test("an older node's spinner frames reach the clients as one row, its title plain", async () => {
    primary = await startPrimary();
    const d = primary.d;
    const told: Terminal[] = [];
    d.bus.on("terminal.state", (row) => void told.push(row));
    rogue = await rogueLink(primary);
    await waitFor(() => d.nodes.linkedTo(rogue!.id));
    const row: Terminal = { id: "spinning", node: rogue.id, host: "h", argv0: "codex", cwd: "C:\\x", cols: 80, rows: 24, status: "running", windows: 0, startedAt: Date.now() };
    for (const frame of ["⠋", "⠙", "⠹", "⠸"]) rogue.notify("terminal.state", { ...row, title: `${frame} build the docs` });
    rogue.notify("terminal.state", { ...row, title: "⠼ fix the tests" });
    await waitFor(() => told.length >= 2);
    await sleep(100);
    expect(told.map((r) => r.title)).toEqual(["build the docs", "fix the tests"]);
    expect(d.nodes.mirror.terminal(rogue.id, row.id)?.title).toBe("fix the tests");
  }, 30_000);
});
