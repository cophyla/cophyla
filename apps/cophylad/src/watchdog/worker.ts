// The watchdog's thread. The daemon's main thread moves a beat in shared memory every tenth of
// a second; this thread looks at it as often, by its own clock, and when the beat has not moved
// for more than a second the main thread is stuck: it says so in the log at once, every five seconds while it lasts, and
// once more when it ends, with how long it was and the task the main thread was in (watchdog/
// task.ts), the one it was in longest when it changed. It writes the lines itself, to the
// daemon's log file or its stderr: the main thread is the one that cannot.

import { appendFileSync, writeSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
import { SHARED_BYTES, SLOT_BEAT, SLOT_TASK } from "./task.ts";

declare const self: Worker;

export interface WatchdogInit {
  kind: "init";
  block: SharedArrayBuffer;
  /** The daemon's own log file, when it writes one; its stderr otherwise. */
  logFile?: string;
  stallMs: number;
  checkMs: number;
  /** While a stall lasts, how often it is told again. */
  repeatMs: number;
  level: "debug" | "info" | "warn" | "error";
}

export type ToWatchdog = WatchdogInit | { kind: "label"; id: number; label: string } | { kind: "stop" };

const labels = new Map<number, string>();
let slots: Int32Array | undefined;
let init: WatchdogInit | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let stall: { from: number; told: number; tasks: Map<number, number> } | undefined;
/** The beat last seen, and when this thread saw it move. */
let seen = -1;
let movedAt = 0;

function write(msg: string, fields: Record<string, unknown>): void {
  if (!init) return;
  const line = `${new Date().toISOString()} WARN  cophylad.watchdog ${msg} ${JSON.stringify(fields)}\n`;
  try {
    if (init.logFile) appendFileSync(init.logFile, line);
    else writeSync(2, line);
  } catch {
    // a log that cannot be written loses the line, never the watchdog
  }
}

const name = (id: number): string | undefined => (id === 0 ? undefined : (labels.get(id) ?? `task ${id}`));

/** The task the stall spent the most checks in. */
function longest(tasks: Map<number, number>): string | undefined {
  let best: [number, number] | undefined;
  for (const e of tasks) if (!best || e[1] > best[1]) best = e;
  return best ? name(best[0]) : undefined;
}

function check(): void {
  if (!slots || !init) return;
  const now = Date.now();
  const beat = Atomics.load(slots, SLOT_BEAT);
  if (beat !== seen) {
    seen = beat;
    movedAt = now;
  }
  const last = movedAt;
  if (beat === 0) return;
  const late = now - last;
  const task = Atomics.load(slots, SLOT_TASK);
  if (late > init.stallMs) {
    if (!stall) {
      stall = { from: last, told: now, tasks: new Map([[task, 1]]) };
      write("event loop stalled", { ms: late, ...(name(task) ? { task: name(task) } : {}) });
      return;
    }
    stall.tasks.set(task, (stall.tasks.get(task) ?? 0) + 1);
    if (now - stall.told >= init.repeatMs) {
      stall.told = now;
      write("event loop still stalled", { ms: late, ...(name(task) ? { task: name(task) } : {}) });
    }
    return;
  }
  if (stall) {
    const ms = last - stall.from;
    const most = longest(stall.tasks);
    stall = undefined;
    write("event loop stall ended", { ms, ...(most ? { task: most } : {}) });
  }
}

if (!isMainThread) {
  self.onmessage = (ev: MessageEvent<ToWatchdog>) => {
    const m = ev.data;
    if (m.kind === "init") {
      init = m;
      slots = new Int32Array(m.block, 0, SHARED_BYTES / 4);
      timer = setInterval(check, m.checkMs);
    } else if (m.kind === "label") labels.set(m.id, m.label);
    else if (m.kind === "stop") {
      if (timer) clearInterval(timer);
      self.postMessage({ kind: "stopped" });
    }
  };
}
