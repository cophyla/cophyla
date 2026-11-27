// The host page's log: each line goes to the console, as it always did, and to the app's log
// file (src-tauri/src/applog.rs), the lines of a quarter of a second together, over the page's
// link socket or by the `app_log` command when it is not open (link.ts). A page that logs faster
// than the lines go keeps the newest `MAX_LINES` and says how many it dropped.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogLine {
  level: LogLevel;
  message: string;
}

export interface PageLogDeps {
  /** Hands a batch of lines to the shell. */
  send: (lines: LogLine[]) => Promise<unknown>;
  console?: Pick<Console, LogLevel>;
  flushMs?: number;
}

export const FLUSH_MS = 250;
export const MAX_LINES = 500;

export class PageLog {
  private deps: PageLogDeps;
  private lines: LogLine[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: PageLogDeps) {
    this.deps = deps;
  }

  debug(message: string): void {
    this.line("debug", message);
  }

  info(message: string): void {
    this.line("info", message);
  }

  warn(message: string): void {
    this.line("warn", message);
  }

  error(message: string): void {
    this.line("error", message);
  }

  line(level: LogLevel, message: string): void {
    (this.deps.console ?? console)[level](message);
    this.lines.push({ level, message });
    if (this.lines.length > MAX_LINES) {
      this.dropped += this.lines.length - MAX_LINES;
      this.lines.splice(0, this.lines.length - MAX_LINES);
    }
    this.timer ??= setTimeout(() => this.flush(), this.deps.flushMs ?? FLUSH_MS);
  }

  /** Sends the lines waiting now. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.lines.length === 0) return;
    const lines = this.lines;
    this.lines = [];
    if (this.dropped > 0) {
      lines.unshift({ level: "warn", message: `${this.dropped} page log lines dropped` });
      this.dropped = 0;
    }
    void this.deps.send(lines).catch(() => {});
  }
}

/** What an error or a rejection says, for a line. */
export function describe(e: unknown): string {
  if (e instanceof Error) return e.stack ?? `${e.name}: ${e.message}`;
  return typeof e === "string" ? e : JSON.stringify(e) ?? String(e);
}
