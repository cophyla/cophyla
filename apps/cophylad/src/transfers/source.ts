// The sending end of a file's pipe: the file read from where the receiver asked, at the pace
// the pipe takes it. A file of a folder is named by its path under the folder (`rel`), and is
// resolved here again, as the walk was: a link is refused, and so is a path that leads out of
// the folder, through `..` or a link swapped in since the walk; on a confined node, a file
// outside the folders it shares. The end sends exactly the bytes from `at` to the size it
// found when it opened, then stays open: the receiver closes the pipe once it has them all,
// so the pipe needs no end of its own. A file that grew since is cut at that size; one that
// shrank closes the pipe short, and the receiver asks again.

import { createReadStream } from "node:fs";
import type { ReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import { FILE_PIPE_CHUNK } from "../remote/pipes.ts";
import type { End, FileTarget, PipeFile } from "../remote/pipes.ts";
import { folderParts } from "../sessions/files.ts";
import { isWithin } from "../sessions/paths.ts";
import { mtimeOf } from "./tree.ts";

export interface SourceOptions {
  /** Refuses a path outside the folders a confined node shares. */
  require?: (path: string) => void;
  platform?: string;
}

function fsError(path: string, e: unknown): RpcError {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return new RpcError("not_found", `${path}: no such file`);
  if (code === "EACCES" || code === "EPERM") return new RpcError("denied", `${path}: not allowed to read it`);
  return new RpcError("unavailable", `${path}: ${e instanceof Error ? e.message : String(e)}`);
}

/** Where a pipe's file is: `path` itself, or `rel` under it, resolved and checked. */
export async function resolveSource(target: Pick<FileTarget, "path" | "rel">, opts: SourceOptions = {}): Promise<string> {
  const platform = opts.platform ?? process.platform;
  if (!isAbsolute(target.path)) throw new RpcError("invalid", `${target.path}: not an absolute path`);
  let root: string;
  try {
    root = await realpath(target.path);
  } catch (e) {
    throw fsError(target.path, e);
  }
  let full = root;
  if (target.rel !== undefined && target.rel !== "") {
    const parts = folderParts(target.rel, platform);
    if (!parts) throw new RpcError("invalid", `${target.rel}: not a path under the folder`);
    const joined = join(root, ...parts);
    try {
      if ((await lstat(joined)).isSymbolicLink()) throw new RpcError("denied", `${target.rel}: a link, which a transfer does not follow`);
      full = await realpath(joined);
    } catch (e) {
      throw e instanceof RpcError ? e : fsError(target.rel, e);
    }
    if (!isWithin(full, root, platform)) throw new RpcError("denied", `${target.rel}: outside the folder`);
  }
  opts.require?.(full);
  return full;
}

/** Opens a pipe's file: its end, and the file as it is now. */
export async function openSource(target: FileTarget, deliver: (data: Uint8Array) => boolean, gone: (end: End, reason: string) => void, opts: SourceOptions = {}): Promise<{ end: FileSourceEnd; file: PipeFile }> {
  const full = await resolveSource(target, opts);
  let info;
  try {
    info = await stat(full);
  } catch (e) {
    throw fsError(target.rel || target.path, e);
  }
  if (!info.isFile()) throw new RpcError("invalid", `${target.rel || target.path}: not a file`);
  const end = new FileSourceEnd(full, target.at, info.size, deliver, gone);
  return { end, file: { size: info.size, mtimeMs: mtimeOf(info.mtimeMs) } };
}

export class FileSourceEnd implements End {
  onRoom?: () => void;
  private path: string;
  private at: number;
  private size: number;
  private deliver: (data: Uint8Array) => boolean;
  private gone: (end: End, reason: string) => void;
  private stream?: ReadStream;
  private sent = 0;
  private closed = false;

  constructor(path: string, at: number, size: number, deliver: (data: Uint8Array) => boolean, gone: (end: End, reason: string) => void) {
    this.path = path;
    this.at = at;
    this.size = size;
    this.deliver = deliver;
    this.gone = gone;
  }

  /** Nothing comes back toward the file; the end takes whatever does. */
  get room(): boolean {
    return !this.closed;
  }

  write(_data: Uint8Array): void {
    // the receiver sends nothing toward the file
  }

  /** The pipe is joined: the bytes from `at` go, as fast as it takes them. */
  start(): void {
    if (this.closed || this.stream) return;
    const want = this.size - this.at;
    // nothing to send, or the receiver holds more than the file has: it sees the size and asks again
    if (want <= 0) return;
    const s = createReadStream(this.path, { start: this.at, end: this.size - 1, highWaterMark: FILE_PIPE_CHUNK });
    this.stream = s;
    s.on("data", (chunk: string | Buffer) => {
      if (this.closed || typeof chunk === "string") return;
      this.sent += chunk.length;
      if (!this.deliver(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length))) s.pause();
    });
    s.on("end", () => {
      if (!this.closed && this.sent < want) this.fail("the file got shorter while it was read");
    });
    s.on("error", (e: Error) => this.fail(`the file could not be read: ${e.message}`));
  }

  /** The pipe has room again: the read goes on. */
  resume(): void {
    if (!this.closed) this.stream?.resume();
  }

  close(_reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stream?.destroy();
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.close();
    this.gone(this, reason);
  }
}
