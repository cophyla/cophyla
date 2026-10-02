// The Gemini provider: `POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse` with
// the user's key in `x-goog-api-key`. The protocol's messages map onto `contents`: text and
// images as parts, a `tool_use` as a `functionCall`, a `tool_result` as a `functionResponse`
// whose `name` is recovered from the matching call; the model's `thoughtSignature` rides on
// the block as `signature` and goes back unchanged. Deltas stream to the brain as text and
// whole tool calls; the return value is the coalesced completion. A request that names its
// turn (`cache`) goes through the turn's explicit cache (gemini-cache.ts): the system prompt,
// tools and earlier contents cached once, each step sending only what follows them.

import { RpcError } from "@cophyla/protocol";
import type { LlmContent, LlmResult, LlmTool } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import { TurnCaches } from "./gemini-cache.ts";
import type { CacheParts } from "./gemini-cache.ts";
import type { Provider, ProviderRequest } from "./index.ts";

export interface GeminiOptions {
  apiKey: () => string | undefined;
  baseUrl: string;
  timeoutMs: number;
  log: Logger;
  fetch?: typeof fetch;
}

interface Part {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args?: unknown };
  functionResponse?: { id?: string; name: string; response: unknown };
}

interface Content {
  role: "user" | "model";
  parts: Part[];
}

const STRIP_SCHEMA_KEYS = new Set(["$schema", "additionalProperties", "propertyNames", "$id", "$comment"]);

/**
 * A JSON Schema the way Gemini accepts it: no `$schema`, `additionalProperties` or
 * `propertyNames`, the exclusive bounds zod emits for `.positive()` folded into the
 * inclusive `minimum`/`maximum` the service knows (exact for integers, the bound itself for
 * numbers), and the `const` a `z.literal` emits as a one-value `enum`.
 */
export function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (schema !== null && typeof schema === "object") {
    const src = schema as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const integer = src["type"] === "integer";
    for (const [k, v] of Object.entries(src)) {
      if (STRIP_SCHEMA_KEYS.has(k)) continue;
      if (k === "exclusiveMinimum" && typeof v === "number") {
        if (!("minimum" in src)) out["minimum"] = integer ? v + 1 : v;
        continue;
      }
      if (k === "exclusiveMaximum" && typeof v === "number") {
        if (!("maximum" in src)) out["maximum"] = integer ? v - 1 : v;
        continue;
      }
      if (k === "const") {
        if (!("enum" in src)) out["enum"] = [v];
        continue;
      }
      out[k] = cleanSchema(v);
    }
    return out;
  }
  return schema;
}

/** The protocol's messages as Gemini contents. A `tool_result` names the call it answers by id. */
export function toContents(messages: ProviderRequest["params"]["messages"]): Content[] {
  const names = new Map<string, string>();
  const out: Content[] = [];
  for (const m of messages) {
    const parts: Part[] = [];
    for (const b of m.content) {
      switch (b.type) {
        case "text": {
          const part: Part = { text: b.text };
          if (b.signature) part.thoughtSignature = b.signature;
          parts.push(part);
          break;
        }
        case "image":
          parts.push({ inlineData: { mimeType: b.mime, data: b.base64 } });
          break;
        case "tool_use": {
          names.set(b.id, b.name);
          const part: Part = { functionCall: { id: b.id, name: b.name, args: b.input ?? {} } };
          if (b.signature) part.thoughtSignature = b.signature;
          parts.push(part);
          break;
        }
        case "tool_result": {
          const name = names.get(b.toolUseId) ?? "tool";
          const response = b.isError ? { error: b.content } : { result: b.content };
          parts.push({ functionResponse: { id: b.toolUseId, name, response } });
          break;
        }
      }
    }
    if (parts.length === 0) continue;
    out.push({ role: m.role === "assistant" ? "model" : "user", parts });
  }
  return out;
}

export function toTools(tools: LlmTool[] | undefined): { functionDeclarations: unknown[] }[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: cleanSchema(t.schema) })) }];
}

function mapFinish(reason: string | undefined, sawToolUse: boolean): LlmResult["stopReason"] {
  if (sawToolUse) return "tool_use";
  switch (reason) {
    case "MAX_TOKENS":
      return "max_tokens";
    default:
      return "end";
  }
}

function errorFor(status: number, body: string): RpcError {
  let message = body.slice(0, 500);
  try {
    const j = JSON.parse(body) as { error?: { message?: string } };
    if (j.error?.message) message = j.error.message;
  } catch {
    // not JSON
  }
  if (status === 400) return new RpcError("invalid", message);
  if (status === 401 || status === 403) return new RpcError("denied", message);
  if (status === 404) return new RpcError("not_found", message);
  return new RpcError("unavailable", message, { provider: "gemini", status });
}

