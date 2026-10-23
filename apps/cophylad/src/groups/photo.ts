// A photo for a group chat's post, made from an image on one of the user's machines: an agent's
// `post_group` with `photos`, or a file the desktop app was dropped. JPEG, PNG, WebP and GIF are
// read for their kind and size from their first bytes, never from their name; one within a
// photo's limits goes as it is, and anything else (bigger, wider than PHOTO_KEEP_SIDE, or a kind
// no view draws, a HEIC or a TIFF) is scaled down to a JPEG by the computer's own codecs
// (`sessions/convert.ts`), or refused saying why. Bytes an app uploaded as a photo are checked
// the same way; the app made them a photo already.

import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { FILE_PIECE_BYTES, GROUP_PHOTO_MAX_BYTES, GROUP_PHOTO_MAX_SIDE, RpcError } from "@cophyla/protocol";
import type { GroupPhotoType } from "@cophyla/protocol";
import { ConvertError, convertKind } from "../sessions/convert.ts";
import type { ImageConverter } from "../sessions/convert.ts";

/** The longest side a photo is scaled down to when it must be. */
export const PHOTO_SCALE_SIDE = 2048;
/** The longest side a photo keeps as it is: a wider one is scaled, since a model shrinks it anyway. */
export const PHOTO_KEEP_SIDE = 4096;
/** The most of an image read to make a photo of it. */
const PHOTO_READ_MAX = 64 * 1024 * 1024;

export interface ImageInfo {
  type: GroupPhotoType;
  width: number;
  height: number;
}

export interface PreparedPhoto extends ImageInfo {
  bytes: Uint8Array;
  name: string;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/** What an image is and how big, from its first bytes: JPEG, PNG, WebP or GIF; undefined for anything else. */
export function sniffImage(b: Uint8Array): ImageInfo | undefined {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && ascii(b, 12, 4) === "IHDR") return sized("image/png", u32be(b, 16), u32be(b, 20));
  if (b.length >= 10 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return sized("image/gif", u16le(b, 6), u16le(b, 8));
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8 ") return sized("image/webp", u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
    if (chunk === "VP8L") return sized("image/webp", 1 + (((b[22]! & 0x3f) << 8) | b[21]!), 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)));
    if (chunk === "VP8X") return sized("image/webp", 1 + u24le(b, 24), 1 + u24le(b, 27));
    return undefined;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      // fill bytes, and the markers that stand alone
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = u16be(b, i + 2);
      // a start of frame, but not a table (C4 Huffman, C8 reserved, CC arithmetic)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return sized("image/jpeg", u16be(b, i + 7), u16be(b, i + 5));
      if (len < 2) return undefined;
      i += 2 + len;
    }
  }
  return undefined;
}

function sized(type: GroupPhotoType, width: number, height: number): ImageInfo | undefined {
  return width > 0 && height > 0 ? { type, width, height } : undefined;
}

/** Whether a photo goes as it is: a kind every view draws, within a photo's bytes and the side it keeps. */
export function keepsAsItIs(info: ImageInfo, bytes: number): boolean {
  return bytes <= GROUP_PHOTO_MAX_BYTES && Math.max(info.width, info.height) <= PHOTO_KEEP_SIDE;
}

/** Bytes an app uploaded as a photo, checked: a JPEG, PNG, WebP or GIF within a photo's limits. */
export function checkPhoto(bytes: Uint8Array, name: string): PreparedPhoto {
  const info = sniffImage(bytes);
  if (!info) throw new RpcError("invalid", `${name} is not a JPEG, PNG, WebP or GIF image`);
  if (bytes.length > GROUP_PHOTO_MAX_BYTES) throw new RpcError("invalid", `${name} is ${Math.round(bytes.length / 1024)} KB: a photo is ${GROUP_PHOTO_MAX_BYTES / 1024 / 1024} MB at most`);
  if (Math.max(info.width, info.height) > GROUP_PHOTO_MAX_SIDE) throw new RpcError("invalid", `${name} is ${info.width}×${info.height}: a photo is ${GROUP_PHOTO_MAX_SIDE} pixels a side at most`);
  return { ...info, bytes, name };
}

