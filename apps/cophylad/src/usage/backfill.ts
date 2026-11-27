// Fills the spend ledger from the Claude transcripts the adapter does not read live: the ones
// there were before the ledger, and any a session Cophyla never tracked wrote since. The
// background worker finds and reads them (backfill-worker.ts, the `spend.backfill` job) with the
// ledger's marks it reads on its own connection, so the daemon's own thread only writes what
// it hands back, a conversation at a time, after checking the adapter has not claimed it
// meanwhile. Each conversation is told apart by the Cophyla session that tracked it, when one
// did: by the conversation a session is in, or one it left behind as it was cleared
// (`session_clears`, a key lookup each). Until the clears recorded before that table are read
// into it, a run waits: a conversation written without its session would keep none. The daemon
// runs it as a background job: a little after it starts, so the live sessions are claimed
// first, then once an hour, when only what grew is read again.

import type { Background } from "../background/client.ts";
import type { Logger } from "../log.ts";
import type { Price } from "../metrics/prices.ts";
import type { Store } from "../store/index.ts";
import type { BackfillMessage, BackfillRequest, BackfillResult } from "./backfill-worker.ts";
import type { SpendLedger } from "./ledger.ts";

export interface SpendBackfillDeps {
  ledger: SpendLedger;
  store: Store;
  /** Where the transcripts are read: the background worker, or the store's own connection inline. */
  background: Background;
  /** The node's Claude directories, whose `projects` folders hold the transcripts. */
  claudeDirs: () => string[];
  /** What a session the store holds by this id is: in the ledger's terms. */
  session: (id: string) => { profile: string; cwd: string; title?: string } | undefined;
  prices: [string, Price][];
  retentionDays: number;
  log?: Logger;
  now?: () => number;
}

export interface SpendBackfillRun {
  read: number;
  skipped: number;
  failed: number;
  /** The run waited for the clears to be read in: nothing was read. */
  waiting?: true;
}

export class SpendBackfill {
  private deps: SpendBackfillDeps;
  private running?: Promise<SpendBackfillRun>;
  private firstDone = false;

  constructor(deps: SpendBackfillDeps) {
    this.deps = deps;
  }

  /** One run; a run already going is the one waited on. */
  run(): Promise<SpendBackfillRun> {
    this.running ??= this.runOnce().finally(() => (this.running = undefined));
    return this.running;
  }

  private async runOnce(): Promise<SpendBackfillRun> {
    const { ledger, store } = this.deps;
    if (!store.spend.clearsFilled()) {
      this.deps.log?.debug("spend backfill waits for the clears to be read in");
      return { read: 0, skipped: 0, failed: 0, waiting: true };
    }
    const now = this.deps.now?.() ?? Date.now();
    const req: Omit<BackfillRequest, "marks"> = {
      dirs: this.deps.claudeDirs(),
      since: now - this.deps.retentionDays * 86_400_000,
      // What the adapter reads live is its own; the claims are checked again as each result lands.
      claimed: ledger.claimedList(),
      prices: this.deps.prices,
    };
    if (!this.firstDone) ledger.filling = true;
    const started = Date.now();
    let rows = 0;
    let end: Extract<BackfillMessage, { kind: "end" }> | undefined;
    let error: string | undefined;
    try {
      await this.deps.background.call("spend.backfill", req, {
        onPart: (p) => {
          const m = p as BackfillMessage;
          if (m.kind === "result") rows += this.write(m.result);
          else if (m.kind === "end") end = m;
          else error = m.message;
        },
      });
    } finally {
      ledger.filling = false;
      this.firstDone = true;
    }
    if (error !== undefined) throw new Error(error);
    if (!end) throw new Error("the spend backfill ended without its count");
    ledger.prune();
    if (end.read > 0 || end.failed > 0) this.deps.log?.info("spend backfill read", { conversations: end.read, unchanged: end.skipped, failed: end.failed, cells: rows, ms: Date.now() - started });
    return { read: end.read, skipped: end.skipped, failed: end.failed };
  }

  /** A conversation the worker read, written unless the adapter claimed it meanwhile; the cells it wrote. */
  private write(r: BackfillResult): number {
    const { ledger, store } = this.deps;
    if (ledger.isClaimed(r.conversation)) return 0;
    const id = r.conversation.slice(r.conversation.indexOf(":") + 1);
    const tracked = store.sessions.getByNative("claude", id);
    const sessionId = tracked?.id ?? store.spend.clearedSession(id);
    const s = sessionId ? this.deps.session(sessionId) : undefined;
    const at = r.lastAt ?? r.firstAt ?? Date.now();
    try {
      store.spend.commit(
        {
          conversation: r.conversation,
          harness: "claude",
          ...(sessionId ? { session: sessionId } : {}),
          profile: s?.profile ?? "",
          cwd: r.cwd ?? s?.cwd ?? "",
          ...((r.title ?? s?.title) ? { title: r.title ?? s?.title } : {}),
          firstAt: r.firstAt ?? at,
          lastAt: at,
        },
        r.rows,
        r.marks,
      );
      return r.rows.length;
    } catch (e) {
      this.deps.log?.warn("spend backfill write failed", { conversation: r.conversation, error: e instanceof Error ? e.message : String(e) });
      return 0;
    }
  }
}
