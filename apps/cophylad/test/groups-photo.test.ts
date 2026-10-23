// A photo for a group chat's post, made from an image on a machine: its kind and size read from
// its first bytes, never its name; kept as it is within a photo's limits, else scaled down to a
// JPEG by the computer's own codecs, or refused saying why.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GROUP_PHOTO_MAX_BYTES } from "@cophyla/protocol";
import { checkPhoto, PhotoMaker, preparePhoto, sniffImage } from "../src/groups/photo.ts";
import { tempHome } from "./helpers.ts";
import { PNG_1X1 } from "./images.ts";


function png(width: number, height: number, extra = 0): Uint8Array {
  const b = new Uint8Array(33 + extra);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment, then SOF0 with the size
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, ...new Array(9).fill(0)];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

describe("photos", () => {
  test("an image's kind and size come from its first bytes: PNG, JPEG, GIF and WebP", () => {
    expect(sniffImage(PNG_1X1)).toEqual({ type: "image/png", width: 1, height: 1 });
    expect(sniffImage(png(1920, 1080))).toEqual({ type: "image/png", width: 1920, height: 1080 });
    expect(sniffImage(jpeg(4032, 3024))).toEqual({ type: "image/jpeg", width: 4032, height: 3024 });
    const gif = new Uint8Array([...Buffer.from("GIF89a"), 0x40, 0x01, 0xf0, 0x00, 0, 0, 0]);
    expect(sniffImage(gif)).toEqual({ type: "image/gif", width: 320, height: 240 });
    const vp8x = new Uint8Array(30);
    vp8x.set(Buffer.from("RIFF"), 0);
    vp8x.set(Buffer.from("WEBPVP8X"), 8);
    vp8x.set([0x7f, 0x07, 0x00, 0x37, 0x04, 0x00], 24);
    expect(sniffImage(vp8x)).toEqual({ type: "image/webp", width: 1920, height: 1080 });
    expect(sniffImage(Buffer.from("not an image at all, just words"))).toBeUndefined();
  });

  test("bytes an app uploaded must be an image within a photo's limits", () => {
    expect(checkPhoto(PNG_1X1, "dot.png")).toMatchObject({ type: "image/png", width: 1, height: 1, name: "dot.png" });
    expect(() => checkPhoto(Buffer.from("hello"), "notes.txt")).toThrow("not a JPEG, PNG, WebP or GIF");
    expect(() => checkPhoto(png(9000, 10), "wide.png")).toThrow("8000 pixels a side");
    expect(() => checkPhoto(png(100, 100, GROUP_PHOTO_MAX_BYTES), "big.png")).toThrow("MB at most");
  });

  test("an image on the machine goes as it is within the limits; a big one is scaled to a JPEG; one with no codec is refused", async () => {
    const home = tempHome();
    mkdirSync(home, { recursive: true });
    const small = join(home, "shot.png");
    writeFileSync(small, PNG_1X1);
    const kept = await preparePhoto(small);
    expect(kept).toMatchObject({ type: "image/png", width: 1, height: 1, name: "shot.png" });
    expect(Buffer.from(kept.bytes).equals(PNG_1X1)).toBe(true);

    const wide = join(home, "panorama.png");
    writeFileSync(wide, png(6000, 1000, 100));
    const asked: { kind: string; max?: number; format?: string }[] = [];
    const scaled = await preparePhoto(wide, {
      converter: async (_p, kind, o) => {
        asked.push({ kind, ...(o?.max ? { max: o.max } : {}), ...(o?.format ? { format: o.format } : {}) });
        return jpeg(2048, 341);
      },
    });
    expect(asked).toEqual([{ kind: "PNG", max: 2048, format: "jpeg" }]);
    expect(scaled).toMatchObject({ type: "image/jpeg", width: 2048, height: 341, name: "panorama.jpg" });

    await expect(preparePhoto(wide)).rejects.toThrow("cannot scale it down");
    const text = join(home, "notes.txt");
    writeFileSync(text, "words");
    await expect(preparePhoto(text, { converter: async () => jpeg(1, 1) })).rejects.toThrow("not a JPEG, PNG, WebP, GIF, HEIC or TIFF image");
    // a HEIC is made a photo by the codecs, by its name
    const heic = join(home, "IMG_0001.HEIC");
    writeFileSync(heic, "ftypheic....");
    expect(await preparePhoto(heic, { converter: async () => jpeg(2048, 1536) })).toMatchObject({ type: "image/jpeg", name: "IMG_0001.jpg" });
    await expect(preparePhoto(join(home, "gone.png"))).rejects.toThrow("no such file");
    await expect(preparePhoto("relative/shot.png")).rejects.toThrow("not an absolute path");
  });

  test("a photo made for the primary goes a piece at a time, the rest read from what was made", async () => {
    const home = tempHome();
    mkdirSync(home, { recursive: true });
    const path = join(home, "shot.png");
    writeFileSync(path, PNG_1X1);
    let made = 0;
    const maker = new PhotoMaker({ converter: async () => (made++, jpeg(1, 1)) });
    const first = await maker.piece(path, 0);
    expect(first).toMatchObject({ type: "image/png", at: 0, total: PNG_1X1.length, width: 1, height: 1, name: "shot.png" });
    const rest = await maker.piece(path, 10);
    expect(rest.at).toBe(10);
    expect(Buffer.from(rest.data).equals(PNG_1X1.subarray(10))).toBe(true);
    expect(made).toBe(0);
    await expect(maker.piece(path, 1000)).rejects.toThrow("past the photo's end");
  });
});
