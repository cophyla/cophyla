// What the group chats keep beside their posts, on the primary, under `<data>/groups/`:
// `photos/<group>/<gph_…>`, a photo's bytes, kept by every side of a group (this side's own as
// they were posted, another side's once fetched from it); `files/<group>/<gfile_…>/<name>`, a file
// an app uploaded to post, which has no machine of its own to stay on; and `uploads/<upl_…>`,
// bytes an app is handing over a piece at a time, gone an hour after their last piece unless a
// post took them. A group deleted here takes its photos and files with it. None of it is
// replicated to a backup or the cloud backup: a primary that changes shows another side's
// photos again once it fetched them, and this side's from before as gone.

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FILE_PIECE_BYTES, GROUP_PHOTO_MAX_BYTES, GROUP_UPLOAD_MAX_BYTES, newId, RpcError } from "@cophyla/protocol";
import type { Logger } from "../log.ts";

/** How long an upload waits for its next piece, or for a post to take it. */
export const UPLOAD_IDLE_MS = 60 * 60_000;
/** Uploads one primary holds at once. */
const UPLOADS_MAX = 32;

interface Upload {
  id: string;
  group: string;
  name: string;
  size: number;
  received: number;
  photo: boolean;
  at: number;
}

/** A name a file may take on this machine: no folder in it, nothing Windows refuses. */
export function safeName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 200);
  return cleaned === "" || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cleaned) ? `file${cleaned ? `_${cleaned}` : ""}` : cleaned;
}

export class GroupMedia {
  private root: string;
  private log: Logger;
  private now: () => number;
  private uploads = new Map<string, Upload>();

  constructor(dataDir: string, log: Logger, now: () => number = Date.now) {
    this.root = join(dataDir, "groups");
    this.log = log;
    this.now = now;
  }

  private photoPath(group: string, id: string): string {
    return join(this.root, "photos", group, id);
  }

  private uploadPath(id: string): string {
    return join(this.root, "uploads", id);
  }

  // --- photos ---------------------------------------------------------------------------------

  hasPhoto(group: string, id: string): boolean {
    return existsSync(this.photoPath(group, id));
  }

