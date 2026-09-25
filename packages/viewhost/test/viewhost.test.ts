// The view host's choice of view and its reload decision after a reconnect or a
// `view.changed`: the default wins, the first stands in for a missing default, a mounted
// view is stale only when the default moved to another view or its own files changed, and
// a burst of `view.changed` notices is answered by one `view.list`; the frame may run scripts
// and fire `submit`, and nothing more.

import { describe, expect, test } from "bun:test";
import type { ViewManifest } from "@cophyla/protocol";
import { CHANGED_COALESCE_MS, chooseView, FRAME_SANDBOX, isStale, ViewHost } from "../src/viewhost.ts";
import type { Connection } from "../src/connection.ts";
import type { SnapshotCache } from "../src/snapshot.ts";

const view = (id: string, def: boolean, version?: string): ViewManifest => ({ id, name: id, entry: "index.html", default: def, source: "builtin", ...(version !== undefined ? { version } : {}) });

describe("view host", () => {
  test("the default view is chosen, else the first, else nothing", () => {
    expect(chooseView([view("a", false), view("b", true)])?.id).toBe("b");
    expect(chooseView([view("a", false), view("b", false)])?.id).toBe("a");
    expect(chooseView([])).toBeUndefined();
  });

  test("a mounted view is stale when its files changed", () => {
    const mounted = view("default", true, "aaaa");
    expect(isStale(mounted, view("default", true, "aaaa"))).toBe(false);
    expect(isStale(mounted, view("default", true, "bbbb"))).toBe(true);
  });

  test("a mounted view is stale when the default moved to another view", () => {
    expect(isStale(view("default", true, "aaaa"), view("other", true, "aaaa"))).toBe(true);
  });

  test("a version unknown on either side, or no view served, is not a change", () => {
    expect(isStale(view("default", true), view("default", true, "bbbb"))).toBe(false);
    expect(isStale(view("default", true, "aaaa"), view("default", true))).toBe(false);
    expect(isStale(view("default", true, "aaaa"), undefined)).toBe(false);
  });

  test("the frame is sandboxed with scripts and forms, never its own origin", async () => {
    // Without allow-forms Chromium drops a submission before `submit` fires, and the view's Send does nothing.
    const attrs = new Map<string, string>();
    (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {} };
    (globalThis as unknown as { document: unknown }).document = {
      createElement: () => ({ setAttribute: (k: string, v: string) => attrs.set(k, v), addEventListener: () => {}, remove: () => {}, contentWindow: undefined, src: "" }),
    };
    const conn = {
      state: { state: "connected", hello: { client: { scopes: [] } } },
      connected: true,
      request: async () => ({ views: [view("default", true, "v1")] }),
      send: async () => ({}),
    } as unknown as Connection;
    const cache = { replay: () => [] } as unknown as SnapshotCache;
    const host = new ViewHost({ conn, cache, container: { replaceChildren: () => {} } as unknown as HTMLElement, stage: async () => ({ base: "http://view.localhost/" }) });
    await host.load();
    expect(attrs.get("sandbox")).toBe(FRAME_SANDBOX);
    expect(FRAME_SANDBOX.split(" ").sort()).toEqual(["allow-forms", "allow-scripts"]);
  });

  test("a burst of view.changed notices makes one view.list; a changed version reloads the view, the same version does not", async () => {
    const win = { addEventListener: () => {} };
    const doc = {
      createElement: () => ({ setAttribute: () => {}, addEventListener: () => {}, remove: () => {}, contentWindow: undefined, src: "" }),
    };
    (globalThis as unknown as { window: unknown }).window = win;
    (globalThis as unknown as { document: unknown }).document = doc;
    const requests: string[] = [];
    let served = view("default", true, "v1");
    const conn = {
      state: { state: "connected", hello: { client: { scopes: [] } } },
      connected: true,
      request: async (method: string) => {
        requests.push(method);
        if (method === "view.list") return { views: [served] };
        return { id: served.id, version: served.version, files: [] };
      },
      send: async () => ({}),
    } as unknown as Connection;
    const cache = { replay: () => [] } as unknown as SnapshotCache;
    const host = new ViewHost({ conn, cache, container: { replaceChildren: () => {} } as unknown as HTMLElement, stage: async (m) => ({ base: "http://view.localhost/", ...(m.version !== undefined ? { version: m.version } : {}) }) });
    await host.load();
    expect(requests).toEqual(["view.list"]);
    expect(host.manifest?.version).toBe("v1");
    host.onChanged("default");
    host.onChanged("default");
    host.onChanged("other");
    await new Promise((r) => setTimeout(r, CHANGED_COALESCE_MS + 50));
    expect(requests).toEqual(["view.list", "view.list"]);
    served = view("default", true, "v2");
    host.onChanged("default");
    await new Promise((r) => setTimeout(r, CHANGED_COALESCE_MS + 50));
    // The stale check's view.list, then the load's own view.list.
    expect(requests).toEqual(["view.list", "view.list", "view.list", "view.list"]);
    expect(host.manifest?.version).toBe("v2");
  });
});
