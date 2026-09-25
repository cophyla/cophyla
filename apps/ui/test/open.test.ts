// `host.open` in the desktop app: only a stream page on this machine's loopback, with its
// stream id, opens, in the shell's stream window; its window closing ends the session on the
// node, once; the link to cophylad going closes the windows.

import { describe, expect, test } from "bun:test";
import { StreamWindows, streamOf } from "../host/open.ts";

describe("host.open in the desktop app", () => {
  test("a loopback stream page with its id opens; anything else says why not", () => {
    expect(streamOf({ url: "http://127.0.0.1:50123/remote/?t=abc", stream: "stream_0123" })).toEqual({ url: "http://127.0.0.1:50123/remote/?t=abc", stream: "stream_0123" });
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
});
