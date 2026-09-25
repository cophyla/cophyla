// A small structured logger to stderr. One line per event, fields as JSON.

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
