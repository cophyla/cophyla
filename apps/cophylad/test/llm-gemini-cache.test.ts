// A turn's explicit cache on Gemini, against a scripted fetch: an eager turn makes it before
// its first step and sends every step's tail against it; a turn the user waits on sends its
// first step whole, makes the cache beside it and uses it from the step that finds it made;
// the turn's answer deletes it, the made tokens billed once; a moved prefix, a step with no
// tools, a small prefix, a refused making and a refused use all leave the steps whole.

import { describe, expect, test } from "bun:test";
import type { LlmComplete, LlmMessage } from "@cophyla/protocol";
import { GeminiProvider } from "../src/llm/gemini.ts";
import { silentLogger } from "../src/log.ts";

interface Seen {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/** A fetch that answers Gemini's three calls: a cache made, a cache deleted, a streamed step. */
function fakeGemini(opts: { answers: ("tool" | "text")[]; createFails?: boolean; createDelayMs?: number; cachedFails?: boolean; tokens?: number }) {
  const seen: Seen[] = [];
  let made = 0;
  const answers = [...opts.answers];
  const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    seen.push({ method: init?.method ?? "GET", path: url.pathname, ...(body ? { body } : {}) });
    if (url.pathname.endsWith("/cachedContents") && init?.method === "POST") {
      if (opts.createDelayMs) await new Promise((r) => setTimeout(r, opts.createDelayMs));
      if (opts.createFails) return new Response(JSON.stringify({ error: { message: "too small" } }), { status: 400 });
      made++;
      return new Response(JSON.stringify({ name: `cachedContents/c${made}`, usageMetadata: { totalTokenCount: opts.tokens ?? 9000 } }), { status: 200 });
    }
    if (init?.method === "DELETE") return new Response("{}", { status: 200 });
    if (body?.["cachedContent"] && opts.cachedFails) return new Response(JSON.stringify({ error: { message: "CachedContent not found" } }), { status: 404 });
    const kind = answers.shift() ?? "text";
    const part = kind === "tool" ? { functionCall: { id: "call_1", name: "agents", args: { action: "List" } } } : { text: "Done." };
    const cached = body?.["cachedContent"] ? { cachedContentTokenCount: opts.tokens ?? 9000 } : {};
    return sse([{ candidates: [{ content: { parts: [part] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12000, candidatesTokenCount: 5, ...cached }, modelVersion: "fast-model" }]);
  }) as typeof fetch;
  return { fetch: fetchFn, seen, generates: () => seen.filter((s) => s.path.includes(":streamGenerateContent")), creates: () => seen.filter((s) => s.path.endsWith("/cachedContents")), deletes: () => seen.filter((s) => s.method === "DELETE") };
}

const history: LlmMessage[] = [
  { role: "user", content: [{ type: "text", text: `[log of this conversation]\n${"An earlier line of the log.\n".repeat(900)}` }] },
  { role: "assistant", content: [{ type: "text", text: "Noted." }] },
];
const seed: LlmMessage = { role: "user", content: [{ type: "text", text: "what are my agents doing?" }] };
const tools = [{ name: "agents", description: "the agents", schema: { type: "object" } }];
const step = (messages: LlmMessage[], cache?: LlmComplete["cache"], extra: Partial<LlmComplete> = {}): LlmComplete => ({ model: { tier: "fast" }, system: "You are Cophyla.\nThe situation now:\nNow: Friday", messages, tools, maxTokens: 2048, ...(cache ? { cache } : {}), ...extra });
const afterTool = (n: number): LlmMessage[] => {
  const out: LlmMessage[] = [...history, seed];
  for (let i = 0; i < n; i++) {
    out.push({ role: "assistant", content: [{ type: "tool_use", id: `call_${i}`, name: "agents", input: { action: "List" } }] });
    out.push({ role: "user", content: [{ type: "tool_result", toolUseId: `call_${i}`, content: `${i} sessions` }] });
  }
  return out;
};
const provider = (f: ReturnType<typeof fakeGemini>) => new GeminiProvider({ apiKey: () => "k", baseUrl: "http://gemini.test", timeoutMs: 5000, log: silentLogger, fetch: f.fetch });
const req = (params: LlmComplete) => ({ model: "fast-model", thinking: "low" as const, params });
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("a turn's Gemini cache", () => {
  test("an eager turn makes the cache before its first step: every step sends its tail against it, the made tokens billed once, the answer deletes it", async () => {
    const f = fakeGemini({ answers: ["tool", "tool", "text"] });
    const p = provider(f);
    const one = await p.complete(req(step([...history, seed], { key: "t1", eager: true })));
    expect(f.creates()).toHaveLength(1);
    const made = f.creates()[0]!.body!;
    expect(made["model"]).toBe("models/fast-model");
    expect(made["ttl"]).toBe("300s");
    expect(made["systemInstruction"]).toEqual({ parts: [{ text: "You are Cophyla.\nThe situation now:\nNow: Friday" }] });
    expect((made["contents"] as unknown[]).length).toBe(2);
    const first = f.generates()[0]!.body!;
    expect(first["cachedContent"]).toBe("cachedContents/c1");
    expect(first["systemInstruction"]).toBeUndefined();
    expect(first["tools"]).toBeUndefined();
    expect(first["contents"]).toEqual([{ role: "user", parts: [{ text: "what are my agents doing?" }] }]);
    expect(first["generationConfig"]).toEqual({ maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: "LOW" } });
    expect(one.usage).toEqual({ in: 12000, out: 5, cacheRead: 9000, cacheWrite: 9000 });
    const two = await p.complete(req(step(afterTool(1), { key: "t1", eager: true })));
    expect(f.creates()).toHaveLength(1);
    expect((f.generates()[1]!.body!["contents"] as unknown[]).length).toBe(3);
    expect(two.usage.cacheWrite).toBeUndefined();
    const three = await p.complete(req(step(afterTool(2), { key: "t1", eager: true })));
    expect(three.stopReason).toBe("end");
    await settle();
    expect(f.deletes().map((d) => d.path)).toEqual(["/v1beta/cachedContents/c1"]);
  });

  test("a turn the user waits on sends its first step whole, makes the cache beside it, and uses it from the first later step that finds it made", async () => {
    const f = fakeGemini({ answers: ["tool", "tool", "tool", "text"], createDelayMs: 60 });
    const p = provider(f);
    await p.complete(req(step([...history, seed], { key: "t2" })));
    expect(f.generates()[0]!.body!["systemInstruction"]).toBeDefined();
    expect(f.creates()).toHaveLength(1);
    // Still being made: the next step goes whole rather than wait.
    await p.complete(req(step(afterTool(1), { key: "t2" })));
    expect(f.generates()[1]!.body!["cachedContent"]).toBeUndefined();
    await new Promise((r) => setTimeout(r, 80));
    const three = await p.complete(req(step(afterTool(2), { key: "t2" })));
    expect(f.generates()[2]!.body!["cachedContent"]).toBe("cachedContents/c1");
    // The cache holds what came before the first step's seed: the seed and everything since is the tail.
    expect((f.generates()[2]!.body!["contents"] as unknown[]).length).toBe(5);
    expect(three.usage.cacheWrite).toBe(9000);
    expect(f.creates()).toHaveLength(1);
    await p.complete(req(step(afterTool(3), { key: "t2" })));
    await settle();
    expect(f.deletes()).toHaveLength(1);
  });

  test("a one-step turn the user waits on: the cache made beside it is billed on its answer and deleted, or deleted once made when the answer came first", async () => {
    const quick = fakeGemini({ answers: ["text"] });
    const made = await provider(quick).complete(req(step([...history, seed], { key: "t3" })));
    await settle();
    expect(quick.creates()).toHaveLength(1);
    expect(made.usage.cacheWrite).toBe(9000);
    expect(quick.deletes().map((d) => d.path)).toEqual(["/v1beta/cachedContents/c1"]);

    const slow = fakeGemini({ answers: ["text"], createDelayMs: 60 });
    const first = await provider(slow).complete(req(step([...history, seed], { key: "t3" })));
    expect(first.usage.cacheWrite).toBeUndefined();
    await new Promise((r) => setTimeout(r, 100));
    expect(slow.deletes().map((d) => d.path)).toEqual(["/v1beta/cachedContents/c1"]);
  });

  test("a moved prefix or a step with no tools drops the cache and goes whole; the next turn's key drops the last one's", async () => {
    const f = fakeGemini({ answers: ["tool", "tool", "text", "tool"] });
    const p = provider(f);
    await p.complete(req(step([...history, seed], { key: "t4", eager: true })));
    // The window cut the log: the cached part moved, so the cache goes and a new one is made for the step.
    const cut: LlmMessage[] = [{ role: "user", content: [{ type: "text", text: `[log of this conversation]\n${"A shorter log.\n".repeat(900)}` }] }, ...afterTool(1).slice(1)];
    await p.complete(req(step(cut, { key: "t4", eager: true })));
    expect(f.deletes().map((d) => d.path)).toEqual(["/v1beta/cachedContents/c1"]);
    expect(f.creates()).toHaveLength(2);
    expect(f.generates()[1]!.body!["cachedContent"]).toBe("cachedContents/c2");
    // The last step answers with no tools: whole, and the turn's answer ends the cache.
    const { tools: _t, ...noTools } = step([...cut, { role: "assistant", content: [{ type: "tool_use", id: "x", name: "agents", input: {} }] }, { role: "user", content: [{ type: "tool_result", toolUseId: "x", content: "ok" }] }], { key: "t4", eager: true });
    await p.complete(req(noTools));
    expect(f.generates()[2]!.body!["cachedContent"]).toBeUndefined();
    await settle();
    expect(f.deletes()).toHaveLength(2);
    // A turn whose cache outlived it is dropped by the next turn's first step.
    await p.complete(req(step([...history, seed], { key: "t5", eager: true })));
    await p.complete(req(step([...history, seed], { key: "t6" })));
    await settle();
    expect(f.deletes().map((d) => d.path)).toContain("/v1beta/cachedContents/c3");
  });

  test("a small prefix, a refused making and a refused use leave the steps whole; a request with no turn is untouched", async () => {
    const small = fakeGemini({ answers: ["tool", "text"] });
    const sp = provider(small);
    await sp.complete(req(step([seed], { key: "s", eager: true })));
    await sp.complete(req(step([seed, { role: "assistant", content: [{ type: "tool_use", id: "a", name: "agents", input: {} }] }, { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: "ok" }] }], { key: "s", eager: true })));
    expect(small.creates()).toHaveLength(0);

    const refused = fakeGemini({ answers: ["tool", "text"], createFails: true });
    const rp = provider(refused);
    await rp.complete(req(step([...history, seed], { key: "r", eager: true })));
    await rp.complete(req(step(afterTool(1), { key: "r", eager: true })));
    // Tried once for the turn, then whole.
    expect(refused.creates()).toHaveLength(1);
    expect(refused.generates().every((g) => g.body!["systemInstruction"] !== undefined)).toBe(true);

    const gone = fakeGemini({ answers: ["tool", "text"], cachedFails: true });
    const gp = provider(gone);
    const r = await gp.complete(req(step([...history, seed], { key: "g", eager: true })));
    expect(r.stopReason).toBe("tool_use");
    expect(gone.generates().map((g) => g.body!["cachedContent"] !== undefined)).toEqual([true, false]);

    const plain = fakeGemini({ answers: ["tool"] });
    await provider(plain).complete(req(step([...history, seed])));
    expect(plain.creates()).toHaveLength(0);
    expect(plain.generates()[0]!.body!["systemInstruction"]).toBeDefined();
  });
});
