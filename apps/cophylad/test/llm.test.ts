// The llm router and the Gemini provider against the fake API: tier and vendor/model
// resolution, the request mapping (system, contents, tool_result names, signatures, tools,
// generation config), deltas, coalesced text, usage, error codes and cancel.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LlmComplete, LlmDelta } from "@cophyla/protocol";
import { parseConfig } from "../src/config/load.ts";
import { cleanSchema, GeminiProvider, toContents, toTools } from "../src/llm/gemini.ts";
import { RpcError } from "@cophyla/protocol";
import { Llm } from "../src/llm/index.ts";
import type { Provider } from "../src/llm/index.ts";
import { silentLogger } from "../src/log.ts";
import { call, finish, startGeminiFake, text, thought } from "./fakes/gemini.ts";
import type { GeminiFake } from "./fakes/gemini.ts";
import { sleep } from "./helpers.ts";

let fake: GeminiFake;
let llm: Llm;

beforeAll(() => {
  fake = startGeminiFake({
    apiKey: "k-test",
    scripts: {
      default: [text("Hello"), text(", world."), finish("STOP", { promptTokenCount: 12, candidatesTokenCount: 4, thoughtsTokenCount: 2, cachedContentTokenCount: 3 })],
      "use the tool": [thought("thinking…"), text("Reading.", { thoughtSignature: "sig-text" }), call("files", { action: "Read", path: "a.md" }, { thoughtSignature: "sig-call" }), finish("STOP")],
      __function_response__: [text("Line one says hello."), finish("STOP")],
      long: [text("a"), text("b"), finish("MAX_TOKENS")],
    },
  });
  const config = parseConfig(`[providers]\nllm = "byok:gemini"\ntimeout_ms = 5000\n[providers.gemini]\napi_key = "k-test"\nbase_url = "${fake.url}"\n[providers.tiers.fast]\nmodel = "gemini/fast-model"\nthinking = "low"\n[providers.tiers.smart]\nmodel = "gemini/smart-model"\n`).providers;
  llm = new Llm({ config, log: silentLogger, env: {} });
});

afterAll(async () => {
  await fake.stop();
});

const ask = (textIn: string, extra: Partial<LlmComplete> = {}): LlmComplete => ({
  model: { tier: "fast" },
  messages: [{ role: "user", content: [{ type: "text", text: textIn }] }],
  ...extra,
});

