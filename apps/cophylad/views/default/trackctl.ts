// The tracker on the host's line: every ask and the settings asked for as the view connects
// (`tracked.list`, `tracker.get`), the notices folded in (`tracked.state`, `tracker.state`), and
// the strip's presses: a session's Track switch, folding, marking, dismissing, and an answer
// read out of the session's history (`session.history` around its seq) or the timeline when it
// holds it. A node or an app older than the tracker refuses `tracked.list` (`unsupported`): no
// strip and no switch show then; a node that is not the primary yet (`unavailable`) is asked
// again once it may be.

import type { SessionEvent, Tracked, TrackedStatus, TrackerState } from "@cophyla/protocol";
import type { Action, ViewState } from "./model.ts";
import type { Roots, UiState } from "./render.ts";
import type { HostRpc } from "./rpc.ts";
import { ViewRpcError } from "./rpc.ts";
import { follows } from "./trackmodel.ts";

export interface TrackDeps {
  rpc: HostRpc;
  state: ViewState;
  ui: UiState;
  roots: Roots;
  dispatch: (action: Action) => void;
  draw: () => void;
  /** Brings a session's message into view in its chat, where the timeline holds it. */
  showInChat: (session: string, seq: number) => void;
}

/** How many answers' words are kept once read, so a second press shows them at once. */
const TEXTS_KEPT = 30;

export class TrackControl {
  private d: TrackDeps;
  private refused = false;
  private texts = new Map<string, string>();

  constructor(deps: TrackDeps) {
    this.d = deps;
  }

  /** The line is up: the asks and the settings, asked for afresh. */
  connected(): void {
    void this.load();
  }

  async load(): Promise<void> {
    if (!this.d.state.scopes.includes("sessions:read")) return;
    try {
      const { tracked } = await this.d.rpc.request<{ tracked: Tracked[] }>("tracked.list", {});
      this.refused = false;
      this.d.dispatch({ type: "tracked", tracked });
    } catch (e) {
      // Older than the tracker, or a node that is not the primary yet: no strip. Anything else
      // (the line dropped) leaves things as they were, and the next connect asks again.
      if (e instanceof ViewRpcError && (e.code === "unsupported" || e.code === "unavailable")) {
        this.refused = e.code === "unavailable";
        this.d.dispatch({ type: "tracked" });
      }
      return;
    }
    try {
      const tracker = await this.d.rpc.request<TrackerState>("tracker.get", {});
      this.d.dispatch({ type: "tracker", tracker });
    } catch {
      // limited access reads the asks of its sessions but not the settings: no switch
      this.d.dispatch({ type: "tracker" });
    }
  }

  /** The node's own row changed (it took the primary role, say): a refused list is asked again. */
  again(): void {
    if (this.refused) void this.load();
  }

  /** A notice for the tracker, folded in; false for any other. */
  notification(method: string, params: unknown): boolean {
    switch (method) {
      case "tracked.state": {
        const t = params as Tracked;
        if (t.dismissed && this.d.ui.track.reader?.id === t.id) this.d.ui.track.reader = undefined;
        this.d.dispatch({ type: "tracked.state", params: t });
        return true;
      }
      case "tracker.state":
        this.d.dispatch({ type: "tracker.state", params: params as TrackerState });
        return true;
      default:
        return false;
    }
  }

  /** A press in a strip or on Track; false for any other. */
  click(target: HTMLElement): boolean {
    const data = target.dataset;
    switch (data["action"]) {
      case "tracked-follow":
        if (data["session"]) void this.follow(data["session"]);
        return true;
      case "tracked-fold": {
        const session = data["session"];
        if (!session) return true;
        const folded = this.d.ui.track.folded;
        if (folded.has(session)) folded.delete(session);
        else folded.add(session);
        this.d.draw();
        return true;
      }
      case "tracked-mark":
        if (data["id"] && (data["to"] === "open" || data["to"] === "partial" || data["to"] === "answered")) void this.mark(data["id"], data["to"]);
        return true;
      case "tracked-dismiss":
        if (data["id"]) void this.dismiss([data["id"]]);
        return true;
      case "tracked-dismiss-answered": {
        const session = data["session"];
        const ids = [...this.d.state.tracked.values()].filter((t) => t.session === session && t.status === "answered").map((t) => t.id);
        if (ids.length > 0) void this.dismiss(ids);
        return true;
      }
      case "tracked-answer": {
        const session = data["session"];
        const id = data["id"];
        const seq = Number(data["seq"]);
        if (!session || !id || !Number.isInteger(seq)) return true;
        const r = this.d.ui.track.reader;
        // the answer open already: a second press puts it away
        if (r && r.id === id && r.seq === seq) this.d.ui.track.reader = undefined;
        else this.open(session, id, seq, Number(data["n"]) || 1, Number(data["of"]) || 1, data["status"] === "partial" ? "partial" : "answered", Number(data["at"]) || 0);
        this.d.draw();
        return true;
      }
      case "tracked-reader-close":
        this.d.ui.track.reader = undefined;
        this.d.draw();
        return true;
      case "tracked-show": {
        const session = data["session"];
        const seq = Number(data["seq"]);
        if (session && Number.isInteger(seq)) this.d.showInChat(session, seq);
        return true;
      }
      default:
        return false;
    }
  }

