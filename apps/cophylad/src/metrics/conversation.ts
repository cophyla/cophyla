// What the brain's model calls have cost one conversation, for the Context overlay: the store's
// sums per model (`threadSpend`), each with the price it is charged at and its cost, the cached
// part of the prompts at the cached rate; and the model the next turn goes to, with its price.
// A rate the table leaves out is the input's, as `costOf` takes it, so the overlay shows the
// rate each token was priced at.

import type { ConversationSpend, ModelPrice } from "@cophyla/protocol";
import type { ThreadSpendRow } from "../store/index.ts";
import { completionCost, priceOf } from "./prices.ts";
import type { Price, PriceTable } from "./prices.ts";

export function modelPrice(p: Price): ModelPrice {
  return { input: p.input, output: p.output, cacheRead: p.cache_read ?? p.input, cacheWrite: p.cache_write ?? p.input };
}

/** The conversation's spend by model; `next` is the next turn's model as `vendor/model`, when it is known. */
export function conversationSpend(thread: string, rows: ThreadSpendRow[], table: PriceTable, next?: string): ConversationSpend {
  const models = rows.map((r) => {
    const price = priceOf(table, r.model);
    const tokens = { in: r.in, out: r.out, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite };
    return { model: r.model, calls: r.calls, since: r.since, last: r.last, tokens, ...(price ? { price: modelPrice(price), cost: completionCost(price, tokens) } : {}) };
  });
  const out: ConversationSpend = { thread, models };
  if (next !== undefined) {
    const price = priceOf(table, next);
    out.next = { model: next, ...(price ? { price: modelPrice(price) } : {}) };
  }
  return out;
}
