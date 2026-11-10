// Videos in the file viewer, DOM-free: which paths are videos and what they play as, read whole
// like an image; what the viewer's head and note say of one (its kind, size, length; too big, or
// a computer too old to send it); a length as a player shows it; and the player page, whose name
// is escaped and whose script is one a browser reads, with its keys and its buttons.

import { describe, expect, test } from "bun:test";
import type { FileText } from "@cophyla/protocol";
import { clockWords, readsWhole, VIDEO_SENT_MAX, videoKind, viewerMeta, viewerNote } from "../views/default/model.ts";
import { NUDGE_S, PLAYER_KEYS, playerPage, SKIP_S } from "../views/default/videoplayer.ts";

const file = (over: Partial<FileText>): FileText => ({ path: "clips/demo.mp4", size: 24 * 1024 * 1024, modified: 1, ...over });

describe("a video in the viewer", () => {
  test("by its extension, any case: what it is called and the type it plays as", () => {
    expect(videoKind("clips/demo.MP4")).toEqual({ kind: "MP4", type: "video/mp4" });
    expect(videoKind("a.m4v")?.type).toBe("video/mp4");
    // QuickTime's H.264 plays as an MP4 does, Matroska's VP9 as a WebM does
    expect(videoKind("a.mov")).toEqual({ kind: "QuickTime", type: "video/mp4" });
    expect(videoKind("a.mkv")).toEqual({ kind: "Matroska", type: "video/webm" });
    expect(videoKind("a.webm")?.kind).toBe("WebM");
    expect(videoKind("a.ogv")?.type).toBe("video/ogg");
    for (const none of ["song.mp3", "mp4", "notes.mp4.txt", "dir.mp4/readme"]) expect(videoKind(none)).toBeUndefined();
    expect(readsWhole("a.mov")).toBe(true);
  });

  test("its head says its kind, its size in pixels and its length once played, and how big it is", () => {
    expect(viewerMeta(file({ base64: "" }), undefined)).toBe("MP4 video · 24 MB");
    expect(viewerMeta(file({ base64: "" }), undefined, { width: 1920, height: 1080 }, undefined, 95.4)).toBe("MP4 video · 1920 × 1080 · 1:35 · 24 MB");
    expect(viewerMeta(file({ path: "a.mov", base64: "" }), undefined, undefined, undefined, 3725)).toBe("QuickTime video · 1:02:05 · 24 MB");
  });

  test("its note: none when it came whole; too big past what is sent; else a computer too old to send it", () => {
    expect(viewerNote(file({ base64: "" }))).toBe("");
    expect(viewerNote(file({ binary: true, size: VIDEO_SENT_MAX + 1 }))).toBe("This video is too big to play here: 256 MB, past 256 MB.");
    expect(viewerNote(file({ binary: true }))).toBe("That computer's Cophyla is too old to play this video: update it there.");
    // A picture keeps its own words.
    expect(viewerNote({ path: "a.png", size: 1, modified: 1, binary: true })).toBe("That computer's Cophyla is too old to show this image: update it there.");
  });

  test("a length as a player shows it", () => {
    expect([clockWords(0), clockWords(9.9), clockWords(61), clockWords(600), clockWords(3600), clockWords(3725)]).toEqual(["0:00", "0:09", "1:01", "10:00", "1:00:00", "1:02:05"]);
    expect([clockWords(Number.NaN), clockWords(Number.POSITIVE_INFINITY), clockWords(-4)]).toEqual(["0:00", "0:00", "0:00"]);
  });

  test("the player page: its name escaped, a video with the browser's controls, buttons back, play and forward, and a speed", () => {
    const page = playerPage('a<b>&"c".mp4');
    expect(page).toContain("<title>a&lt;b&gt;&amp;&quot;c&quot;.mp4</title>");
    expect(page).not.toContain("<b>");
    expect(page).toContain("<video playsinline controls");
    for (const cls of ["back", "play", "fwd", "rate", "time"]) expect(page).toContain(`class="${cls}"`);
    expect(page).toContain(`Back ${SKIP_S} seconds`);
    expect(page).toContain(`Forward ${SKIP_S} seconds`);
    expect(page).toContain(`for ${NUDGE_S})`);
    // It asks the view for the video, and plays it from a blob.
    expect(page).toContain("cophylaMediaReady");
    expect(page).toContain("URL.createObjectURL(new Blob(d.cophylaMedia.parts");
  });

  test("its script is one a browser reads, and the keys the view hands on are the ones it answers", () => {
    const page = playerPage("demo.mp4");
    const script = /<script>([\s\S]*)<\/script>/.exec(page)?.[1] ?? "";
    expect(script.length).toBeGreaterThan(100);
    // Parsed, not run: no DOM here.
    expect(() => new Function(script)).not.toThrow();
    for (const k of ["k", "j", "l", "ArrowLeft", "ArrowRight", "Home", "End", "m", "f"]) expect(script).toContain(k.length === 1 ? `${k}:` : `${k}:`);
    expect(PLAYER_KEYS).toContain(" ");
    expect(PLAYER_KEYS).not.toContain("Escape");
  });
});
