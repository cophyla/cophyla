// The desktop app's streamed media (host/media.ts): the shell's commands as MediaHost calls them.

import { describe, expect, test } from "bun:test";
import { shellMedia } from "../host/media.ts";

describe("the desktop's streamed media", () => {
  test("a stream opened is the shell's, told the read and the file's time, and answers where the player finds it", async () => {
    const calls: [string, unknown][] = [];
    const io = { invoke: async <T>(cmd: string, args?: Record<string, unknown>) => (calls.push([cmd, args]), (cmd === "media_open" ? { url: "http://127.0.0.1:5/s/media/m1/a%20b.mp4" } : null) as T) };
    const m = shellMedia(io);
    const read = { method: "session.file" as const, params: { id: "ses_1", path: "clips/a b.mp4" } };
    expect(await m.open({ id: "m1", key: "k", size: 9, mime: "video/mp4", keep: false, name: "a b.mp4", read, modified: 7 })).toEqual({ url: "http://127.0.0.1:5/s/media/m1/a%20b.mp4" });
    await m.close("m1");
    expect(calls).toEqual([
      ["media_open", { id: "m1", key: "k", size: 9, mime: "video/mp4", keep: false, name: "a b.mp4", read, modified: 7 }],
      ["media_close", { id: "m1" }],
    ]);
  });
});
