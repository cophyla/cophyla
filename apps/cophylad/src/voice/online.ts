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
// (`splitAtQuiet`), two at a time, and the pieces' words are joined; once speech is heard in
// it each minute goes as soon as it is said, so the end of a long one waits on its last
// minute alone (`onlineStt`). Either way an utterance
// lasts as long as the user lets one (`MAX_SECONDS` at most, an hour): Gemini Live's session
// is ten minutes of wall time, so a longer one goes on in the next (`live.ts`). Either way
// the words come as said unless Settings has them cleaned up (`clean`): then Gemini's own
// transcription models do it in smart mode, fillers, stutters and false starts out and
// corrections said out loud resolved, live (`gemini-3.5-transcribe-live`) or whole
// (`gemini-3.5-transcribe` over the Interactions API, about $0.005 a minute); the account's
// server does the same when asked. Speech goes
// a line at a time, as the server's does, and the WAV that streams back is played as it comes:
// Kokoro-82M on DeepInfra is the cheapest voice there is online, $0.62 a million characters,
// about $0.0006 a minute of speech.

import { MAX_RECORDING_SECONDS, RpcError } from "@cophyla/protocol";
import type { VoiceRoute } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import type { LiveOpener, SttEngine, SttStream, TtsEngine } from "./engines.ts";
import { IN_RATE, OUT_RATE, sttFailed } from "./engines.ts";
import { geminiLive } from "./gemini-live.ts";
import type { LiveConnect } from "./gemini-live.ts";
import { liveStt } from "./live.ts";
import { WavStream } from "./wav-stream.ts";

/** The most audio one utterance may carry online: the longest a recording may be set to last. */
export const MAX_SECONDS = MAX_RECORDING_SECONDS;
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

type Transcribed = { text: string; route?: string };

/**
 * The pieces of one utterance, each transcribed through `transcribe` as it is added, with
 * `PIECES_IN_FLIGHT` at once, and their words joined in order once `done`. A piece that fails
 * is left out; the route is the first piece's. An utterance of one piece throws what it failed
 * with, and one whose every piece failed throws whether each was a rate limit.
 */
export class Pieces {
  private readonly results: Promise<{ ok: Transcribed } | { error: unknown }>[] = [];
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly transcribe: (piece: Int16Array) => Promise<Transcribed>;
  private readonly log: Logger | undefined;

  constructor(transcribe: (piece: Int16Array) => Promise<Transcribed>, log?: Logger) {
    this.transcribe = transcribe;
    this.log = log;
  }

  add(piece: Int16Array): void {
    this.results.push(this.run(piece));
  }

  async done(): Promise<Transcribed> {
    const outs = await Promise.all(this.results);
    const of = outs.length;
    const failures = outs.flatMap((o) => ("error" in o ? [o.error] : []));
    if (of === 1 && failures.length === 1) throw failures[0];
    outs.forEach((o, piece) => {
      if ("error" in o) this.log?.warn("a piece of the utterance was not transcribed", { piece, of, error: o.error instanceof Error ? o.error.message : String(o.error) });
    });
    if (of > 0 && failures.length === of) {
      const limitedAll = failures.every((e) => e instanceof RpcError && e.code === "quota_exceeded");
      throw new RpcError(limitedAll ? "quota_exceeded" : "unavailable", "no piece of the utterance was transcribed");
    }
    const done = outs.flatMap((o) => ("ok" in o ? [o.ok] : []));
    return { text: done.map((r) => r.text.trim()).filter(Boolean).join(" "), ...(done[0]?.route ? { route: done[0].route } : {}) };
  }

