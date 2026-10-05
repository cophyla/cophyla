// The chat's own session on Codex, against an app-server that records what it is asked and
// lets the test play its notifications and requests: the thread starts read-only, never
// asking, under the brain's rules, with Cophyla's tools as its dynamic tools and the compact
// limit capped; a resume goes on with a thread; the thread is claimed as the chat's. A prompt
// is told to the module first and is a `turn/start` with what the brain says beside it as
// named entries, and one sent into a running turn is steered into it. A turn's reply is its
// last agent message that is not commentary; an interrupted turn ends with no words, a failed
// one says a line. The host cuts no turn short itself but the one that runs when it is
// stopped. The thread's tool calls are run and answered, any other request declined. Its token
// use is the session's size, a compaction forgets what it was told, a clear is a thread of its
// own, and the app-server going away is told once.

import { beforeEach, describe, expect, test } from "bun:test";
import type { HarnessProfile, LlmTool, ToolCallResult } from "@cophyla/protocol";
import { CODEX_COMPACT_MAX, CodexHost, contextEntries, threadParams } from "../src/assistant/codex.ts";
import type { CodexServer, CodexServerOptions } from "../src/assistant/codex.ts";
import { CODEX_PART_CHARS } from "../src/assistant/context.ts";
import type { HostEvents } from "../src/assistant/index.ts";
import { silentLogger } from "../src/log.ts";

const PROFILE: HarnessProfile = { id: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV", harness: "codex", name: "work", configDir: "/home/me/.codex", env: {}, origin: "discovered", status: "ok" };
const TOOLS: LlmTool[] = [
  { name: "agents", description: "The agent sessions.", schema: { type: "object", properties: {} } },
  { name: "say", description: "Says a line.", schema: { type: "object", properties: { text: { type: "string" } } } },
];
const CONFIG = { codex_model: "gpt-6.1-sol", codex_effort: "low", autocompact_tokens: 300_000 };

type Params = Record<string, unknown>;

/** The app-server as the host uses it: every call recorded and answered, threads and turns numbered. */
class FakeServer implements CodexServer {
  alive = false;
  readonly calls: { method: string; params: Params }[] = [];
  starts = 0;
  stops = 0;
  private threads = 0;
  private turns = 0;
  readonly opts: CodexServerOptions;
  /** What the log of calls and of the module's events is kept in, in order. */
  private order: string[];

  constructor(opts: CodexServerOptions, order: string[]) {
    this.opts = opts;
    this.order = order;
  }

  async start(): Promise<unknown> {
    this.starts++;
    this.alive = true;
    return {};
  }

  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    const p = params as Params;
    this.calls.push({ method, params: p });
    this.order.push(method);
    if (method === "thread/start") return { thread: { id: `thread-${++this.threads}` } } as T;
    if (method === "thread/resume") return { thread: { id: p["threadId"] } } as T;
    if (method === "turn/start") return { turn: { id: `turn-${++this.turns}` } } as T;
    return {} as T;
  }

  async stop(): Promise<void> {
    this.stops++;
    this.alive = false;
  }

  of(method: string): Params[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }
}

interface World {
  host: CodexHost;
  server: FakeServer;
  order: string[];
  claimed: string[];
  prompted: { ref: string | undefined; text: string; size: number }[];
  replied: string[];
  steps: { tool: string; input: unknown }[];
  called: { tool: string; input: unknown }[];
  ended: string[];
  counts: { changed: number; forgot: number };
  /** What the brain says goes beside the next prompt, and what a tool call answers. */
  told: string[];
  result: ToolCallResult;
  /** A notification of the app-server's, for the host's thread unless it names another. */
  notify(method: string, params: Params): void;
  request(method: string, params: Params): Promise<unknown> | undefined;
}

