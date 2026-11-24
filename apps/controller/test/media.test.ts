// The phone's streamed media (native/media.ts): the plugin's URL on the app's origin, and its commands as MediaHost calls them.

import { describe, expect, test } from "bun:test";
import { MEDIA_PATH, phoneMedia } from "../src/native/media.ts";
import type { CophylaMediaPlugin } from "../src/native/media.ts";

describe("the phone's streamed media", () => {
  test("a stream is served under the app's origin, its id and name escaped; the commands go to the plugin", async () => {
    const calls: unknown[] = [];
    let heard: ((n: never) => void) | undefined;
    const plugin: CophylaMediaPlugin = {
      open: async (o) => void calls.push(["open", o]),
      piece: async (o) => void calls.push(["piece", o]),
      close: async (o) => void calls.push(["close", o]),
      stats: async (o) => (calls.push(["stats", o]), { requests: 1, fetched: 1, cached: 0 }),
      addListener: (_e, l) => void (heard = l as never),
    };
    const m = phoneMedia(plugin, "https://localhost");
    expect(await m.native.open({ id: "m1-ab", key: "k", size: 3, mime: "audio/mpeg", keep: true, name: "my song #1.mp3", read: { method: "session.file", params: { id: "ses_1", path: "a" } }, modified: 1 })).toEqual({ url: `https://localhost${MEDIA_PATH}m1-ab/my%20song%20%231.mp3` });
    await m.native.piece({ req: 1, data: "AAAA" });
    await m.native.close("m1");
    expect(await m.native.stats("m1")).toEqual({ requests: 1, fetched: 1, cached: 0 });
    const needs: unknown[] = [];
    m.onNeed((n) => needs.push(n));
    heard!({ req: 2, id: "m1", index: 0, at: 0, len: 3 } as never);
    expect(needs).toEqual([{ req: 2, id: "m1", index: 0, at: 0, len: 3 }]);
    expect(calls.map((c) => (c as unknown[])[0])).toEqual(["open", "piece", "close", "stats"]);
    // the plugin is not told the name: only the URL carries it
    expect(calls[0]).toEqual(["open", { id: "m1-ab", key: "k", size: 3, mime: "audio/mpeg", keep: true }]);
  });
});
