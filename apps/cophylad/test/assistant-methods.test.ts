// The chat's own session as the clients and the brain reach it. `assistant.state`,
// `assistant.configure` and `assistant.restart` answer from the assistant module, and say so
// when none runs here. `brain.context` asks the brain what the session would be told now
// (`assistant.context {kind: "preview"}`) and answers it with the size the session itself
// holds and compacts at; a preview that is not one is `unavailable`, and with `show_context`
// off the method is `unsupported`. The brain's `assistant.wake` is handed to the module, and
// answers that nothing took it while none runs. The platform names the feature in its hello.

import { describe, expect, test } from "bun:test";
import { BrainContext, RpcError } from "@cophyla/protocol";
import type { AssistantPreview, AssistantState, ClientParams, ConversationSpend } from "@cophyla/protocol";
import { assistantMethods, brainContextMethods } from "../src/api/methods.ts";
import type { BrainContextDeps, MethodContext } from "../src/api/methods.ts";
import { PLATFORM_FEATURES } from "../src/brain-link/link.ts";
import { brainMethods } from "../src/brain-link/methods.ts";
import type { BrainMethodContext, BrainMethodDeps } from "../src/brain-link/methods.ts";

const ctx = {} as MethodContext;
const THREAD = "thr_01ARZ3NDEKTSV4RRFFQ69G5FB3";
const PROFILE = "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8";

const rpcCode = async (fn: () => unknown): Promise<string> => {
  try {
    await fn();
    return "ok";
  } catch (e) {
    return e instanceof RpcError ? e.code : String(e);
  }
};

describe("assistant.state, assistant.configure, assistant.restart", () => {
  const idle: AssistantState = { status: "idle", harness: "claude", model: "sonnet", effort: "low", profile: PROFILE, context: { used: 41_000, limit: 300_000 } };

  function module() {
    const seen: { configured: ClientParams<"assistant.configure">[]; restarted: unknown[][] } = { configured: [], restarted: [] };
    const assistant = {
      state: () => idle,
      configure: async (patch: ClientParams<"assistant.configure">): Promise<AssistantState> => {
        seen.configured.push(patch);
        return { ...idle, harness: "codex", model: "gpt-6.1-sol" };
      },
      restart: async (...args: unknown[]): Promise<AssistantState> => {
        seen.restarted.push(args);
        return { ...idle, status: "starting" };
      },
    };
    return { seen, table: assistantMethods({ assistant: () => assistant }) };
  }

  test("the state is the module's; on a node that runs none it is off", async () => {
    expect(await module().table["assistant.state"]!.handler({}, ctx)).toEqual({ state: idle });
    expect(await assistantMethods({ assistant: () => undefined })["assistant.state"]!.handler({}, ctx)).toEqual({ state: { status: "off" } });
  });

  test("a choice of harness or account is handed to the module as it came, and answers where the session then stands", async () => {
    const { seen, table } = module();
    expect(await table["assistant.configure"]!.handler({ harness: "codex" }, ctx)).toEqual({ state: { ...idle, harness: "codex", model: "gpt-6.1-sol" } });
    await table["assistant.configure"]!.handler({ harness: null, profile: PROFILE }, ctx);
    expect(seen.configured).toEqual([{ harness: "codex" }, { harness: null, profile: PROFILE }]);
    // what a rule keyed on a target sees: the account, else the harness
    const target = table["assistant.configure"]!.target!;
    expect(target({ profile: PROFILE, harness: "codex" })).toBe(PROFILE);
    expect(target({ harness: "codex" })).toBe("codex");
    expect(target({ harness: null })).toBeUndefined();
    expect(target({})).toBeUndefined();
  });

  test("a restart starts it again where it was: the module is asked for nothing fresh", async () => {
    const { seen, table } = module();
    expect(await table["assistant.restart"]!.handler({}, ctx)).toEqual({ state: { ...idle, status: "starting" } });
    expect(seen.restarted).toEqual([[]]);
  });

  test("with no module here, configuring and restarting say the session runs on the primary", async () => {
    const table = assistantMethods({ assistant: () => undefined });
    expect(await rpcCode(() => table["assistant.configure"]!.handler({ harness: "codex" }, ctx))).toBe("unavailable");
    expect(await rpcCode(() => table["assistant.restart"]!.handler({}, ctx))).toBe("unavailable");
    await expect(table["assistant.restart"]!.handler({}, ctx)).rejects.toThrow("the chat's session runs on the primary");
  });
});

