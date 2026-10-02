// A turn's explicit cache on Gemini. The brain names its turn on every step (`cache.key`) and
// holds the turn's system prompt, so from one step to the next only the end of the request
// changes: the seed's message and what came after it. The cache holds the rest, the system
// prompt, the tools and every content before the last of the request it is made from, and a
// step that uses it sends only the contents after them. `eager` makes it before the first step
// (a wake, which nobody waits on; making it first adds about two seconds); otherwise it is
// made beside the first step, which goes whole, and used by the first later step that finds it
// made, never waited for, so the user's turns are no slower. A step whose cached part no
// longer matches (the window cut an older result, the step has no tools) drops it and goes on
// as a first step would. An answer with no tool call ends the turn and deletes it, as does the
// next turn's key; its TTL bounds it in any case. A prefix under the model's minimum is never
// cached, and a cache that cannot be made leaves the turn's steps as they were. The tokens it
// was made with are billed at the input price: they ride as `cacheWrite` on the step that
// first uses it, or on the turn's last.

import { createHash } from "node:crypto";
import type { LlmResult } from "@cophyla/protocol";
import type { Logger } from "../log.ts";

/** How long a turn's cache lives at most; a turn's end deletes it well before. */
export const CACHE_TTL_S = 300;
/** The fewest tokens a cache may hold on Gemini 3.x Flash; a prefix estimated under it is not cached. */
export const CACHE_MIN_TOKENS = 4096;
/** Characters per token for the estimate, low so a prefix near the floor is left plain. */
const CHARS_PER_TOKEN = 3.2;

/** What a request is made of, in Gemini's own shapes. */
export interface CacheParts {
  model: string;
  system?: unknown;
  tools?: unknown;
  contents: unknown[];
}

interface Held {
  key: string;
  /** The contents cached, from the start. */
  cut: number;
  hash: string;
  name?: string;
  making?: Promise<void>;
  /** Not made and not to be tried again this turn: too small, or refused. */
  off?: boolean;
  /** Tokens it was made with, not billed yet. */
  unbilled: number;
}

export interface TurnCacheDeps {
  baseUrl: string;
  apiKey: () => string | undefined;
  fetch?: typeof fetch;
  log: Logger;
  ttlS?: number;
}

/** What a step sends against the cache: its name, the contents after it, and the made tokens to bill. */
export interface CacheUse {
  name: string;
  contents: unknown[];
  written: number;
}

function hashOf(p: CacheParts, cut: number): string {
  return createHash("sha256").update(JSON.stringify([p.model, p.system ?? null, p.tools ?? null, p.contents.slice(0, cut)])).digest("hex");
}

export class TurnCaches {
  private deps: TurnCacheDeps;
  private held?: Held;

  constructor(deps: TurnCacheDeps) {
    this.deps = deps;
  }

  /** The cache a step of turn `key` uses, made first when `eager`; undefined to send the step whole. */
  async before(key: string, p: CacheParts, eager: boolean): Promise<CacheUse | undefined> {
    if (this.held && this.held.key !== key) this.drop("next turn");
    let h = this.held;
    if (h && !h.off && (p.contents.length <= h.cut || hashOf(p, h.cut) !== h.hash)) {
      this.drop("prefix moved");
      h = undefined;
    }
    // A step with no tools is a turn's last: nothing after it would use a cache made for it.
    if (!h && p.tools !== undefined) {
      h = this.make(key, p);
      if (eager) await h.making;
    }
    if (!h || h.off) return undefined;
    if (!h.name && h.making && eager) await h.making;
    if (!h.name) return undefined;
    const written = h.unbilled;
    h.unbilled = 0;
    return { name: h.name, contents: p.contents.slice(h.cut), written };
  }

  /** After a step of turn `key`: an answer ends the turn, and the cache with it. */
  after(key: string, result: LlmResult): void {
    const h = this.held?.key === key ? this.held : undefined;
    if (!h || result.stopReason === "tool_use" || result.stopReason === "max_tokens") return;
    // Made and never used: its making is this step's to bill.
    if (h.unbilled > 0) result.usage.cacheWrite = (result.usage.cacheWrite ?? 0) + h.unbilled;
    h.unbilled = 0;
    this.drop("turn over");
  }

  /** Turn `key`'s cache was refused when used: dropped, and the turn's next step makes another. */
  forget(key: string): void {
    if (this.held?.key === key) this.drop("refused");
  }

  /** Starts making the cache of `p`'s prefix for turn `key`, held at once so the next step finds it under way. */
  private make(key: string, p: CacheParts): Held {
    const cut = p.contents.length - 1;
    const h: Held = { key, cut, hash: hashOf(p, cut), unbilled: 0 };
    this.held = h;
    const chars = JSON.stringify([p.system ?? null, p.tools ?? null, p.contents.slice(0, cut)]).length;
    if (cut < 1 || chars / CHARS_PER_TOKEN < CACHE_MIN_TOKENS) {
      h.off = true;
      return h;
    }
    h.making = this.create(p, cut).then(
      (made) => {
        h.making = undefined;
        if (this.held !== h) {
          // Dropped while it was being made: gone at once.
          this.remove(made.name);
          if (made.tokens > 0) this.deps.log.info("turn cache made after its turn ended", { tokens: made.tokens });
          return;
        }
        h.name = made.name;
        h.unbilled = made.tokens;
      },
      (e: unknown) => {
        h.making = undefined;
        h.off = true;
        this.deps.log.info("turn cache not made; the turn's steps go whole", { error: e instanceof Error ? e.message : String(e) });
      },
    );
    return h;
  }

  private async create(p: CacheParts, cut: number): Promise<{ name: string; tokens: number }> {
    const key = this.deps.apiKey();
    if (!key) throw new Error("no Gemini API key");
    const body: Record<string, unknown> = { model: `models/${p.model}`, contents: p.contents.slice(0, cut), ttl: `${this.deps.ttlS ?? CACHE_TTL_S}s` };
    if (p.system !== undefined) body["systemInstruction"] = p.system;
    if (p.tools !== undefined) body["tools"] = p.tools;
    const res = await (this.deps.fetch ?? fetch)(`${this.base()}/v1beta/cachedContents`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
    const j = JSON.parse(text) as { name?: unknown; usageMetadata?: { totalTokenCount?: number } };
    if (typeof j.name !== "string") throw new Error("no cache name in the answer");
    return { name: j.name, tokens: j.usageMetadata?.totalTokenCount ?? 0 };
  }

  /** Lets the held cache go: deleted now if made, once made if still being made. */
  private drop(why: string): void {
    const h = this.held;
    if (!h) return;
    this.held = undefined;
    if (h.name) this.remove(h.name);
    if (h.unbilled > 0) this.deps.log.info("turn cache made and not used", { why, tokens: h.unbilled });
    this.deps.log.debug("turn cache dropped", { why, ...(h.name ? { name: h.name } : {}) });
  }

  private remove(name: string): void {
    const key = this.deps.apiKey();
    if (!key) return;
    void (this.deps.fetch ?? fetch)(`${this.base()}/v1beta/${name}`, { method: "DELETE", headers: { "x-goog-api-key": key } }).then(
      (res) => {
        if (!res.ok) this.deps.log.debug("turn cache not deleted; its TTL ends it", { name, status: res.status });
      },
      () => this.deps.log.debug("turn cache not deleted; its TTL ends it", { name }),
    );
  }

  private base(): string {
    return this.deps.baseUrl.replace(/\/$/, "");
  }
}