  private async run(piece: Int16Array): Promise<{ ok: Transcribed } | { error: unknown }> {
    // A piece that finishes hands its place to the next one waiting, so no more than the limit ever run.
    if (this.running < PIECES_IN_FLIGHT) this.running++;
    else await new Promise<void>((go) => this.waiting.push(go));
    try {
      return { ok: await this.transcribe(piece) };
    } catch (error) {
      return { error };
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}

/**
 * An utterance of any length through `transcribe`, a piece at a time with `PIECES_IN_FLIGHT`
 * in flight, the words joined in order (`Pieces`).
 */
export function transcribeLong(pcm: Int16Array, transcribe: (piece: Int16Array) => Promise<Transcribed>, log?: Logger): Promise<Transcribed> {
  const pieces = new Pieces(transcribe, log);
  for (const piece of splitAtQuiet(pcm)) pieces.add(piece);
  return pieces.done();
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

/** Gemini's transcription model, which cleans the words up in smart mode. */
export const CLEAN_MODEL = "gemini-3.5-transcribe";

/**
 * One utterance, cleaned up by Gemini's transcription model in smart mode with the user's own
 * key: fillers, stutters and false starts out, corrections said out loud resolved, punctuated.
 * It is asked over the Interactions API, the audio inline as a WAV.
 */
export async function geminiSmartTranscribe(pcm: Int16Array, language: string | undefined, opts: GeminiSttOptions, signal?: AbortSignal): Promise<string> {
  const key = opts.apiKey();
  if (!key) throw new RpcError("unavailable", "no Gemini API key: set [providers.gemini] api_key or GEMINI_API_KEY", { provider: "gemini" });
  const body = {
    model: `models/${opts.model}`,
    input: [{ type: "audio", data: Buffer.from(wavOf(pcm, IN_RATE)).toString("base64"), mime_type: "audio/wav" }],
    generation_config: { transcription_config: { mode: "smart", ...(language ? { language_codes: [language] } : {}) } },
  };
  const url = `${opts.baseUrl.replace(/\/$/, "")}/v1beta/interactions`;
  const { res, done } = await call("gemini", opts.fetch ?? fetch, url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) }, signal, opts.timeoutMs ?? TIMEOUT_MS);
  try {
    const text = await res.text();
    if (!res.ok) throw vendorError("gemini", res.status, text);
    return interactionText(JSON.parse(text));
  } finally {
    done();
  }
}

/** The transcript in an interaction's answer: `output_text`, or the text of its steps. */
export function interactionText(j: { output_text?: unknown; steps?: { content?: { type?: string; text?: unknown }[] }[] }): string {
  if (typeof j.output_text === "string") return j.output_text.trim();
  return (j.steps ?? [])
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("")
    .trim();
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
    transcribe(pcm: Int16Array, language: string | undefined, clean?: boolean): Promise<string>;
    speak(text: string, voice: string, signal?: AbortSignal): AsyncIterable<Int16Array>;
    /** Live transcription through the server. */
    listen?: LiveOpener;
  };
  /** Gemini with the user's own key; `liveModel` transcribes live, `cleanModel` whole and cleaned up. */
  gemini: GeminiSttOptions & { liveModel: string; cleanModel?: string; connect?: LiveConnect };
  deepinfra: DeepInfraTtsOptions;
  language?: string;
  /** Words the live recogniser should expect: the names of this node's things. */
  vocabulary?: () => string[];
  /** Whether the words are cleaned up, read as each utterance begins; word for word without it. */
  clean?: () => boolean;
  log: Logger;
  /** Waits before a rate-limited transcription is tried again; a timer, unless a test gives its own. */
  sleep?: (ms: number) => Promise<void>;
}

const asRpc = (route: string, e: unknown) => (e instanceof RpcError ? e : new RpcError("unavailable", e instanceof Error ? e.message : String(e), { provider: route }));

/** The longest wait a rate limit may ask for and still be waited out: past it, the utterance fails and says why. */
export const RATE_RETRY_MAX_S = 60;

/**
 * Whether a refusal is the vendor's rate limit on the model (Gemini's requests a day, or input
 * tokens a minute), and how many seconds it says to wait when it says. A limit is per model, so
 * the plain transcription model is not held by the clean-up model's.
 */
export function rateLimited(err: RpcError): { retryS?: number } | undefined {
  const status = (err.error.data as { status?: unknown } | undefined)?.status;
  if (status !== 429 && !/rate limit|resource.?exhausted|retry in \d/i.test(err.message)) return undefined;
  const wait = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(err.message);
  return wait ? { retryS: Number(wait[1]) } : {};
}

/** One piece over one route, cleaned up or as said. */
async function viaRoute(deps: OnlineDeps, route: string, pcm: Int16Array, language: string | undefined, clean: boolean): Promise<string> {
  if (route === "server") {
    if (!deps.server) throw new RpcError("unavailable", "no account on this node", { provider: "server" });
    return deps.server.transcribe(pcm, language, clean);
  }
  if (route === "byok:gemini") return clean ? geminiSmartTranscribe(pcm, language, { ...deps.gemini, model: deps.gemini.cleanModel ?? CLEAN_MODEL }) : geminiTranscribe(pcm, language, deps.gemini);
  throw new RpcError("unavailable", `${route} does not transcribe`, { provider: route });
}

/**
 * One pass over the routes: the words and the route that took them, or how every route refused.
 * A route whose clean-up model is rate-limited transcribes the piece as said on the same route
 * before the next is tried, since that model has a limit of its own, far above.
 */
async function routesOnce(deps: OnlineDeps, pcm: Int16Array, language: string | undefined, clean: boolean, refusals: string[]): Promise<{ text: string; route: string } | { limited: boolean; waitS?: number }> {
  let limited = true;
  let tried = false;
  let waitS: number | undefined;
  for (const route of deps.sttRoutes()) {
    tried = true;
    let err: RpcError | undefined;
    for (const tidy of clean ? [true, false] : [false]) {
      try {
        const text = await viaRoute(deps, route, pcm, language, tidy);
        if (clean && !tidy) deps.log.info("transcribed as said: the clean-up model is rate-limited", { route });
        return { text, route };
      } catch (e) {
        err = asRpc(route, e);
        refusals.push(`${route}${clean && !tidy ? " as said" : ""}: ${err.message}`);
        const limit = rateLimited(err);
        if (limit?.retryS !== undefined) waitS = Math.min(waitS ?? Infinity, limit.retryS);
        if (!limit) break;
      }
    }
    if (err && !rateLimited(err)) limited = false;
    if (err && !passesOn(route, err)) return { limited: false };
  }
  return { limited: tried && limited, ...(waitS !== undefined ? { waitS } : {}) };
}

