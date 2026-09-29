// The online engines: transcription and speech over the network rather than on this machine,
// routed the way `llm.complete` is. `[providers] stt` lists the routes a transcription tries
// in order — `server`, the account's hosted transcription; `byok:gemini`, Gemini with the
// user's own key — and `[providers] tts` the routes speech tries: `server`, then
// `byok:deepinfra`, Kokoro on DeepInfra with the user's own key. The app can say where they go
// first (`routes`): the account's server with the user's key after it, or the user's key
// alone. A route that cannot serve (not signed in, no key, the vendor throttled or down, a
// plan the server no longer grants) passes the call to the next, as the model's routing does;
// when every one refused, the turn goes on as if nothing were said (an empty transcript), or
// with nothing spoken, and the log says why.
//
// Two engines transcribe. `gemini-live` streams the words as they are said (`live.ts`, Gemini
// Live in `gemini-live.ts`), about $0.009 a minute. `gemini` sends each utterance once the VAD
// has closed it: Gemini hears it as a WAV inside the prompt and is asked for the words and
// nothing else; on Flash-Lite a second of audio is 32 tokens, about $0.0007 a minute with the
// transcript, and an utterance comes back in about a second. A request carries a minute at
// most, the server's limit, so a longer utterance goes in pieces cut at its quietest moments
// (`splitAtQuiet`), two at a time, and the pieces' words are joined. Either way an utterance
// lasts `MAX_SECONDS` at most: Gemini Live's session is ten minutes of wall time, less the
// margin its setup and its last words need. Speech goes
// a line at a time, as the server's does, and the WAV that streams back is played as it comes:
// Kokoro-82M on DeepInfra is the cheapest voice there is online, $0.62 a million characters,
// about $0.0006 a minute of speech.

import { RpcError } from "@cophyla/protocol";
import type { VoiceRoute } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import type { LiveOpener, SttEngine, SttStream, TtsEngine } from "./engines.ts";
import { IN_RATE, OUT_RATE } from "./engines.ts";
import { geminiLive } from "./gemini-live.ts";
import type { LiveConnect } from "./gemini-live.ts";
import { liveStt } from "./live.ts";
import { WavStream } from "./wav-stream.ts";

/** The most audio one utterance may carry online: Gemini Live's ten minutes, less its setup and its last words. */
export const MAX_SECONDS = 570;
/** The most audio one transcription request carries, as the server allows: a longer utterance goes in pieces. */
export const PIECE_SECONDS = 60;
/** Where before a piece's end it may be cut: the quietest `QUIET_STEP_MS` in its last `QUIET_SEARCH_SECONDS`. */
export const QUIET_SEARCH_SECONDS = 5;
export const QUIET_STEP_MS = 100;
/** The pieces of one utterance transcribed at once. */
export const PIECES_IN_FLIGHT = 2;
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

/** A refusal that hands a call to the next route: a plan the server no longer grants too, which the node may not know yet. */
export function passesOn(route: string, err: RpcError): boolean {
  return PASS_ON.has(err.code) || (err.code === "denied" && route === "server");
}

/**
 * The routes as the app said they go: `cloud`, the account's server first and the user's key
 * after; `own`, the user's key alone; as config.toml lists them when the app said nothing.
 */
export function routesFor(configured: string[], pick: VoiceRoute | undefined): string[] {
  if (pick === undefined) return configured;
  const own = configured.filter((r) => r !== "server");
  return pick === "cloud" ? ["server", ...own] : own;
}

/**
 * An utterance in pieces of at most `pieceSamples`, each cut before its end at the quietest
 * `step` in the `search` before it, so a word is seldom cut in two.
 */
export function splitAtQuiet(pcm: Int16Array, pieceSamples = PIECE_SECONDS * IN_RATE, search = QUIET_SEARCH_SECONDS * IN_RATE, step = (QUIET_STEP_MS / 1000) * IN_RATE): Int16Array[] {
  const pieces: Int16Array[] = [];
  let start = 0;
  while (pcm.length - start > pieceSamples) {
    const mark = start + pieceSamples;
    let cut = mark;
    let quietest = Infinity;
    for (let at = mark - step; at >= Math.max(start + 1, mark - search); at -= step) {
      let energy = 0;
      for (let i = at; i < at + step; i++) energy += Math.abs(pcm[i]!);
      if (energy < quietest) {
        quietest = energy;
        cut = at + Math.floor(step / 2);
      }
    }
    pieces.push(pcm.subarray(start, cut));
    start = cut;
  }
  pieces.push(pcm.subarray(start));
  return pieces;
}

/**
 * An utterance of any length through `transcribe`, a piece at a time with `PIECES_IN_FLIGHT`
 * in flight, the words joined in order. A piece that fails is left out; the route is the
 * first piece's.
 */
