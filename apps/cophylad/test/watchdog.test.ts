// The event-loop watchdog: a main thread held by a busy loop is reported from the watchdog's
// worker while it is held, with the task it was in, and again when it lets go; a loop that
// keeps beating is never reported. The lag reading resets as it is read.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "../src/log.ts";
import { Watchdog } from "../src/watchdog/index.ts";
import { currentTask, enter, leave, taskId, withTask } from "../src/watchdog/task.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function busy(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // held
  }
}

describe("the watchdog", () => {
  test("a held loop is told while held, with its task, and when it lets go", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cophyla-test-watchdog-"));
    const logFile = join(dir, "cophylad.log");
    const dog = new Watchdog({ log: silentLogger, logFile, stallMs: 300, beatMs: 50 });
    dog.start();
    try {
      await sleep(200);
      withTask("api: chat.send", () => busy(900));
      // the loop runs again: the worker sees the beat move and says the stall ended
      await sleep(400);
      const text = readFileSync(logFile, "utf8");
      expect(text).toContain("event loop stalled");
      expect(text).toContain('"task":"api: chat.send"');
      expect(text).toMatch(/event loop stall ended \{"ms":\d+,"task":"api: chat.send"\}/);
      const ended = Number(/stall ended \{"ms":(\d+)/.exec(text)![1]);
      expect(ended).toBeGreaterThanOrEqual(600);
    } finally {
      await dog.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a loop that keeps beating is never told; the lag starts over as it is read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cophyla-test-watchdog-"));
    const logFile = join(dir, "cophylad.log");
    const dog = new Watchdog({ log: silentLogger, logFile, stallMs: 300, beatMs: 50 });
    dog.start();
    try {
      for (let i = 0; i < 5; i++) {
        busy(50);
        await sleep(60);
      }
      const lag = dog.lag();
      expect(lag).toBeDefined();
      expect(lag!.max).toBeGreaterThanOrEqual(lag!.p50);
      await sleep(200);
      expect(() => readFileSync(logFile, "utf8")).toThrow();
    } finally {
      await dog.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tasks nest, and the current one is named", () => {
    const outer = enter(taskId("job: audit.retention"));
    expect(currentTask()).toBe("job: audit.retention");
    withTask("sql: SELECT 1", () => expect(currentTask()).toBe("sql: SELECT 1"));
    expect(currentTask()).toBe("job: audit.retention");
    leave(outer);
  });
});