function world(over: { config?: Partial<typeof CONFIG> } = {}): World {
  const order: string[] = [];
  let server!: FakeServer;
  const w: World = {
    host: undefined as unknown as CodexHost,
    server: undefined as unknown as FakeServer,
    order,
    claimed: [],
    prompted: [],
    replied: [],
    steps: [],
    called: [],
    ended: [],
    counts: { changed: 0, forgot: 0 },
    told: [],
    result: { content: "2 sessions" },
    notify: (method, params) => server.opts.onNotification(method, { threadId: w.host.native(), ...params }),
    request: (method, params) => server.opts.onRequest(method, params),
  };
  const events: HostEvents = {
    prompted: async (ref, text, size) => {
      order.push("prompted");
      w.prompted.push({ ref, text, size });
      return w.told;
    },
    step: (tool, input) => void w.steps.push({ tool, input }),
    replied: (text) => void w.replied.push(text),
    ended: (why) => void w.ended.push(why),
    changed: () => void w.counts.changed++,
    forgot: () => void w.counts.forgot++,
    call: async (tool, input) => {
      w.called.push({ tool, input });
      return w.result;
    },
    tools: async () => TOOLS,
  };
  w.host = new CodexHost({
    profile: PROFILE,
    events,
    config: { ...CONFIG, ...over.config },
    system: "You are Cophyla.",
    cwd: "/data/assistant/work",
    server: (opts) => (server = new FakeServer(opts, order)),
    claim: (thread) => void w.claimed.push(thread),
    log: silentLogger,
  });
  w.server = server;
  return w;
}

const message = (text: string, phase?: string) => ({ type: "agentMessage", text, ...(phase !== undefined ? { phase } : {}) });

describe("a thread of its own", () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  test("it starts read-only, never asking, under the brain's rules, with Cophyla's tools as its own", async () => {
    expect(w.host.harness).toBe("codex");
    expect(w.host.native()).toBeUndefined();
    expect(await w.host.start(undefined)).toEqual({ native: "thread-1" });
    expect(w.server.starts).toBe(1);
    expect(w.server.calls.map((c) => c.method)).toEqual(["thread/start"]);
    const p = w.server.calls[0]!.params;
    expect(p).toMatchObject({ model: "gpt-6.1-sol", cwd: "/data/assistant/work", approvalPolicy: "never", sandbox: "read-only", developerInstructions: "You are Cophyla." });
    expect(p["dynamicTools"]).toEqual(TOOLS.map((t) => ({ type: "function", name: t.name, description: t.description, inputSchema: t.schema })));
    // the harness's own tools it can spare are off, and it has no shell
    expect(p["config"]).toMatchObject({ model_reasoning_effort: "low", "features.shell_tool": false, "features.unified_exec": false, "features.multi_agent": false });
    expect(w.host.native()).toBe("thread-1");
    expect(w.host.terminal()).toBeUndefined();
    expect(w.claimed).toEqual(["thread-1"]);
  });

  test("it compacts at the configured size, never past what its models hold", async () => {
    await w.host.start(undefined);
    expect((w.server.calls[0]!.params["config"] as Params)["model_auto_compact_token_limit"]).toBe(CODEX_COMPACT_MAX);
    expect(CODEX_COMPACT_MAX).toBeLessThan(300_000);
    const small = world({ config: { autocompact_tokens: 150_000 } });
    await small.host.start(undefined);
    expect((small.server.calls[0]!.params["config"] as Params)["model_auto_compact_token_limit"]).toBe(150_000);
    expect(threadParams({ config: { ...CONFIG, autocompact_tokens: 1_000_000 }, system: "s", cwd: "/w" })["config"]).toMatchObject({ model_auto_compact_token_limit: CODEX_COMPACT_MAX });
  });

  test("a resume goes on with the thread named, under the same rules, and is claimed too", async () => {
    expect(await w.host.start("thread-kept")).toEqual({ native: "thread-kept" });
    expect(w.server.calls.map((c) => c.method)).toEqual(["thread/resume"]);
    const p = w.server.calls[0]!.params;
    expect(p).toMatchObject({ threadId: "thread-kept", excludeTurns: true, approvalPolicy: "never", sandbox: "read-only", developerInstructions: "You are Cophyla." });
    // its tools survive a resume: they are not declared again
    expect(p["dynamicTools"]).toBeUndefined();
    expect(w.claimed).toEqual(["thread-kept"]);
  });

  test("a clear is a thread of its own: started as the first was, claimed, and what it was told forgotten", async () => {
    await w.host.start(undefined);
    w.notify("thread/tokenUsage/updated", { tokenUsage: { last: { totalTokens: 9000 }, modelContextWindow: 272_000 } });
    expect(w.host.used()).toBe(9000);
    await w.host.clear();
    expect(w.server.calls.map((c) => c.method)).toEqual(["thread/start", "thread/start"]);
    expect(w.server.calls[1]!.params["dynamicTools"]).toHaveLength(TOOLS.length);
    expect(w.host.native()).toBe("thread-2");
    expect(w.claimed).toEqual(["thread-1", "thread-2"]);
    expect(w.counts.forgot).toBe(1);
    expect(w.host.used()).toBeUndefined();
    // what the thread before still says is no longer the chat's
    w.server.opts.onNotification("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [message("late")] } });
    expect(w.replied).toEqual([]);
  });
});

