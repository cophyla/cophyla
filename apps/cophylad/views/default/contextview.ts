// What the brain sees on its next turn (`brain.context`), behind the chat's Context button, which
// shows only while the node turned it on (`[brain] show_context`): laid over the pane as the file
// viewer is, and over all of it on a phone. Its head says the estimated tokens of each tier, with
// Refresh and Close; under it, sections that fold: the log, the messages after it, the situation,
// then the fixed rules and the tools' names, folded. Everything is text in a `pre`, set with
// `textContent`: nothing the model is sent is ever parsed as HTML. What the user folded stays
// folded across a refresh.

import type { BrainContext } from "@cophyla/protocol";
import { contextBlocks, contextTokenWords } from "./model.ts";
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
  ["log", "Log", true],
  ["messages", "Messages", true],
  ["situation", "Situation", true],
  ["rules", "Rules", false],
  ["tools", "Tools", false],
] as const;

type Section = (typeof SECTIONS)[number][0];

export class ContextView {
  /** The overlay: its head (the title, the tokens, Refresh, Close), a note, and the sections. */
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
    this.el.setAttribute("aria-label", "What the brain sees on its next turn");
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
      const r = await this.rpc.request<{ context?: BrainContext }>("brain.context", {});
      if (generation !== this.generation) return;
      if (!r.context) throw new Error("the node sent no context");
      this.draw(r.context);
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

  private draw(c: BrainContext): void {
    this.meta.textContent = contextTokenWords(c.tokens);
    this.meta.title = `${c.thread ? `Thread ${c.thread}, as` : "As"} of ${new Date(c.at).toLocaleTimeString()}; tokens are estimated at four characters each`;
    const top = this.body.scrollTop;
    const sections: HTMLElement[] = [];
    for (const [key, label, open] of SECTIONS) {
      const d = el("details", "context-section");
      d.dataset["section"] = key;
      d.open = this.open.get(key) ?? open;
      const summary = el("summary", "context-summary", label);
      d.append(summary);
      switch (key) {
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

  private pre(text: string): HTMLPreElement {
    return el("pre", "context-text", text);
  }
}
