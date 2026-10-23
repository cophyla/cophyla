// Checking for a new Cophyla by hand: the node's `update.state` for its platform, said before it
// answers `update.check`, tells nothing newer from a release on its way or ready; a release found
// on its way is told when it is ready; a node too old to be asked says so; Update now asks the
// node to restart when nothing waits; and the settings show an Updates page only where a check
// can be made.

import { describe, expect, test } from "bun:test";
import type { RpcNotification } from "@cophyla/protocol";
import { settingsPages } from "../src/settings.ts";
import { checkWords, outcomeOf, UpdateChecker } from "../src/updates.ts";
import type { PlatformUpdate } from "../src/updates.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const state = (s: Partial<PlatformUpdate>): RpcNotification => ({ jsonrpc: "2.0", method: "update.state", params: { node: NODE, component: "platform", current: "0.18.0", ...s } });

/** A node that answers `update.check` after saying `says`, as the daemon does. */
function rig(says: Partial<PlatformUpdate> | undefined, opts: { fail?: string } = {}) {
  const asked: { method: string; params: unknown }[] = [];
  const ready: string[] = [];
  let c!: UpdateChecker;
  c = new UpdateChecker({
    request: async <T>(method: string, params: unknown) => {
      asked.push({ method, params });
      if (opts.fail) throw new Error(opts.fail);
      if (method === "update.check" && says) c.onNotification(state(says));
      return (method === "update.apply" ? { waiting: ["a turn in api-claude"] } : {}) as T;
    },
    node: () => NODE,
    version: () => "0.18.0",
    onReady: (v) => ready.push(v),
  });
  return { c, asked, ready };
}

describe("checking for updates by hand", () => {
  test("nothing newer: up to date, under the version that runs", async () => {
    const r = rig({});
    const o = await r.c.check();
    expect(o).toEqual({ kind: "latest", current: "0.18.0" });
    expect(checkWords(o)).toEqual({ title: "Cophyla is up to date", detail: "0.18.0 is the newest version." });
    expect(r.asked.map((a) => a.method)).toEqual(["update.check"]);
  });

  test("a release on its way, then told when it is ready; another node's state is not this one's", async () => {
    const r = rig({ available: "0.18.1", progress: 0.25 });
    const o = await r.c.check();
    expect(o).toEqual({ kind: "found", version: "0.18.1", current: "0.18.0", ready: false, progress: 0.25 });
    expect(checkWords(o).title).toBe("Cophyla 0.18.1 is on its way");
    expect(checkWords(o).detail).toContain("25%");
    r.c.onNotification({ jsonrpc: "2.0", method: "update.state", params: { node: OTHER, component: "platform", current: "0.17.1", staged: "0.18.1" } });
    expect(r.ready).toEqual([]);
    r.c.onNotification(state({ available: "0.18.1", staged: "0.18.1" }));
    expect(r.ready).toEqual(["0.18.1"]);
    expect(r.c.last).toEqual({ kind: "found", version: "0.18.1", current: "0.18.0", ready: true });
    // told once
    r.c.onNotification(state({ available: "0.18.1", staged: "0.18.1" }));
    expect(r.ready).toEqual(["0.18.1"]);
  });

  test("a release ready already; Update now asks for a restart when nothing waits and says on what it waits", async () => {
    const r = rig({ available: "0.18.1", staged: "0.18.1" });
    const o = await r.c.check();
    expect(o).toMatchObject({ kind: "found", ready: true });
    expect(checkWords(o).title).toBe("Cophyla 0.18.1 is ready");
    await r.c.apply();
    expect(r.asked.at(-1)).toEqual({ method: "update.apply", params: { component: "platform", whenIdle: true } });
    expect(r.c.applyNote).toContain("a turn in api-claude");
  });

  test("a node too old to be asked, or a feed that could not be read, fails in words", async () => {
    expect(await rig(undefined, { fail: "unknown method update.check" }).c.check()).toEqual({ kind: "failed", message: "this Cophyla is too old to check by hand: it checks by itself" });
    const o = await rig(undefined, { fail: "feed not read: HTTP 503" }).c.check();
    expect(checkWords(o)).toEqual({ title: "Could not check for updates", detail: "feed not read: HTTP 503" });
  });

  test("the state alone: staged over available, the same version as current is nothing new", () => {
    expect(outcomeOf(undefined, "0.18.0")).toEqual({ kind: "latest", current: "0.18.0" });
    expect(outcomeOf({ node: NODE, component: "platform", current: "0.18.1", available: "0.18.1" })).toEqual({ kind: "latest", current: "0.18.1" });
    expect(outcomeOf({ node: NODE, component: "platform", current: "0.18.0", available: "0.18.2", staged: "0.18.1" })).toMatchObject({ version: "0.18.1", ready: true });
  });

  test("the settings show Updates only on a host that can check", () => {
    expect(settingsPages({ device: false, microphone: true }).map((p) => p.id)).not.toContain("updates");
    expect(settingsPages({ device: true, microphone: true, updates: true }).map((p) => p.id)).toEqual(["sessions", "accounts", "usage", "chat", "voice", "listeners", "updates", "device"]);
  });
});
