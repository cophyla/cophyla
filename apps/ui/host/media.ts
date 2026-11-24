// Streamed media in the desktop app: the shell (src-tauri/src/media.rs) serves a video or a sound
// to the view's player from a server on this computer's loopback, at a path with a secret of the
// run's in it, answering the player's byte ranges from the pieces it keeps, and reads the ones it
// lacks itself, over its own link to cophylad with the view's read, so no piece passes through
// this page (each would cross the web view twice, as base64). A file on another computer is kept
// on this one's disk; a file on this computer only in memory. The player frame cannot stream from
// the app's own schemes: the view's frame has no origin of its own, nor has anything framed in
// it, and WebView2 hands the shell no media request from such a frame.

import type { MediaNative, MediaStats } from "@cophyla/viewhost";

export interface MediaIo {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

/** The shell's side of the app's streams. */
export function shellMedia(io: MediaIo): MediaNative {
  return {
    open: (s) => io.invoke<{ url: string }>("media_open", { id: s.id, key: s.key, size: s.size, mime: s.mime, keep: s.keep, name: s.name, read: s.read, modified: s.modified }),
    // the shell reads its pieces itself: none is ever handed it from here
    piece: async () => {},
    close: (id) => io.invoke<void>("media_close", { id }),
    stats: (id) => io.invoke<MediaStats>("media_stats", { id }),
  };
}
