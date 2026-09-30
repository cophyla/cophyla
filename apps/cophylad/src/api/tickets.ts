// Serving a view's files to the controller's sandboxed frame. The desktop app stages a view
// on the shell's native side and loads it from a custom-protocol origin; a browser has no
// such origin, so the node serves the same files over the controller listener under an
// unguessable ticket and the same frame policy: scripts, styles, images and fonts from this
// origin only, no `connect-src`, and only the controller page may embed it. The view may frame
// this origin, for the document frame the listener serves beside the views (DOC_FRAME_PATH),
// in which it runs an HTML file's scripts under that page's own policy. A ticket belongs
// to one client and is forgotten when it disconnects, so a view's files are reachable only
// while the client that asked for them is on the socket.

import { randomBytes } from "node:crypto";
import type { ViewContent } from "@cophyla/protocol";

export interface Served {
  bytes: Uint8Array;
  mime: string;
}

/**
 * What the frame may do. The same policy as the desktop shell's (`apps/ui/src-tauri/src/views.rs`)
 * with this listener's origin in place of the view origin (`http://view.localhost` on Windows,
 * `view://localhost` on macOS and Linux): no network of its own, and
 * only the page that framed it may embed it.
 */
export function viewCsp(origin: string): string {
  return [
    "default-src 'none'",
    `script-src ${origin}`,
    `style-src ${origin} 'unsafe-inline'`,
    `img-src ${origin} data:`,
    `font-src ${origin}`,
    "connect-src 'none'",
    `frame-src ${origin}`,
    `frame-ancestors ${origin}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * The headers every view file is served with, the policy included.
 *
 * `access-control-allow-origin: null` is what makes a view's `<script type="module">` load:
 * the frame is sandboxed without `allow-same-origin`, so its document sits on an opaque
 * origin and a module fetch from it is cross-origin, with `Origin: null`. The desktop shell
 * has the same shape and its custom protocol answers the same way. The ticket in the path is
 * what keeps the files private; this header only lets the frame read what it was given.
 */
export function viewHeaders(origin: string, mime: string): Record<string, string> {
  return {
    "content-type": mime,
    "content-security-policy": viewCsp(origin),
    "access-control-allow-origin": "null",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

const VALID_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** The same rule the shell's `valid_path` applies: relative, no traversal, plain segments. */
export function validPath(path: string): boolean {
  if (!path || path.startsWith("/")) return false;
  return path.split("/").every((s) => s !== "" && s !== "." && s !== ".." && VALID_SEGMENT.test(s));
}

interface Ticketed {
  client: string;
  version: string;
  files: Map<string, Served>;
}

export class ViewTickets {
  private byTicket = new Map<string, Ticketed>();
  private byClient = new Map<string, string>();

  /** Stages one view for one client, replacing whatever that client staged before. */
  stage(client: string, content: ViewContent): { ticket: string; version: string } {
    this.forget(client);
    const files = new Map<string, Served>();
    for (const file of content.files) {
      if (!validPath(file.path)) continue;
      const bytes = file.text !== undefined ? new TextEncoder().encode(file.text) : file.base64 !== undefined ? new Uint8Array(Buffer.from(file.base64, "base64")) : undefined;
      if (!bytes) continue;
      files.set(file.path, { bytes, mime: file.mime });
    }
    const ticket = randomBytes(16).toString("hex");
    this.byTicket.set(ticket, { client, version: content.version, files });
    this.byClient.set(client, ticket);
    return { ticket, version: content.version };
  }

  serve(ticket: string, path: string): Served | undefined {
    if (!validPath(path)) return undefined;
    return this.byTicket.get(ticket)?.files.get(path);
  }

  /** The client a ticket belongs to, for a listener that checks the two agree. */
  owner(ticket: string): string | undefined {
    return this.byTicket.get(ticket)?.client;
  }

  forget(client: string): void {
    const ticket = this.byClient.get(client);
    if (ticket === undefined) return;
    this.byTicket.delete(ticket);
    this.byClient.delete(client);
  }

  get size(): number {
    return this.byTicket.size;
  }
}