/**
 * One piece of at most a minute over `[providers] stt`, cleaned up or not, and the route that
 * took it; thrown when every route refused. When each refused for a rate limit that names a
 * short wait, the routes are tried once more after it. What is thrown says whether it was a rate
 * limit (`quota_exceeded`) or anything else (`unavailable`).
 */
async function transcribeRouted(deps: OnlineDeps, pcm: Int16Array, language: string | undefined, clean: boolean): Promise<{ text: string; route: string }> {
  const refusals: string[] = [];
  let pass = await routesOnce(deps, pcm, language, clean, refusals);
  if ("text" in pass) return pass;
  if (pass.limited && pass.waitS !== undefined && pass.waitS <= RATE_RETRY_MAX_S) {
    deps.log.info("transcription rate-limited: trying again", { afterS: pass.waitS });
    await (deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(Math.ceil(pass.waitS * 1000) + 250);
    pass = await routesOnce(deps, pcm, language, clean, refusals);
    if ("text" in pass) return pass;
  }
  throw new RpcError(pass.limited ? "quota_exceeded" : "unavailable", `no transcription route could take it: ${refusals.join("; ")}`, { routes: refusals });
}

/** An utterance of any length over `[providers] stt`, in pieces the routes take, every piece cleaned up or none. */
function transcribeWhole(deps: OnlineDeps, pcm: Int16Array, language: string | undefined): Promise<{ text: string; route?: string }> {
  const clean = deps.clean?.() ?? false;
  return transcribeLong(pcm, (piece) => transcribeRouted(deps, piece, language, clean), deps.log);
}

/** Int16 chunks as one run of samples. */
function joined(chunks: Int16Array[], samples: number): Int16Array {
  const all = new Int16Array(samples);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return all;
}

/**
 * Transcription over `[providers] stt`, of each utterance whole once it ends. A long one is
 * not left to its end: once the VAD has heard speech in it, each minute is cut off (at its
 * quietest, as `splitAtQuiet` cuts) and transcribed while the user goes on talking, so when
 * they stop only the last minute is left to wait for, however long they spoke. Before speech
 * is heard nothing is sent, so a recording of silence costs nothing.
 */
export function onlineStt(deps: OnlineDeps): SttEngine {
  return {
    maxSeconds: MAX_SECONDS,
    stream: (opts = {}): SttStream => {
      const language = opts.language ?? deps.language;
      /** What is not yet cut into a piece, and how much of the utterance was taken at all. */
      let chunks: Int16Array[] = [];
      let samples = 0;
      let total = 0;
      let speech = false;
      // Every piece of one utterance is cleaned up, or none: the choice as its first piece went.
      let clean: boolean | undefined;
      let pieces: Pieces | undefined;
      const piecesNow = (): Pieces => {
        clean ??= deps.clean?.() ?? false;
        const tidy = clean;
        return (pieces ??= new Pieces((piece) => transcribeRouted(deps, piece, language, tidy), deps.log));
      };
      // The minutes heard so far go off now; the last, still growing, stays.
      const cutDone = (): void => {
        if (!speech || samples <= PIECE_SECONDS * IN_RATE) return;
        const parts = splitAtQuiet(joined(chunks, samples));
        const rest = parts.pop()!;
        const run = piecesNow();
        for (const part of parts) run.add(part);
        chunks = [rest];
        samples = rest.length;
      };
      const clear = () => {
        chunks = [];
        samples = 0;
        total = 0;
        speech = false;
        clean = undefined;
        // pieces on their way are let go: their words come back to nothing
        pieces = undefined;
      };
      const stream: SttStream & { how?: { route?: string; live?: boolean } } = {
        accept(pcm: Int16Array): void {
          if (total + pcm.length > (MAX_SECONDS + 1) * IN_RATE) return;
          chunks.push(pcm);
          samples += pcm.length;
          total += pcm.length;
          cutDone();
        },
        heard(): void {
          speech = true;
          cutDone();
        },
        async final(): Promise<string> {
          const rest = joined(chunks, samples);
          const run = pieces ?? (rest.length > 0 ? piecesNow() : undefined);
          clear();
          if (!run) return "";
          for (const part of rest.length > 0 ? splitAtQuiet(rest) : []) run.add(part);
          try {
            const r = await run.done();
            stream.how = { ...(r.route ? { route: r.route } : {}), live: false };
            return r.text;
          } catch (e) {
            deps.log.warn("the utterance was not transcribed", { error: e instanceof Error ? e.message : String(e) });
            stream.how = { route: "none", live: false, failed: sttFailed(e) };
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
    ...(deps.clean ? { clean: deps.clean } : {}),
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
