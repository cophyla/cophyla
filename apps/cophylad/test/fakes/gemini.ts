// A stand-in for the Gemini API: `POST /v1beta/models/<model>:streamGenerateContent?alt=sse`
// answered from a script chosen by the last user text, streamed as SSE chunks the way the
// real API shapes them. Records every request body so a test can check the mapping. Usable
// as the daemon's provider base_url and by the brain's ttft script.

export interface GeminiFakeOptions {
  /** Answers per trigger word found in the last user text (or a function of that text and the request body); `default` when none matches. */
  scripts?: Record<string, Script>;
  /** Milliseconds between chunks. */
  delayMs?: number;
  /** Requests answered with this status and body, e.g. a 429. */
  fail?: { status: number; body: string };
  /** Refuse any key but this one with 403. */
  apiKey?: string;
}

export type Chunk = Record<string, unknown>;
export type Script = Chunk[] | ((trigger: string, body: Record<string, unknown>) => Chunk[]);

export interface RecordedRequest {
  model: string;
  key: string | null;
  body: Record<string, unknown>;
}

export const text = (t: string, extra: Record<string, unknown> = {}): Chunk => ({
  candidates: [{ content: { role: "model", parts: [{ text: t, ...extra }] } }],
});
export const thought = (t: string): Chunk => ({ candidates: [{ content: { role: "model", parts: [{ text: t, thought: true }] } }] });
export const call = (name: string, args: unknown, extra: Record<string, unknown> = {}): Chunk => ({
  candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args }, ...extra }] } }],
});
export const finish = (reason: string, usage: Record<string, number> = { promptTokenCount: 10, candidatesTokenCount: 5 }): Chunk => ({
  candidates: [{ content: { role: "model", parts: [] }, finishReason: reason }],
  usageMetadata: usage,
  modelVersion: "gemini-fake-001",
});

/** The last user text in a request body, for the script lookup. */
export function lastUserText(body: Record<string, unknown>): string {
  const contents = (body["contents"] as { role: string; parts: { text?: string; functionResponse?: unknown }[] }[] | undefined) ?? [];
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i]!;
    if (c.role !== "user") continue;
    const t = c.parts.map((p) => p.text ?? "").join("");
    if (t) return t;
    if (c.parts.some((p) => p.functionResponse)) return "__function_response__";
  }
  return "";
}

export function startGeminiFake(opts: GeminiFakeOptions = {}) {
  const requests: RecordedRequest[] = [];
  let scripts = opts.scripts ?? {};
  let fail = opts.fail;
  const inflight = new Set<AbortController>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const m = /^\/v1beta\/models\/([^:]+):streamGenerateContent$/.exec(url.pathname);
      if (!m || req.method !== "POST") return new Response("not found", { status: 404 });
      const key = req.headers.get("x-goog-api-key");
      if (opts.apiKey !== undefined && key !== opts.apiKey) return new Response(JSON.stringify({ error: { code: 403, message: "bad key" } }), { status: 403 });
      const body = (await req.json()) as Record<string, unknown>;
      requests.push({ model: decodeURIComponent(m[1]!), key, body });
      if (fail) return new Response(fail.body, { status: fail.status, headers: { "content-type": "application/json" } });
      const trigger = lastUserText(body);
      const match = Object.keys(scripts).find((k) => k !== "default" && trigger.includes(k));
      const script = scripts[match ?? "default"];
      const chunks = typeof script === "function" ? script(trigger, body) : (script ?? [text("ok"), finish("STOP")]);
      const delay = opts.delayMs ?? 0;
      const abort = new AbortController();
      inflight.add(abort);
      req.signal.addEventListener("abort", () => abort.abort(), { once: true });
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          try {
            for (const c of chunks) {
              if (abort.signal.aborted) break;
              if (delay > 0) await new Promise((r) => setTimeout(r, delay));
              if (abort.signal.aborted) break;
              controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\r\n\r\n`));
            }
          } catch {
            // the client went away
          }
          inflight.delete(abort);
          try {
            controller.close();
          } catch {
            // already closed
          }
        },
        cancel() {
          abort.abort();
          inflight.delete(abort);
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    requests,
    /** How many streams are still being written. */
    get inflight() {
      return inflight.size;
    },
    setScripts(next: Record<string, Script>) {
      scripts = next;
    },
    setFail(next: { status: number; body: string } | undefined) {
      fail = next;
    },
    stop: () => server.stop(true),
  };
}

export type GeminiFake = ReturnType<typeof startGeminiFake>;

if (import.meta.main) {
  // Standalone: `bun test/fakes/gemini.ts` prints the base url and serves a wordy default until killed.
  const fake = startGeminiFake({ scripts: { default: [text("The fake answers. "), text("Nothing more to say."), finish("STOP")] } });
  console.log(fake.url);
}
