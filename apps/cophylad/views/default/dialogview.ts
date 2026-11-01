// A session's dialog drawn natively in the chat's dock, above the send box: its title and text, its
// tabs and rows as buttons, its footer keys as buttons. A press goes to the session's terminal the
// way the terminal takes it (`session.dialogPress`), so the panel never types anything itself. The
// terminal stays the way to a dialog the panel cannot draw, or the one the user chose: `drawDialogSwitch`
// puts the way back to the panel above it. Everything is built with `textContent`: no label or line
// from the screen is parsed as HTML.

import type { DialogPanel, DialogPress } from "./model.ts";

/** What the dock's buttons do. */
export interface DialogActions {
  /** A row, a tab or a footer key was pressed. */
  press(press: DialogPress): void;
  /** The terminal is to be shown in place of the panel. */
  showTerminal(): void;
  /** The panel is to be shown in place of the terminal. */
  showNative(): void;
}

/** The last drawing of each dock, so a draw that changes nothing keeps the buttons (and the focus) as they are. */
const signatures = new WeakMap<HTMLElement, string>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(className: string, label: string | undefined, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Draws the native panel of a session's dialog as the dock's only content. `busy` says a press is on
 * its way to the session, so its buttons wait for the answer.
 */
export function drawDialogPanel(dock: HTMLElement, session: string, panel: DialogPanel, busy: boolean, actions: DialogActions): void {
  const sig = JSON.stringify([session, panel, busy]);
  const old = dock.querySelector<HTMLElement>(":scope > .dialog-panel");
  if (old && signatures.get(dock) === sig) return;
  const scroll = old?.querySelector<HTMLElement>(":scope > .dialog-body")?.scrollTop ?? 0;
  const node = panelNode(panel, busy, actions);
  dock.replaceChildren(node);
  signatures.set(dock, sig);
  const body = node.querySelector<HTMLElement>(":scope > .dialog-body");
  if (body) body.scrollTop = scroll;
}

/**
 * The way back to the panel, above the terminal the dock shows for a dialog: a bar with a Show panel
 * button, or none when `showNative` is not given. The panel itself is taken away with it.
 */
export function drawDialogSwitch(dock: HTMLElement, session: string, showNative: (() => void) | undefined): void {
  dock.querySelector(":scope > .dialog-panel")?.remove();
  signatures.delete(dock);
  const old = dock.querySelector<HTMLElement>(":scope > .dialog-switch");
  if (showNative === undefined) {
    old?.remove();
    return;
  }
  // The bar belongs to the session it was drawn for: another session's is replaced.
  if (old && old.dataset["session"] === session) return;
  old?.remove();
  const bar = el("div", "dialog-switch");
  bar.dataset["session"] = session;
  bar.append(button("dialog-show", "Show panel", false, showNative));
  dock.prepend(bar);
}

/** Takes the dock's panel and its bar away. */
export function clearDialogDock(dock: HTMLElement): void {
  dock.querySelectorAll(":scope > .dialog-panel, :scope > .dialog-switch").forEach((n) => n.remove());
  signatures.delete(dock);
}

function panelNode(panel: DialogPanel, busy: boolean, actions: DialogActions): HTMLElement {
  const root = el("section", "dialog-panel");
  root.setAttribute("aria-label", panel.title ?? "Dialog");
  if (panel.title !== undefined) root.append(el("h3", "dialog-title", panel.title));
  for (const line of panel.note) root.append(el("p", "dialog-note", line));
  if (panel.tabs.length > 0) {
    const tabs = el("div", "dialog-tabs");
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "Tabs");
    panel.tabs.forEach((t, i) => {
      const b = button("dialog-tab", t.label, busy, () => actions.press({ tab: i }));
      b.setAttribute("aria-pressed", t.selected ? "true" : "false");
      tabs.append(b);
    });
    root.append(tabs);
  }
  if (panel.rows.length > 0) {
    const list = el("div", "dialog-rows");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", panel.title ?? "Choices");
    panel.rows.forEach((r, i) => {
      const b = button("dialog-row", undefined, busy, () => actions.press({ row: i }));
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", r.selected ? "true" : "false");
      b.append(el("span", "dialog-row-label", r.label));
      if (r.detail !== undefined) b.append(el("span", "dialog-row-detail", r.detail));
      if (r.current) {
        const mark = el("span", "dialog-row-mark", "✔");
        mark.title = "In use";
        mark.setAttribute("aria-label", "In use");
        b.append(mark);
      }
      list.append(b);
    });
    root.append(list);
  }
  if (panel.lines.length > 0) root.append(el("pre", "dialog-text", panel.lines.join("\n")));
  const foot = el("div", "dialog-foot");
  for (const k of panel.keys) {
    const b = button("option dialog-key", k.label, busy, () => actions.press({ key: k.key }));
    b.dataset["key"] = k.key;
    if (k.key === "Enter") b.dataset["style"] = "primary";
    foot.append(b);
  }
  foot.append(button("dialog-terminal", "Show terminal", false, actions.showTerminal));
  root.append(foot);
  // The text, tabs and rows scroll; the footer's keys stay in view beneath them, so Escape is always there.
  const body = el("div", "dialog-body");
  body.append(...Array.from(root.children).filter((c) => c !== foot));
  root.replaceChildren(body, foot);
  return root;
}
