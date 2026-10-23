// Fills the spend ledger from the Claude transcripts the adapter does not read live: the ones
// there were before the ledger, and any a session Cophyla never tracked wrote since. A worker
// (backfill-worker.ts) finds and reads them, so the daemon's own thread only writes what it
// hands back, a conversation at a time, after checking the adapter has not claimed it
// meanwhile. Each conversation is told apart by the Cophyla session that tracked it, when one
// did: by the conversation a session is in, or one it left behind as it was cleared. The
// first run starts a little after the daemon, so the live sessions are claimed first; then
// once an hour, when only what grew is read again.

import type { Logger } from "../log.ts";
import type { Price } from "../metrics/prices.ts";
import type { Store } from "../store/index.ts";
import type { BackfillMessage, BackfillRequest, BackfillResult } from "./backfill-worker.ts";
import type { SpendLedger } from "./ledger.ts";

export interface SpendBackfillDeps {
  ledger: SpendLedger;
  store: Store;
  /** The node's Claude directories, whose `projects` folders hold the transcripts. */
  claudeDirs: () => string[];
  /** What a session the store holds by this id is: in the ledger's terms. */
  session: (id: string) => { profile: string; cwd: string; title?: string } | undefined;
  prices: [string, Price][];
  retentionDays: number;
  log?: Logger;
  now?: () => number;
  /** How long after `start` the first run begins. */
  delayMs?: number;
  /** How often it runs again. */
  everyMs?: number;
}

const DELAY_MS = 30_000;
const EVERY_MS = 3_600_000;

export class SpendBackfill {
  private deps: SpendBackfillDeps;
  private timer?: ReturnType<typeof setTimeout>;
  private worker?: Worker;
  private running?: Promise<{ read: number; skipped: number; failed: number }>;
  private stopped = false;
  private firstDone = false;

  constructor(deps: SpendBackfillDeps) {
    this.deps = deps;
  }

  start(): void {
    this.stopped = false;
    this.schedule(this.deps.delayMs ?? DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.worker?.terminate();
    this.worker = undefined;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.run()
        .catch((e) => this.deps.log?.warn("spend backfill failed", { error: e instanceof Error ? e.message : String(e) }))
        .finally(() => this.schedule(this.deps.everyMs ?? EVERY_MS));
    }, ms);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** One run; a run already going is the one waited on. */
  run(): Promise<{ read: number; skipped: number; failed: number }> {
    this.running ??= this.runOnce().finally(() => (this.running = undefined));
    return this.running;
  }

  private runOnce(): Promise<{ read: number; skipped: number; failed: number }> {
    const { ledger, store } = this.deps;
    const now = this.deps.now?.() ?? Date.now();
    const req: BackfillRequest = {
      dirs: this.deps.claudeDirs(),
      since: now - this.deps.retentionDays * 86_400_000,
      // What the adapter reads live is its own; the claims are checked again as each result lands.
      claimed: ledger.claimedList(),
      marks: store.spend.allMarks(),
      prices: this.deps.prices,
    };
    const cleared = store.spend.clearedFrom();
    if (!this.firstDone) ledger.filling = true;
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./backfill-worker.ts", import.meta.url).href);
      this.worker = worker;
      let rows = 0;
      const finish = (): void => {
        worker.terminate();
        if (this.worker === worker) this.worker = undefined;
        ledger.filling = false;
        this.firstDone = true;
      };
      worker.onmessage = (ev: MessageEvent<BackfillMessage>) => {
        const m = ev.data;
        if (m.kind === "result") rows += this.write(m.result, cleared);
        else if (m.kind === "end") {
          finish();
          ledger.prune();
          if (m.read > 0 || m.failed > 0) this.deps.log?.info("spend backfill read", { conversations: m.read, unchanged: m.skipped, failed: m.failed, cells: rows, ms: Date.now() - started });
          resolve({ read: m.read, skipped: m.skipped, failed: m.failed });
        } else {
          finish();
          reject(new Error(m.message));
        }
      };
      worker.onerror = (ev) => {
        finish();
        reject(new Error(ev.message));
      };
      worker.postMessage(req);
    });
  }

  /** A conversation the worker read, written unless the adapter claimed it meanwhile; the cells it wrote. */
  private write(r: BackfillResult, cleared: Map<string, string>): number {
    const { ledger, store } = this.deps;
    if (ledger.isClaimed(r.conversation)) return 0;
    const id = r.conversation.slice(r.conversation.indexOf(":") + 1);
    const tracked = store.sessions.getByNative("claude", id);
    const sessionId = tracked?.id ?? cleared.get(id);
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
