// What the brain sees on its next turn (`brain.context`), behind the Context button in the chat's
// composer, which shows only while the node turned it on (`[brain] show_context`): laid over the
// chat's conversation and nothing else, so it goes when another tab is shown and comes back with
// the chat, asked for afresh. Its head says when it was read, with Refresh and Close. Under it,
// three tiles: what the conversation's model calls have cost, its input tokens with the share read
// from the provider's cache, and the next turn's tokens against the window's budget. Then sections
// that fold: the spend by model, line by line with the rate each kind of token is charged at; the
// next turn's tokens tier by tier against their budgets; the log, the messages after it, the
// situation, then the fixed rules and the tools' names, folded. The model's text is in a `pre`,
// set with `textContent`: nothing the model is sent is ever parsed as HTML. What the user folded
// stays folded across a refresh.

import type { BrainContext, ConversationSpend } from "@cophyla/protocol";
import { contextBlocks, countWords, nextTurn, percentWords, rateWords, spendSummary, tierRows, tokenWords, usdWords } from "./model.ts";
import type { SpendSummary } from "./model.ts";
import { ViewRpcError } from "./rpc.ts";
import type { HostRpc } from "./rpc.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(className: string, title: string): HTMLButtonElement {
  const b = el("button", className);
  b.type = "button";
  b.dataset["action"] = className.split(" ")[0]!;
  b.title = title;
  b.setAttribute("aria-label", title);
  return b;
}

/** The sections, in order, and whether each shows open until the user folds it. */
const SECTIONS = [
  ["spend", "Spend by model", true],
  ["tokens", "Next turn's tokens", true],
  ["log", "Log", true],
  ["messages", "Messages", true],
  ["situation", "Situation", true],
  ["rules", "Rules", false],
  ["tools", "Tools", false],
] as const;

type Section = (typeof SECTIONS)[number][0];

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/** A bar of `share` (0 to 1, more when over), filled in the brand's colour, the warning's past 80% and the error's past the end. */
function meter(share: number, label: string): HTMLElement {
  const bar = el("span", "context-meter");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", label);
  bar.title = label;
  const fill = el("span", "context-meter-fill");
  fill.style.width = `${Math.min(100, Math.max(0, share * 100)).toFixed(1)}%`;
  bar.dataset["level"] = share > 1 ? "over" : share >= 0.8 ? "high" : "normal";
  bar.append(fill);
  return bar;
}

export class ContextView {
  /** The overlay: its head (the title, when it was read, Refresh, Close), a note, and the body. */
  readonly el: HTMLElement;
  private meta: HTMLElement;
  private note: HTMLElement;
  private body: HTMLElement;
  private refreshButton: HTMLButtonElement;
  private rpc: HostRpc;
  private generation = 0;
  /** Whether each section is open, as the user left it. */
  private open = new Map<Section, boolean>();

  constructor(rpc: HostRpc) {
    this.rpc = rpc;
    this.el = el("aside", "context-view");
    this.el.hidden = true;
    this.el.setAttribute("aria-label", "What the brain sees on its next turn, and what the conversation has cost");
    const head = el("header", "context-head");
    const title = el("span", "context-title", "Context for the next turn");
    this.meta = el("span", "context-meta");
    const tools = el("span", "context-tools");
    this.refreshButton = button("context-refresh viewer-tool viewer-refresh", "Ask the brain again");
    tools.append(this.refreshButton, button("context-close viewer-tool viewer-close", "Close (Esc)"));
    head.append(el("span", "context-mark"), title, this.meta, tools);
    this.note = el("p", "context-note");
    this.note.hidden = true;
    this.body = el("div", "context-body");
    this.body.tabIndex = 0;
    this.el.append(head, this.note, this.body);
    // A section the user folds or opens stays so when the context is read again.
    this.body.addEventListener("toggle", (ev) => {
      const d = ev.target as HTMLDetailsElement;
      const key = d.dataset["section"] as Section | undefined;
      if (key) this.open.set(key, d.open);
    }, true);
  }

  get shown(): boolean {
    return !this.el.hidden;
  }

  /** Lays it over `parent` and asks the brain what it sees now. */
  show(parent: HTMLElement): void {
    if (this.el.parentElement !== parent) parent.append(this.el);
    this.el.hidden = false;
    void this.refresh();
  }

  hide(): void {
    this.el.hidden = true;
    // An answer still coming is for an overlay that is gone.
    this.generation++;
  }

  focus(): void {
    this.body.focus();
  }

