// The online engines: transcription and speech over the network rather than on this machine,
// routed the way `llm.complete` is. `[providers] stt` lists the routes a transcription tries
// in order — `server`, the account's hosted transcription; `byok:gemini`, Gemini with the
// user's own key — and `[providers] tts` the routes speech tries: `server`, then
// `byok:deepinfra`, Kokoro on DeepInfra with the user's own key. A route that cannot serve
// (not signed in, no key, the vendor throttled or down) passes the call to the next, as the
// model's routing does; when every one refused, the turn goes on as if nothing were said (an
// empty transcript), or with nothing spoken, and the log says why.
//
// Transcription is of the whole utterance, sent once the VAD has closed it, so there are no
// partials. Gemini hears it as a WAV inside the prompt and is asked for the words and nothing
// else; on Flash-Lite a second of audio is 32 tokens, about $0.0007 a minute with the
// transcript, and an utterance comes back in about a second. Speech goes
// a line at a time, as the server's does, and the WAV that streams back is played as it comes:
// Kokoro-82M on DeepInfra is the cheapest voice there is online, $0.62 a million characters,
// about $0.0006 a minute of speech.

import { RpcError } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import type { SttEngine, SttStream, TtsEngine } from "./engines.ts";
import { IN_RATE, OUT_RATE } from "./engines.ts";
import { WavStream } from "./wav-stream.ts";

/** The most audio one utterance may carry, as the server allows. */
export const MAX_SECONDS = 60;
/** How long one transcription or one line of speech may take. */
export const TIMEOUT_MS = 30_000;

/** Kokoro's English voices, in the order the app counts them; the first is the default. */
export const KOKORO_VOICES = [
  "af_heart",
  "af_bella",
  "af_nicole",
  "af_sarah",
  "af_sky",
  "am_adam",
  "am_michael",
  "am_fenrir",
  "bf_emma",
  "bf_isabella",
  "bm_george",
  "bm_fable",
] as const;

const PROMPT =
  "Transcribe the speech in this recording exactly as spoken, in the language it is spoken in. " +
  "Reply with the transcript alone: no quotes, no labels, no notes. If nothing is said, reply with nothing.";

/** The codes that hand a call to the next route, as in the model's routing. */
const PASS_ON = new Set(["unavailable", "quota_exceeded", "timeout"]);

/** A WAV container around int16 mono PCM. */
export function wavOf(pcm: Int16Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44);
  return out;
}

function vendorError(vendor: string, status: number, body: string): RpcError {
  let message = body.slice(0, 300);
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; detail?: unknown };
    if (typeof j.error === "string") message = j.error;
    else if (j.error?.message) message = j.error.message;
  } catch {
    // not JSON
  }
  if (status === 429) return new RpcError("quota_exceeded", `${vendor}: ${message}`, { provider: vendor, status });
  if (status === 400 || status === 422) return new RpcError("invalid", `${vendor}: ${message}`, { provider: vendor, status });
  if (status === 401 || status === 403) return new RpcError("unavailable", `${vendor}: the key was refused: ${message}`, { provider: vendor, status });
  return new RpcError("unavailable", `${vendor}: ${message}`, { provider: vendor, status });
}

/** A fetch with a deadline and the caller's signal; network failures as `unavailable`. */
async function call(vendor: string, doFetch: typeof fetch, url: string, init: RequestInit, signal: AbortSignal | undefined, timeoutMs: number): Promise<{ res: Response; controller: AbortController; done: () => void }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };
  try {
    if (signal?.aborted) throw new RpcError("cancelled", "cancelled");
    const res = await doFetch(url, { ...init, signal: controller.signal });
    return { res, controller, done };
  } catch (e) {
    done();
    if (e instanceof RpcError) throw e;
    if (signal?.aborted) throw new RpcError("cancelled", "cancelled");
    if (controller.signal.aborted) throw new RpcError("timeout", `${vendor}: no answer within ${timeoutMs} ms`, { provider: vendor });
    throw new RpcError("unavailable", `${vendor}: ${e instanceof Error ? e.message : String(e)}`, { provider: vendor });
  }
}

