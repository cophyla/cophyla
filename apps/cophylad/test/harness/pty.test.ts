// The pty driver on its own: a shell in a terminal reads a line the test types and echoes
// it back, through the host `ptyHost` picks (the Node broker wherever Node is on PATH: in
// this process under Bun the typed input is lost). Needs no login, so it runs with the rest
// of the suite; skipped where Node is absent, since that host cannot type.

import { describe, expect, test } from "bun:test";
import { ptyHost, spawnTui, stripAnsi } from "./pty.ts";

const SHELL: [string, string[]] = process.platform === "win32" ? ["cmd.exe", ["/q", "/k", "prompt $g"]] : ["bash", ["--norc", "--noprofile", "-i"]];
const hasNode = Bun.which("node") !== null;

describe("pty driver", () => {
  test("stripAnsi keeps the text", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m \x1b]0;title\x07x").trim()).toBe("red x");
  });

  test.skipIf(!hasNode)(`types into a shell and reads it back (host: ${ptyHost()})`, async () => {
    const [file, args] = SHELL;
    const tui = await spawnTui(file, args, { cwd: process.cwd(), env: { ...process.env, PS1: "$ ", TERM: "xterm" } as Record<string, string> });
    try {
      const mark = tui.mark();
      await tui.submit("echo pty-round-trip-ok", 100);
      const m = await tui.waitFor(/pty-round-trip-ok\s*\r?\n/, 15_000, mark);
      expect(m[0]).toContain("pty-round-trip-ok");
      expect(tui.exited).toBeNull();
    } finally {
      tui.kill();
    }
  }, 30_000);
});
