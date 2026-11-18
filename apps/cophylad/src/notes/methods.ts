// The notes' client methods: the notes agents left the user listed, marked read or answered by
// hand, and dismissed (`note.*`), and whether agents may leave them (`notes.*`): `sessions:read`
// to read, `sessions:write` to change, the changes refused to limited access by the filter
// tables. The notes are the primary's: a client of a secondary is the primary's client, and its
// requests are answered there. Clients alone: the brain neither reads nor changes them.

import { RpcError } from "@cophyla/protocol";
import type { MethodTable } from "../api/methods.ts";
import type { Notes } from "./index.ts";

export function notesMethods(deps: { notes: () => Notes | undefined }): MethodTable {
  const get = (): Notes => {
    const n = deps.notes();
    if (!n) throw new RpcError("unavailable", "notes are kept by the primary");
    return n;
  };
  return {
    "note.list": { handler: () => ({ notes: get().list() }) },
    "note.mark": {
      target: (p) => p.id,
      handler: (p) => ({ note: get().mark(p.id, { ...(p.read !== undefined ? { read: p.read } : {}), ...(p.answered !== undefined ? { answered: p.answered } : {}) }) }),
    },
    "note.dismiss": {
      handler: (p) => {
        get().dismiss(p.ids);
        return {};
      },
    },
    "notes.get": { handler: () => get().state() },
    "notes.set": { handler: (p) => get().set({ on: p.on }) },
  };
}