export interface GeminiSttOptions {
  apiKey: () => string | undefined;
  baseUrl: string;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** One utterance, transcribed by Gemini with the user's own key. */
export async function geminiTranscribe(pcm: Int16Array, language: string | undefined, opts: GeminiSttOptions, signal?: AbortSignal): Promise<string> {
  const key = opts.apiKey();
  if (!key) throw new RpcError("unavailable", "no Gemini API key: set [providers.gemini] api_key or GEMINI_API_KEY", { provider: "gemini" });
  const audio = Buffer.from(wavOf(pcm, IN_RATE)).toString("base64");
  const prompt = language ? `${PROMPT} The language is ${language}.` : PROMPT;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: "audio/wav", data: audio } }] }],
    // No thinking: a transcript needs none. Gemini 2.x turns it off with a budget of 0, Gemini 3 with the minimal level.
    generationConfig: { temperature: 0, maxOutputTokens: 1024, thinkingConfig: /^gemini-2\./.test(opts.model) ? { thinkingBudget: 0 } : { thinkingLevel: "MINIMAL" } },
  };
  const url = `${opts.baseUrl.replace(/\/$/, "")}/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`;
  const { res, done } = await call("gemini", opts.fetch ?? fetch, url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) }, signal, opts.timeoutMs ?? TIMEOUT_MS);
  try {
    const text = await res.text();
    if (!res.ok) throw vendorError("gemini", res.status, text);
    const j = JSON.parse(text) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
    return (j.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("")
      .trim();
  } finally {
    done();
  }
}

export interface DeepInfraTtsOptions {
  apiKey: () => string | undefined;
  baseUrl: string;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** One line spoken by Kokoro on DeepInfra with the user's own key: int16 at 24 kHz, as it streams. */
export async function* deepinfraSpeak(text: string, voice: string, opts: DeepInfraTtsOptions, signal?: AbortSignal): AsyncIterable<Int16Array> {
  const key = opts.apiKey();
  if (!key) throw new RpcError("unavailable", "no DeepInfra API key: set [providers.deepinfra] api_key or DEEPINFRA_API_KEY", { provider: "deepinfra" });
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const url = `${opts.baseUrl.replace(/\/$/, "")}/v1/openai/audio/speech`;
  const init = { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: opts.model, input: text, voice, response_format: "wav" }) };
  const { res, controller, done } = await call("deepinfra", opts.fetch ?? fetch, url, init, signal, timeoutMs);
  try {
    if (!res.ok) throw vendorError("deepinfra", res.status, await res.text());
    if (!res.body) throw new RpcError("unavailable", "deepinfra: empty response", { provider: "deepinfra" });
    const out: Int16Array[] = [];
    const wav = new WavStream((chunk) => out.push(chunk));
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        wav.push(value);
        while (out.length > 0) yield out.shift()!;
      }
    } catch (e) {
      if (signal?.aborted) return;
      if (controller.signal.aborted) throw new RpcError("timeout", `deepinfra: speech stalled past ${timeoutMs} ms`, { provider: "deepinfra" });
      throw new RpcError("unavailable", `deepinfra: ${e instanceof Error ? e.message : String(e)}`, { provider: "deepinfra" });
    } finally {
      void reader.cancel().catch(() => {});
    }
    wav.end();
    while (out.length > 0) yield out.shift()!;
  } finally {
    done();
  }
}

export interface OnlineDeps {
  /** `[providers] stt` and `tts`: the routes in order. */
  sttRoutes: string[];
  ttsRoutes: string[];
  /** The account's hosted transcription and speech: the `server` route. */
  server?: {
    transcribe(pcm: Int16Array, language: string | undefined): Promise<string>;
    speak(text: string, voice: string, signal?: AbortSignal): AsyncIterable<Int16Array>;
  };
  gemini: GeminiSttOptions;
  deepinfra: DeepInfraTtsOptions;
  language?: string;
  log: Logger;
}