  /** The session's switch, flipped: set against the tracker's own only where it differs from it. */
  private async follow(session: string): Promise<void> {
    const t = this.d.state.tracker;
    if (!t) return;
    const on = !follows(this.d.state, session);
    try {
      const next = await this.d.rpc.request<TrackerState>("tracker.set", { session: { id: session, on: on === t.on ? null : on } });
      this.d.dispatch({ type: "tracker.state", params: next });
    } catch (e) {
      this.fail("track", e);
    }
  }

  private async mark(id: string, status: TrackedStatus): Promise<void> {
    try {
      const { tracked } = await this.d.rpc.request<{ tracked: Tracked }>("tracked.mark", { id, status });
      this.d.dispatch({ type: "tracked.state", params: tracked });
    } catch (e) {
      this.fail("mark", e);
    }
  }

  private async dismiss(ids: string[]): Promise<void> {
    // gone at once; the node's word follows, and a failure brings the list back
    for (const id of ids) {
      const t = this.d.state.tracked.get(id);
      if (t) this.d.dispatch({ type: "tracked.state", params: { ...t, dismissed: true } });
      if (this.d.ui.track.reader?.id === id) this.d.ui.track.reader = undefined;
    }
    try {
      await this.d.rpc.request("tracked.dismiss", { ids });
    } catch (e) {
      this.fail("dismiss", e);
      void this.load();
    }
  }

  /** An answer opened under the list: its words from those read before, the timeline, or the session's history. */
  private open(session: string, id: string, seq: number, n: number, of: number, status: "partial" | "answered", at: number): void {
    const key = `${session}:${seq}`;
    const known = this.texts.get(key) ?? textOf(this.d.state.sessions.get(session)?.events.get(seq));
    this.d.ui.track.reader = { session, id, seq, n, of, status, at, ...(known !== undefined ? { text: known } : {}) };
    if (known !== undefined) {
      this.keep(key, known);
      return;
    }
    void (async () => {
      let text: string | undefined;
      let failed: string | undefined;
      try {
        const { events } = await this.d.rpc.request<{ events: SessionEvent[] }>("session.history", { id: session, around: seq, limit: 2 });
        text = textOf(events.find((e) => e.seq === seq));
        if (text === undefined) failed = "That message is no longer in the session's history.";
      } catch (e) {
        failed = `The answer could not be read: ${e instanceof Error ? e.message : String(e)}`;
      }
      const r = this.d.ui.track.reader;
      if (!r || r.session !== session || r.seq !== seq) return;
      if (text !== undefined) {
        this.keep(key, text);
        r.text = text;
      } else if (failed !== undefined) r.failed = failed;
      this.d.draw();
    })();
  }

  private keep(key: string, text: string): void {
    this.texts.delete(key);
    this.texts.set(key, text);
    if (this.texts.size > TEXTS_KEPT) this.texts.delete(this.texts.keys().next().value!);
  }

  private fail(what: string, e: unknown): void {
    this.d.dispatch({ type: "error", message: `${what}: ${e instanceof Error ? e.message : String(e)}` });
  }
}

/** An agent's message's words, from its event. */
function textOf(e: SessionEvent | undefined): string | undefined {
  if (!e || e.kind !== "assistant_text") return undefined;
  const text = (e.payload as { text?: unknown } | undefined)?.text;
  return typeof text === "string" ? text : undefined;
}
