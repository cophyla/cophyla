// The pure part of task triggers: what a valid trigger is, when a time or cron trigger is
// next due, and whether an event matches an event trigger. A cron trigger without `tz`
// runs in the platform's zone; a cron expression is checked by asking croner for its next
// run, so an expression that can never match is refused with the rest. An event trigger
// matches by name and, key by key, by equality of `match` with the payload's field: ranges
// and patterns belong in the hook that raises the event, where the event is defined. `rearms`
// and `refires` say which tasks run again: after a run marked done, and after one that never was.

import { Cron } from "croner";
import { RpcError } from "@cophyla/protocol";
import type { Task, TaskTrigger } from "@cophyla/protocol";

/** The zone this process runs in, as Intl reports it; UTC when it reports none. */
export function nodeTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Whether `tz` names a zone Intl knows. */
export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Throws `invalid` for a trigger the scheduler could not fire. */
export function validateTrigger(t: TaskTrigger, tz: string): void {
  switch (t.kind) {
    case "at":
      return;
    case "cron": {
      const zone = t.tz ?? tz;
      let next: Date | null;
      try {
        next = new Cron(t.expr, { timezone: zone }).nextRun(new Date(0));
      } catch (e) {
        throw new RpcError("invalid", `bad cron trigger: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (next === null) throw new RpcError("invalid", `cron trigger never matches: ${t.expr}`);
      return;
    }
    case "event":
      if (t.name.trim() === "") throw new RpcError("invalid", "an event trigger needs an event name");
      return;
  }
}

/** When an `at` or `cron` task is next due, in epoch ms: a cron's next run after the task last changed, which its firing is. Undefined for an event trigger or none. */
export function dueAt(task: Task, tz: string): number | undefined {
  const t = task.trigger;
  if (!t) return undefined;
  if (t.kind === "at") return t.at;
  if (t.kind === "event") return undefined;
  try {
    const next = new Cron(t.expr, { timezone: t.tz ?? tz }).nextRun(new Date(task.updatedAt));
    return next === null ? undefined : next.getTime();
  } catch {
    return undefined;
  }
}

/** Whether an event, by name and payload, fires an event trigger. */
export function matchesEvent(trigger: TaskTrigger | undefined, event: { name: string; payload: unknown }): boolean {
  if (!trigger || trigger.kind !== "event" || trigger.name !== event.name) return false;
  if (!trigger.match) return true;
  const payload = event.payload !== null && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
  for (const [key, want] of Object.entries(trigger.match)) {
    if (JSON.stringify(payload[key] ?? null) !== JSON.stringify(want ?? null)) return false;
  }
  return true;
}

/** A recurring cron or event task goes back to `pending` when done; a recurring `at` task behaves as once. */
export function rearms(task: Task): boolean {
  return task.recurring === true && (task.trigger?.kind === "cron" || task.trigger?.kind === "event");
}

/**
 * A recurring cron task still `ready` fires again when its time comes round: nobody marked
 * its last run done, and the schedule goes on all the same. An event task that is ready waits
 * for that run to end, since each of its fires is one event's.
 */
export function refires(task: Task): boolean {
  return task.status === "ready" && task.recurring === true && task.trigger?.kind === "cron";
}
