// A file's two pipe ends. The sending one reads from `at`, pauses while the pipe has no room
// and goes on when it has, sends exactly the bytes up to the size it found and then waits;
// a file that shrank under it closes the pipe short. The receiving one appends from `at`, or
// starts the file again from nothing; it is complete once the bytes it was told to expect came,
// short when the pipe closed before, and never takes more than it was told. Between two nodes
// a file's bytes come whole, acknowledged a quarter window at a time.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FILE_PIPE_ACK, FILE_PIPE_CHUNK, PipeHub } from "../src/remote/pipes.ts";
import type { End, PipeWire } from "../src/remote/pipes.ts";
import { silentLogger } from "../src/log.ts";
import { FileSinkEnd } from "../src/transfers/sink.ts";
import { openSource } from "../src/transfers/source.ts";
import { removeHome, sleep, tempHome, waitFor } from "./helpers.ts";

function counted(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = i % 251;
  return out;
}

describe("a file's pipe ends", () => {
  let scratch: string;

  beforeAll(() => {
    scratch = tempHome();
  });

  afterAll(() => removeHome(scratch));

  test("the sending end reads from `at`, holds while the pipe is full, and sends the rest when there is room", async () => {
    const bytes = counted(1024 * 1024);
    writeFileSync(join(scratch, "s.bin"), bytes);
    const got: Uint8Array[] = [];
    let room = true;
    let gone: string | undefined;
    const { end, file } = await openSource({ kind: "file", path: join(scratch, "s.bin"), at: 1000 }, (d) => {
      got.push(new Uint8Array(d));
      return room;
    }, (_e: End, reason) => (gone = reason));
    expect(file.size).toBe(bytes.length);
    room = false;
    end.start();
    await waitFor(() => got.length > 0);
    // held: one read past the full pipe, no more
    await sleep(100);
    expect(got.length).toBe(1);
    room = true;
    end.resume();
    await waitFor(() => got.reduce((n, d) => n + d.length, 0) === bytes.length - 1000, 5000);
    const all = Buffer.concat(got);
    expect(Buffer.compare(all, Buffer.from(bytes.subarray(1000)))).toBe(0);
    expect(gone).toBeUndefined();
    end.close("done");
  });

  test("a file that shrank while it was read closes the pipe short", async () => {
    writeFileSync(join(scratch, "shrinks.bin"), counted(4 * 1024 * 1024));
    let gone: string | undefined;
    let first = true;
    const { end } = await openSource({ kind: "file", path: join(scratch, "shrinks.bin"), at: 0 }, () => {
      if (first) {
        first = false;
        truncateSync(join(scratch, "shrinks.bin"), 1000);
      }
      return true;
    }, (_e, reason) => (gone = reason));
    end.start();
    await waitFor(() => gone !== undefined, 5000);
    expect(gone).toContain("shorter");
  });

  test("the receiving end appends from `at`, is complete at what it was told, and takes no more", async () => {
    const path = join(scratch, "r.bin");
    writeFileSync(path, "abc");
    const counts: number[] = [];
    const sink = new FileSinkEnd(path, 3, (n) => counts.push(n));
    sink.write(new TextEncoder().encode("def"));
    sink.expect(5);
    sink.write(new TextEncoder().encode("ghij"));
    expect(await sink.outcome).toEqual({ kind: "complete" });
    await sink.finish();
    expect(readFileSync(path, "utf8")).toBe("abcdefgh");
    expect(counts).toEqual([3, 2]);
  });

  test("from nothing it starts the file again; a pipe that closes before is short", async () => {
    const path = join(scratch, "again.bin");
    writeFileSync(path, "old old old");
    const sink = new FileSinkEnd(path, 0);
    sink.expect(10);
    sink.write(new TextEncoder().encode("new"));
    sink.close("the link went");
    expect(await sink.outcome).toEqual({ kind: "short", reason: "the link went" });
    await sink.finish();
    expect(readFileSync(path, "utf8")).toBe("new");
  });
});

describe("a file's pipe between two nodes", () => {
  let scratch: string;

  beforeAll(() => {
    scratch = tempHome();
  });

  afterAll(() => removeHome(scratch));

  test("the bytes come whole, a quarter window to an ack: half the frames a stream pipe's acks would add", async () => {
    const A = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const B = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
    const size = 8 * 1024 * 1024 + 5;
    const bytes = counted(size);
    writeFileSync(join(scratch, "f.bin"), bytes);
    const hubs: Record<string, PipeHub> = {};
    const frames = { data: 0, acks: 0 };
    // each frame crosses on a later turn, as on a socket
    const wire = (from: string, to: string): PipeWire => ({
      data: (pipe, data) => {
        frames.data++;
        setTimeout(() => hubs[to]!.data(`link:${from}`, pipe, data), 0);
        return true;
      },
      ack: (pipe, n) => {
        frames.acks++;
        setTimeout(() => hubs[to]!.ack(`link:${from}`, pipe, n), 0);
      },
      close: (pipe, reason) => void setTimeout(() => hubs[to]!.closed(`link:${from}`, pipe, reason), 0),
    });
    const base = { loopbackPort: () => 0, clientWire: () => wire("x", "x"), openOnLink: async () => ({ window: 1 }), log: silentLogger };
    hubs[A] = new PipeHub({
      ...base,
      selfId: () => A,
      linkWire: (n) => (n === B ? wire(A, B) : undefined),
      nextHop: (n) => (n === B ? B : undefined),
      openFileOnLink: async (_hop, p) => {
        const r = await hubs[B]!.openForLink(A, { node: p.node, pipe: p.pipe }, { kind: "file", path: p.path, at: p.at });
        return { window: r.window, size: r.size!, mtimeMs: r.mtimeMs! };
      },
    });
    hubs[B] = new PipeHub({
      ...base,
      selfId: () => B,
      linkWire: (n) => (n === A ? wire(B, A) : undefined),
      nextHop: (n) => (n === A ? A : undefined),
      openFile: (target, deliver, gone) => openSource(target, deliver, gone),
    });
    const got: Uint8Array[] = [];
    let n = 0;
    const near: End = {
      write: (d) => {
        got.push(d.slice());
        n += d.length;
      },
      room: true,
      close: () => undefined,
    };
    const pipe = await hubs[A]!.openForFile(B, { kind: "file", path: join(scratch, "f.bin"), at: 0 }, near);
    expect(pipe.file.size).toBe(size);
    await waitFor(() => n >= size, 10_000);
    pipe.close("done");
    expect(Buffer.concat(got).equals(Buffer.from(bytes))).toBe(true);
    expect(frames.data).toBe(Math.ceil(size / FILE_PIPE_CHUNK));
    // one ack a quarter window, and the last few bytes after a moment
    expect(frames.acks).toBeLessThanOrEqual(Math.ceil(size / FILE_PIPE_ACK) + 1);
    expect(frames.acks).toBeGreaterThanOrEqual(Math.floor(size / FILE_PIPE_ACK));
  });
});
