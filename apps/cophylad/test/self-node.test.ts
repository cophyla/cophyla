// The machine's name a node takes when `[node] name` is unset: macOS's Computer Name, the
// host name elsewhere, and on a Mac whose Computer Name cannot be read the host name
// without its `.local`.

import { describe, expect, test } from "bun:test";
import { machineName } from "../src/nodes/self.ts";

describe("the machine's name", () => {
  test("a Mac's Computer Name, as its user sees it; the host name elsewhere", () => {
    expect(machineName("darwin", () => "Ada’s MacBook Pro", () => "Adas-MacBook-Pro.local")).toBe("Ada’s MacBook Pro");
    expect(machineName("darwin", () => undefined, () => "Adas-MacBook-Pro.local")).toBe("Adas-MacBook-Pro");
    expect(machineName("darwin", () => "", () => "studio")).toBe("studio");
    expect(machineName("linux", () => "never asked", () => "desk.local")).toBe("desk.local");
    expect(machineName("win32", () => "never asked", () => "DESKTOP-7Q2")).toBe("DESKTOP-7Q2");
  });

  test.skipIf(process.platform !== "darwin")("this Mac's is read from scutil", () => {
    const name = machineName();
    expect(name.length).toBeGreaterThan(0);
    expect(name.endsWith(".local")).toBe(false);
  });
});
