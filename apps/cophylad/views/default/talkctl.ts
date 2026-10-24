// Agents' conversations on the host's line: every session's count asked for as the view
// connects (`talk.list`), the notices folded in (`talk.state` to everyone, `talk.said` to the
// view watching the session), a session's messages asked for as its Messages pane shows, a
// page back at a time, and what the user read told once the end of them is in view. A node or
// an app older than conversations refuses `talk.list` (`unsupported`): no Messages shows then.

import type { TalkMessage, TalkSummary } from "@cophyla/protocol";
import type { Action, ViewState } from "./model.ts";
import type { Roots, UiState } from "./render.ts";
import type { HostRpc } from "./rpc.ts";
import { ViewRpcError } from "./rpc.ts";
import { talkReadUpTo } from "./talkmodel.ts";
import { talkStream } from "./talkview.ts";

export interface TalkDeps {
  rpc: HostRpc;
  state: ViewState;
  ui: UiState;
  roots: Roots;
  dispatch: (action: Action, opts?: { anchor?: boolean }) => void;
  draw: () => void;
}

export class TalkControl {
  private d: TalkDeps;
  /** The session whose Messages pane showed at the last draw. */
  private shown?: string;
  /** `talk.list` was refused as kept by the primary: asked again once the node may be it. */
  private refused = false;

  constructor(deps: TalkDeps) {
    this.d = deps;
  }

  /** The line is up: every session's count, asked for afresh. */
  connected(): void {
    void this.load();
  }

  /** The line went: what was told as read is told again. */
  disconnected(): void {
    this.d.ui.talk.readSent.clear();
  }

  async load(): Promise<void> {
    if (!this.d.state.scopes.includes("sessions:read")) return;
    try {
      const { talks } = await this.d.rpc.request<{ talks: TalkSummary[] }>("talk.list", {});
      this.refused = false;
      this.d.dispatch({ type: "talks", talks });
    } catch (e) {
      // Older than conversations, or a node that keeps none: Messages goes. Anything else (the
      // line dropped) leaves things as they were, and the next connect asks again.
      if (e instanceof ViewRpcError && (e.code === "unsupported" || e.code === "unavailable")) {
        this.refused = e.code === "unavailable";
        this.d.dispatch({ type: "talks" });
      }
    }
  }

  /** The node's own row changed (it took the primary role, say): a refused list is asked again. */
  again(): void {
    if (this.refused) void this.load();
  }

  /** A notice for conversations, folded in; false for any other. */
  notification(method: string, params: unknown): boolean {
    switch (method) {
      case "talk.state":
        this.d.dispatch({ type: "talk.state", params: params as TalkSummary });
        return true;
      case "talk.said":
        this.d.dispatch({ type: "talk.said", params: params as { message: TalkMessage } });
        return true;
      default:
        return false;
    }
  }

  /** The latest page of a session's messages, or (`earlier`) the one before those shown. */
  async loadPage(session: string, earlier = false): Promise<void> {
    const page = this.d.state.talkPages.get(session);
    if (page?.loading) return;
    const before = earlier && page?.loaded && !page.stale ? page.messages[0]?.n : undefined;
    if (earlier && before === undefined) return;
    this.d.dispatch({ type: "talk.page.loading", session });
    try {
      const r = await this.d.rpc.request<{ messages: TalkMessage[]; more: boolean }>("talk.messages", { session, ...(before !== undefined ? { before } : {}) });
      this.d.dispatch({ type: "talk.page", session, messages: r.messages, more: r.more, ...(before !== undefined ? { before } : {}) }, { anchor: before !== undefined });
    } catch (e) {
      this.d.dispatch({ type: "talk.page.failed", session });
      this.d.dispatch({ type: "error", message: `messages: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /**
   * After a draw: a pane that just opened takes the read point it opened at, which marks its
   * first new message, and has its messages asked for unless they are here and current; what
   * the user read is told once the end of them is in view.
   */
  afterDraw(): void {
    const { ui, state } = this.d;
    const stream = talkStream(this.d.roots.sessions, ui);
    const session = stream ? ui.selected : undefined;
    if (session !== this.shown) {
      if (this.shown !== undefined) ui.talk.since.delete(this.shown);
      this.shown = session;
      if (session !== undefined) {
        ui.talk.since.set(session, state.talks.get(session)?.readTo ?? 0);
        // drawn once more, with its first new message marked
        if (state.talkPages.get(session)?.loaded) queueMicrotask(() => this.d.draw());
      }
    }
    if (session === undefined) return;
    const page = state.talkPages.get(session);
    if (state.connected && (!page || ((!page.loaded || page.stale) && !page.loading))) void this.loadPage(session);
    this.syncRead();
  }

  /** Tells the node the user read the conversation shown up to its last message, once the end of it is in view in a window that shows. */
  syncRead(): void {
    const { ui, state } = this.d;
    const stream = talkStream(this.d.roots.sessions, ui);
    const session = ui.selected;
    if (!stream || session === undefined || !state.connected || !state.scopes.includes("sessions:write") || document.visibilityState !== "visible") return;
    const page = state.talkPages.get(session);
    if (!page?.loaded || page.stale) return;
    if (stream.scrollHeight - stream.scrollTop - stream.clientHeight > 24) return;
    const upTo = talkReadUpTo(state, session);
    if (upTo === undefined || (ui.talk.readSent.get(session) ?? 0) >= upTo) return;
    ui.talk.readSent.set(session, upTo);
    this.d.rpc.request("talk.read", { session, upTo }).catch(() => {
      if (ui.talk.readSent.get(session) === upTo) ui.talk.readSent.delete(session);
    });
  }

  /** A click in a Messages pane; false for any other. */
  click(target: HTMLElement): boolean {
    const session = target.dataset["session"];
    switch (target.dataset["action"]) {
      case "talk-earlier":
        if (session) void this.loadPage(session, true);
        return true;
      case "talk-party": {
        if (!session) return true;
        const party = target.dataset["party"] ?? "";
        if (party === "" || this.d.ui.talk.party.get(session) === party) this.d.ui.talk.party.delete(session);
        else this.d.ui.talk.party.set(session, party);
        this.d.draw();
        return true;
      }
      default:
        return false;
    }
  }
}
