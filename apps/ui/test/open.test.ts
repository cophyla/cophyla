// `host.open` in the desktop app: only a stream page on this machine's loopback, with its
// stream id, opens, in the shell's stream window or beside the view; a page beside the view
// goes where the view places it, in the window's coordinates and inside the frame, hides
// under the host's own layers and comes back, and closes with the view's document; a stream
// closing ends the session on the node, once, and the view is told; the link to cophylad going
// closes them all.

import { describe, expect, test } from "bun:test";
import { placeOf, StreamWindows, streamOf, windowPlace } from "../host/open.ts";

describe("host.open in the desktop app", () => {
  test("a loopback stream page with its id opens; anything else says why not", () => {
    expect(streamOf({ url: "http://127.0.0.1:50123/remote/?t=abc", stream: "stream_0123" })).toEqual({ url: "http://127.0.0.1:50123/remote/?t=abc", stream: "stream_0123", embed: false });
    expect(streamOf({ url: "http://127.0.0.1:50123/remote/?t=abc", stream: "stream_0123", embed: true })).toMatchObject({ embed: true });
    const refused: [unknown, string][] = [
      [{}, "host.open needs a url"],
      [{ url: "::" }, "that link cannot be opened"],
      [{ url: "https://127.0.0.1:50123/remote/", stream: "s" }, "this app opens only a stream page from its own node"],
      [{ url: "http://192.168.1.44:4818/remote/", stream: "s" }, "this app opens only a stream page from its own node"],
      [{ url: "http://127.0.0.1/remote/", stream: "s" }, "this app opens only a stream page from its own node"],
      [{ url: "http://127.0.0.1:50123/ws/client", stream: "s" }, "this app opens only a stream page from its own node"],
      [{ url: "http://u:p@127.0.0.1:50123/remote/", stream: "s" }, "this app opens only a stream page from its own node"],
      [{ url: "art://192.168.1.44:47989?pin=1234", stream: "s" }, "this app opens only a stream page from its own node"],
      [{ url: "http://127.0.0.1:50123/remote/" }, "the stream did not say which it is"],
      [{ url: "http://127.0.0.1:50123/remote/", stream: "a/b" }, "the stream did not say which it is"],
    ];
    for (const [params, why] of refused) expect(streamOf(params)).toEqual({ refuse: why });
  });

  test("the shell opens the window; its close ends the session once; the link going closes the windows", async () => {
    const invoked: [string, unknown][] = [];
    const requests: [string, unknown][] = [];
    const windows = new StreamWindows({
      invoke: async <T>(cmd: string, args?: Record<string, unknown>) => {
        invoked.push([cmd, args]);
        return undefined as T;
      },
      request: async (method, params) => void requests.push([method, params]),
    });
    await expect(windows.host("host.chooseView", {})).rejects.toThrow("no host.chooseView");
    await expect(windows.host("host.place", { stream: "stream_1", rect: null })).rejects.toThrow("no such stream beside the view");
    await expect(windows.host("host.open", { url: "http://192.168.1.44:4818/remote/", stream: "s" })).rejects.toThrow("this app opens only");
    expect(invoked).toEqual([]);
    expect(await windows.host("host.open", { node: "node_b", url: "http://127.0.0.1:50123/remote/?t=abc", stream: "stream_1" })).toEqual({});
    await windows.host("host.open", { url: "http://127.0.0.1:50124/remote/?t=def", stream: "stream_2" });
    expect(invoked).toEqual([
      ["stream_open", { url: "http://127.0.0.1:50123/remote/?t=abc", stream: "stream_1" }],
      ["stream_open", { url: "http://127.0.0.1:50124/remote/?t=def", stream: "stream_2" }],
    ]);
    windows.closed("stream_1");
    windows.closed("stream_1");
    windows.closed("stream_unknown");
    expect(requests).toEqual([["remote.close", { stream: "stream_1" }]]);
    windows.linkLost();
    expect(invoked.at(-1)).toEqual(["stream_close", { stream: "stream_2" }]);
    expect(windows.count).toBe(1);
  });

  test("a place is the frame's offset added, cut to the frame, in whole pixels; a sliver is nothing", () => {
    const frame = { left: 0, top: 0, width: 1200, height: 800 };
    expect(windowPlace({ x: 600.4, y: 40, width: 599.6, height: 760 }, frame)).toEqual({ x: 600, y: 40, width: 600, height: 760 });
    expect(windowPlace({ x: 600, y: 40, width: 900, height: 900 }, frame)).toEqual({ x: 600, y: 40, width: 600, height: 760 });
    expect(windowPlace({ x: -20, y: -20, width: 120, height: 120 }, { left: 10, top: 30, width: 500, height: 500 })).toEqual({ x: 10, y: 30, width: 100, height: 100 });
    expect(windowPlace({ x: 1196, y: 0, width: 400, height: 400 }, frame)).toBeUndefined();
    expect(placeOf({ stream: "stream_1", rect: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({ stream: "stream_1", rect: { x: 1, y: 2, width: 3, height: 4 } });
    expect(placeOf({ stream: "stream_1", rect: null })).toEqual({ stream: "stream_1", rect: null });
    expect(placeOf({ stream: "stream_1", rect: { x: 1, y: 2, width: Number.NaN, height: 4 } })).toEqual({ refuse: "host.place needs a rect, or null" });
    expect(placeOf({ rect: null })).toEqual({ refuse: "host.place needs a stream" });
  });

  test("beside the view: opened hidden, placed where the view says inside the frame, hidden under the host's layers and back, closed with the view's document; its end tells the node and the view", async () => {
    const invoked: [string, unknown][] = [];
    const requests: [string, unknown][] = [];
    const told: string[] = [];
    const streams = new StreamWindows({
      invoke: async <T>(cmd: string, args?: Record<string, unknown>) => {
        invoked.push([cmd, args]);
        return undefined as T;
      },
      request: async (method, params) => void requests.push([method, params]),
      frame: () => ({ left: 0, top: 30, width: 1000, height: 700 }),
      onClosed: (stream) => void told.push(stream),
    });
    expect(await streams.host("host.open", { url: "http://127.0.0.1:50123/remote/?t=abc", stream: "stream_1", embed: true })).toEqual({ embedded: true });
    expect(invoked).toEqual([["stream_embed", { url: "http://127.0.0.1:50123/remote/?t=abc", stream: "stream_1" }]]);
    await streams.host("host.place", { stream: "stream_1", rect: { x: 500, y: 0, width: 500, height: 700 } });
    expect(invoked.at(-1)).toEqual(["stream_place", { stream: "stream_1", x: 500, y: 30, width: 500, height: 700 }]);
    await streams.host("host.place", { stream: "stream_1", rect: null });
    expect(invoked.at(-1)).toEqual(["stream_place", { stream: "stream_1", hidden: true }]);
    await streams.host("host.place", { stream: "stream_1", rect: { x: 400, y: 0, width: 600, height: 700 } });

    // under the picker, and back where it was
    streams.overlay(true);
    await Bun.sleep(0);
    expect(invoked.at(-1)).toEqual(["stream_place", { stream: "stream_1", hidden: true }]);
    // a place meanwhile is kept for later, not shown
    await streams.host("host.place", { stream: "stream_1", rect: { x: 300, y: 0, width: 700, height: 700 } });
    expect(invoked.at(-1)).toEqual(["stream_place", { stream: "stream_1", hidden: true }]);
    streams.overlay(false);
    await Bun.sleep(0);
    expect(invoked.at(-1)).toEqual(["stream_place", { stream: "stream_1", x: 300, y: 30, width: 700, height: 700 }]);

    // the view's document went: the page goes; the shell's word that it closed ends the session and tells the view
    streams.unmounted();
    expect(invoked.at(-1)).toEqual(["stream_close", { stream: "stream_1" }]);
    streams.closed("stream_1");
    streams.closed("stream_1");
    expect(requests).toEqual([["remote.close", { stream: "stream_1" }]]);
    expect(told).toEqual(["stream_1"]);
    expect(streams.count).toBe(0);

    // host.close is the view's own close
    await streams.host("host.open", { url: "http://127.0.0.1:50123/remote/?t=def", stream: "stream_2", embed: true });
    await streams.host("host.close", { stream: "stream_2" });
    expect(invoked.at(-1)).toEqual(["stream_close", { stream: "stream_2" }]);
    await expect(streams.host("host.close", {})).rejects.toThrow("host.close needs a stream");
    streams.linkLost();
    expect(invoked.at(-1)).toEqual(["stream_close", { stream: "stream_2" }]);
  });
});
