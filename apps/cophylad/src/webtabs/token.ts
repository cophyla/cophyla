// The key in the debugging endpoint Cophyla gives a Claude session it starts
// (`PLAYWRIGHT_MCP_CDP_ENDPOINT=ws://127.0.0.1:<port>/cdp/<token>`): the session's own id, and a
// seal over it that only this daemon can make, so the endpoint says which session's tabs the
// Playwright behind it may drive, and outlives a daemon restart (the seal is made again from the
// same secret). It keeps out a guess, not a program on this machine that reads the session's
// environment.

import { createHmac, timingSafeEqual } from "node:crypto";

const SEAL_CHARS = 22;

function seal(secret: string, native: string): string {
  return createHmac("sha256", secret).update(`cdp:${native}`).digest("base64url").slice(0, SEAL_CHARS);
}

/** The token for a session's native id. */
export function cdpToken(secret: string, native: string): string {
  return `${native}.${seal(secret, native)}`;
}

/** The session's native id a token names, if this daemon sealed it. */
export function readCdpToken(secret: string, token: string): string | undefined {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || token.length > 200) return undefined;
  const native = token.slice(0, dot);
  if (!/^[A-Za-z0-9_-]+$/.test(native)) return undefined;
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(seal(secret, native));
  return given.length === want.length && timingSafeEqual(given, want) ? native : undefined;
}

/** The endpoint a session's Playwright is pointed at. */
export function cdpEndpoint(port: number, secret: string, native: string): string {
  return `ws://127.0.0.1:${port}/cdp/${cdpToken(secret, native)}`;
}
