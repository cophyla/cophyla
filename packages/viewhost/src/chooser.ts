// The host's view picker: a layer over the frame that is the host's own, so any view gets the
// same one by asking `host.chooseView` and none has to draw it. It lists what `view.list`
// serves, the one showing marked; picking another makes it the node's default
// (`view.setDefault`), which every host on the node then loads, this one at once. It closes on
// its ✕, on Escape, on a click outside its card, and once the view picked is up. Its look is
// `chooser.css`, which each host page links: a host's policy may refuse inline styles.

import type { ViewManifest } from "@cophyla/protocol";

export interface ChooserRow {
  id: string;
  name: string;
  /** Where it comes from: the platform's, or one written into `~/.cophyla/views`. */
  source: string;
  /** The view showing now. */
  current: boolean;
}

/** The picker's rows: every view served, by name, the one showing marked. */
export function chooserRows(views: ViewManifest[], showing: string | undefined): ChooserRow[] {
  return [...views]
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((v) => ({ id: v.id, name: v.name, source: v.source === "builtin" ? "built in" : `yours, in ~/.cophyla/views/${v.id}`, current: v.id === showing }));
}

export interface ViewChooserDeps {
  /** The host's own connection: `view.list` and `view.setDefault`. */
  request: <T>(method: string, params: unknown) => Promise<T>;
  /** The id of the view showing now. */
  showing: () => string | undefined;
  /** Loads the default anew once another was picked; the layer closes when it is up. */
  reload: () => Promise<void>;
  /** Where the layer goes; the page's body when absent. */
  root?: HTMLElement;
  /** Where the focus goes once the layer closes: the view's frame. */
  refocus?: () => void;
}

export class ViewChooser {
  private deps: ViewChooserDeps;
  private layer?: HTMLElement;
  private rows: ChooserRow[] = [];
  private note = "Loading views…";
  /** The view being switched to. */
  private switching?: string;
  private onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") this.close();
  };

  constructor(deps: ViewChooserDeps) {
    this.deps = deps;
  }

  get isOpen(): boolean {
    return this.layer !== undefined;
  }

  /** Shows the layer and asks what views there are; open already, it only takes the focus. */
  open(): void {
    if (this.layer) {
      this.focusFirst();
      return;
    }
    const layer = document.createElement("div");
    layer.className = "view-chooser";
    layer.addEventListener("click", (ev) => {
      if (ev.target === layer) this.close();
    });
    const card = document.createElement("div");
    card.className = "view-chooser-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "view-chooser-title");
    const head = document.createElement("div");
    head.className = "view-chooser-head";
    const title = document.createElement("h2");
    title.id = "view-chooser-title";
    title.textContent = "Change view";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "view-chooser-close";
    close.setAttribute("aria-label", "Close");
    close.title = "Close";
    close.textContent = "✕";
    close.addEventListener("click", () => this.close());
    head.append(title, close);
    const list = document.createElement("div");
    list.className = "view-chooser-list";
    const note = document.createElement("p");
    note.className = "view-chooser-note";
    const hint = document.createElement("p");
    hint.className = "view-chooser-hint";
    hint.textContent = "Every app on this computer and its phones shows the view picked. A view of your own is a folder under ~/.cophyla/views.";
    card.append(head, list, note, hint);
    layer.append(card);
    (this.deps.root ?? document.body).append(layer);
    this.layer = layer;
    this.rows = [];
    this.note = "Loading views…";
    this.switching = undefined;
    document.addEventListener("keydown", this.onKey);
    this.render();
    close.focus();
    void this.list(layer);
  }

  close(): void {
    if (!this.layer) return;
    this.layer.remove();
    this.layer = undefined;
    document.removeEventListener("keydown", this.onKey);
    this.deps.refocus?.();
  }

  private async list(layer: HTMLElement): Promise<void> {
    try {
      const { views } = await this.deps.request<{ views: ViewManifest[] }>("view.list", {});
      if (this.layer !== layer) return;
      this.rows = chooserRows(views, this.deps.showing());
      this.note = this.rows.length <= 1 ? "This is the only view there is." : "";
    } catch (e) {
      if (this.layer !== layer) return;
      this.note = `The views could not be listed: ${message(e)}`;
    }
    this.render();
    this.focusFirst();
  }

  private async pick(id: string): Promise<void> {
    const layer = this.layer;
    if (!layer || this.switching !== undefined) return;
    if (id === this.deps.showing()) return this.close();
    this.switching = id;
    this.note = "";
    this.render();
    try {
      await this.deps.request("view.setDefault", { id });
      await this.deps.reload();
      if (this.layer === layer) this.close();
    } catch (e) {
      if (this.layer !== layer) return;
      this.switching = undefined;
      this.note = `That view did not load: ${message(e)}`;
      this.render();
    }
  }

  private render(): void {
    const layer = this.layer;
    if (!layer) return;
    const list = layer.querySelector<HTMLElement>(".view-chooser-list")!;
    list.replaceChildren(
      ...this.rows.map((row) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "view-chooser-row";
        b.dataset["view"] = row.id;
        b.setAttribute("aria-current", row.current ? "true" : "false");
        b.disabled = this.switching !== undefined;
        const name = document.createElement("span");
        name.className = "view-chooser-name";
        name.textContent = row.name;
        const meta = document.createElement("span");
        meta.className = "view-chooser-meta";
        meta.textContent = this.switching === row.id ? "Switching…" : row.current ? `Showing · ${row.source}` : row.source;
        b.append(name, meta);
        b.addEventListener("click", () => void this.pick(row.id));
        return b;
      }),
    );
    const note = layer.querySelector<HTMLElement>(".view-chooser-note")!;
    note.textContent = this.note;
    note.hidden = this.note === "";
  }

  /** The focus on the view showing, else the first, else the ✕. */
  private focusFirst(): void {
    const layer = this.layer;
    if (!layer) return;
    const target = layer.querySelector<HTMLElement>('.view-chooser-row[aria-current="true"]') ?? layer.querySelector<HTMLElement>(".view-chooser-row") ?? layer.querySelector<HTMLElement>(".view-chooser-close");
    target?.focus();
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