describe("llm", () => {
  test("a tier resolves through config; a vendor/model is used as is; other routes are unavailable", () => {
    expect(llm.resolve({ tier: "fast" })).toEqual({ vendor: "gemini", model: "fast-model", thinking: "low" });
    expect(llm.resolve({ tier: "smart" })).toEqual({ vendor: "gemini", model: "smart-model" });
    expect(new Llm({ config: parseConfig("").providers, log: silentLogger, env: {} }).resolve({ tier: "smart" })).toEqual({ vendor: "gemini", model: "gemini-3.1-pro-preview", thinking: "medium" });
    expect(new Llm({ config: parseConfig("").providers, log: silentLogger, env: {} }).resolve({ tier: "tiny" })).toEqual({ vendor: "gemini", model: "gemini-3.1-flash-lite", thinking: "minimal" });
    expect(llm.resolve({ model: "gemini/x-1" })).toEqual({ vendor: "gemini", model: "x-1" });
    expect(() => llm.resolve({ tier: "local" })).toThrow(/local tier/);
    const local = new Llm({ config: parseConfig('[providers]\nllm = "local:llama"\n').providers, log: silentLogger, env: {} });
    expect(local.complete(ask("hi"))).rejects.toMatchObject({ code: "unavailable" });
    const other = new Llm({ config: parseConfig('[providers]\nllm = "byok:gemini"\n').providers, log: silentLogger, env: {} });
    expect(other.complete(ask("hi", { model: { model: "openai/gpt" } }))).rejects.toMatchObject({ code: "unavailable" });
  });

  test("streams text deltas and returns the coalesced completion with usage and the model", async () => {
    const deltas: LlmDelta[] = [];
    const r = await llm.complete(ask("hi", { system: "Be brief.", maxTokens: 100, temperature: 0.3 }), { onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: ", world." },
    ]);
    expect(r.content).toEqual([{ type: "text", text: "Hello, world." }]);
    expect(r.stopReason).toBe("end");
    expect(r.usage).toEqual({ in: 12, out: 6, cacheRead: 3 });
    expect(r.model).toBe("gemini-fake-001");
    const req = fake.requests[fake.requests.length - 1]!;
    expect(req.model).toBe("fast-model");
    expect(req.key).toBe("k-test");
    expect(req.body["systemInstruction"]).toEqual({ parts: [{ text: "Be brief." }] });
    expect(req.body["generationConfig"]).toEqual({ maxOutputTokens: 100, temperature: 0.3, thinkingConfig: { thinkingLevel: "LOW" } });
    expect(req.body["contents"]).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
    expect(req.body["tools"]).toBeUndefined();
  });

  test("a request's own thinking level beats its tier's, and a tier with none thinks by default", async () => {
    await llm.complete(ask("hi", { thinking: "medium" }));
    expect(fake.requests[fake.requests.length - 1]!.body["generationConfig"]).toEqual({ thinkingConfig: { thinkingLevel: "MEDIUM" } });
    await llm.complete(ask("hi", { model: { tier: "smart" }, thinking: "high" }));
    expect(fake.requests[fake.requests.length - 1]!.body["generationConfig"]).toEqual({ thinkingConfig: { thinkingLevel: "HIGH" } });
    await llm.complete(ask("hi", { model: { tier: "smart" } }));
    expect(fake.requests[fake.requests.length - 1]!.body["generationConfig"]).toBeUndefined();
  });

  test("tool calls come back as tool_use with signatures, thoughts are dropped, and the round trip recovers the function name", async () => {
    const tools = [{ name: "files", description: "Files", schema: { $schema: "x", type: "object", additionalProperties: false, properties: { action: { type: "string" } } } }];
    const deltas: LlmDelta[] = [];
    const r = await llm.complete(ask("please use the tool", { tools }), { onDelta: (d) => deltas.push(d) });
    expect(r.stopReason).toBe("tool_use");
    expect(r.content).toEqual([
      { type: "text", text: "Reading.", signature: "sig-text" },
      { type: "tool_use", id: "call_1", name: "files", input: { action: "Read", path: "a.md" }, signature: "sig-call" },
    ]);
    expect(deltas[1]).toEqual({ type: "tool_use", id: "call_1", name: "files", inputJson: '{"action":"Read","path":"a.md"}' });
    const sent = fake.requests[fake.requests.length - 1]!.body;
    expect(sent["tools"]).toEqual([{ functionDeclarations: [{ name: "files", description: "Files", parameters: { type: "object", properties: { action: { type: "string" } } } }] }]);

    // The brain appends the assistant content verbatim and the tool result; the name is recovered from the call.
    const follow: LlmComplete = {
      model: { tier: "fast" },
      messages: [
        { role: "user", content: [{ type: "text", text: "please use the tool" }] },
        { role: "assistant", content: r.content },
        { role: "user", content: [{ type: "tool_result", toolUseId: "call_1", content: "1\thello" }] },
      ],
      tools,
    };
    const r2 = await llm.complete(follow);
    expect(r2.content).toEqual([{ type: "text", text: "Line one says hello." }]);
    const body = fake.requests[fake.requests.length - 1]!.body;
    expect(body["contents"]).toEqual([
      { role: "user", parts: [{ text: "please use the tool" }] },
      { role: "model", parts: [{ text: "Reading.", thoughtSignature: "sig-text" }, { functionCall: { id: "call_1", name: "files", args: { action: "Read", path: "a.md" } }, thoughtSignature: "sig-call" }] },
      { role: "user", parts: [{ functionResponse: { id: "call_1", name: "files", response: { result: "1\thello" } } }] },
    ]);
  });

  test("mapping helpers: images, errors, an unknown tool id", () => {
    const contents = toContents([
      { role: "user", content: [{ type: "image", mime: "image/png", base64: "AAAA" }, { type: "text", text: "what" }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "zzz", content: "boom", isError: true }] },
      { role: "assistant", content: [] },
    ]);
    expect(contents).toEqual([
      { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }, { text: "what" }] },
      { role: "user", parts: [{ functionResponse: { id: "zzz", name: "tool", response: { error: "boom" } } }] },
    ]);
    expect(toTools(undefined)).toBeUndefined();
    expect(toTools([])).toBeUndefined();
    expect(cleanSchema({ $schema: "s", type: "object", properties: { a: { type: "array", items: { type: "string", additionalProperties: false } } } })).toEqual({ type: "object", properties: { a: { type: "array", items: { type: "string" } } } });
    // what zod emits for `.positive()`, `.record()` and `.lt()`, which the service rejects as unknown names
    expect(cleanSchema({ type: "integer", exclusiveMinimum: 0 })).toEqual({ type: "integer", minimum: 1 });
    expect(cleanSchema({ type: "number", exclusiveMinimum: 0, exclusiveMaximum: 10 })).toEqual({ type: "number", minimum: 0, maximum: 10 });
    expect(cleanSchema({ type: "integer", minimum: 5, exclusiveMinimum: 0 })).toEqual({ type: "integer", minimum: 5 });
    expect(cleanSchema({ type: "object", properties: { action: { type: "string", const: "Search" } } })).toEqual({ type: "object", properties: { action: { type: "string", enum: ["Search"] } } });
    expect(cleanSchema({ type: "object", propertyNames: { type: "string" }, additionalProperties: {} })).toEqual({ type: "object" });
  });

  test("max_tokens, provider errors by status, a bad key, no key, and cancel", async () => {
    const long = await llm.complete(ask("long"));
    expect(long.stopReason).toBe("max_tokens");
    expect(long.content).toEqual([{ type: "text", text: "ab" }]);

    fake.setFail({ status: 429, body: JSON.stringify({ error: { code: 429, message: "quota" } }) });
    await expect(llm.complete(ask("hi"))).rejects.toMatchObject({ code: "unavailable", message: "quota" });
    fake.setFail({ status: 400, body: "bad" });
    await expect(llm.complete(ask("hi"))).rejects.toMatchObject({ code: "invalid" });
    fake.setFail({ status: 404, body: "{}" });
    await expect(llm.complete(ask("hi"))).rejects.toMatchObject({ code: "not_found" });
    fake.setFail({ status: 500, body: "{}" });
    await expect(llm.complete(ask("hi"))).rejects.toMatchObject({ code: "unavailable", error: { retryable: true } });
    fake.setFail(undefined);

    const wrongKey = new GeminiProvider({ apiKey: () => "nope", baseUrl: fake.url, timeoutMs: 5000, log: silentLogger });
    await expect(wrongKey.complete({ model: "m", params: ask("hi") })).rejects.toMatchObject({ code: "denied" });
    const noKey = new GeminiProvider({ apiKey: () => undefined, baseUrl: fake.url, timeoutMs: 5000, log: silentLogger });
    await expect(noKey.complete({ model: "m", params: ask("hi") })).rejects.toMatchObject({ code: "unavailable" });
    const down = new GeminiProvider({ apiKey: () => "k", baseUrl: "http://127.0.0.1:1", timeoutMs: 5000, log: silentLogger });
    await expect(down.complete({ model: "m", params: ask("hi") })).rejects.toMatchObject({ code: "unavailable" });

    // Cancel mid-stream: the fake pauses between chunks, the abort ends the request as cancelled.
    const slow = startGeminiFake({ delayMs: 200, scripts: { default: [text("a"), text("b"), text("c"), finish("STOP")] } });
    try {
      const provider = new GeminiProvider({ apiKey: () => "k", baseUrl: slow.url, timeoutMs: 5000, log: silentLogger });
      const ac = new AbortController();
      const deltas: LlmDelta[] = [];
      const p = provider.complete({ model: "m", params: ask("hi"), signal: ac.signal, onDelta: (d) => deltas.push(d) });
      await sleep(300);
      ac.abort();
      await expect(p).rejects.toMatchObject({ code: "cancelled" });
      expect(deltas.length).toBeLessThan(3);
      const quick = new GeminiProvider({ apiKey: () => "k", baseUrl: slow.url, timeoutMs: 100, log: silentLogger });
      await expect(quick.complete({ model: "m", params: ask("hi") })).rejects.toMatchObject({ code: "timeout" });
    } finally {
      await slow.stop();
    }
  });
  test("the route walk: a refusal that cannot serve passes the call on, any other answers at once, and the last refusal names every route", async () => {
    const calls: string[] = [];
    const stub = (vendor: string, answer: () => Promise<{ text: string }>): Provider => ({
      vendor,
      complete: async (req) => {
        calls.push(`${vendor}:${req.model}`);
        const a = await answer();
        req.onDelta?.({ type: "text", text: a.text });
        return { content: [{ type: "text", text: a.text }], stopReason: "end", usage: { in: 1, out: 1 }, model: `${vendor}-model` };
      },
    });
    const refuse = (code: "unavailable" | "quota_exceeded" | "denied" | "invalid", data?: unknown) => () => Promise.reject(new RpcError(code, `${code} from the stub`, data));
    const config = parseConfig('[providers]\nllm = ["server", "byok:gemini"]\n[providers.tiers.fast]\nmodel = "gemini/fast-model"\n').providers;
    // the server serves: byok is never asked, and the request goes as is (the tier, not a model)
    let walk = new Llm({ config, log: silentLogger, env: {}, providers: [stub("server", async () => ({ text: "hosted" })), stub("gemini", async () => ({ text: "own key" }))] });
    let r = await walk.complete(ask("hi"));
    expect(r.route).toBe("server");
    expect(r.content[0]).toEqual({ type: "text", text: "hosted" });
    expect(calls).toEqual(["server:fast"]);
    // quota_exceeded passes on; the byok answer is the result
    calls.length = 0;
    walk = new Llm({ config, log: silentLogger, env: {}, providers: [stub("server", refuse("quota_exceeded", { metric: "llm_tokens_in", resetsAt: 1 })), stub("gemini", async () => ({ text: "own key" }))] });
    r = await walk.complete(ask("hi"));
    expect(r.route).toBe("byok:gemini");
    expect(calls).toEqual(["server:fast", "gemini:fast-model"]);
    // both refuse: the quota refusal wins over a later unavailable, with every route's reason and its own data kept whole
    walk = new Llm({ config, log: silentLogger, env: {}, providers: [stub("server", refuse("quota_exceeded", { metric: "llm_tokens_in", resetsAt: 1 })), stub("gemini", refuse("unavailable", { provider: "gemini", status: 503 }))] });
    let err: RpcError | undefined;
    try {
      await walk.complete(ask("hi"));
    } catch (e) {
      err = e as RpcError;
    }
    expect(err?.code).toBe("quota_exceeded");
    expect(err?.error.data).toEqual({ metric: "llm_tokens_in", resetsAt: 1, routes: [{ route: "server", code: "quota_exceeded", message: "quota_exceeded from the stub" }, { route: "byok:gemini", code: "unavailable", message: "unavailable from the stub" }] });
    // both unavailable: the last one
    walk = new Llm({ config, log: silentLogger, env: {}, providers: [stub("server", refuse("unavailable", { provider: "server" })), stub("gemini", refuse("unavailable", { provider: "gemini", status: 503 }))] });
    try {
      await walk.complete(ask("hi"));
    } catch (e) {
      err = e as RpcError;
    }
    expect(err?.code).toBe("unavailable");
    expect(err?.error.data).toMatchObject({ provider: "gemini", status: 503 });
    // one route alone keeps its own data: the brain reads metric and resetsAt from it
    const alone = new Llm({ config: parseConfig('[providers]\nllm = ["server"]\n').providers, log: silentLogger, env: {}, providers: [stub("server", refuse("quota_exceeded", { metric: "llm_tokens_out", resetsAt: 7 }))] });
    try {
      await alone.complete(ask("hi"));
    } catch (e) {
      err = e as RpcError;
    }
    expect(err?.code).toBe("quota_exceeded");
    expect(err?.error.data).toMatchObject({ metric: "llm_tokens_out", resetsAt: 7 });
    // any other code is the answer at once: byok is never asked
    calls.length = 0;
    walk = new Llm({ config, log: silentLogger, env: {}, providers: [stub("server", refuse("denied")), stub("gemini", async () => ({ text: "own key" }))] });
    await expect(walk.complete(ask("hi"))).rejects.toMatchObject({ code: "denied" });
    expect(calls).toEqual(["server:fast"]);
    // no server provider on the node: the server route is unavailable and passes on
    walk = new Llm({ config, log: silentLogger, env: {}, providers: [stub("gemini", async () => ({ text: "own key" }))] });
    expect((await walk.complete(ask("hi"))).route).toBe("byok:gemini");
  });

  test("onRetry fires when a later route takes over after an earlier one streamed, and not otherwise", async () => {
    const config = parseConfig('[providers]\nllm = ["server", "byok:gemini"]\n[providers.tiers.fast]\nmodel = "gemini/fast-model"\n').providers;
    const events: string[] = [];
    const streamsThenFails: Provider = {
      vendor: "server",
      complete: async (req) => {
        req.onDelta?.({ type: "text", text: "half" });
        throw new RpcError("unavailable", "the link dropped");
      },
    };
    const refusesAtOnce: Provider = { vendor: "server", complete: () => Promise.reject(new RpcError("unavailable", "signed out")) };
    const serves: Provider = {
      vendor: "gemini",
      complete: async (req) => {
        req.onDelta?.({ type: "text", text: "whole" });
        return { content: [{ type: "text", text: "whole" }], stopReason: "end", usage: { in: 1, out: 1 }, model: "g" };
      },
    };
    const opts = { onDelta: (d: LlmDelta) => events.push(d.type === "text" ? d.text : d.type), onRetry: () => events.push("retry") };
    let walk = new Llm({ config, log: silentLogger, env: {}, providers: [streamsThenFails, serves] });
    expect((await walk.complete(ask("hi"), opts)).route).toBe("byok:gemini");
    expect(events).toEqual(["half", "retry", "whole"]);
    // a route that refused before streaming anything voids nothing
    events.length = 0;
    walk = new Llm({ config, log: silentLogger, env: {}, providers: [refusesAtOnce, serves] });
    await walk.complete(ask("hi"), opts);
    expect(events).toEqual(["whole"]);
  });
});
