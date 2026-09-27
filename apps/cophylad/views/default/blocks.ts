// A message's content blocks as DOM: text as markdown when a model wrote it and as typed
// when the user did (markdown.ts; never parsed as HTML either way), quotes as blockquotes with
// a source chip, their words as they were at the source (a session chip opens the session's
// tab; file, thread and memory chips name where the words came from; an unresolved quote is
// marked), refs as chips. Reconciled by block index so a streaming message grows in place.

import type { ContentBlock, Source } from "@cophyla/protocol";
import { renderText } from "./markdown.ts";
import type { ViewState } from "./model.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function setData(node: HTMLElement, name: string, value: string): void {
  if (node.dataset[name] !== value) node.dataset[name] = value;
}

function shortId(id: string): string {
  return id.replace(/^(sess|task|thr|ask|aud)_/, "").slice(0, 6);
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** What a session chip does: open the session's tab, while it has one. An ended session left the rail, so its chip only names it. */
function sessionAction(session: string, state: ViewState): { title: string; action?: string; session?: string } {
  return state.sessions.has(session) ? { title: "Open its tab", action: "select", session } : { title: "This session has ended" };
}

/** What a source chip says and does. A session chip carries the first seq quoted, for a later jump to it. */
function sourceChip(source: Source, state: ViewState): { text: string; title: string; action?: string; session?: string; seq?: number } {
  switch (source.kind) {
    case "session": {
      const card = state.sessions.get(source.session);
      const name = card ? (card.session.title ?? card.session.intent) : undefined;
      const who = card ? `${card.session.harness}${name ? `: ${name}` : ""}` : `session ${shortId(source.session)}`;
      const range = source.seq ? ` · ${source.seq[0] === source.seq[1] ? `#${source.seq[0]}` : `#${source.seq[0]}–${source.seq[1]}`}` : "";
      return { text: `${who}${range}`, ...sessionAction(source.session, state), ...(source.seq ? { seq: source.seq[0] } : {}) };
    }
    case "file": {
      const range = source.lines ? `:${source.lines[0]}${source.lines[1] !== source.lines[0] ? `-${source.lines[1]}` : ""}` : "";
      return { text: `${baseName(source.path)}${range}`, title: source.path };
    }
    case "thread":
      return { text: `thread ${shortId(source.thread)}`, title: source.thread };
    case "memory": {
      const range = source.lines ? `:${source.lines[0]}${source.lines[1] !== source.lines[0] ? `-${source.lines[1]}` : ""}` : "";
      return { text: `memory ${source.name}${range}`, title: source.name };
    }
  }
}

function refChip(block: Extract<ContentBlock, { type: "ref" }>, state: ViewState): { text: string; title: string; action?: string; session?: string } {
  if (block.session) {
    const card = state.sessions.get(block.session);
    const name = card ? (card.session.title ?? card.session.intent) : undefined;
    return { text: card ? `${card.session.harness}${name ? `: ${name}` : ""}` : `session ${shortId(block.session)}`, ...sessionAction(block.session, state) };
  }
  if (block.task) {
    const task = state.tasks.get(block.task);
    return { text: task ? task.title : `task ${shortId(block.task)}`, title: block.task };
  }
  if (block.thread) return { text: `thread ${shortId(block.thread)}`, title: block.thread };
  if (block.ask) return { text: `prompt ${shortId(block.ask)}`, title: block.ask };
  if (block.audit) return { text: `audit ${shortId(block.audit)}`, title: block.audit };
  if (block.file) return { text: `${baseName(block.file.path)}${block.file.line ? `:${block.file.line}` : ""}`, title: block.file.path };
  return { text: "ref", title: "" };
}

function createBlock(block: ContentBlock): HTMLElement {
  switch (block.type) {
    case "text":
      return el("div", "block-text");
    case "quote": {
      const q = el("blockquote", "quote");
      q.append(el("p", "quote-text"), el("button", "chip source"));
      const chip = q.querySelector<HTMLButtonElement>(".chip")!;
      chip.type = "button";
      return q;
    }
    case "ref": {
      const chip = el("button", "chip ref");
      chip.type = "button";
      return chip;
    }
    case "audio":
      return el("span", "block-audio", "[audio]");
  }
}

function updateBlock(node: HTMLElement, block: ContentBlock, state: ViewState, markdown: boolean): void {
  switch (block.type) {
    case "text":
      renderText(node, block.text, markdown);
      return;
    case "quote": {
      setText(node.querySelector(".quote-text")!, block.text);
      setData(node, "unresolved", block.unresolved ? "1" : "0");
      const chip = node.querySelector<HTMLButtonElement>(".chip")!;
      if (block.source) {
        const c = sourceChip(block.source, state);
        setText(chip, c.text);
        chip.title = c.title;
        setData(chip, "kind", block.source.kind);
        if (c.action) {
          setData(chip, "action", c.action);
          if (c.session) setData(chip, "session", c.session);
        } else {
          delete chip.dataset["action"];
          delete chip.dataset["session"];
        }
        if (c.seq !== undefined) setData(chip, "seq", String(c.seq));
        else delete chip.dataset["seq"];
        chip.hidden = false;
      } else {
        setText(chip, block.unresolved ? "source unknown" : "");
        chip.title = "";
        setData(chip, "kind", "none");
        delete chip.dataset["action"];
        chip.hidden = !block.unresolved;
      }
      chip.disabled = !chip.dataset["action"] || !state.connected;
      return;
    }
    case "ref": {
      const c = refChip(block, state);
      setText(node, c.text);
      node.title = c.title;
      setData(node, "kind", block.session ? "session" : block.task ? "task" : block.thread ? "thread" : block.ask ? "ask" : block.audit ? "audit" : "file");
      if (c.action) {
        setData(node, "action", c.action);
        if (c.session) setData(node, "session", c.session);
      } else {
        delete node.dataset["action"];
        delete node.dataset["session"];
      }
      (node as HTMLButtonElement).disabled = !c.action || !state.connected;
      return;
    }
    case "audio":
      return;
  }
}

/** Keeps `container`'s children in step with the blocks, by index; a block that changed type is rebuilt. Text is markdown when `markdown`. */
export function renderBlocks(container: HTMLElement, blocks: ContentBlock[], state: ViewState, markdown: boolean): void {
  const children = Array.from(container.children) as HTMLElement[];
  blocks.forEach((block, i) => {
    let node = children[i];
    if (!node || node.dataset["type"] !== block.type) {
      const fresh = createBlock(block);
      fresh.dataset["type"] = block.type;
      if (node) node.replaceWith(fresh);
      else container.append(fresh);
      node = fresh;
    }
    updateBlock(node, block, state, markdown);
  });
  for (const stale of children.slice(blocks.length)) stale.remove();
}
