// A message's content blocks as DOM: text as markdown when a model wrote it and as typed
// when the user did (markdown.ts; never parsed as HTML either way), quotes as blockquotes with
// a source chip, their words as they were at the source, refs as chips (an unresolved quote is
// marked). A chip goes to what it names, in the view: a session's opens its tab, a file's opens
// it in the viewer of the agent whose folder holds it, at its line, and shows it in that agent's
// Files panel (a folder's shows there alone), and a thread's, a task's, a prompt's
// or an audit row's brings that into view in the chat; one whose target the view does not have
// (an ended session, a thread not loaded, a memory) only names it. A run of text and refs is
// one flow, the refs' chips standing in the sentence where the model put them, not on lines
// of their own; a quote stands apart. A chip's words are cut short past a width, and its
// title then says them whole. Reconciled by index, a flow and a quote each one part, so a
// streaming message grows in place.

import type { ContentBlock, Source } from "@cophyla/protocol";
import { renderText } from "./markdown.ts";
import { chipTitle, explorerKey, fileHome, listedKind, parts, sessionWho } from "./model.ts";
import type { Part, ViewState } from "./model.ts";

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
  const parts = path.split(/[\\/]/).filter((p) => p !== "");
  return parts[parts.length - 1] || path;
}

/** What a chip says and does: its action, and what the action goes to, ride on it as data. */
interface Chip {
  text: string;
  title: string;
  action?: "select" | "goto" | "reveal-file";
  /** `select`: the session whose tab opens. A quote's also carries the first seq quoted, for a later jump to it. */
  session?: string;
  seq?: number;
  /** `goto`: the thread, task, prompt or audit row brought into view, by the chip's kind; a thread's may name a message in it. */
  ref?: string;
  message?: string;
  /** `reveal-file`: the file the viewer opens and the Files panel shows, and the line it opens at. */
  node?: string;
  path?: string;
  line?: number;
}

const CHIP_DATA = ["action", "session", "seq", "ref", "message", "node", "path", "line"] as const;

/** A session's chip: it opens the session's tab, while it has one. An ended session left the rail, so its chip only names it. */
function sessionChip(session: string, state: ViewState, suffix = ""): Chip {
  const card = state.sessions.get(session);
  if (!card) return { text: `session ${shortId(session)}${suffix}`, title: "This session has ended" };
  return { text: `${sessionWho(card.session)}${suffix}`, title: "Open its tab", action: "select", session };
}

/**
 * A file's chip: it opens the file, at `line`, in the viewer of the agent whose folder holds it,
 * when one does. A folder's, known as one by the separator after it or by that agent's Files,
 * shows it in Files.
 */
function fileChip(node: string, path: string, suffix: string, state: ViewState, line?: number): Chip {
  const text = `${baseName(path)}${suffix}`;
  const home = fileHome(state, node, path);
  if (!home) return { text, title: path };
  const folder = home.rel === "" || /[\\/]$/.test(path) || listedKind(state.explorers.get(explorerKey(state, home.session)), home.rel) === "dir";
  return { text, title: folder ? `Show it in Files: ${path}` : `Open it: ${path}`, action: "reveal-file", node, path, ...(line !== undefined ? { line } : {}) };
}

/** A chip for something the chat shows: it brings it into view while the chat has it. */
function gotoChip(text: string, id: string, shown: boolean, title: string): Chip {
  return shown ? { text, title, action: "goto", ref: id } : { text, title: id };
}

function sourceChip(source: Source, state: ViewState): Chip {
  switch (source.kind) {
    case "session": {
      const range = source.seq ? ` · ${source.seq[0] === source.seq[1] ? `#${source.seq[0]}` : `#${source.seq[0]}–${source.seq[1]}`}` : "";
      return { ...sessionChip(source.session, state, range), ...(source.seq ? { seq: source.seq[0] } : {}) };
    }
    case "file": {
      const range = source.lines ? `:${source.lines[0]}${source.lines[1] !== source.lines[0] ? `-${source.lines[1]}` : ""}` : "";
      return fileChip(source.node, source.path, range, state, source.lines?.[0]);
    }
    case "thread": {
      const chip = gotoChip(`thread ${shortId(source.thread)}`, source.thread, state.threads.has(source.thread), "Show the thread");
      return chip.action && source.message && state.messages.has(source.message) ? { ...chip, title: "Show the message", message: source.message } : chip;
    }
    case "memory": {
      const range = source.lines ? `:${source.lines[0]}${source.lines[1] !== source.lines[0] ? `-${source.lines[1]}` : ""}` : "";
      return { text: `memory ${source.name}${range}`, title: source.name };
    }
  }
}