describe("brain.context", () => {
  const preview: AssistantPreview = { rules: "You are Cophyla.", situation: "Now: Tuesday\n2 sessions", notes: ["the build finished"], tools: ["agents", "tasks"], tokens: { rules: 1200, situation: 340, tools: 2100 } };

  function context(over: Partial<BrainContextDeps> & { answer?: unknown } = {}) {
    const asked: { method: string; params: unknown; timeoutMs: number }[] = [];
    const { answer, ...deps } = over;
    const table = brainContextMethods({
      show: true,
      brain: () => ({
        request: async (method: string, params?: unknown, timeoutMs?: number) => {
          asked.push({ method, params, timeoutMs: timeoutMs! });
          return "answer" in over ? answer : { text: "", preview };
        },
      }),
      now: () => 1_758_196_800_000,
      ...deps,
    });
    return { asked, method: table["brain.context"]! };
  }

  test("it is the brain's preview, asked for now and taking nothing, with the size the session itself holds", async () => {
    const spend: ConversationSpend = { thread: THREAD, models: [] };
    const { asked, method } = context({ thread: () => THREAD, assistant: () => ({ status: "idle", context: { used: 41_000, limit: 230_000 } }), spend: () => spend });
    const r = await method.handler({}, ctx);
    expect(asked).toEqual([{ method: "assistant.context", params: { kind: "preview" }, timeoutMs: 10_000 }]);
    expect(r).toEqual({
      context: { thread: THREAD, at: 1_758_196_800_000, tokens: { rules: 1200, situation: 340, tools: 2100, used: 41_000, window: 230_000 }, rules: preview.rules, situation: preview.situation, notes: preview.notes, tools: preview.tools },
      spend,
    });
    expect(BrainContext.safeParse(r.context).success).toBe(true);
  });

  test("a session that has said no size yet, or none at all, leaves the preview's own estimates alone", async () => {
    for (const assistant of [undefined, () => undefined, (): AssistantState => ({ status: "starting", harness: "claude" })]) {
      const { method } = context({ thread: () => THREAD, ...(assistant ? { assistant } : {}) });
      const r = await method.handler({}, ctx);
      expect(r.context!.tokens).toEqual(preview.tokens);
      // with nothing that counts a thread's spend, none is answered
      expect(Object.keys(r)).toEqual(["context"]);
    }
  });

  test("outside any thread the context comes alone: no thread, and no spend", async () => {
    const { method } = context({ thread: () => undefined, spend: () => ({ thread: THREAD, models: [] }) });
    const r = await method.handler({}, ctx);
    expect(Object.keys(r)).toEqual(["context"]);
    expect(Object.keys(r.context!)).not.toContain("thread");
  });

  test("an answer that is no preview is unavailable, and says what was wrong with it", async () => {
    for (const answer of [undefined, {}, { text: "Now: Tuesday" }, { preview: { ...preview, tokens: { rules: 1 } } }, { preview: { ...preview, notes: "one" } }, { preview: { thread: 7 } }]) {
      const { method } = context({ answer });
      expect(await rpcCode(() => method.handler({}, ctx))).toBe("unavailable");
    }
    await expect(context({ answer: { preview: { ...preview, rules: 7 } } }).method.handler({}, ctx)).rejects.toThrow(/^the brain answered the preview with something else: rules: /);
  });

  test("with no brain on this node it is unavailable; a brain that fails is its own error", async () => {
    expect(await rpcCode(() => context({ brain: () => undefined }).method.handler({}, ctx))).toBe("unavailable");
    const failing = context({
      brain: () => ({
        request: async () => {
          throw new RpcError("unsupported", "the brain knows no assistant.context");
        },
      }),
    });
    expect(await rpcCode(() => failing.method.handler({}, ctx))).toBe("unsupported");
  });

  test("with show_context off it is unsupported, a check included; on, a check asks the brain nothing", async () => {
    const off = context({ show: false });
    expect(await rpcCode(() => off.method.handler({}, ctx))).toBe("unsupported");
    expect(await rpcCode(() => off.method.handler({ check: true }, ctx))).toBe("unsupported");
    await expect(Promise.resolve().then(() => off.method.handler({ check: true }, ctx))).rejects.toThrow("show_context");
    expect(off.asked).toEqual([]);
    const on = context();
    expect(await on.method.handler({ check: true }, ctx)).toEqual({});
    expect(on.asked).toEqual([]);
  });

  test("the audit row keeps the thread and the sizes, never the rules or the situation", async () => {
    const { method } = context({ thread: () => THREAD });
    const r = await method.handler({}, ctx);
    const kept = method.redactResult!(r);
    expect(kept).toEqual({ context: { thread: THREAD, at: 1_758_196_800_000, tokens: preview.tokens } });
    expect(JSON.stringify(kept)).not.toContain("You are Cophyla.");
    expect(JSON.stringify(kept)).not.toContain("Tuesday");
    expect(method.redactResult!({})).toEqual({});
  });
});

describe("the brain's side", () => {
  const bctx = {} as BrainMethodContext;

  test("assistant.wake is handed to the module with its id and words, and answers what the module does", async () => {
    const woken: { id: string; text: string }[] = [];
    let queued = true;
    const table = brainMethods({
      assistant: () => ({
        wake: (p: { id: string; text: string }) => {
          woken.push(p);
          return { queued };
        },
      }),
    } as unknown as BrainMethodDeps);
    const wake = table["assistant.wake"]!;
    expect(await wake.handler({ id: "wake-1", text: "The build finished.", kind: "wake", about: "the build" }, bctx)).toEqual({ queued: true });
    queued = false;
    expect(await wake.handler({ id: "wake-2", text: "Say the tests passed.", kind: "notify" }, bctx)).toEqual({ queued: false });
    // the kind and what it is about are the brain's own to keep: the session is typed the words alone
    expect(woken).toEqual([
      { id: "wake-1", text: "The build finished." },
      { id: "wake-2", text: "Say the tests passed." },
    ]);
    expect(wake.target!({ id: "wake-1", text: "x", kind: "result" })).toBe("result");
  });

  test("with no module on this node, or none running, nothing took the wake", async () => {
    for (const deps of [{}, { assistant: () => undefined }]) {
      const wake = brainMethods(deps as unknown as BrainMethodDeps)["assistant.wake"]!;
      expect(await wake.handler({ id: "wake-1", text: "The build finished.", kind: "wake" }, bctx)).toEqual({ queued: false });
    }
  });

  test("the platform names the feature in its hello, so a brain may rely on it", () => {
    expect(PLATFORM_FEATURES as readonly string[]).toContain("assistant");
  });
});
