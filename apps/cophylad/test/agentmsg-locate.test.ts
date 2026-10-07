// Where cophylad finds the agent sessions' MCP shim, in order: its configured command,
// `COPHYLA_MCP`, the installed version folder (and only it, once installed), a checkout's
// release build, then its debug build; and the one copy every session runs, kept current.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateMcp, MCP_NAME, stageMcp } from "../src/agentmsg/locate.ts";
import { MCP_PATH } from "../src/update/platform.ts";

describe("locating cophyla-mcp", () => {
  const all = (paths: string[]) => (p: string) => paths.includes(p);

  test("the config, then the environment, each alone when named", () => {
    expect(locateMcp({ config: { command: "C:/c/cophyla-mcp.exe" }, env: { COPHYLA_MCP: "C:/e/cophyla-mcp.exe" }, exists: all(["C:/c/cophyla-mcp.exe", "C:/e/cophyla-mcp.exe"]) })).toEqual({
      path: "C:/c/cophyla-mcp.exe",
      origin: "config",
    });
    expect(locateMcp({ config: { command: "C:/missing.exe" }, env: { COPHYLA_MCP: "C:/e/cophyla-mcp.exe" }, exists: all(["C:/e/cophyla-mcp.exe"]) })).toBeUndefined();
    expect(locateMcp({ config: {}, env: { COPHYLA_MCP: "C:/e/cophyla-mcp.exe" }, exists: all(["C:/e/cophyla-mcp.exe"]) })).toEqual({ path: "C:/e/cophyla-mcp.exe", origin: "env" });
    expect(locateMcp({ config: {}, env: { COPHYLA_MCP: "C:/missing.exe" }, repoRoot: "R", exists: all([join("R", "apps", "mcp", "target", "release", MCP_NAME)]) })).toBeUndefined();
  });

  test("an installed platform runs its own, never a checkout's", () => {
    const installed = join("V", MCP_PATH);
    const built = join("R", "apps", "mcp", "target", "release", MCP_NAME);
    expect(locateMcp({ config: {}, env: {}, versionDir: "V", repoRoot: "R", exists: all([installed, built]) })).toEqual({ path: installed, origin: "installed" });
    expect(locateMcp({ config: {}, env: {}, versionDir: "V", repoRoot: "R", exists: all([built]) })).toBeUndefined();
  });

  test("a checkout's release build before its debug build; nothing found is nothing", () => {
    const release = join("R", "apps", "mcp", "target", "release", MCP_NAME);
    const debug = join("R", "apps", "mcp", "target", "debug", MCP_NAME);
    expect(locateMcp({ config: {}, env: {}, repoRoot: "R", exists: all([release, debug]) })).toEqual({ path: release, origin: "checkout" });
    expect(locateMcp({ config: {}, env: {}, repoRoot: "R", exists: all([debug]) })).toEqual({ path: debug, origin: "checkout" });
    expect(locateMcp({ config: {}, env: {}, repoRoot: "R", exists: all([]) })).toBeUndefined();
    expect(locateMcp({ config: {}, env: {}, exists: all([release]) })).toBeUndefined();
  });

  test("every session runs one copy under one name, replaced when the build changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "cophyla-mcp-locate-"));
    try {
      const src = join(dir, "built", MCP_NAME);
      mkdirSync(join(dir, "built"), { recursive: true });
      writeFileSync(src, "one");
      const staged = stageMcp(src, join(dir, "mcp"));
      expect(staged).toBe(join(dir, "mcp", MCP_NAME));
      expect(readFileSync(staged, "utf8")).toBe("one");
      expect(stageMcp(src, join(dir, "mcp"))).toBe(staged);
      writeFileSync(src, "two");
      expect(stageMcp(src, join(dir, "mcp"))).toBe(staged);
      expect(readFileSync(staged, "utf8")).toBe("two");
      expect(readdirSync(join(dir, "mcp"))).toEqual([MCP_NAME]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