function refChip(block: Extract<ContentBlock, { type: "ref" }>, state: ViewState): Chip {
  if (block.session) return sessionChip(block.session, state);
  if (block.task) {
    const task = state.tasks.get(block.task);
    return gotoChip(task ? task.title : `task ${shortId(block.task)}`, block.task, task !== undefined, "Show the task");
  }
  if (block.thread) return gotoChip(`thread ${shortId(block.thread)}`, block.thread, state.threads.has(block.thread), "Show the thread");
  // A prompt shows while it is open, pinned over the pane.
  if (block.ask) return gotoChip(`prompt ${shortId(block.ask)}`, block.ask, state.asks.get(block.ask)?.status === "open", "Show the prompt");
  if (block.audit) return gotoChip(`audit ${shortId(block.audit)}`, block.audit, state.audit.has(block.audit), "Show the audit row");
  if (block.file) return fileChip(block.file.node, block.file.path, block.file.line ? `:${block.file.line}` : "", state, block.file.line);
  return { text: "ref", title: "" };
}

/** Puts what a chip says and does on its button; one with no action is disabled, and so is every one while the node is away. */
function applyChip(chip: HTMLButtonElement, c: Chip, state: ViewState): void {
  setText(chip, c.text);
  chip.title = chipTitle(c.text, c.title);
  for (const name of CHIP_DATA) {
    const value = c[name];
    if (value !== undefined) setData(chip, name, String(value));
    else delete chip.dataset[name];
  }
  chip.disabled = !c.action || !state.connected;
}

type Ref = Extract<ContentBlock, { type: "ref" }>;

function createPart(part: Part): HTMLElement {
  switch (part.type) {
    case "flow":
      return el("div", "block-text");
    case "quote": {
      const q = el("blockquote", "quote");
      q.append(el("p", "quote-text"), el("button", "chip source"));
      const chip = q.querySelector<HTMLButtonElement>(".chip")!;
      chip.type = "button";
      return q;
    }
    case "audio":
      return el("span", "block-audio", "[audio]");
  }
}

function updateRef(chip: HTMLButtonElement, block: Ref, state: ViewState): void {
  setData(chip, "kind", block.session ? "session" : block.task ? "task" : block.thread ? "thread" : block.ask ? "ask" : block.audit ? "audit" : "file");
  applyChip(chip, refChip(block, state), state);
}

/** The flow's text, then a chip in each of its slots; a slot the text lost (inside a link's address) gets one at the end. */
function updateFlow(node: HTMLElement, part: Extract<Part, { type: "flow" }>, state: ViewState, markdown: boolean): void {
  renderText(node, part.text, markdown);
  part.refs.forEach((block, i) => {
    let holder = node.querySelector<HTMLElement>(`.slot[data-slot="${i}"]`);
    if (!holder) {
      holder = el("span", "slot");
      holder.dataset["slot"] = String(i);
      node.append(holder);
    }
    let chip = holder.firstElementChild as HTMLButtonElement | null;
    if (!chip) {
      chip = el("button", "chip ref");
      chip.type = "button";
      holder.append(chip);
    }
    updateRef(chip, block, state);
  });
}

function updatePart(node: HTMLElement, part: Part, state: ViewState, markdown: boolean): void {
  switch (part.type) {
    case "flow":
      updateFlow(node, part, state, markdown);
      return;
    case "quote": {
      setText(node.querySelector(".quote-text")!, part.text);
      setData(node, "unresolved", part.unresolved ? "1" : "0");
      const chip = node.querySelector<HTMLButtonElement>(".chip")!;
      setData(chip, "kind", part.source?.kind ?? "none");
      applyChip(chip, part.source ? sourceChip(part.source, state) : { text: part.unresolved ? "source unknown" : "", title: "" }, state);
      chip.hidden = !part.source && !part.unresolved;
      return;
    }
    case "audio":
      return;
  }
}

/** Keeps `container`'s children in step with the blocks' parts, by index; a part that changed type is rebuilt. Text is markdown when `markdown`. */
export function renderBlocks(container: HTMLElement, blocks: ContentBlock[], state: ViewState, markdown: boolean): void {
  const children = Array.from(container.children) as HTMLElement[];
  const list = parts(blocks);
  list.forEach((part, i) => {
    let node = children[i];
    if (!node || node.dataset["type"] !== part.type) {
      const fresh = createPart(part);
      fresh.dataset["type"] = part.type;
      if (node) node.replaceWith(fresh);
      else container.append(fresh);
      node = fresh;
    }
    updatePart(node, part, state, markdown);
  });
  for (const stale of children.slice(list.length)) stale.remove();
}