const asRpc = (route: string, e: unknown) => (e instanceof RpcError ? e : new RpcError("unavailable", e instanceof Error ? e.message : String(e), { provider: route }));

/** Transcription over `[providers] stt`, of each utterance whole. */
export function onlineStt(deps: OnlineDeps): SttEngine {
  const transcribe = async (pcm: Int16Array, language: string | undefined): Promise<string> => {
    const refusals: string[] = [];
    for (const route of deps.sttRoutes) {
      try {
        if (route === "server") {
          if (!deps.server) throw new RpcError("unavailable", "no account on this node", { provider: "server" });
          return await deps.server.transcribe(pcm, language);
        }
        if (route === "byok:gemini") return await geminiTranscribe(pcm, language, deps.gemini);
        throw new RpcError("unavailable", `${route} does not transcribe`, { provider: route });
      } catch (e) {
        const err = asRpc(route, e);
        refusals.push(`${route}: ${err.message}`);
        if (!PASS_ON.has(err.code)) break;
      }
    }
    deps.log.warn("the utterance was not transcribed", { routes: refusals });
    return "";
  };
  return {
    stream: (opts = {}): SttStream => {
      const language = opts.language ?? deps.language;
      let chunks: Int16Array[] = [];
      let samples = 0;
      const clear = () => {
        chunks = [];
        samples = 0;
      };
      return {
        accept(pcm: Int16Array): void {
          if (samples >= MAX_SECONDS * IN_RATE) return;
          const take = Math.min(pcm.length, MAX_SECONDS * IN_RATE - samples);
          chunks.push(take === pcm.length ? pcm : pcm.subarray(0, take));
          samples += take;
        },
        async final(): Promise<string> {
          const all = new Int16Array(samples);
          let o = 0;
          for (const c of chunks) {
            all.set(c, o);
            o += c.length;
          }
          clear();
          return all.length === 0 ? "" : transcribe(all, language);
        },
        reset: clear,
        dispose: clear,
      };
    },
    close: () => {},
  };
}

/** Speech over `[providers] tts`, Kokoro's voices counted from the first. */
export function onlineTts(deps: OnlineDeps): TtsEngine {
  let chosen: number | undefined;
  const voiceName = () => KOKORO_VOICES[Math.max(0, Math.min(KOKORO_VOICES.length - 1, chosen ?? 0))]!;
  return {
    name: "kokoro-online",
    sampleRate: OUT_RATE,
    voices: KOKORO_VOICES.length,
    get voice() {
      return chosen ?? 0;
    },
    useVoice(voice) {
      chosen = voice;
    },
    async *synth(text, opts = {}) {
      if (!text.trim()) return;
      const voice = voiceName();
      const refusals: string[] = [];
      for (const route of deps.ttsRoutes) {
        let spoke = false;
        try {
          let lines: AsyncIterable<Int16Array>;
          if (route === "server") {
            if (!deps.server) throw new RpcError("unavailable", "no account on this node", { provider: "server" });
            lines = deps.server.speak(text, voice, opts.signal);
          } else if (route === "byok:deepinfra") lines = deepinfraSpeak(text, voice, deps.deepinfra, opts.signal);
          else throw new RpcError("unavailable", `${route} does not speak`, { provider: route });
          for await (const chunk of lines) {
            spoke = true;
            yield chunk;
          }
          return;
        } catch (e) {
          if (opts.signal?.aborted) return;
          const err = asRpc(route, e);
          // Once a route has spoken, another would say the line again from its start.
          if (spoke || !PASS_ON.has(err.code)) throw err;
          refusals.push(`${route}: ${err.message}`);
        }
      }
      throw new RpcError("unavailable", `no speech route could speak: ${refusals.join("; ")}`, { routes: refusals });
    },
    close: () => {},
  };
}
