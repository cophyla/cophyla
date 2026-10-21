// The host's first-run screen. Before the first view mounts on a node whose user has not yet
// said which of their sessions it connects to (its `session.scope` has no `setupAt`), the host
// asks over the whole page, so no session shows before the answer: every account on each
// machine with a box, all ticked; "Tether (Cophyla) started sessions only"; whether its Claude
// sessions in bypass take agents' messages at once, as the machine has it now; and, folded, the
// allowed and hidden folders. Continue saves every machine's scope as it stands, which marks
// each set, and the bypass switch where it was changed, and the view mounts. It cannot be dismissed without an answer, but the answer that
// changes nothing is one press. Its look is in `settings.css`, beside the settings it mirrors.

import { continueLabel, ScopeModel, scopeControls } from "./scope.ts";
import type { FolderDrafts, ScopeRequest } from "./scope.ts";
import { button, el, keepFocus, message } from "./ui.ts";

export interface SetupPanelDeps {
  request: ScopeRequest;
  /** Where the screen goes; the page's body when absent. */
  root?: HTMLElement;
}

export class SetupPanel {
  private deps: SetupPanelDeps;
  private layer?: HTMLElement;
  private model?: ScopeModel;
  private drafts: FolderDrafts = new Map();
  private unfolded = new Set<string>();
  private saving = false;
  private failure = "";
  private done?: () => void;

  constructor(deps: SetupPanelDeps) {
    this.deps = deps;
  }

  get isOpen(): boolean {
    return this.layer !== undefined;
  }

  /** Shows the screen; resolves once the user answered and every machine that can say kept its scope. */
  run(): Promise<void> {
    if (this.layer) return new Promise((resolve) => (this.done = resolve));
    const layer = el("div", "host-settings host-setup");
    const card = el("div", "host-setup-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "host-setup-title");
    card.setAttribute("aria-describedby", "host-setup-lead");
    const title = el("h2", "host-setup-title", "Connect your AI sessions");
    title.id = "host-setup-title";
    title.tabIndex = -1;
    const lead = el(
      "p",
      "host-setup-lead",
      "Cophyla follows the coding agents you run — Claude Code, Codex and Muse — so it can tell you what they are doing, answer their questions with you and pass messages between them. Choose which sessions it connects to.",
    );
    lead.id = "host-setup-lead";
    const body = el("div", "host-setup-body");
    const foot = el("div", "host-setup-foot");
    card.append(el("div", "host-setup-head", title, lead), body, foot);
    layer.append(card);
    (this.deps.root ?? document.body).append(layer);
    this.layer = layer;
    const model = new ScopeModel(this.deps.request, () => {
      if (this.model === model) this.render();
    }, { autosave: false });
    this.model = model;
    this.render();
    title.focus();
    void model.load();
    return new Promise((resolve) => (this.done = resolve));
  }

  private render(): void {
    const layer = this.layer;
    const model = this.model;
    if (!layer || !model) return;
    keepFocus(layer, () => {
      const body = layer.querySelector<HTMLElement>(".host-setup-body")!;
      const foot = layer.querySelector<HTMLElement>(".host-setup-foot")!;
      const machines = model.machines();
      const parts: HTMLElement[] = [];
      if (model.note) parts.push(el("p", model.note === "Loading…" ? "host-settings-page-note is-quiet" : "host-settings-page-note", model.note));
      else {
        const many = machines.length > 1;
        for (const m of machines) {
          const section = el("div", "host-setup-machine");
          if (many) section.append(el("h3", "host-setup-machine-name", m.name));
          section.append(...scopeControls(m, { model, drafts: this.drafts, redraw: () => this.render(), form: true, unfolded: this.unfolded }));
          parts.push(section);
        }
      }
      body.replaceChildren(...parts);
      const words = el("p", "host-setup-foot-note", "Sessions Cophyla starts itself are always connected. Change this any time in Settings → Sessions.");
      const failed = model.note !== "" && model.note !== "Loading…" && model.kept.size === 0;
      // Nothing could be read: try again, or go on with every session connected and be asked next time.
      const actions = failed
        ? [button("setup:retry", "Try again", "secondary", () => void model.load()), button("setup:later", "Continue for now", "primary", () => this.close())]
        : [button("setup:continue", this.saving ? "Saving…" : continueLabel(machines), "primary", () => void this.finish(), { disabled: this.saving || model.note !== "" })];
      foot.replaceChildren(words, ...(this.failure ? [el("p", "host-settings-page-note", this.failure)] : []), el("div", "host-setup-actions", ...actions));
    });
  }

  /** Saves every machine's scope; the screen goes once all took it. */
  private async finish(): Promise<void> {
    const model = this.model;
    if (!model || this.saving) return;
    this.saving = true;
    this.failure = "";
    this.render();
    let ok = false;
    try {
      ok = await model.saveAll();
      if (!ok) this.failure = "Not every machine took its choice: see the note beside it, then try again.";
    } catch (e) {
      this.failure = `Not saved: ${message(e)}`;
    } finally {
      this.saving = false;
    }
    if (!ok) {
      this.render();
      return;
    }
    this.close();
  }

  private close(): void {
    this.layer?.remove();
    this.layer = undefined;
    this.model = undefined;
    this.drafts.clear();
    const done = this.done;
    this.done = undefined;
    done?.();
  }
}
