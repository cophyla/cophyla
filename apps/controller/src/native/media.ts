// Streamed media on the phone: the Kotlin side (MediaFiles.kt, CophylaMediaPlugin.kt) serves a
// video or a sound to the view's player at `/_cophyla_media/<id>/<name>` on the app's own origin,
// answering the player's byte ranges from the pieces it keeps in the app's cache, and asks for the
// ones it lacks (`need`); @cophyla/viewhost's MediaHost reads them over the link and hands them
// back (`piece`). Every file is kept: none of them is on the phone.

import type { MediaNative, MediaNeed, MediaStats, MediaStream } from "@cophyla/viewhost";

/** The slice of the Kotlin plugin this needs, so a test can play it. */
export interface CophylaMediaPlugin {
  open(options: MediaStream): Promise<unknown>;
  piece(options: { req: number; data?: string; error?: string }): Promise<void>;
  close(options: { id: string }): Promise<void>;
  stats(options: { id: string }): Promise<MediaStats>;
  addListener(event: "need", listener: (need: MediaNeed) => void): Promise<unknown> | unknown;
}

/** Where the plugin serves streams, under the app's own origin. */
export const MEDIA_PATH = "/_cophyla_media/";

/** The native side of the phone's streams, and a way to hear what it lacks. */
export function phoneMedia(plugin: CophylaMediaPlugin, origin: string): { native: MediaNative; onNeed: (listener: (need: MediaNeed) => void) => void } {
  return {
    native: {
      // the plugin is told the stream alone: the pieces it lacks are read here, in the page
      open: async ({ name, read: _read, modified: _modified, ...stream }) => {
        await plugin.open(stream);
        return { url: `${origin}${MEDIA_PATH}${encodeURIComponent(stream.id)}/${encodeURIComponent(name)}` };
      },
      piece: (answer) => plugin.piece(answer),
      close: (id) => plugin.close({ id }),
      stats: (id) => plugin.stats({ id }),
    },
    onNeed: (listener) => void plugin.addListener("need", listener),
  };
}
