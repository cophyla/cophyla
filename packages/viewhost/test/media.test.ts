// The host's side of a streamed video or sound (media.ts): what a view may open, where a stream
// is kept, and each piece read with the view's own read and joined as the native side needs it.

import { describe, expect, test } from "bun:test";
import type { FileText } from "@cophyla/protocol";
import { MEDIA_OPEN_MAX, MediaHost, mediaOpen } from "../src/media.ts";
import type { MediaNative, MediaStream } from "../src/media.ts";

const OPEN = { op: "open", read: { method: "session.file", params: { id: "ses_1", path: "music/a.mp3" } }, size: 20, modified: 7, mime: "audio/mpeg", name: "a.mp3", node: "node_far" };

function fakeNative() {
  const opened: MediaStream[] = [];
  const closed: string[] = [];
  const pieces: { req: number; data?: string; error?: string }[] = [];
  const native: MediaNative = {
    open: async ({ name, read: _read, modified: _modified, ...s }) => {
      opened.push(s);
      return { url: `http://127.0.0.1:9/k/media/${s.id}/${encodeURIComponent(name)}` };
    },
    piece: async (a) => void pieces.push(a),
    close: async (id) => void closed.push(id),
    stats: async () => ({ requests: 3, fetched: 2, cached: 1 }),
  };
  return { native, opened, closed, pieces };
}

