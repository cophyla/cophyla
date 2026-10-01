// What a stream is asked for when the user set nothing: the host's own screen size, so the
// picture has its shape and no bars, at 60 frames a second, and a bitrate of a quarter of a
// bit per pixel per frame, held between 10 and 150 Mbps: about 31 Mbps at 1080p60, 35 at
// 1200p60, 55 at 1440p60 and 124 at 4K, which the LAN carries. A stream across the internet
// (no LAN route, WebRTC through the host's TURN servers) is held to 15 Mbps.

import type { DisplaySize } from "@cophyla/protocol";

export interface StreamVideo {
  width: number;
  height: number;
  fps: number;
  /** Kbps, as moonlight-qt and moonlight-web take it. */
  bitrate: number;
}

/** The size a stream falls back to with no screen to go by. */
export const FALLBACK_SIZE: DisplaySize = { width: 1920, height: 1080 };
const FPS = 60;
const BITS_PER_PIXEL = 0.25;
const MIN_KBPS = 10_000;
const MAX_KBPS = 150_000;
const AWAY_KBPS = 15_000;

/** The stream's size, frame rate and bitrate for a host showing `display`; across the internet when `away`. */
export function streamVideo(display: DisplaySize | undefined, opts: { away?: boolean } = {}): StreamVideo {
  const { width, height } = display ?? FALLBACK_SIZE;
  const kbps = Math.round((width * height * FPS * BITS_PER_PIXEL) / 1000);
  const held = Math.min(MAX_KBPS, Math.max(MIN_KBPS, kbps));
  return { width, height, fps: FPS, bitrate: opts.away ? Math.min(held, AWAY_KBPS) : held };
}
