// The view picker's rows: every view served, by name, the one showing marked, and where each
// comes from.

import { describe, expect, test } from "bun:test";
import type { ViewManifest } from "@cophyla/protocol";
import { chooserRows } from "../src/chooser.ts";

const view = (id: string, name: string, source: ViewManifest["source"] = "builtin"): ViewManifest => ({ id, name, entry: "index.html", default: false, source });

describe("view chooser", () => {
  test("rows go by name, then id; the one showing is marked; a user's view says where it lives", () => {
    const rows = chooserRows([view("kanban", "Board", "editable"), view("default", "Chat"), view("b2", "Board", "editable")], "default");
    expect(rows).toEqual([
      { id: "b2", name: "Board", source: "yours, in ~/.cophyla/views/b2", current: false },
      { id: "kanban", name: "Board", source: "yours, in ~/.cophyla/views/kanban", current: false },
      { id: "default", name: "Chat", source: "built in", current: true },
    ]);
  });

  test("with nothing mounted, no row is marked; the list it was given is left as it was", () => {
    const views = [view("z", "Zed"), view("a", "Ay")];
    expect(chooserRows(views, undefined).map((r) => r.current)).toEqual([false, false]);
    expect(views.map((v) => v.id)).toEqual(["z", "a"]);
  });
});
