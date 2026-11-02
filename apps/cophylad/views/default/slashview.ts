// The composer's slash commands on screen. Typing `/` in a composer (the chat's, or a session's
// send box) opens a palette above its field: the commands that match what is typed, arrow keys to
// move, Enter or a click to take one. A command that sends (`/compact`) goes where the composer's
// words go. `/clear` asks first, in the panel. `/model` changes the model of the session the
// composer talks to: its picker lists what the agent offers and marks the one it is on, and
// `/model <name>` typed sets it at once. `/resume`, `/usage` and `/help` open a panel laid over the
// pane, a sheet from the bottom on a phone, closed by Escape, its Close button, or a pick. Everything
// is built with `textContent`: no name, title, cost or model from a session or the node is ever
// parsed as HTML.

import type { ClientClosedSession } from "@cophyla/protocol";
import { matchSlash, paletteOpen, sendLine, SLASH_COMMANDS } from "./slash.ts";
import type { SlashCommand } from "./slash.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** One row of the `/usage` panel: a name, what it spent, and a plan limit where the login has one. */
export interface UsageRow {
  label: string;
  cost: string;
  tokens: string;
  limit?: string;
  /** Marks the session the composer talks to. */
  current?: boolean;
}

/** A section of the `/usage` panel: the logins' limits, or the sessions' spend over the last week. */
export interface UsageSection {
  heading: string;
  rows: UsageRow[];
  /** Said in place of the rows when there are none. */
  empty: string;
}

export interface ModelChoices {
  current?: string;
  models: { value: string; label: string }[];
}

/** What the view gives a composer's palette: where its words go, the session it talks to, and the data the panels show. */
export interface SlashHost {
  /** Sends a line where this composer's words go: the chat, or the session its send box is for. */
  run(line: string): void;
  /** The session this composer talks to, whose model `/model` changes; none when the chat has no session running. */
  target(): string | undefined;
  /** The models a session can be put on, and the one it is on where the agent says. */
  models(id: string): Promise<ModelChoices>;
  /** Puts a session on a model. */
  setModel(id: string, model: string): Promise<void>;
  /** Starts an ended session again, and shows it. */
  reopen(id: string): Promise<void>;
  /** Ended sessions, newest first, for `/resume`. */
  closed(): Promise<ClientClosedSession[]>;
  /** What `/usage` shows: the logins and the sessions' spend, from the node. */
  usage(): Promise<UsageSection[]>;
  /** Reports a failure in the composer's error line. */
  fail(message: string): void;
}

/** The palette and the panel of one composer. `attach` binds them to its form and the pane the panel lies over. */
export class SlashMenu {
  private readonly host: SlashHost;
  private readonly palette: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private field: HTMLTextAreaElement | undefined;
  private attached = false;
  private items: SlashCommand[] = [];
  private active = 0;
  private returnFocus: HTMLElement | undefined;
  /** Bumped whenever the panel changes, so a list that loads late does not draw over another panel. */
  private generation = 0;

