// The clears recorded before `session_clears` existed, read into it once. The spend ledger
// tells a conversation's session by the conversation a session is in, or one it left as it was
// cleared; the table keeps each clear as it is recorded, and this fills it from the session
// events already stored: the background worker reads them a range of rowids at a time, this
// thread writes what each range held, and the rowid reached is kept in `meta`, so a stopped
// fill resumes where it was and a finished one is marked done and never repeated. A clear
// recorded meanwhile is written as it happens; the later of two clears of one conversation wins.

import type { JobContext } from "../background/scheduler.ts";
import type { ClearRow } from "../background/jobs.ts";
import type { Store } from "./index.ts";

export const CLEARS_FILLED = "store.session_clears.v1";
const CLEARS_AT = "store.session_clears.v1.at";
/** Rowids one read covers: a few thousand rows of session events. */
const SPAN = 20_000;

/** What a fill needs of its job: the worker's reads and the slices. */
export type FillContext = Pick<JobContext, "read" | "yield" | "stopping">;

/** Fills `session_clears` from the stored events; true once it is done. */
export async function fillClears(store: Store, ctx: FillContext): Promise<boolean> {
  if (store.meta.get(CLEARS_FILLED) === "done") return true;
  let after = Number(store.meta.get(CLEARS_AT) ?? "0") || 0;
  const max = await ctx.read<number>("rowid.max", { table: "session_events" });
  while (after < max) {
    if (ctx.stopping) return false;
    const to = Math.min(max, after + SPAN);
    const rows = await ctx.read<ClearRow[]>("clears.scan", { after, to });
    store.db.transaction(() => {
      for (const r of rows) store.spend.putClear(r.native, r.session, r.at);
      store.meta.set(CLEARS_AT, String(to));
    })();
    after = to;
    await ctx.yield();
  }
  store.meta.set(CLEARS_FILLED, "done");
  return true;
}
