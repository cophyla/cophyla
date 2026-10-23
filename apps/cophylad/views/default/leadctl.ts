// Leaders on the host's line: what the view asks for as it connects (`lead.list`), the notice it
// folds in (`lead.state`), and what Lead's list asks of the node (`lead.set`, `lead.remove`). A
// node or an app older than leaders refuses `lead.list` (`unsupported`, "unknown method"): no
// Lead shows then, and no mark, until a connect finds one that keeps them.

import type { Leader } from "@cophyla/protocol";
import { leadDraft, leadFailure, leadSetParams } from "./model.ts";
import type { Action, ViewState } from "./model.ts";
import type { Roots, UiState } from "./render.ts";
import type { HostRpc } from "./rpc.ts";
import { ViewRpcError } from "./rpc.ts";

export interface LeadDeps {
  rpc: HostRpc;
  state: ViewState;
  ui: UiState;
  roots: Roots;
  dispatch: (action: Action) => void;
  draw: () => void;
  /** On a phone's width no field takes the focus by itself. */
  phone: () => boolean;
}

export class LeadControl {
  private d: LeadDeps;

  constructor(deps: LeadDeps) {
    this.d = deps;
  }

  /** The line is up: the leaders, asked for afresh. */
  connected(): void {
    void this.load();
  }

  async load(): Promise<void> {
    const { state, ui } = this.d;
    if (!state.scopes.includes("sessions:read")) return;
    try {
      const { leaders } = await this.d.rpc.request<{ leaders: Leader[] }>("lead.list", {});
      this.d.dispatch({ type: "leaders", leaders });
    } catch (e) {
      // Older than leaders: Lead and the marks go. Anything else (the line dropped, the primary
      // out of reach) leaves things as they were, and the next connect asks again.
      if (e instanceof ViewRpcError && e.code === "unsupported") {
        ui.lead = undefined;
        this.d.dispatch({ type: "leaders" });
      }
    }
  }

  /** A notice for leaders, folded in; false for any other. */
  notification(method: string, params: unknown): boolean {
    if (method !== "lead.state") return false;
    this.d.dispatch({ type: "lead.state", params: params as { leaders: Leader[] } });
    return true;
  }

  private words(e: unknown): string {
    return leadFailure(e instanceof ViewRpcError ? e.code : undefined, e instanceof Error ? e.message : String(e));
  }

  /** The open list. */
  private pop(): HTMLElement | null {
    return this.d.roots.app.querySelector<HTMLElement>(".lead-pop:not([hidden])");
  }

  /** Lead pressed: its list opens with the speaker's group as it stands, or closes on a second press. */
  private open(speaker: string): void {
    const { ui, state } = this.d;
    if (ui.lead?.speaker === speaker) return this.close(true);
    const draft = leadDraft(state, speaker);
    ui.lead = { speaker, all: draft.all, picked: draft.picked };
    this.d.draw();
    if (!this.d.phone()) this.pop()?.querySelector<HTMLInputElement>(".lead-every-check")?.focus();
  }

  /** The list goes; the focus back on its Lead when the user closed it from the keys. */
  close(refocus = false): void {
    const speaker = this.d.ui.lead?.speaker;
    if (speaker === undefined) return;
    this.d.ui.lead = undefined;
    this.d.draw();
    if (refocus) this.d.roots.app.querySelector<HTMLButtonElement>(`.lead-start[data-speaker="${speaker}"]`)?.focus();
  }

  private async save(): Promise<void> {
    const { ui, state } = this.d;
    const p = ui.lead;
    if (!p || p.busy) return;
    const made = leadSetParams(state, p);
    if ("error" in made) {
      p.error = made.error;
      this.d.draw();
      return;
    }
    p.busy = "set";
    p.error = undefined;
    this.d.draw();
    try {
      const { leader } = await this.d.rpc.request<{ leader: Leader }>("lead.set", made.params);
      this.d.dispatch({ type: "leader", leader });
      if (ui.lead === p) ui.lead = undefined;
    } catch (e) {
      p.error = this.words(e);
    } finally {
      p.busy = undefined;
      this.d.draw();
    }
  }

  private async stop(): Promise<void> {
    const { ui } = this.d;
    const p = ui.lead;
    if (!p || p.busy) return;
    p.busy = "remove";
    p.error = undefined;
    this.d.draw();
    try {
      await this.d.rpc.request("lead.remove", { speaker: p.speaker });
      this.d.dispatch({ type: "leader.removed", speaker: p.speaker });
      if (ui.lead === p) ui.lead = undefined;
    } catch (e) {
      p.error = this.words(e);
    } finally {
      p.busy = undefined;
      this.d.draw();
    }
  }

  /** A click anywhere: the list closes unless it was in it or on a Lead. */
  outside(target: Element | null): void {
    if (this.d.ui.lead && !this.d.ui.lead.busy && !target?.closest(".lead-pop, .lead-start")) this.close();
  }

  /** A press on Lead or its list's buttons; false for any other. */
  click(target: HTMLElement): boolean {
    switch (target.dataset["action"]) {
      case "lead-open":
        if (target.dataset["speaker"]) this.open(target.dataset["speaker"]);
        return true;
      case "lead-save":
        void this.save();
        return true;
      case "lead-stop":
        void this.stop();
        return true;
      case "lead-cancel":
        if (!this.d.ui.lead?.busy) this.close(true);
        return true;
      default:
        return false;
    }
  }

  /** A box ticked in the list: Every agent, or a session. */
  change(target: HTMLElement): boolean {
    const p = this.d.ui.lead;
    const box = target as HTMLInputElement;
    if (box.classList.contains("lead-every-check")) {
      if (p) p.all = box.checked;
    } else if (box.classList.contains("lead-check")) {
      const session = box.dataset["session"];
      if (p && session) {
        if (box.checked) p.picked.add(session);
        else p.picked.delete(session);
      }
    } else return false;
    if (p) p.error = undefined;
    this.d.draw();
    return true;
  }

  /** Escape: the list closes, the focus back on its Lead. */
  escape(): boolean {
    if (!this.d.ui.lead || this.d.ui.lead.busy) return false;
    this.close(true);
    return true;
  }
}
