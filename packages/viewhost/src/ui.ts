// The pieces the host's own layers are drawn from (`SettingsPanel`, `SetupPanel`), so each page
// reads the same: a group is a titled box of rows; a row is a label with a line of help on the
// left and its control on the right, stacked on a phone; a block row holds something wider (a
// card, a list) across the box. Switches are for what takes effect at once, boxes for picking
// several of a list. Every control carries `data-focus`, so a redraw puts the caret back.

/** An element with a class and its children: text, elements, or nothing. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", ...children: (Node | string | undefined | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  for (const c of children) if (c !== undefined && c !== false) e.append(c);
  return e;
}

/** A titled box of rows; `lead` is a line under the title. Rows that are absent are left out. */
export function group(title: string | undefined, rows: (HTMLElement | undefined | false)[], lead?: string): HTMLElement {
  const s = el("section", "host-settings-group");
  if (title) s.append(el("h3", "host-settings-group-title", title));
  if (lead) s.append(el("p", "host-settings-group-lead", lead));
  const box = el("div", "host-settings-box");
  for (const r of rows) if (r) box.append(r);
  s.append(box);
  return s;
}

export interface RowOptions {
  label: string;
  /** A line under the label: what the setting does, or where it came from. */
  help?: string;
  /** What is set with it, on the right. */
  control?: (HTMLElement | undefined | false)[] | HTMLElement;
  /** A note under it all: what failed, or what to do. */
  note?: string;
  /** The note is trouble rather than news. */
  trouble?: boolean;
  /** The label names this control, for a click on it and for a screen reader. */
  for?: string;
}

/** A label with its help on the left and its control on the right. */
export function row(o: RowOptions): HTMLElement {
  const r = el("div", "host-settings-row");
  const text = el("div", "host-settings-row-text");
  const label = el(o.for ? "label" : "span", "host-settings-row-label", o.label);
  if (o.for && label instanceof HTMLLabelElement) label.htmlFor = o.for;
  text.append(label);
  if (o.help) text.append(el("span", "host-settings-row-help", o.help));
  r.append(text);
  const controls = o.control === undefined ? [] : Array.isArray(o.control) ? o.control : [o.control];
  const kept = controls.filter((c): c is HTMLElement => c !== undefined && c !== false);
  if (kept.length > 0) r.append(el("div", "host-settings-row-control", ...kept));
  if (o.note) r.append(el("p", o.trouble === false ? "host-settings-row-news" : "host-settings-row-note", o.note));
  return r;
}

/** A row that holds something wider than a control: a card, a list, an install's licences. */
export function block(...children: (Node | string | undefined | false)[]): HTMLElement {
  return el("div", "host-settings-row host-settings-row-block", ...children);
}

/** The id a control with this focus key gets, for a label's `for`. */
export function controlId(focus: string): string {
  return `hs-${focus.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/** An on/off switch: a checkbox that reads as one, for what takes effect at once. */
export function switchInput(focus: string, label: string, on: boolean, set: (on: boolean) => void, disabled = false): HTMLInputElement {
  const box = el("input", "host-settings-switch");
  box.type = "checkbox";
  box.setAttribute("role", "switch");
  box.setAttribute("aria-label", label);
  box.checked = on;
  box.disabled = disabled;
  box.dataset["focus"] = focus;
  box.id = controlId(focus);
  box.addEventListener("change", () => set(box.checked));
  return box;
}

/** A box ticked or not, for one of several to pick; its label beside it. */
export function checkRow(focus: string, label: string, on: boolean, set: (on: boolean) => void, opts: { help?: string; aside?: string; disabled?: boolean } = {}): HTMLElement {
  const line = el("label", "host-settings-check");
  const box = el("input");
  box.type = "checkbox";
  box.checked = on;
  box.disabled = opts.disabled ?? false;
  box.dataset["focus"] = focus;
  box.addEventListener("change", () => set(box.checked));
  const text = el("span", "host-settings-check-text", el("span", "host-settings-check-label", label));
  if (opts.help) text.append(el("span", "host-settings-row-help", opts.help));
  line.append(box, text);
  if (opts.aside) line.append(el("span", "host-settings-check-aside", opts.aside));
  return line;
}

export type ButtonKind = "primary" | "secondary" | "quiet" | "danger";

export function button(focus: string, text: string, kind: ButtonKind, onClick: () => void, opts: { disabled?: boolean; title?: string; hidden?: boolean } = {}): HTMLButtonElement {
  const b = el("button", `host-settings-button is-${kind}`, text);
  b.type = "button";
  b.dataset["focus"] = focus;
  b.disabled = opts.disabled ?? false;
  b.hidden = opts.hidden ?? false;
  if (opts.title) b.title = opts.title;
  b.addEventListener("click", onClick);
  return b;
}

export function select(focus: string, label: string, value: string, options: readonly { value: string; label: string }[], set: (value: string) => void, disabled = false): HTMLSelectElement {
  const s = el("select", "host-settings-select");
  s.dataset["focus"] = focus;
  s.id = controlId(focus);
  s.setAttribute("aria-label", label);
  for (const o of options) s.append(option(o.value, o.label));
  s.value = value;
  s.disabled = disabled;
  s.addEventListener("change", () => set(s.value));
  return s;
}

export function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

export function paragraph(className: string, text: string): HTMLElement {
  return el("p", className, text);
}

export function span(className: string, text: string): HTMLElement {
  return el("span", className, text);
}

/** A status in a word or two, coloured by how it stands. */
export function pill(text: string, tone: "ok" | "warn" | "off" | "accent"): HTMLElement {
  return el("span", `host-settings-pill is-${tone}`, text);
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Draws again, putting the focus and the caret back on the control that had them. */
export function keepFocus(within: HTMLElement, draw: () => void): void {
  const active = document.activeElement as HTMLElement | null;
  const key = active && within.contains(active) ? active.dataset["focus"] : undefined;
  const caret = active instanceof HTMLInputElement && (active.type === "text" || active.type === "password") ? ([active.selectionStart, active.selectionEnd] as const) : undefined;
  draw();
  if (!key) return;
  const again = within.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`);
  again?.focus({ preventScroll: true });
  if (again instanceof HTMLInputElement && caret && caret[0] !== null && caret[1] !== null) again.setSelectionRange(caret[0], caret[1]);
}