  async putPhoto(group: string, id: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length > GROUP_PHOTO_MAX_BYTES) throw new RpcError("invalid", "a photo past its limit");
    const path = this.photoPath(group, id);
    await mkdir(join(this.root, "photos", group), { recursive: true });
    await writeFile(`${path}.tmp`, bytes);
    await rename(`${path}.tmp`, path);
  }

  /** A photo's bytes, whole. */
  async photo(group: string, id: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.photoPath(group, id)));
    } catch {
      throw new RpcError("not_found", "this photo is not here");
    }
  }

  /** A piece of a photo from `at`: its bytes and how many it has. */
  async photoPiece(group: string, id: string, at = 0): Promise<{ data: Uint8Array; total: number }> {
    const path = this.photoPath(group, id);
    let fh;
    try {
      fh = await open(path, "r");
    } catch {
      throw new RpcError("not_found", "this photo is not here");
    }
    try {
      const total = (await fh.stat()).size;
      if (at > total) throw new RpcError("invalid", "past the photo's end");
      const want = Math.min(FILE_PIECE_BYTES, total - at);
      const buf = new Uint8Array(want);
      let got = 0;
      while (got < want) {
        const { bytesRead } = await fh.read(buf, got, want - got, at + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return { data: buf.subarray(0, got), total };
    } finally {
      await fh.close();
    }
  }

  // --- uploads --------------------------------------------------------------------------------

  /** One piece of an upload: the first starts it, each next goes on where the last ended. */
  async upload(p: { group: string; upload?: string; name: string; size: number; at: number; data: Uint8Array; photo?: boolean }): Promise<{ upload: string; received: number }> {
    this.sweep();
    if (p.size > GROUP_UPLOAD_MAX_BYTES) throw new RpcError("invalid", `a file posted from an app is ${GROUP_UPLOAD_MAX_BYTES / 1024 ** 3} GB at most`);
    if (p.photo && p.size > GROUP_PHOTO_MAX_BYTES) throw new RpcError("invalid", `a photo is ${GROUP_PHOTO_MAX_BYTES / 1024 / 1024} MB at most`);
    if (p.data.length > FILE_PIECE_BYTES) throw new RpcError("invalid", "a piece past its limit");
    let u: Upload | undefined;
    if (p.upload === undefined) {
      if (p.at !== 0) throw new RpcError("invalid", "a new upload starts at 0");
      if (this.uploads.size >= UPLOADS_MAX) throw new RpcError("unavailable", "too many uploads at once: post or wait a little");
      u = { id: newId("upload"), group: p.group, name: p.name, size: p.size, received: 0, photo: p.photo === true, at: this.now() };
      await mkdir(join(this.root, "uploads"), { recursive: true });
      await writeFile(this.uploadPath(u.id), new Uint8Array(0));
      this.uploads.set(u.id, u);
    } else {
      u = this.uploads.get(p.upload);
      if (!u || u.group !== p.group) throw new RpcError("not_found", "no such upload: it may have waited too long; start it again");
      if (p.at !== u.received) throw new RpcError("conflict", `the upload has ${u.received} bytes; the next piece starts there`);
    }
    if (u.received + p.data.length > u.size) throw new RpcError("invalid", "more than the upload's size");
    await appendFile(this.uploadPath(u.id), p.data);
    u.received += p.data.length;
    u.at = this.now();
    return { upload: u.id, received: u.received };
  }

  /** A whole upload a post takes: its name, where its bytes are, and whether it was to be a photo. Gone from the uploads. */
  take(group: string, id: string): { name: string; path: string; size: number; photo: boolean } {
    const u = this.uploads.get(id);
    if (!u || u.group !== group) throw new RpcError("not_found", "no such upload: it may have waited too long; upload it again");
    if (u.received !== u.size) throw new RpcError("conflict", `${u.name} has not all come yet (${u.received} of ${u.size} bytes)`);
    this.uploads.delete(id);
    return { name: u.name, path: this.uploadPath(id), size: u.size, photo: u.photo };
  }

  /** An upload a post did not take after all: its bytes go. */
  async discard(path: string): Promise<void> {
    await rm(path, { force: true }).catch(() => undefined);
  }

  /** A file an upload brought, kept for the post it is attached to: where it is now. */
  async keepFile(group: string, fileId: string, uploadPath: string, name: string): Promise<string> {
    const dir = join(this.root, "files", group, fileId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, safeName(name));
    await rename(uploadPath, path);
    return path;
  }

  /** The uploads that waited past their hour go. */
  sweep(): void {
    const at = this.now();
    for (const [id, u] of this.uploads) {
      if (at - u.at <= UPLOAD_IDLE_MS) continue;
      this.uploads.delete(id);
      void rm(this.uploadPath(id), { force: true }).catch(() => undefined);
    }
  }

  /** Leftovers of a run that stopped: uploads no one can take any more. */
  clearUploads(): void {
    const dir = join(this.root, "uploads");
    try {
      for (const name of readdirSync(dir)) if (!this.uploads.has(name)) rmSync(join(dir, name), { force: true });
    } catch {
      // none
    }
  }

  // --- what goes with a post ------------------------------------------------------------------

  /** A post trimmed or taken back: its photos go, and the files uploaded for it. */
  dropPost(group: string, photos: readonly string[], uploaded: readonly string[]): void {
    for (const id of photos) rmSync(this.photoPath(group, id), { force: true });
    for (const id of uploaded) rmSync(join(this.root, "files", group, id), { recursive: true, force: true });
  }

  /** Whether a path is a file an app uploaded to this group, kept here. */
  isUploaded(group: string, path: string): boolean {
    const dir = join(this.root, "files", group);
    return path.startsWith(dir);
  }

  // --- a group gone ---------------------------------------------------------------------------

  /** A group deleted here: its photos and the files uploaded to it go. */
  dropGroup(group: string): void {
    for (const kind of ["photos", "files"]) {
      try {
        rmSync(join(this.root, kind, group), { recursive: true, force: true });
      } catch (e) {
        this.log.warn("a deleted group's media could not be removed", { group, kind, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /** Makes sure the folders are there; nothing else at start. */
  init(): void {
    try {
      mkdirSync(this.root, { recursive: true });
    } catch {
      // made at first use
    }
    this.clearUploads();
  }
}