export async function transcribeLong(pcm: Int16Array, transcribe: (piece: Int16Array) => Promise<{ text: string; route?: string }>, log?: Logger): Promise<{ text: string; route?: string }> {
  const pieces = splitAtQuiet(pcm);
  const out: ({ text: string; route?: string } | undefined)[] = new Array(pieces.length);
  let next = 0;
  let failed = 0;
  const worker = async () => {
    while (next < pieces.length) {
      const i = next++;
      try {
        out[i] = await transcribe(pieces[i]!);
      } catch (e) {
        failed++;
        if (pieces.length === 1) throw e;
        log?.warn("a piece of the utterance was not transcribed", { piece: i, of: pieces.length, error: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PIECES_IN_FLIGHT, pieces.length) }, worker));
  if (failed === pieces.length) throw new RpcError("unavailable", "no piece of the utterance was transcribed");
  const done = out.filter((r): r is { text: string; route?: string } => r !== undefined);
  return { text: done.map((r) => r.text.trim()).filter(Boolean).join(" "), ...(done[0]?.route ? { route: done[0].route } : {}) };
}

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
  /** `[providers] stt` and `tts` as the app's route picks leave them: the routes in order, as they are now. */
  sttRoutes: () => string[];
  ttsRoutes: () => string[];
  /** The account's hosted transcription and speech: the `server` route. */
  server?: {
    transcribe(pcm: Int16Array, language: string | undefined): Promise<string>;
    speak(text: string, voice: string, signal?: AbortSignal): AsyncIterable<Int16Array>;
    /** Live transcription through the server. */
    listen?: LiveOpener;
  };
  /** Gemini with the user's own key; `liveModel` transcribes live. */
  gemini: GeminiSttOptions & { liveModel: string; connect?: LiveConnect };
  deepinfra: DeepInfraTtsOptions;
  language?: string;
  /** Words the live recogniser should expect: the names of this node's things. */
  vocabulary?: () => string[];
  log: Logger;
}

const asRpc = (route: string, e: unknown) => (e instanceof RpcError ? e : new RpcError("unavailable", e instanceof Error ? e.message : String(e), { provider: route }));

/** One piece of at most a minute over `[providers] stt`, and the route that took it; thrown when every route refused. */
async function transcribeRouted(deps: OnlineDeps, pcm: Int16Array, language: string | undefined): Promise<{ text: string; route: string }> {
  const refusals: string[] = [];
  for (const route of deps.sttRoutes()) {
    try {
      if (route === "server") {
        if (!deps.server) throw new RpcError("unavailable", "no account on this node", { provider: "server" });
        return { text: await deps.server.transcribe(pcm, language), route };
      }
      if (route === "byok:gemini") return { text: await geminiTranscribe(pcm, language, deps.gemini), route };
      throw new RpcError("unavailable", `${route} does not transcribe`, { provider: route });
    } catch (e) {
      const err = asRpc(route, e);
      refusals.push(`${route}: ${err.message}`);
      if (!passesOn(route, err)) break;
    }
  }
  throw new RpcError("unavailable", `no transcription route could take it: ${refusals.join("; ")}`, { routes: refusals });
}

/** An utterance of any length over `[providers] stt`, in pieces the routes take. */
function transcribeWhole(deps: OnlineDeps, pcm: Int16Array, language: string | undefined): Promise<{ text: string; route?: string }> {
  return transcribeLong(pcm, (piece) => transcribeRouted(deps, piece, language), deps.log);
}

/** Transcription over `[providers] stt`, of each utterance whole once it ends. */
export function onlineStt(deps: OnlineDeps): SttEngine {
  return {
    maxSeconds: MAX_SECONDS,
    stream: (opts = {}): SttStream => {
      const language = opts.language ?? deps.language;
      let chunks: Int16Array[] = [];
      let samples = 0;
      const clear = () => {
        chunks = [];
        samples = 0;
      };
      const stream: SttStream & { how?: { route?: string; live?: boolean } } = {
        accept(pcm: Int16Array): void {
          if (samples + pcm.length > (MAX_SECONDS + 1) * IN_RATE) return;
          chunks.push(pcm);
          samples += pcm.length;
        },
        async final(): Promise<string> {
          const all = new Int16Array(samples);
          let o = 0;
          for (const c of chunks) {
            all.set(c, o);
            o += c.length;
          }
          clear();
          if (all.length === 0) return "";
          try {
            const r = await transcribeWhole(deps, all, language);
            stream.how = { ...(r.route ? { route: r.route } : {}), live: false };
            return r.text;
          } catch (e) {
            deps.log.warn("the utterance was not transcribed", { error: e instanceof Error ? e.message : String(e) });
            stream.how = { route: "none", live: false };
            return "";
          }
        },
        reset: clear,
        dispose: clear,
      };
      return stream;
    },
    close: () => {},
  };
}

/** Transcription as it is said over `[providers] stt`, each utterance whole over the same routes when no live one hears. */
export function onlineLiveStt(deps: OnlineDeps): SttEngine {
  const own = geminiLive({ apiKey: deps.gemini.apiKey, baseUrl: deps.gemini.baseUrl, model: deps.gemini.liveModel, log: deps.log, ...(deps.gemini.connect ? { connect: deps.gemini.connect } : {}) });
  return liveStt({
    routes: deps.sttRoutes,
    opener: (route) => (route === "server" ? deps.server?.listen : route === "byok:gemini" ? own : undefined),
    batch: (pcm, language) => transcribeWhole(deps, pcm, language),
    maxSeconds: MAX_SECONDS,
    ...(deps.language ? { language: deps.language } : {}),
    ...(deps.vocabulary ? { vocabulary: deps.vocabulary } : {}),
    log: deps.log,
  });
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
      for (const route of deps.ttsRoutes()) {
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
          if (spoke || !passesOn(route, err)) throw err;
          refusals.push(`${route}: ${err.message}`);
        }
      }
      throw new RpcError("unavailable", `no speech route could speak: ${refusals.join("; ")}`, { routes: refusals });
    },
    close: () => {},
  };
}
