// The notes on the host's line: every note and the switch asked for as the view connects
// (`note.list`, `notes.get`), the notices folded in (`note.state`, `notes.state`), and the
// presses: the bell, Open (which goes to the note in its session's chat and marks it read),
// Dismiss, Dismiss finished, Not answered, a strip folded, and a reply sent from a note's box.
// A node or an app older than notes refuses `note.list` (`unsupported`): no bell shows then; a
// node that is not the primary yet (`unavailable`) is asked again once it may be.
//
// A reply goes to the session as `session.send` itself, never through the session's own send
// box, whose answer clears that box's draft: the node marks the note answered once the user's
// turn lands in the session.
//
// A session's chat in front of the user reads its notes: once its tab shows in a window in
// sight and the user is at it (the frame has the focus, or they touched, clicked, scrolled or
// typed in the view within `PRESENT_MS`), each of its notes not read yet is marked read. The bell
// and the tab's dot lose them; the strip at the top of the chat keeps them until dismissed. A
// note that waits for an answer stays open until it is answered.

import type { Note, NotesState } from "@cophyla/protocol";
import type { Action, ViewState } from "./model.ts";
import type { UiState } from "./render.ts";
import type { HostRpc } from "./rpc.ts";
import { ViewRpcError } from "./rpc.ts";
import { finishedNotes, unreadNotesOf } from "./notemodel.ts";

/** How long after the user's last input in the view they count as at it, for reading a chat's notes. */
export const PRESENT_MS = 60_000;
/** How long a note whose marking failed waits before it is marked again. */
const RETRY_MS = 30_000;

export interface NoteDeps {
  rpc: HostRpc;
  state: ViewState;
  ui: UiState;
  dispatch: (action: Action) => void;
  draw: () => void;
  /** Goes to a point in a session's chat, however far back: the tab selected, its chat shown, the point scrolled to and outlined. */
  showAt: (session: string, seq: number) => void;
}

export class NoteControl {
  private d: NoteDeps;
  private refused = false;
  /** When the user last touched, clicked, scrolled or typed in the view. */
  private lastInput = 0;
  /** Notes being marked read, or whose marking failed, with when it was tried. */
  private marking = new Map<string, number>();

  constructor(deps: NoteDeps) {
    this.d = deps;
  }

  /**
   * After a draw: the selected session's chat in sight of a user at it reads its notes not read
   * yet. A note marked a moment ago, or whose marking failed lately, is left for now.
   */
  afterDraw(): void {
    const { ui, state } = this.d;
    const session = ui.selected;
    if (session === undefined || ui.devices !== undefined || ui.terminal !== undefined || ui.group !== undefined) return;
    if (document.visibilityState !== "visible" || !state.scopes.includes("sessions:write") || !state.sessions.has(session)) return;
    const now = Date.now();
    if (!document.hasFocus() && now - this.lastInput > PRESENT_MS) return;
    for (const n of unreadNotesOf(state, session)) {
      const tried = this.marking.get(n.id);
      if (tried !== undefined && now - tried < RETRY_MS) continue;
      this.marking.set(n.id, now);
      void this.mark(n.id, { read: true }).then((ok) => {
        if (ok) this.marking.delete(n.id);
      });
    }
  }

  /** The user touched, clicked, scrolled or typed in the view: they are at it, and the chat in front of them reads its notes. */
  input(): void {
    const now = Date.now();
    const was = this.lastInput;
    this.lastInput = now;
    if (now - was > 1000) this.afterDraw();
  }

  /** The line is up: the notes and the switch, asked for afresh. */
  connected(): void {
    void this.load();
  }

  async load(): Promise<void> {
    if (!this.d.state.scopes.includes("sessions:read")) return;
    try {
      const { notes } = await this.d.rpc.request<{ notes: Note[] }>("note.list", {});
      this.refused = false;
      this.d.dispatch({ type: "notes", notes });
    } catch (e) {
      // Older than notes, or a node that is not the primary yet: no bell. Anything else (the
      // line dropped) leaves things as they were, and the next connect asks again.
      if (e instanceof ViewRpcError && (e.code === "unsupported" || e.code === "unavailable")) {
        this.refused = e.code === "unavailable";
        this.d.dispatch({ type: "notes" });
      }
      return;
    }
    try {
      const setting = await this.d.rpc.request<NotesState>("notes.get", {});
      this.d.dispatch({ type: "notes.setting", setting });
    } catch {
      this.d.dispatch({ type: "notes.setting" });
    }
  }

  /** The node's own row changed (it took the primary role, say): a refused list is asked again. */
  again(): void {
    if (this.refused) void this.load();
  }

  /** A notice for the notes, folded in; false for any other. */
  notification(method: string, params: unknown): boolean {
    switch (method) {
      case "note.state": {
        const n = params as Note;
        if (n.dismissed || n.answered) {
          this.d.ui.notes.sending.delete(n.id);
          this.d.ui.notes.failed.delete(n.id);
        }
        this.d.dispatch({ type: "note.state", params: n });
        return true;
      }
      case "notes.state":
        this.d.dispatch({ type: "notes.state", params: params as NotesState });
        return true;
      default:
        return false;
    }
  }