describe("a prompt", () => {
  let w: World;
  beforeEach(async () => {
    w = world();
    await w.host.start(undefined);
    w.order.length = 0;
  });

  test("the module hears of it first, and it is a turn with what the brain says beside it as named entries", async () => {
    w.told = ["[cophyla context, part 1 of 2]\nNow: Tuesday", "[cophyla context, part 2 of 2]\n2 sessions"];
    expect(await w.host.send("what is open?", "prompt-1")).toEqual({ ref: "prompt-1" });
    expect(w.order).toEqual(["prompted", "turn/start"]);
    expect(w.prompted).toEqual([{ ref: "prompt-1", text: "what is open?", size: CODEX_PART_CHARS }]);
    expect(w.server.of("turn/start")).toEqual([
      {
        threadId: "thread-1",
        input: [{ type: "text", text: "what is open?", text_elements: [] }],
        effort: "low",
        additionalContext: { "cophyla-01": { value: w.told[0]!, kind: "application" }, "cophyla-02": { value: w.told[1]!, kind: "application" } },
      },
    ]);
  });

  test("with nothing to tell beside it, the turn carries no context at all", async () => {
    await w.host.send("hello", "prompt-1");
    expect(Object.keys(w.server.of("turn/start")[0]!)).not.toContain("additionalContext");
  });

  test("the entries are named so they sort as they were cut, past nine too", () => {
    const names = Object.keys(contextEntries(Array.from({ length: 11 }, (_, i) => `p${i}`)));
    expect(names).toEqual(["cophyla-01", "cophyla-02", "cophyla-03", "cophyla-04", "cophyla-05", "cophyla-06", "cophyla-07", "cophyla-08", "cophyla-09", "cophyla-10", "cophyla-11"]);
    expect([...names].sort()).toEqual(names);
    expect(contextEntries([])).toEqual({});
  });

  test("a thread that is not running takes none: before its start, and once its program went", async () => {
    const cold = world();
    await expect(cold.host.send("hello", "prompt-1")).rejects.toThrow("the chat's thread is not running");
    expect(cold.prompted).toEqual([]);
    w.server.opts.onExit();
    await expect(w.host.send("hello", "prompt-1")).rejects.toThrow("the chat's thread is not running");
    expect(w.prompted).toEqual([]);
  });
});

