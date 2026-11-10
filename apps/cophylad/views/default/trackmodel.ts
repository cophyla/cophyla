// The tracker as the view keeps it: the asks it follows, from `tracked.list` and
// `tracked.state` (a dismissed one goes), its settings and health from `tracker.get` and
// `tracker.state`, and what a session's strip of asks shows. Kept apart from model.ts, which
// folds these in through `applyTrack`.

import type { Tracked, TrackedStatus, TrackerState } from "@cophyla/protocol";
import type { Action, ViewState } from "./model.ts";

/** Folds a tracker action in; false when the action is none of them. */
export function applyTrack(state: ViewState, action: Action): boolean {
  switch (action.type) {
    case "tracked":
      // refused (an older node or app, or no primary yet): no strip and no switch show
      state.trackOn = action.tracked !== undefined;
      state.tracked = new Map((action.tracked ?? []).map((t) => [t.id, t]));
      return true;
    case "tracked.state": {
      const t = action.params;
      if (t.dismissed) state.tracked.delete(t.id);
      else state.tracked.set(t.id, t);
      return true;
    }
    case "tracker":
      if (action.tracker) state.tracker = action.tracker;
      else delete state.tracker;
      return true;
    case "tracker.state":
      state.tracker = action.params;
      return true;
    default:
      return false;
  }
}

/** Whether the tracker follows a session: its own switch, else the tracker's. */
export function follows(state: Pick<ViewState, "tracker">, session: string): boolean {
  const t = state.tracker;
  if (!t) return false;
  return t.sessions[session] ?? t.on;
}

/** A session's asks, the oldest first. */
export function trackedOf(state: Pick<ViewState, "tracked">, session: string): Tracked[] {
  return [...state.tracked.values()].filter((t) => t.session === session).sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
}

/** What a session's strip says on its line: how many are open, partly answered and answered. */
export function trackedCounts(list: readonly Tracked[]): Record<TrackedStatus, number> {
  const out: Record<TrackedStatus, number> = { open: 0, partial: 0, answered: 0 };
  for (const t of list) out[t.status]++;
  return out;
}

/** The strip's line: "3 asks · 1 answered · 1 in part". */
export function trackedSummary(list: readonly Tracked[]): string {
  const c = trackedCounts(list);
  const parts = [`${list.length} ask${list.length === 1 ? "" : "s"}`];
  if (c.answered > 0) parts.push(`${c.answered} answered`);
  if (c.partial > 0) parts.push(`${c.partial} in part`);
  return parts.join(" · ");
}

/** An ask's status in words, for its mark's label. */
export function statusWords(status: TrackedStatus, marked?: boolean): string {
  const by = marked ? ", as you marked it" : "";
  switch (status) {
    case "open":
      return `Not answered yet${by}`;
    case "partial":
      return `Answered in part${by}`;
    case "answered":
      return `Answered${by}`;
  }
}

/** What pressing an ask's mark sets it to: an answered one back to open, any other answered. */
export function nextMark(status: TrackedStatus): TrackedStatus {
  return status === "answered" ? "open" : "answered";
}

/**
 * Why the tracker cannot judge now, for a line in a followed session's strip; undefined while
 * it can. A limit says when it lifts where it said so.
 */
export function trackerTrouble(state: Pick<ViewState, "tracker">): string | undefined {
  const h = state.tracker?.health;
  if (!h || h.state === "ok") return undefined;
  if (h.state === "limited") return "Asks are on hold: the Claude account they are checked with is at its usage limit. They are checked again once it lifts.";
  return `Asks are not being checked: ${h.detail ?? "no Claude account is signed in to check them with"}.`;
}

/** An answer's place on its ask's line: "Answer 2 of 3, in part". */
export function answerWords(n: number, of: number, status: "partial" | "answered"): string {
  return `Answer ${n} of ${of}${status === "partial" ? ", in part" : ""}`;
}