  /** The bell's list closes on a click anywhere but in it or on a bell. */
  outside(target: Element | null): void {
    if (!this.d.ui.notes.open || target?.closest(".notes-panel, .notes-bell")) return;
    this.d.ui.notes.open = false;
    this.d.draw();
  }

  /** Escape closes the bell's list; true when it was open. */
  escape(): boolean {
    if (!this.d.ui.notes.open) return false;
    this.d.ui.notes.open = false;
    this.d.draw();
    document.querySelector<HTMLButtonElement>(".notes-bell:not([hidden])")?.focus();
    return true;
  }

  /** A press on the bell, a note or a strip; false for any other. */
  click(target: HTMLElement): boolean {
    const data = target.dataset;
    switch (data["action"]) {
      case "notes-bell":
        this.d.ui.notes.open = !this.d.ui.notes.open;
        this.d.draw();
        // a fresh look: the newest note's reply box, if it waits for one, else the list
        if (this.d.ui.notes.open) document.querySelector<HTMLElement>(".notes-panel .note-title:not(:disabled)")?.focus();
        return true;
      case "note-open": {
        const id = data["id"];
        const session = data["session"];
        const seq = Number(data["seq"]);
        if (!id || !session || !Number.isInteger(seq)) return true;
        this.open(id, session, seq);
        return true;
      }
      case "note-dismiss":
        if (data["id"]) void this.dismiss([data["id"]]);
        return true;
      case "notes-dismiss-finished": {
        // from a session's strip, that session's; from the bell's list, every one
        const ids = finishedNotes(this.d.state, data["session"]).map((n) => n.id);
        if (ids.length > 0) void this.dismiss(ids);
        return true;
      }
      case "note-reopen":
        if (data["id"]) void this.mark(data["id"], { answered: false });
        return true;
      case "notes-fold": {
        const session = data["session"];
        if (!session) return true;
        const folded = this.d.ui.notes.folded;
        if (folded.has(session)) folded.delete(session);
        else folded.add(session);
        this.d.draw();
        return true;
      }
      default:
        return false;
    }
  }

  /** A note's reply box sent (Enter or Send); false for any other form. */
  submit(form: HTMLFormElement): boolean {
    if (!form.classList.contains("note-reply")) return false;
    const id = form.dataset["id"];
    const session = form.dataset["session"];
    const field = form.querySelector<HTMLTextAreaElement>(".note-reply-text");
    if (id && session && field) void this.reply(id, session, field);
    return true;
  }

  /** Enter in a note's reply box sends it, Shift+Enter starts a new line. */
  keydown(ev: KeyboardEvent, sends: (ev: KeyboardEvent) => boolean): void {
    const input = ev.target as HTMLElement | null;
    if (ev.defaultPrevented || !input?.matches?.(".note-reply-text") || !sends(ev)) return;
    ev.preventDefault();
    input.closest("form")?.requestSubmit();
  }

  /**
   * Goes to a note where it was left (by the host too, from a toast: `host.reveal`), marking it
   * read; the bell's list closes.
   */
  open(id: string | undefined, session: string, seq: number): void {
    this.d.ui.notes.open = false;
    const n = id !== undefined ? this.d.state.notes.get(id) : undefined;
    if (n && n.read === undefined) void this.mark(n.id, { read: true });
    this.d.showAt(session, n?.seq ?? seq);
  }

  private async reply(id: string, session: string, field: HTMLTextAreaElement): Promise<void> {
    const text = field.value.trim();
    if (!text || this.d.ui.notes.sending.has(id)) return;
    this.d.ui.notes.sending.add(id);
    this.d.ui.notes.failed.delete(id);
    this.d.draw();
    try {
      await this.d.rpc.request("session.send", { id: session, text });
      field.value = "";
      const n = this.d.state.notes.get(id);
      if (n && n.read === undefined) void this.mark(id, { read: true });
    } catch (e) {
      this.d.ui.notes.failed.set(id, `Not sent: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.d.ui.notes.sending.delete(id);
      this.d.draw();
    }
  }

  /** Marks a note; true once the node took it, or it is gone. */
  private async mark(id: string, p: { read?: boolean; answered?: boolean }): Promise<boolean> {
    try {
      const { note } = await this.d.rpc.request<{ note: Note }>("note.mark", { id, ...p });
      this.d.dispatch({ type: "note.state", params: note });
      return true;
    } catch (e) {
      // gone meanwhile (dismissed on another device): nothing to mark
      if (e instanceof ViewRpcError && e.code === "not_found") return true;
      this.fail("note", e);
      return false;
    }
  }

  private async dismiss(ids: string[]): Promise<void> {
    // gone at once; the node's word follows, and a failure brings the list back
    for (const id of ids) {
      const n = this.d.state.notes.get(id);
      if (n) this.d.dispatch({ type: "note.state", params: { ...n, dismissed: true } });
    }
    try {
      await this.d.rpc.request("note.dismiss", { ids });
    } catch (e) {
      this.fail("dismiss", e);
      void this.load();
    }
  }

  private fail(what: string, e: unknown): void {
    this.d.dispatch({ type: "error", message: `${what}: ${e instanceof Error ? e.message : String(e)}` });
  }
}