export interface PhotoOptions {
  converter?: ImageConverter;
  /** Refuses a path outside the folders a confined node shares. */
  require?: (path: string) => void;
}

/** The image at `path`, on this machine, made a photo: as it is when it may be, else scaled down to a JPEG. */
export async function preparePhoto(path: string, opts: PhotoOptions = {}): Promise<PreparedPhoto> {
  if (!isAbsolute(path)) throw new RpcError("invalid", `${path}: not an absolute path`);
  let real: string;
  let size: number;
  try {
    real = await realpath(path);
    const info = await stat(real);
    if (!info.isFile()) throw new RpcError("invalid", `${path}: not a file`);
    size = info.size;
  } catch (e) {
    if (e instanceof RpcError) throw e;
    const code = (e as { code?: unknown } | null)?.code;
    throw new RpcError(code === "ENOENT" || code === "ENOTDIR" ? "not_found" : "unavailable", `${path}: ${code === "ENOENT" ? "no such file" : e instanceof Error ? e.message : String(e)}`);
  }
  opts.require?.(real);
  const name = basename(path);
  if (size === 0) throw new RpcError("invalid", `${name} is empty`);
  if (size > PHOTO_READ_MAX) throw new RpcError("invalid", `${name} is over ${PHOTO_READ_MAX / 1024 / 1024} MB: too big for a photo`);
  const head = await readHead(real, Math.min(size, 256 * 1024));
  const info = sniffImage(head);
  if (info && keepsAsItIs(info, size)) {
    const bytes = size <= head.length ? head : await readHead(real, size);
    return { ...info, bytes, name };
  }
  if (!opts.converter || (!info && convertKind(path) === undefined)) throw new RpcError(info ? "unsupported" : "invalid", info ? `${name} is too big for a photo and this computer cannot scale it down` : `${name} is not a JPEG, PNG, WebP, GIF, HEIC or TIFF image`);
  let jpeg: Uint8Array;
  try {
    jpeg = await opts.converter(real, info ? info.type.slice("image/".length).toUpperCase() : (convertKind(path) ?? "image"), { max: PHOTO_SCALE_SIDE, format: "jpeg" });
  } catch (e) {
    throw new RpcError("unsupported", e instanceof ConvertError ? `${name}: ${e.message}` : `${name} could not be made a photo: ${e instanceof Error ? e.message : String(e)}`);
  }
  return checkPhoto(jpeg, name.replace(/\.[^.]*$/, "") + ".jpg");
}

/** How long a photo made is kept for its next pieces. */
const MADE_MS = 60_000;

/**
 * Photos made on this machine for the primary, a piece at a time: the first piece makes it, and
 * the rest read what was made, kept a minute.
 */
export class PhotoMaker {
  private kept = new Map<string, { at: number; photo: PreparedPhoto }>();
  private opts: PhotoOptions;
  private now: () => number;

  constructor(opts: PhotoOptions = {}, now: () => number = Date.now) {
    this.opts = opts;
    this.now = now;
  }

  async piece(path: string, at = 0, require?: (path: string) => void): Promise<ImageInfo & { data: Uint8Array; at: number; total: number; name: string }> {
    const t = this.now();
    for (const [k, v] of this.kept) if (t - v.at > MADE_MS) this.kept.delete(k);
    let k = at === 0 ? undefined : this.kept.get(path);
    if (!k) {
      k = { at: t, photo: await preparePhoto(path, { ...this.opts, ...(require ? { require } : {}) }) };
      this.kept.set(path, k);
    }
    const ph = k.photo;
    if (at > ph.bytes.length) throw new RpcError("invalid", "past the photo's end");
    return { type: ph.type, width: ph.width, height: ph.height, name: ph.name, data: ph.bytes.subarray(at, at + FILE_PIECE_BYTES), at, total: ph.bytes.length };
  }
}

async function readHead(path: string, n: number): Promise<Uint8Array> {
  const fh = await open(path, "r");
  try {
    const buf = new Uint8Array(n);
    let got = 0;
    while (got < n) {
      const { bytesRead } = await fh.read(buf, got, n - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return buf.subarray(0, got);
  } finally {
    await fh.close();
  }
}