describe("a turn's end", () => {
  let w: World;
  beforeEach(async () => {
    w = world();
    await w.host.start(undefined);
    await w.host.send("what is open?", "prompt-1");
  });

  test("a completed turn's reply is its last agent message that is not commentary", () => {
    w.notify("turn/completed", { turn: { id: "turn-1", status: "completed", items: [message("Looking.", "commentary"), message("Two sessions are open."), message("One more thing.", "commentary"), { type: "webSearch", query: "x" }] } });
    expect(w.replied).toEqual(["Two sessions are open."]);
  });

  test("a turn that ends with no items listed says the last message that completed in it", () => {
    w.notify("item/completed", { item: message("First answer.") });
    w.notify("item/completed", { item: message("Thinking aloud.", "commentary") });
    w.notify("item/completed", { item: message("The answer.", "final_answer") });
    // another thread's messages are not this turn's
    w.server.opts.onNotification("item/completed", { threadId: "thread-other", item: message("Not ours.") });
    w.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    expect(w.replied).toEqual(["The answer."]);
  });

  test("the next turn does not repeat the one before: what it said is its own, or nothing", async () => {
    w.notify("item/completed", { item: message("The first reply.") });
    w.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    await w.host.send("and now?", "prompt-2");
    w.notify("turn/completed", { turn: { id: "turn-2", status: "completed" } });
    expect(w.replied).toEqual(["The first reply.", ""]);
  });

  test("a prompt sent into a running turn is steered into it: the turn ends once, under its first id", async () => {
    await w.host.send("and the tasks?", "prompt-2");
    expect(w.server.of("turn/start")).toHaveLength(2);
    w.notify("turn/completed", { turn: { id: "turn-2", status: "completed", items: [message("Not the turn that runs.")] } });
    expect(w.replied).toEqual([]);
    w.notify("turn/completed", { turn: { id: "turn-1", status: "completed", items: [message("Both answered.")] } });
    expect(w.replied).toEqual(["Both answered."]);
    // and it ended: the same end again is no second reply
    w.notify("turn/completed", { turn: { id: "turn-1", status: "completed", items: [message("Both answered.")] } });
    expect(w.replied).toEqual(["Both answered."]);
  });

  test("a turn that was interrupted ends with no words, whatever it had said; one that failed says why in a line", async () => {
    w.notify("item/completed", { item: message("Half an ans") });
    w.notify("turn/completed", { turn: { id: "turn-1", status: "interrupted", items: [message("Half an ans")] } });
    expect(w.replied).toEqual([""]);
    await w.host.send("again", "prompt-2");
    w.notify("turn/completed", { turn: { id: "turn-2", status: "failed", error: { message: "the model is overloaded" }, items: [message("Half an ans")] } });
    await w.host.send("once more", "prompt-3");
    w.notify("turn/completed", { turn: { id: "turn-3", status: "failed", error: null } });
    expect(w.replied).toEqual(["", "I could not finish that: the model is overloaded.", "I could not finish that: the turn failed."]);
    // the turn after them is heard as any other
    await w.host.send("and now?", "prompt-4");
    w.notify("turn/completed", { turn: { id: "turn-4", status: "completed", items: [message("Done.")] } });
    expect(w.replied.at(-1)).toBe("Done.");
  });

  test("a prompt never cuts the turn that runs: the host asks the app-server to interrupt nothing", async () => {
    await w.host.send("and the tasks?", "prompt-2");
    await w.host.send("and the nodes?", "prompt-3");
    expect(w.server.calls.map((c) => c.method)).toEqual(["thread/start", "turn/start", "turn/start", "turn/start"]);
    expect("interrupt" in w.host).toBe(false);
  });
});

describe("what the app-server asks and tells", () => {
  let w: World;
  beforeEach(async () => {
    w = world();
    await w.host.start(undefined);
  });

  test("a tool call of its thread is run and answered with its text", async () => {
    const answer = w.request("item/tool/call", { threadId: "thread-1", turnId: "turn-1", callId: "c1", tool: "agents", arguments: { status: ["busy"] } });
    expect(answer).toBeInstanceOf(Promise);
    expect(await answer).toEqual({ success: true, contentItems: [{ type: "inputText", text: "2 sessions" }] });
    expect(w.called).toEqual([{ tool: "agents", input: { status: ["busy"] } }]);
    // no arguments are an empty input
    await w.request("item/tool/call", { threadId: "thread-1", tool: "tasks" });
    expect(w.called[1]).toEqual({ tool: "tasks", input: {} });
  });

  test("a picture goes beside the text as a data URL, and a tool that failed is no success", async () => {
    w.result = { content: "the desktop", image: { mime: "image/png", base64: "iVBORw0KGgo=" } };
    expect(await w.request("item/tool/call", { threadId: "thread-1", tool: "shot", arguments: {} })).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "the desktop" }, { type: "inputImage", imageUrl: "data:image/png;base64,iVBORw0KGgo=" }],
    });
    w.result = { content: "no such session", isError: true };
    expect(await w.request("item/tool/call", { threadId: "thread-1", tool: "agents", arguments: {} })).toEqual({ success: false, contentItems: [{ type: "inputText", text: "no such session" }] });
  });

  test("a tool call of another thread, and any other request, is declined: nothing is run", () => {
    expect(w.request("item/tool/call", { threadId: "thread-other", tool: "agents", arguments: {} })).toBeUndefined();
    expect(w.request("item/tool/call", { tool: "agents", arguments: {} })).toBeUndefined();
    expect(w.request("item/commandExecution/requestApproval", { threadId: "thread-1", command: "rm -rf ." })).toBeUndefined();
    expect(w.request("item/fileChange/requestApproval", { threadId: "thread-1" })).toBeUndefined();
    expect(w.request("item/tool/requestUserInput", { threadId: "thread-1" })).toBeUndefined();
    expect(w.called).toEqual([]);
  });

  test("its token use is the session's size, told as a change; it is folded at the configured size, or sooner under its model's window", () => {
    // before the app-server says anything: no size, and the most a Codex thread compacts at
    expect([w.host.used(), w.host.limit()]).toEqual([undefined, CODEX_COMPACT_MAX]);
    w.notify("thread/tokenUsage/updated", { tokenUsage: { total: { totalTokens: 90_000 }, last: { totalTokens: 41_000 }, modelContextWindow: 272_000 } });
    // the size is the last turn's, not the thread's running total; a window that holds more changes nothing
    expect([w.host.used(), w.host.limit()]).toEqual([41_000, CODEX_COMPACT_MAX]);
    expect(w.counts.changed).toBe(1);
    w.notify("thread/tokenUsage/updated", { tokenUsage: { last: { totalTokens: 43_500 }, modelContextWindow: 128_000 } });
    expect([w.host.used(), w.host.limit()]).toEqual([43_500, 128_000]);
    // a reading with no window keeps the one known
    w.notify("thread/tokenUsage/updated", { tokenUsage: { last: { totalTokens: 44_000 }, modelContextWindow: null } });
    expect([w.host.used(), w.host.limit()]).toEqual([44_000, 128_000]);
    // another thread's is not its own
    w.server.opts.onNotification("thread/tokenUsage/updated", { threadId: "thread-other", tokenUsage: { last: { totalTokens: 1 }, modelContextWindow: 2 } });
    expect([w.host.used(), w.host.limit()]).toEqual([44_000, 128_000]);
    expect(w.counts.changed).toBe(3);
    // a smaller size configured is the one it folds at, as its thread was started with
    const small = world({ config: { autocompact_tokens: 150_000 } });
    expect(small.host.limit()).toBe(150_000);
  });

  test("a compaction forgets what it was told; a search of the web is a step of the turn", () => {
    w.notify("item/completed", { item: { type: "contextCompaction" } });
    expect(w.counts.forgot).toBe(1);
    w.notify("item/completed", { item: { type: "webSearch", query: "bun test todo" } });
    expect(w.steps).toEqual([{ tool: "web_search", input: { query: "bun test todo" } }]);
    w.server.opts.onNotification("item/completed", { threadId: "thread-other", item: { type: "contextCompaction" } });
    expect(w.counts.forgot).toBe(1);
  });
});

