// What the daemon's main thread is doing, for the event-loop watchdog to name when the loop
// stalls. A label (the API method being answered, the SQL statement being run, the background
// job's slice) is interned once to a number, and entering it is one store into shared memory
// the watchdog's worker reads, so labelling costs next to nothing and survives the stall it
// explains: the worker never needs the main thread to tell it what was running. Labels nest;
// `enter` answers the one it replaces, for `leave` to put back.

/** The layout of the shared block: the beat and the current task, read by watchdog/worker.ts. */
export const SHARED_BYTES = 64;
/** Int32 slots: [0] the current task's id, [1] the beat's seconds part, [2] its milliseconds part. */
export const SLOT_TASK = 0;
export const SLOT_BEAT_S = 1;
export const SLOT_BEAT_MS = 2;

const MAX_LABELS = 4096;
/** The id every label past the cap shares. */
const OTHER = 1;

const ids = new Map<string, number>([["other", OTHER]]);
let next = 2;
let slots: Int32Array | undefined;
let current = 0;
/** Hears each label as it is interned, so the worker can name an id it has not seen. */
let announce: ((id: number, label: string) => void) | undefined;

/** Shares the block with the watchdog: from now on each task entered is visible to it. */
export function shareTasks(block: SharedArrayBuffer, onLabel: (id: number, label: string) => void): void {
  slots = new Int32Array(block, 0, SHARED_BYTES / 4);
  announce = onLabel;
  for (const [label, id] of ids) onLabel(id, label);
  Atomics.store(slots, SLOT_TASK, current);
}

/** Stops sharing (the watchdog stopped). */
export function unshareTasks(): void {
  slots = undefined;
  announce = undefined;
}

/** The label's id, interned on first sight. */
export function taskId(label: string): number {
  let id = ids.get(label);
  if (id !== undefined) return id;
  if (ids.size >= MAX_LABELS) return OTHER;
  id = next++;
  ids.set(label, id);
  announce?.(id, label);
  return id;
}

/** Makes `id` the current task; answers the one it replaced. */
export function enter(id: number): number {
  const prev = current;
  current = id;
  if (slots) Atomics.store(slots, SLOT_TASK, id);
  return prev;
}

/** Puts back the task `enter` replaced. */
export function leave(prev: number): void {
  current = prev;
  if (slots) Atomics.store(slots, SLOT_TASK, prev);
}

/** Runs `fn` labelled. */
export function withTask<T>(label: string, fn: () => T): T {
  const prev = enter(taskId(label));
  try {
    return fn();
  } finally {
    leave(prev);
  }
}

/** The current task's label, for a log line written on the main thread. */
export function currentTask(): string | undefined {
  if (current === 0) return undefined;
  for (const [label, id] of ids) if (id === current) return label;
  return undefined;
}