/** Parses an SSE stream into its `data:` payloads. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
  }
  const rest = buf
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trimStart())
    .join("\n");
  if (rest) yield rest;
}

export class GeminiProvider implements Provider {
  readonly vendor = "gemini";
  private opts: GeminiOptions;
  private caches: TurnCaches;

  constructor(opts: GeminiOptions) {
    this.opts = opts;
    this.caches = new TurnCaches({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, log: opts.log, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  }

  async complete(req: ProviderRequest): Promise<LlmResult> {
    const key = this.opts.apiKey();
    if (!key) throw new RpcError("unavailable", "no Gemini API key: set [providers.gemini] api_key or GEMINI_API_KEY", { provider: "gemini" });
    const contents = toContents(req.params.messages);
    const system = req.params.system ? { parts: [{ text: req.params.system }] } : undefined;
    const tools = toTools(req.params.tools);
    const generationConfig: Record<string, unknown> = {};
    if (req.params.maxTokens !== undefined) generationConfig["maxOutputTokens"] = req.params.maxTokens;
    if (req.params.temperature !== undefined) generationConfig["temperature"] = req.params.temperature;
    if (req.thinking) generationConfig["thinkingConfig"] = { thinkingLevel: req.thinking.toUpperCase() };
    const whole = (): Record<string, unknown> => {
      const body: Record<string, unknown> = { contents };
      if (system) body["systemInstruction"] = system;
      if (tools) body["tools"] = tools;
      if (Object.keys(generationConfig).length > 0) body["generationConfig"] = generationConfig;
      return body;
    };
    const turn = req.params.cache;
    if (!turn) return this.send(key, whole(), req);
    // A step of a turn: against the turn's cache once there is one (gemini-cache.ts).
    const parts: CacheParts = { model: req.model, ...(system ? { system } : {}), ...(tools ? { tools } : {}), contents };
    const use = await this.caches.before(turn.key, parts, turn.eager === true);
    let result: LlmResult;
    if (use) {
      const body: Record<string, unknown> = { cachedContent: use.name, contents: use.contents };
      if (Object.keys(generationConfig).length > 0) body["generationConfig"] = generationConfig;
      try {
        result = await this.send(key, body, req);
      } catch (e) {
        // A cache gone before its TTL said (deleted, expired on a long turn): the step goes whole, the turn starts a new one.
        if (!(e instanceof RpcError) || (e.code !== "not_found" && e.code !== "invalid" && e.code !== "denied")) throw e;
        this.opts.log.info("turn cache refused; the step goes whole", { code: e.code, message: e.message });
        this.caches.forget(turn.key);
        result = await this.send(key, whole(), req);
      }
      if (use.written > 0) result.usage.cacheWrite = (result.usage.cacheWrite ?? 0) + use.written;
    } else result = await this.send(key, whole(), req);
    this.caches.after(turn.key, result);
    return result;
  }

  /** One `streamGenerateContent`: deltas as they come, the completion coalesced. */
  private async send(key: string, body: Record<string, unknown>, req: ProviderRequest): Promise<LlmResult> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    const onAbort = () => controller.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const doFetch = this.opts.fetch ?? fetch;
    try {
      if (req.signal?.aborted) throw new RpcError("cancelled", "cancelled");
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        if (req.signal?.aborted) throw new RpcError("cancelled", "cancelled");
        if (controller.signal.aborted) throw new RpcError("timeout", `gemini: no answer within ${this.opts.timeoutMs} ms`);
        throw new RpcError("unavailable", `gemini: ${e instanceof Error ? e.message : String(e)}`, { provider: "gemini" });
      }
      if (!res.ok) throw errorFor(res.status, await res.text());
      if (!res.body) throw new RpcError("unavailable", "gemini: empty response", { provider: "gemini" });

      const content: LlmContent[] = [];
      let usage: LlmResult["usage"] = { in: 0, out: 0 };
      let finish: string | undefined;
      let sawToolUse = false;
      let model = req.model;
      let calls = 0;
      try {
        for await (const data of sse(res.body)) {
          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (typeof chunk["modelVersion"] === "string") model = chunk["modelVersion"];
          const candidate = (chunk["candidates"] as { content?: { parts?: Part[] }; finishReason?: string }[] | undefined)?.[0];
          if (candidate?.finishReason) finish = candidate.finishReason;
          for (const part of candidate?.content?.parts ?? []) {
            if (part.thought) continue;
            if (typeof part.text === "string") {
              const last = content[content.length - 1];
              if (last && last.type === "text") {
                last.text += part.text;
                if (part.thoughtSignature) last.signature = part.thoughtSignature;
              } else {
                const block: LlmContent = { type: "text", text: part.text };
                if (part.thoughtSignature) block.signature = part.thoughtSignature;
                content.push(block);
              }
              if (part.text) req.onDelta?.({ type: "text", text: part.text });
            } else if (part.functionCall) {
              sawToolUse = true;
              const id = part.functionCall.id ?? `call_${++calls}`;
              const block: LlmContent = { type: "tool_use", id, name: part.functionCall.name, input: part.functionCall.args ?? {} };
              if (part.thoughtSignature) block.signature = part.thoughtSignature;
              content.push(block);
              req.onDelta?.({ type: "tool_use", id, name: block.name, inputJson: JSON.stringify(block.input ?? {}) });
            }
          }
          const meta = chunk["usageMetadata"] as { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number } | undefined;
          if (meta) {
            usage = { in: meta.promptTokenCount ?? 0, out: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0) };
            if (meta.cachedContentTokenCount !== undefined) usage.cacheRead = meta.cachedContentTokenCount;
          }
          const err = chunk["error"] as { code?: number; message?: string } | undefined;
          if (err) throw errorFor(err.code ?? 500, JSON.stringify(chunk));
        }
      } catch (e) {
        if (e instanceof RpcError) throw e;
        if (req.signal?.aborted) throw new RpcError("cancelled", "cancelled");
        if (controller.signal.aborted) throw new RpcError("timeout", `gemini: stream stalled past ${this.opts.timeoutMs} ms`);
        throw new RpcError("unavailable", `gemini: ${e instanceof Error ? e.message : String(e)}`, { provider: "gemini" });
      }
      return { content, stopReason: mapFinish(finish, sawToolUse), usage, model };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }
  }
}