  constructor(host: SlashHost) {
    this.host = host;
    this.palette = el("ul", "slash-palette");
    this.palette.setAttribute("role", "listbox");
    this.palette.hidden = true;
    this.panel = el("section", "slash-panel");
    this.panel.setAttribute("role", "dialog");
    this.panel.tabIndex = -1;
    this.panel.hidden = true;
    const head = el("header", "slash-panel-head");
    this.title = el("h2", "slash-panel-title");
    const close = el("button", "slash-panel-close", "Close");
    close.type = "button";
    close.dataset["action"] = "slash-close";
    close.addEventListener("click", () => this.hidePanel());
    head.append(this.title, close);
    this.body = el("div", "slash-panel-body");
    this.panel.append(head, this.body);
    // A press on the palette keeps the focus in the field, so the list stays until a pick.
    this.palette.addEventListener("mousedown", (ev) => ev.preventDefault());
    this.palette.addEventListener("click", (ev) => {
      const li = (ev.target as HTMLElement).closest<HTMLElement>("[data-command]");
      if (li) this.take(li.dataset["command"]!);
    });
    this.panel.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        this.hidePanel();
      }
    });
  }

  /** Binds to the composer's form and the pane. The palette goes above the field; the panel lies over the pane. */
  attach(form: HTMLElement, pane: HTMLElement, field: HTMLTextAreaElement): void {
    if (this.attached) return;
    this.attached = true;
    this.field = field;
    form.prepend(this.palette);
    pane.append(this.panel);
  }

  /** The field changed: the palette shows while a bare command name is typed. */
  sync(): void {
    if (!this.field) return;
    if (this.panel.hidden === false || !paletteOpen(this.field.value)) {
      this.hidePalette();
      return;
    }
    this.items = matchSlash(this.field.value);
    this.active = Math.min(this.active, Math.max(0, this.items.length - 1));
    this.palette.replaceChildren();
    if (this.items.length === 0) this.palette.append(el("li", "slash-empty", "No command matches"));
    this.items.forEach((c, i) => {
      const li = el("li", "slash-item");
      li.setAttribute("role", "option");
      li.dataset["command"] = c.name;
      li.setAttribute("aria-selected", i === this.active ? "true" : "false");
      li.append(el("span", "slash-name", `/${c.name}`), el("span", "slash-summary", c.summary));
      this.palette.append(li);
    });
    this.palette.hidden = false;
  }

  /** The field lost focus: the palette goes. */
  blur(): void {
    this.hidePalette();
  }

  /** Arrow keys, Enter, Tab and Escape while the palette shows. Returns true when the key was taken. */
  key(ev: KeyboardEvent): boolean {
    if (this.palette.hidden || this.items.length === 0) return false;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      this.active = (this.active + (ev.key === "ArrowDown" ? 1 : this.items.length - 1)) % this.items.length;
      this.palette.querySelectorAll<HTMLElement>(".slash-item").forEach((li, i) => li.setAttribute("aria-selected", i === this.active ? "true" : "false"));
      return true;
    }
    if (ev.key === "Enter" || ev.key === "Tab") {
      ev.preventDefault();
      this.take(this.items[this.active]!.name);
      return true;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      this.hidePalette();
      return true;
    }
    return false;
  }

  /**
   * The composer's submit. A complete command line is taken here: `/model <name>` sets the model at
   * once, a bare `/model` or `/resume` opens its panel, `/clear` asks first, and a sending command
   * goes on. Returns false for text that is not a command, which the composer sends as it always has.
   */
  submit(text: string): boolean {
    const m = /^\/([A-Za-z][\w-]*)\s*([\s\S]*)$/.exec(text.trim());
    if (!m) return false;
    const cmd = SLASH_COMMANDS.find((c) => c.name === m[1]!.toLowerCase());
    if (!cmd) return false;
    const args = m[2]!.trim();
    if (cmd.name === "model" && args !== "") {
      this.setModel(args);
      return true;
    }
    if (cmd.destructive) {
      this.askClear(cmd.name, args);
      return true;
    }
    if (cmd.kind === "send") {
      this.host.run(sendLine(cmd.name, args));
      return true;
    }
    this.open(cmd.name);
    return true;
  }

  /** Takes a command picked from the palette: a picker opens, a command that sends runs. */
  take(name: string): void {
    const cmd = SLASH_COMMANDS.find((c) => c.name === name);
    if (!cmd) return;
    this.hidePalette();
    if (this.field) this.field.value = "";
    if (cmd.kind === "picker" && !cmd.destructive) this.open(name);
    else this.submit(`/${name}`);
  }

  /** Opens a picker's panel. */
  open(name: string): void {
    this.hidePalette();
    this.showPanel(name);
    const gen = ++this.generation;
    switch (name) {
      case "model":
        void this.showModels(gen);
        break;
      case "resume":
        void this.showClosed(gen);
        break;
      case "usage":
        void this.showUsage(gen);
        break;
      case "help":
        this.showHelp();
        break;
      default:
        this.hidePanel();
        return;
    }
    this.panel.focus();
  }

  /** Hides the panel and gives the focus back where it was. */
  hidePanel(): void {
    if (this.panel.hidden) return;
    this.generation++;
    this.panel.hidden = true;
    this.body.replaceChildren();
    this.returnFocus?.focus();
  }

  private showPanel(name: string): void {
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.panel.hidden = false;
    this.panel.dataset["command"] = name;
  }

  private hidePalette(): void {
    this.palette.hidden = true;
  }

  private heading(text: string): void {
    this.title.textContent = text;
    this.body.replaceChildren();
  }

  /** `/model <name>`: sets the model of the session the composer talks to. */
  private setModel(model: string): void {
    const id = this.host.target();
    if (id === undefined) {
      this.host.fail("The chat has no session running to change the model of.");
      return;
    }
    this.host.setModel(id, model).catch((e: unknown) => this.host.fail(e instanceof Error ? e.message : String(e)));
  }

  /** The `/clear` confirmation: it discards the conversation, so it waits for the user's word. */
  private askClear(name: string, args: string): void {
    this.hidePalette();
    this.showPanel(name);
    this.heading("Clear the conversation?");
    this.body.append(el("p", "slash-note", "This starts a fresh conversation in this session. What was said before is no longer in its context."));
    const row = el("div", "slash-actions");
    const yes = el("button", "slash-confirm", "Clear");
    yes.type = "button";
    yes.addEventListener("click", () => {
      this.hidePanel();
      this.host.run(sendLine(name, args));
    });
    const no = el("button", "slash-cancel", "Cancel");
    no.type = "button";
    no.addEventListener("click", () => this.hidePanel());
    row.append(no, yes);
    this.body.append(row);
    this.panel.focus();
  }

  private async showModels(gen: number): Promise<void> {
    this.heading("Model");
    const id = this.host.target();
    if (id === undefined) {
      this.body.append(el("p", "slash-note", "The chat has no session running to change the model of."));
      return;
    }
    this.body.append(el("p", "slash-note", "Loading the models…"));
    let choices: ModelChoices;
    try {
      choices = await this.host.models(id);
    } catch (e) {
      if (gen !== this.generation) return;
      this.body.replaceChildren(el("p", "slash-note", e instanceof Error ? e.message : "Could not load the models."));
      return;
    }
    if (gen !== this.generation) return;
    this.body.replaceChildren();
    if (choices.models.length === 0) {
      this.body.append(el("p", "slash-note", "This session's model is changed in its own terminal."));
      return;
    }
    const list = el("ul", "slash-list");
    for (const m of choices.models) {
      const li = el("li");
      const current = choices.current === m.value;
      const b = el("button", "slash-choice");
      b.type = "button";
      b.dataset["value"] = m.value;
      b.setAttribute("aria-pressed", current ? "true" : "false");
      b.append(el("span", "slash-choice-title", m.label));
      if (current) b.append(el("span", "slash-choice-sub", "Current"));
      b.addEventListener("click", () => {
        this.hidePanel();
        this.setModel(m.value);
      });
      li.append(b);
      list.append(li);
    }
    this.body.append(list);
  }

  private async showClosed(gen: number): Promise<void> {
    this.heading("Resume");
    this.body.append(el("p", "slash-note", "Loading ended sessions…"));
    let closed: ClientClosedSession[];
    try {
      closed = await this.host.closed();
    } catch (e) {
      if (gen !== this.generation) return;
      this.body.replaceChildren(el("p", "slash-note", e instanceof Error ? e.message : "Could not load the ended sessions."));
      return;
    }
    if (gen !== this.generation) return;
    this.body.replaceChildren();
    if (closed.length === 0) {
      this.body.append(el("p", "slash-note", "No ended session to resume."));
      return;
    }
    const list = el("ul", "slash-list");
    for (const c of closed) {
      const li = el("li");
      const b = el("button", "slash-choice");
      b.type = "button";
      b.dataset["id"] = c.session.id;
      b.append(el("span", "slash-choice-title", c.session.intent ?? c.session.id), el("span", "slash-choice-sub", c.session.harness));
      b.addEventListener("click", () => {
        this.hidePanel();
        this.host.reopen(c.session.id).catch((e: unknown) => this.host.fail(e instanceof Error ? e.message : String(e)));
      });
      li.append(b);
      list.append(li);
    }
    this.body.append(list);
  }

  private async showUsage(gen: number): Promise<void> {
    this.heading("Usage");
    this.body.append(el("p", "slash-note", "Loading the usage…"));
    let sections: UsageSection[];
    try {
      sections = await this.host.usage();
    } catch (e) {
      if (gen !== this.generation) return;
      this.body.replaceChildren(el("p", "slash-note", e instanceof Error ? e.message : "Could not load the usage."));
      return;
    }
    if (gen !== this.generation) return;
    this.body.replaceChildren();
    for (const section of sections) {
      this.body.append(el("h3", "slash-section", section.heading));
      if (section.rows.length === 0) {
        this.body.append(el("p", "slash-note", section.empty));
        continue;
      }
      const table = el("dl", "slash-usage");
      for (const r of section.rows) {
        const dt = el("dt", r.current ? "slash-current" : undefined, r.label);
        table.append(dt, el("dd", undefined, [r.cost, r.tokens, r.limit].filter(Boolean).join(" · ")));
      }
      this.body.append(table);
    }
  }

  private showHelp(): void {
    this.heading("Slash commands");
    const list = el("ul", "slash-list");
    for (const c of SLASH_COMMANDS) {
      const li = el("li");
      const b = el("button", "slash-choice");
      b.type = "button";
      b.append(el("span", "slash-choice-title", `/${c.name}`), el("span", "slash-choice-sub", c.summary));
      b.addEventListener("click", () => {
        this.hidePanel();
        if (this.field) {
          this.field.value = `/${c.name}`;
          this.field.focus();
          this.sync();
        }
      });
      li.append(b);
      list.append(li);
    }
    this.body.append(list);
  }
}
