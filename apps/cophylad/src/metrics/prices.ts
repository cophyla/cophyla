// The price table behind cost: built-in prices for the models the platform routes to and
// the harnesses run, in USD per million tokens, with the config's `[metrics.prices]` over
// them. A model is looked up as `vendor/model`, then by its bare name, then by the longest
// key that prefixes it (a dated `claude-sonnet-5-20260801` finds `claude-sonnet-5`). An
// unknown model prices to nothing and is logged once. The table dates itself: prices move,
// and the built-in ones are the September 2026 list prices.

import type { Logger } from "../log.ts";

export interface Price {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

export interface Tokens {
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** USD per million tokens, at each provider's list prices. */
export const BUILTIN_PRICES: Record<string, Price> = {
  "gemini/gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cache_read: 0.025 },
  "gemini/gemini-3.8-flash": { input: 0.75, output: 3.75, cache_read: 0.075 },
  "gemini/gemini-3.7-flash": { input: 0.75, output: 3.75, cache_read: 0.075 },
  "gemini/gemini-3.6-flash": { input: 0.75, output: 3.75, cache_read: 0.075 },
  "gemini/gemini-3.1-pro-preview": { input: 2, output: 12, cache_read: 0.2 },
  "anthropic/claude-sonnet-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  "anthropic/claude-opus-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "anthropic/claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  "openai/gpt-5.6-terra": { input: 2, output: 12, cache_read: 0.2 },
};

export type PriceTable = Map<string, Price>;

/** The built-in table with the overrides on top; a key without a vendor stands for every vendor's model of that name. */
export function priceTable(overrides: Record<string, Price> = {}): PriceTable {
  const table: PriceTable = new Map();
  for (const [k, v] of Object.entries(BUILTIN_PRICES)) table.set(k, v);
  for (const [k, v] of Object.entries(overrides)) table.set(k, v);
  return table;
}

const bare = (model: string): string => (model.includes("/") ? model.slice(model.indexOf("/") + 1) : model);

export function priceOf(table: PriceTable, model: string): Price | undefined {
  const exact = table.get(model);
  if (exact) return exact;
  const name = bare(model);
  const byName = table.get(name) ?? [...table].find(([k]) => bare(k) === name)?.[1];
  if (byName) return byName;
  // The longest key whose bare name prefixes the model's: a dated or suffixed variant finds its family.
  let best: { len: number; price: Price } | undefined;
  for (const [k, price] of table) {
    const kb = bare(k);
    if (name.startsWith(kb) && (!best || kb.length > best.len)) best = { len: kb.length, price };
  }
  return best?.price;
}

/** USD for the tokens at the price; a missing cache price falls back to input (read) or nothing (write). */
export function costOf(price: Price, tokens: Tokens): number {
  const per = 1_000_000;
  let usd = (tokens.in * price.input + tokens.out * price.output) / per;
  if (tokens.cacheRead) usd += (tokens.cacheRead * (price.cache_read ?? price.input)) / per;
  if (tokens.cacheWrite) usd += (tokens.cacheWrite * (price.cache_write ?? price.input)) / per;
  return usd;
}

/**
 * USD for a model call's tokens as `llm.complete` reports them, where `in` is the whole prompt
 * and the part read from a cache is among it, not beside it as `costOf` takes it: that part is
 * priced at the cache's rate and the rest at input.
 */
export function completionCost(price: Price, tokens: Tokens): number {
  const cached = Math.min(tokens.cacheRead ?? 0, tokens.in);
  return costOf(price, { ...tokens, in: tokens.in - cached, cacheRead: cached });
}

/** A pricer over a table that logs each unknown model once. */
export class Pricer {
  private table: PriceTable;
  private log?: Logger;
  private unknown = new Set<string>();

  constructor(table: PriceTable, log?: Logger) {
    this.table = table;
    this.log = log;
  }

  /** The cost, or undefined when the model is not priced. */
  cost(model: string, tokens: Tokens): number | undefined {
    const price = priceOf(this.table, model);
    if (!price) {
      if (!this.unknown.has(model)) {
        this.unknown.add(model);
        this.log?.info("no price for model; cost not counted", { model });
      }
      return undefined;
    }
    return costOf(price, tokens);
  }
}
