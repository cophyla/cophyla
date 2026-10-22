// The transfer methods a client calls (`transfer.*`, the `terminal` scope, refused to limited
// access by the filter tables): a transfer to this machine started, stopped, tried again or
// forgotten, and the list. One to another machine is forwarded to it (nodes/forward.ts), which
// keeps it; a client's own is always the user's, whatever it says of who sent it. Where one
// landed shows in this computer's file manager (`transfer.reveal`), for the desktop app here.

import { RpcError } from "@cophyla/protocol";
import type { MethodTable } from "../api/methods.ts";
import type { Revealer } from "../sessions/reveal.ts";
import type { Transfers } from "./index.ts";

/** The last name of a path, whichever machine's separators it has. */
export function lastName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** What starting a transfer asks, where policy asks: what comes, from where, into which folder, and why when it says. */
export function transferAsk(p: { from: { node: string; path: string }; to: { node: string; dir?: string }; reason?: string }): { title: string; detail?: string } {
  return { title: `Copy ${lastName(p.from.path)} to this machine?`, detail: `${p.reason ? `${p.reason}\n` : ""}${p.from.path}, into ${p.to.dir ?? "the Downloads folder"}.` };
}

export function transferMethods(deps: { transfers: () => Transfers | undefined; nodeId: string; revealer?: Revealer }): MethodTable {
  const get = (): Transfers => {
    const t = deps.transfers();
    if (!t) throw new RpcError("unsupported", "this machine receives no files");
    return t;
  };
  return {
    "transfer.start": {
      target: (p) => p.from.path,
      ask: (p) => transferAsk(p),
      handler: (p) => get().begin({ from: p.from, to: p.to, ...(p.reason ? { reason: p.reason } : {}), ...(p.relayOk ? { relayOk: true } : {}), by: { kind: "user" } }),
    },
    "transfer.cancel": {
      target: (p) => p.id,
      handler: async (p) => {
        await get().cancel(p.id);
        return {};
      },
    },
    "transfer.retry": {
      target: (p) => p.id,
      handler: (p) => {
        get().retry(p.id);
        return {};
      },
    },
    "transfer.dismiss": {
      target: (p) => p.id,
      handler: async (p) => {
        await get().dismiss(p.id);
        return {};
      },
    },
    "transfer.list": {
      handler: () => ({ transfers: deps.transfers()?.list() ?? [] }),
    },
    // This computer's file manager: only the desktop app here may ask, for a transfer that landed here.
    "transfer.reveal": {
      target: (p) => p.id,
      handler: async (p, ctx) => {
        if (ctx.client.kind !== "ui" || ctx.client.node !== deps.nodeId || ctx.listener !== "loopback") throw new RpcError("unsupported", "only Cophyla on the computer it landed on can show it in its file manager");
        const t = get().get(p.id);
        if (!t) throw new RpcError("not_found", `no transfer ${p.id} on this computer`);
        if (t.state !== "done" || t.to.path === undefined) throw new RpcError("conflict", `${t.name} has not landed`);
        if (!deps.revealer) throw new RpcError("unsupported", "this computer has no file manager to show files in");
        await deps.revealer(t.to.path, t.kind === "folder" ? "dir" : "file");
        return {};
      },
    },
  };
}