describe("its end", () => {
  let w: World;
  beforeEach(async () => {
    w = world();
    await w.host.start(undefined);
  });

  test("the app-server going away is told once, and its server is stopped so it does not come back", () => {
    w.server.opts.onExit();
    expect(w.ended).toEqual(["its app-server went"]);
    expect(w.server.stops).toBe(1);
    w.server.opts.onExit();
    expect(w.ended).toHaveLength(1);
    expect(w.server.stops).toBe(1);
  });

  test("a stop cuts the turn that runs and ends the server, and its going is then no news", async () => {
    await w.host.send("hello", "prompt-1");
    await w.host.stop();
    expect(w.server.of("turn/interrupt")).toEqual([{ threadId: "thread-1", turnId: "turn-1" }]);
    expect(w.server.stops).toBe(1);
    // the interrupted turn's end, should it still be heard, is an empty reply like any other's
    w.notify("turn/completed", { turn: { id: "turn-1", status: "interrupted" } });
    expect(w.replied).toEqual([""]);
    w.server.opts.onExit();
    expect(w.ended).toEqual([]);
    // the conversation stays where the harness keeps it
    expect(w.host.native()).toBe("thread-1");
  });

  test("a stop with no turn running, or of a server that is down, asks it nothing", async () => {
    await w.host.stop();
    expect(w.server.of("turn/interrupt")).toEqual([]);
    expect(w.server.stops).toBe(1);
    const down = world();
    await down.host.start(undefined);
    await down.host.send("hello", "prompt-1");
    down.server.alive = false;
    await down.host.stop();
    expect(down.server.of("turn/interrupt")).toEqual([]);
    expect(down.server.stops).toBe(1);
  });

  test("letting go ends the server without cutting the turn: the thread is resumed by the next daemon", async () => {
    await w.host.send("hello", "prompt-1");
    await w.host.release();
    expect(w.server.of("turn/interrupt")).toEqual([]);
    expect(w.server.stops).toBe(1);
    w.server.opts.onExit();
    expect(w.ended).toEqual([]);
  });
});
