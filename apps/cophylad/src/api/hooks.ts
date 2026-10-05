// Hook ingress: `POST /hooks/claude`, `/hooks/codex` and `/hooks/muse` on the api's own server,
// loopback only, behind the hook token. The body is parsed with the protocol's hook schemas;
// an unparsable one is logged and answered `{}`, because a session must never break on
// cophylad's account. A PermissionRequest is held open until its ask settles or the request
// aborts, which is how a phone answers a terminal prompt.

import { timingSafeEqual } from "node:crypto";
import type { Server } from "bun";
import { hooks } from "@cophyla/protocol";
import type { ClaudeHookEvent, CodexHookEvent, MuseHookEvent } from "@cophyla/protocol";
import type { Logger } from "../log.ts";

export type HookHarness = "claude" | "codex" | "muse";

export interface HookMeta {
  /** `http` when the harness posted the event itself; `command` through the shim. */
  via: "http" | "command";
  /** The shim's pid and parent pid, when it ran. */
  pid?: number;
  ppid?: number;
  /** The profile the installed hook names; a hint, never the source of truth for Claude. */
  profile?: string;
  /** Fires when the harness gives up on the request: the terminal answered or the hook timed out. */
  signal?: AbortSignal;
}

export interface HookIngress {
  token: string;
  onHook(harness: HookHarness, event: ClaudeHookEvent | CodexHookEvent | MuseHookEvent, meta: HookMeta): Promise<unknown>;
}

const EMPTY = "{}";

export function tokenMatches(header: string | null, token: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const a = Buffer.from(m[1]!, "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return true;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.");
}

function intHeader(req: Request, name: string): number | undefined {
  const v = req.headers.get(name);
  if (!v) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(body === undefined ? EMPTY : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function handleHook(req: Request, server: Server<unknown>, harness: HookHarness, ingress: HookIngress, log: Logger): Promise<Response> {
  if (req.method !== "POST") return new Response("", { status: 405 });
  const ip = server.requestIP(req)?.address;
  if (!isLoopback(ip)) {
    log.warn("hook refused: not loopback", { harness, ip });
    return new Response("", { status: 403 });
  }
  if (!tokenMatches(req.headers.get("authorization"), ingress.token)) {
    log.warn("hook refused: bad token", { harness, ip });
    return new Response("", { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch (e) {
    log.warn("hook body is not JSON", { harness, error: e instanceof Error ? e.message : String(e) });
    return json({});
  }
  const parsed = hooks[harness].event.safeParse(raw);
  if (!parsed.success) {
    log.warn("hook body does not parse", { harness, issues: parsed.error.issues.slice(0, 3), body: JSON.stringify(raw).slice(0, 300) });
    return json({});
  }

  // A PermissionRequest may be held for hours: past the server's idle timeout.
  server.timeout(req, 0);

  const meta: HookMeta = { via: req.headers.get("x-cophylad") ? "http" : "command", signal: req.signal };
  const pid = intHeader(req, "x-cophyla-pid");
  const ppid = intHeader(req, "x-cophyla-ppid");
  const profile = req.headers.get("x-cophyla-profile");
  if (pid !== undefined) meta.pid = pid;
  if (ppid !== undefined) meta.ppid = ppid;
  if (profile) meta.profile = profile;

  try {
    const answer = await ingress.onHook(harness, parsed.data, meta);
    return json(answer ?? {});
  } catch (e) {
    log.error("hook handling failed", { harness, event: parsed.data.hook_event_name, error: e });
    return json({});
  }
}