/** A node that answers a 20-byte file, `chunk` bytes per answer. */
function fakeNode(chunk: number, file = Buffer.from(Array.from({ length: 20 }, (_, i) => 65 + i))) {
  const asked: Record<string, unknown>[] = [];
  let modified = 7;
  const request = async (method: string, params: unknown): Promise<FileText> => {
    const p = params as Record<string, unknown> & { at: number };
    asked.push({ method, ...p });
    const piece = file.subarray(p.at, p.at + chunk);
    return { path: "music/a.mp3", size: file.length, modified, mime: "audio/mpeg", base64: piece.toString("base64"), at: p.at, total: file.length };
  };
  return { request, asked, file, touch: () => void (modified = 8) };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("streamed media", () => {
  test("what a view may open: a video or a sound, read with session.file or terminal.file and the read's own fields alone", () => {
    expect(mediaOpen(OPEN)).toEqual({ ...OPEN, op: "open" } as never);
    expect(mediaOpen({ ...OPEN, read: { method: "chat.send", params: { path: "x" } } })).toHaveProperty("refuse");
    // what the host adds is never the view's
    expect(mediaOpen({ ...OPEN, read: { method: "session.file", params: { id: "ses_1", path: "a", at: 5 } } })).toEqual({ refuse: "host.media: a read takes no at" });
    expect(mediaOpen({ ...OPEN, read: { method: "session.file", params: { path: "a" } } })).toHaveProperty("refuse");
    expect(mediaOpen({ ...OPEN, mime: "text/html" })).toHaveProperty("refuse");
    expect(mediaOpen({ ...OPEN, size: -1 })).toHaveProperty("refuse");
    expect(mediaOpen({ ...OPEN, read: { method: "terminal.file", params: { node: "node_far", path: "C:/a.mp4" } }, mime: "video/mp4" })).not.toHaveProperty("refuse");
  });

  test("a stream opened gets its URL; a file on another computer is kept on the device, one on this computer is not", async () => {
    const n = fakeNative();
    const media = new MediaHost({ native: n.native, request: async () => ({}), here: () => "node_here" });
    const a = (await media.host("host.media", OPEN)) as { id: string; url: string };
    expect(a.url).toBe(`http://127.0.0.1:9/k/media/${a.id}/a.mp3`);
    await media.host("host.media", { ...OPEN, node: "node_here" });
    expect(n.opened.map((s) => [s.keep, s.size, s.mime])).toEqual([
      [true, 20, "audio/mpeg"],
      [false, 20, "audio/mpeg"],
    ]);
    // the same file's version, opened again, has the same key: its pieces are found again
    await media.host("host.media", OPEN);
    expect(n.opened[2]!.key).toBe(n.opened[0]!.key);
    expect(n.opened[2]!.id).not.toBe(n.opened[0]!.id);
    await media.host("host.media", { ...OPEN, modified: 9 });
    expect(n.opened[3]!.key).not.toBe(n.opened[0]!.key);
    // a host that is on no computer of the cluster (the phone) keeps everything
    const p = fakeNative();
    const onPhone = new MediaHost({ native: p.native, request: async () => ({}) });
    await onPhone.host("host.media", { ...OPEN, node: "node_here" });
    expect(p.opened[0]!.keep).toBe(true);
    expect(await media.host("host.media", { op: "stats", id: a.id })).toEqual({ requests: 3, fetched: 2, cached: 1 });
    await media.host("host.media", { op: "close", id: a.id });
    expect(n.closed).toEqual([a.id]);
    await expect(media.host("host.media", { op: "stats", id: a.id })).rejects.toThrow("no such stream");
  });

  test("a piece is read with the view's read, from its offset, and the node's answers are joined", async () => {
    const n = fakeNative();
    // pieces of 6 bytes, a whole number of base64 groups: joined as base64
    const node = fakeNode(6);
    const media = new MediaHost({ native: n.native, request: node.request });
    const { id } = (await media.host("host.media", OPEN)) as { id: string };
    media.need({ req: 1, id, index: 0, at: 3, len: 14 });
    await settle();
    expect(node.asked.map((a) => a.at)).toEqual([3, 9, 15]);
    expect(node.asked[0]).toEqual({ method: "session.file", id: "ses_1", path: "music/a.mp3", whole: true, image: true, stream: true, at: 3 });
    // the node sent 18 bytes for 14 asked: the piece is the 14
    expect(Buffer.from(n.pieces[0]!.data!, "base64").toString()).toBe(node.file.subarray(3, 17).toString());
    expect(n.pieces[0]!.error).toBeUndefined();
  });

  test("answers that are no whole number of base64 groups are joined as bytes", async () => {
    const n = fakeNative();
    const node = fakeNode(5);
    const media = new MediaHost({ native: n.native, request: node.request });
    const { id } = (await media.host("host.media", OPEN)) as { id: string };
    media.need({ req: 2, id, index: 0, at: 0, len: 20 });
    await settle();
    expect(Buffer.from(n.pieces[0]!.data!, "base64").toString()).toBe(node.file.toString());
  });

  test("a file that changed, a closed stream or a range past the end fails the piece, with why", async () => {
    const n = fakeNative();
    const node = fakeNode(6);
    const media = new MediaHost({ native: n.native, request: node.request, log: () => {} });
    const { id } = (await media.host("host.media", OPEN)) as { id: string };
    node.touch();
    media.need({ req: 3, id, index: 0, at: 0, len: 6 });
    media.need({ req: 4, id, index: 9, at: 18, len: 6 });
    media.need({ req: 5, id: "gone", index: 0, at: 0, len: 6 });
    await settle();
    expect(n.pieces.find((p) => p.req === 3)).toEqual({ req: 3, error: "the file changed" });
    expect(n.pieces.find((p) => p.req === 4)).toEqual({ req: 4, error: "past the file's end" });
    expect(n.pieces.find((p) => p.req === 5)).toEqual({ req: 5, error: "the stream is closed" });
    // the view hears why the last one failed: the changed file's, which waited on its node
    expect(await media.host("host.media", { op: "stats", id })).toMatchObject({ requests: 3, error: "the file changed" });
  });

  test("an older node that sends none past its most says so", async () => {
    const n = fakeNative();
    const media = new MediaHost({ native: n.native, request: async () => ({ path: "a", size: 20, modified: 7, binary: true }), log: () => {} });
    const { id } = (await media.host("host.media", OPEN)) as { id: string };
    media.need({ req: 6, id, index: 0, at: 0, len: 6 });
    await settle();
    expect(n.pieces[0]!.error).toContain("update Cophyla there");
  });

  test("streams a view never closed go, the oldest first", async () => {
    const n = fakeNative();
    const media = new MediaHost({ native: n.native, request: async () => ({}) });
    const ids: string[] = [];
    for (let i = 0; i <= MEDIA_OPEN_MAX; i++) ids.push(((await media.host("host.media", OPEN)) as { id: string }).id);
    expect(n.closed).toEqual([ids[0]!]);
  });
});