  /** Asks for the context again; what shows stays until the answer comes. */
  async refresh(): Promise<void> {
    const generation = ++this.generation;
    this.say("Asking the brain…");
    this.refreshButton.disabled = true;
    try {
      const r = await this.rpc.request<{ context?: BrainContext; spend?: ConversationSpend }>("brain.context", {});
      if (generation !== this.generation) return;
      if (!r.context) throw new Error("the node sent no context");
      this.draw(r.context, r.spend);
      this.say(undefined);
    } catch (e) {
      if (generation !== this.generation) return;
      this.say(e instanceof ViewRpcError && e.code === "unavailable" ? `The brain cannot say now: ${e.message}` : `No context: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      if (generation === this.generation) this.refreshButton.disabled = false;
    }
  }

  private say(words: string | undefined, error = false): void {
    this.note.textContent = words ?? "";
    this.note.hidden = words === undefined;
    this.note.dataset["error"] = error ? "1" : "0";
  }

  private draw(c: BrainContext, spend: ConversationSpend | undefined): void {
    this.meta.textContent = `as of ${new Date(c.at).toLocaleTimeString()}`;
    this.meta.title = `${c.thread ? `Thread ${c.thread}. ` : ""}Tokens to come are estimated at four characters each; the spend is what the model reported.`;
    const sum = spendSummary(spend);
    const top = this.body.scrollTop;
    const sections: HTMLElement[] = [this.tiles(c, spend, sum)];
    for (const [key, label, open] of SECTIONS) {
      const d = el("details", "context-section");
      d.dataset["section"] = key;
      d.open = this.open.get(key) ?? open;
      const summary = el("summary", "context-summary", label);
      d.append(summary);
      switch (key) {
        case "spend":
          if (sum.calls > 0) summary.append(el("span", "context-count", usdWords(sum.cost)));
          d.append(this.spendTable(sum));
          break;
        case "tokens":
          d.append(this.tierTable(c));
          break;
        case "log":
          d.append(this.pre(c.log ?? "(no log yet)"));
          break;
        case "messages": {
          const blocks = contextBlocks(c.messages);
          summary.append(el("span", "context-count", String(blocks.length)));
          if (blocks.length === 0) d.append(this.pre("(none: the log covers every turn so far)"));
          for (const b of blocks) {
            const block = el("div", "context-block");
            block.dataset["role"] = b.role;
            block.append(el("div", "context-label", b.label), this.pre(b.text));
            d.append(block);
          }
          break;
        }
        case "situation":
          d.append(this.pre(c.situation || "(nothing yet)"));
          break;
        case "rules":
          d.append(this.pre(c.rules));
          break;
        case "tools":
          summary.append(el("span", "context-count", String(c.tools.length)));
          d.append(this.pre(c.tools.length ? c.tools.join("\n") : "(none declared)"));
          break;
      }
      sections.push(d);
    }
    this.body.replaceChildren(...sections);
    this.body.scrollTop = top;
  }

  /** The three tiles at the top: the conversation's cost, its input with the cached share, and the next turn. */
  private tiles(c: BrainContext, spend: ConversationSpend | undefined, sum: SpendSummary): HTMLElement {
    const grid = el("section", "context-tiles");
    grid.setAttribute("aria-label", "The conversation's spend and the next turn");
    const tile = (kind: string, label: string, value: string, ...rest: HTMLElement[]): HTMLElement => {
      const t = el("div", "context-tile");
      t.dataset["kind"] = kind;
      t.append(el("span", "context-tile-label", label), el("span", "context-tile-value", value), ...rest);
      return t;
    };
    const sub = (text: string) => el("span", "context-tile-sub", text);

    // What the conversation's model calls have cost.
    const since = sum.since !== undefined ? ` since ${DAY.format(sum.since)}` : "";
    const costSub = sum.calls === 0 ? "No model calls in this conversation yet" : `${tokenWords(sum.calls)} model call${sum.calls === 1 ? "" : "s"}${since}${sum.calls > 0 && sum.cost > 0 ? ` · ${usdWords(sum.cost / Math.max(1, sum.calls - sum.unpriced))} a call` : ""}`;
    const costTile = tile("spend", "This conversation", usdWords(sum.cost), sub(costSub));
    if (sum.unpriced > 0) costTile.append(sub(`${tokenWords(sum.unpriced)} call${sum.unpriced === 1 ? "" : "s"} to a model with no price not counted`));

    // Its input, the cached part highlighted: what the provider read from its cache, at the cached rate.
    const cachedShare = sum.input > 0 ? sum.cached / sum.input : 0;
    const split = el("span", "context-split");
    split.setAttribute("role", "img");
    const splitWords = `${percentWords(cachedShare * 100)} of input tokens read from cache`;
    split.setAttribute("aria-label", splitWords);
    split.title = `${tokenWords(sum.cached)} cached, ${tokenWords(sum.input - sum.cached)} not`;
    const cachedPart = el("span", "context-split-cached");
    cachedPart.style.width = `${(cachedShare * 100).toFixed(1)}%`;
    split.append(cachedPart);
    const legend = el("span", "context-tile-sub context-legend");
    const cachedKey = el("span", "context-key", `${countWords(sum.cached)} cached`);
    cachedKey.dataset["kind"] = "cached";
    const plainKey = el("span", "context-key", `${countWords(sum.input - sum.cached)} not`);
    plainKey.dataset["kind"] = "input";
    legend.append(cachedKey, plainKey);
    const fromCache = `${percentWords(cachedShare * 100)} from cache${sum.saved > 0 ? `, saving ${usdWords(sum.saved)}` : ""}`;
    const inputTile = tile("tokens", "Input tokens", countWords(sum.input), split, legend, sub(sum.input === 0 ? "None yet" : `${fromCache} · ${countWords(sum.output)} output tokens`));
    inputTile.title = `${tokenWords(sum.input)} input tokens, ${tokenWords(sum.cached)} of them read from cache; ${tokenWords(sum.output)} output tokens`;

    // The next turn: what it sends in all, the window against its budget, and that input's cost before any cache.
    const next = nextTurn(c, spend);
    const nextTile = tile("next", "Next turn", `~${countWords(next.tokens)} tokens`);
    if (next.budget !== undefined) nextTile.append(meter(next.window / next.budget, `The window: ${tokenWords(next.window)} of its ${tokenWords(next.budget)}-token budget`));
    const windowWords = next.budget !== undefined ? `Window ${tokenWords(next.window)} of ${tokenWords(next.budget)}` : `Window ${tokenWords(next.window)}`;
    nextTile.append(sub(next.tokens > next.window ? `${windowWords}, + ${tokenWords(next.tokens - next.window)} rules and tools` : windowWords));
    if (next.cost !== undefined && next.rate !== undefined) nextTile.append(sub(`≈ ${usdWords(next.cost)} in at ${rateWords(next.rate)} / M, before any cache`));
    if (spend?.next) nextTile.title = `The next turn goes to ${spend.next.model}`;

    grid.append(costTile, inputTile, nextTile);
    return grid;
  }

  /** The spend by model, line by line: each kind of token, how many, its rate per million, and its cost; the cached lines lit. */
  private spendTable(sum: SpendSummary): HTMLElement {
    if (sum.models.length === 0) return this.pre("(no model calls in this conversation yet)");
    const wrap = el("div", "context-table-wrap");
    const table = el("table", "context-table");
    const head = el("tr");
    for (const [text, cls] of [["", "context-col-kind"], ["Tokens", "context-num"], ["Rate / 1M", "context-num"], ["Cost", "context-num"]] as const) {
      const th = el("th", cls, text);
      th.scope = "col";
      head.append(th);
    }
    const thead = el("thead");
    thead.append(head);
    table.append(thead);
    for (const m of sum.models) {
      const body = el("tbody");
      const name = el("tr", "context-model");
      const nameCell = el("th", "context-model-name");
      nameCell.scope = "rowgroup";
      nameCell.colSpan = 3;
      nameCell.append(el("span", "context-model-id", m.model), el("span", "context-model-calls", `${tokenWords(m.calls)} call${m.calls === 1 ? "" : "s"}`));
      name.append(nameCell, el("td", "context-num context-model-cost", m.cost !== undefined ? usdWords(m.cost) : "no price"));
      body.append(name);
      for (const l of m.lines) {
        const row = el("tr", "context-line");
        row.dataset["kind"] = l.kind;
        const kind = el("th", "context-col-kind");
        kind.scope = "row";
        kind.append(el("span", "context-line-label", l.label));
        // The cached line says how much less its tokens cost than the input's.
        if (l.kind === "cached" && m.discount !== undefined && m.discount > 0) {
          const pill = el("span", "context-pill", `${Math.round(m.discount * 100)}% off`);
          pill.title = "What a token read from the provider's cache costs less than one sent afresh";
          kind.append(pill);
        }
        row.append(kind, el("td", "context-num", tokenWords(l.tokens)), el("td", "context-num context-rate", l.rate !== undefined ? rateWords(l.rate) : "—"), el("td", "context-num", l.cost !== undefined ? usdWords(l.cost) : "—"));
        body.append(row);
      }
      table.append(body);
    }
    const foot = el("tfoot");
    const total = el("tr", "context-total");
    const label = el("th", "", "Total");
    label.scope = "row";
    label.colSpan = 3;
    total.append(label, el("td", "context-num", usdWords(sum.cost)));
    foot.append(total);
    table.append(foot);
    wrap.append(table);
    const note = el("p", "context-footnote", "List prices in USD per million tokens. Input counts each whole prompt; the part the provider read from its cache is charged at the cached rate. Output counts the model's thinking too. Every model call made while this was the current conversation is counted: its turns, its log, and the housekeeping between them.");
    const out = el("div");
    out.append(wrap, note);
    return out;
  }

  /** The next turn's tokens, tier by tier, each against its budget where the brain caps it. */
  private tierTable(c: BrainContext): HTMLElement {
    const list = el("div", "context-tiers");
    for (const r of tierRows(c)) {
      const row = el("div", "context-tier");
      row.dataset["tier"] = r.key;
      row.append(el("span", "context-tier-label", r.label));
      if (r.share !== undefined && r.budget !== undefined) row.append(meter(r.share, `${r.label}: ${tokenWords(r.tokens)} of a ${tokenWords(r.budget)}-token budget`));
      else row.append(el("span", "context-tier-note", r.note ?? ""));
      row.append(el("span", "context-tier-count", r.budget !== undefined ? `${tokenWords(r.tokens)} / ${tokenWords(r.budget)}` : tokenWords(r.tokens)));
      list.append(row);
    }
    return list;
  }

  private pre(text: string): HTMLPreElement {
    return el("pre", "context-text", text);
  }
}
