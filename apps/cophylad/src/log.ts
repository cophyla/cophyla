// A small structured logger to stderr. One line per event, fields as JSON.
//
// The daemon's lines are buffered and written a tenth of a second (or 64 KB) at a time, never
// one write per line on the thread that answers the user, and all at once, synchronously, as
// the process exits. Started by a spawner that sends its stderr elsewhere (the desktop app and
// `node.restart` set `COPHYLAD_LOG_FILE` and send stderr to `cophylad.stderr.log`, where a
// runtime panic still lands), the daemon appends to the log file itself and rotates it: past
// 20 MB it becomes `cophylad.1.log`, and the oldest of five goes. Under a spawner that sends
// stderr to the log file (an older app), it writes to stderr and the file is never rotated.

import { appendFileSync, existsSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export type LogSink = (line: string) => void;

export function createLogger(
  level: LogLevel = "info",
  sink: LogSink = (line) => process.stderr.write(line + "\n"),
  scope = "cophylad",
): Logger {
  const min = ORDER[level];
  const write = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const at = new Date().toISOString();
    const tail = fields && Object.keys(fields).length > 0 ? " " + JSON.stringify(fields, replacer) : "";
    sink(`${at} ${lvl.toUpperCase().padEnd(5)} ${scope} ${msg}${tail}`);
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (s) => createLogger(level, sink, `${scope}.${s}`),
  };
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

export const silentLogger: Logger = createLogger("error", () => {});

/** The environment variable a spawner names the daemon's own log file in. */
export const LOG_FILE_ENV = "COPHYLAD_LOG_FILE";
export const ROTATE_BYTES = 20 * 1024 * 1024;
export const ROTATE_KEEP = 5;
const FLUSH_MS = 100;
const FLUSH_BYTES = 64 * 1024;

/** The sinks with lines still buffered: written out whole, synchronously, as the process exits. */
const open = new Set<BufferedSink>();
let exitHooked = false;

/** Writes every buffered line now, synchronously: on exit, and before a fatal stop. */
export function flushLogs(): void {
  for (const s of open) s.flushSync();
}

/** `cophylad.log`'s rotated names: `cophylad.1.log` the newest of them. */
export function rotatedName(path: string, n: number): string {
  const ext = extname(path);
  return join(dirname(path), `${basename(path, ext)}.${n}${ext}`);
}

/** Moves `path` to its first rotated name, each older one a step on, the oldest past `keep` gone. */
export function rotate(path: string, keep = ROTATE_KEEP): void {
  const last = rotatedName(path, keep - 1);
  if (existsSync(last)) rmSync(last, { force: true });
  for (let n = keep - 2; n >= 1; n--) {
    const from = rotatedName(path, n);
    if (existsSync(from)) renameSync(from, rotatedName(path, n + 1));
  }
  if (existsSync(path)) renameSync(path, rotatedName(path, 1));
}

export interface BufferedSink {
  (line: string): void;
  flushSync(): void;
  /** Resolves once what is buffered now is written. */
  flush(): Promise<void>;
}

/**
 * A sink that buffers lines and hands them to `write` a tenth of a second or 64 KB at a time,
 * one write in flight at a time, in order; `writeSync` takes what is left as the process exits,
 * a write still in flight included (a daemon's last lines are written as it stops, and an
 * exit abandons the write the loop would have finished).
 */
export function bufferedSink(write: (chunk: string) => Promise<void>, writeSync: (chunk: string) => void): BufferedSink {
  let buf: string[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  /** What was handed to `write` and is not known written yet, in order. */
  let inflight: string[] = [];
  const take = (): string => {
    const chunk = buf.join("");
    buf = [];
    bytes = 0;
    if (timer) clearTimeout(timer);
    timer = undefined;
    return chunk;
  };
  const flush = (): Promise<void> => {
    if (buf.length === 0) return chain;
    const chunk = take();
    inflight.push(chunk);
    chain = chain
      .then(() => write(chunk))
      .catch(() => {
        // a write that failed loses its lines, never the daemon
      })
      .then(() => {
        const i = inflight.indexOf(chunk);
        if (i >= 0) inflight.splice(i, 1);
      });
    return chain;
  };
  const sink = ((line: string) => {
    buf.push(line + "\n");
    bytes += line.length + 1;
    if (bytes >= FLUSH_BYTES) void flush();
    else if (!timer) {
      timer = setTimeout(() => void flush(), FLUSH_MS);
      (timer as { unref?: () => void }).unref?.();
    }
  }) as BufferedSink;
  sink.flushSync = () => {
    const all = [...inflight, ...(buf.length > 0 ? [take()] : [])];
    inflight = [];
    if (all.length === 0) return;
    try {
      writeSync(all.join(""));
    } catch {
      // as above
    }
  };
  sink.flush = flush;
  open.add(sink);
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", flushLogs);
  }
  return sink;
}

/** The daemon's log file, appended to and rotated by size. */
export function fileSink(path: string, opts: { rotateBytes?: number; keep?: number } = {}): BufferedSink {
  const limit = opts.rotateBytes ?? ROTATE_BYTES;
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    // a log not there yet starts empty
  }
  const before = (chunk: string) => {
    if (size > 0 && size + chunk.length > limit) {
      try {
        rotate(path, opts.keep);
        size = 0;
      } catch {
        // a log another process holds open goes on growing; the next write tries again
      }
    }
    size += Buffer.byteLength(chunk);
  };
  return bufferedSink(
    async (chunk) => {
      before(chunk);
      await appendFile(path, chunk);
    },
    (chunk) => {
      before(chunk);
      appendFileSync(path, chunk);
    },
  );
}

/** Stderr, buffered as the file is. */
export function stderrSink(): BufferedSink {
  return bufferedSink(
    (chunk) =>
      new Promise<void>((resolve) => {
        process.stderr.write(chunk, () => resolve());
      }),
    (chunk) => {
      writeSync(2, chunk);
    },
  );
}

/** Where the daemon's lines go: the file its spawner named, else stderr; both buffered. */
export function daemonSink(env: Record<string, string | undefined> = process.env): { sink: BufferedSink; file?: string } {
  const file = env[LOG_FILE_ENV];
  if (file) return { sink: fileSink(file), file };
  return { sink: stderrSink() };
}
