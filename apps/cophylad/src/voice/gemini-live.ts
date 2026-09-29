// Gemini Live transcription with the user's own key: one WebSocket per utterance to the Live
// API, the key in a header (never in the URL), set up to transcribe what it hears and answer
// nothing (`gemini-3.5-transcribe-live` in SMART mode: fillers dropped, self-corrections
// applied). Audio goes up as base64 PCM at 16 kHz; the words come back as they are heard.
// The server's hosted transcription speaks to Gemini the same way (apps/server
// `capabilities/stt-live.ts`); the two are kept in step by hand.
//
// What comes back, as measured against the service: Gemini's own VAD cuts the audio into
// stretches (`voiceActivity` ACTIVITY_START … ACTIVITY_END); within one, interim transcripts
// (`interimInputTranscription`) grow cumulatively about twice a second, raw, fillers and all;
// a stretch ends with its final (`inputTranscription`), cleaned, then `generationComplete`
// and ACTIVITY_END, all at once. The interims of the next stretch usually start afresh, but
// now and then they carry the last stretch's interim on as their start, which is cut off here.
// After `audioStreamEnd` nothing more comes when no stretch is open; otherwise its final does,
// a few hundred milliseconds later. Audio sent faster than it is spoken (the backlog of an
// utterance that began before the stream was open) is taken, and heard at about four times
// real time. A session ends at ten minutes of wall time less a margin: `goAway` fifty seconds
// before, then the socket closes; an utterance never lasts that long (`online.ts`).

import { RpcError } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import type { LiveOpener, LiveResult, LiveSession } from "./engines.ts";
import { IN_RATE } from "./engines.ts";

/** The most audio a session hears: its ten minutes of wall time end about ten seconds early. */
export const LIVE_MAX_SECONDS = 580;
/** How long the socket and the setup may take together. */
export const SETUP_TIMEOUT_MS = 10_000;
/** After the end of the audio, how long the last stretch's final is waited for before its interim stands. */
export const END_TIMEOUT_MS = 4000;
/** How much faster than real time a backlog is heard: its lag is waited out at the end. */
const CATCH_UP = 3;

const PATH = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** The socket the session speaks over: a WebSocket, or a fake in the tests. */
export interface LiveSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type LiveConnect = (url: string, headers: Record<string, string>) => LiveSocket;

/** Bun's WebSocket takes headers, which the browser's does not. */
const bunConnect: LiveConnect = (url, headers) => new WebSocket(url, { headers } as unknown as string[]) as unknown as LiveSocket;

export interface GeminiLiveOptions {
  apiKey: () => string | undefined;
  baseUrl: string;
  model: string;
  connect?: LiveConnect;
  log?: Logger;
  now?: () => number;
}

/** The alphanumerics of a text, lowercased: what two renderings of the same words share. */
const letters = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The transcript of one session as its messages arrive: the finals kept, the stretch in
 * progress, and whether a stretch is open. The server's copy is the same.
 */
export class LiveTranscript {
  private finals: string[] = [];
  private interim = "";
  /** The raw interim last seen, and the one a final came after: a later interim may start with it. */
  private lastRaw = "";
  private base = "";
  private open = false;
  onText?: (text: string, final: boolean) => void;

  /** One message from the service. */
  take(msg: Record<string, unknown>): void {
    const content = msg["serverContent"] as { interimInputTranscription?: { text?: unknown }; inputTranscription?: { text?: unknown } } | undefined;
    const interim = content?.interimInputTranscription?.text;
    if (typeof interim === "string") {
      this.lastRaw = interim;
      const text = this.strip(interim);
      if (text !== this.interim) {
        this.interim = text;
        this.onText?.(text, false);
      }
    }
    const final = content?.inputTranscription?.text;
    if (typeof final === "string") {
      const text = final.trim();
      if (text) this.finals.push(text);
      this.base = this.lastRaw;
      this.interim = "";
      this.onText?.(text, true);
    }
    const activity = (msg["voiceActivity"] as { type?: unknown } | undefined)?.type;
    if (activity === "ACTIVITY_START") this.open = true;
    else if (activity === "ACTIVITY_END") this.open = false;
  }

  /** An interim with the last stretch's interim cut from its start, when it carried it on. */
  private strip(raw: string): string {
    const base = letters(this.base);
    if (!base || !letters(raw).startsWith(base)) {
      this.base = "";
      return raw.trim();
    }
    let seen = 0;
    let i = 0;
    for (; i < raw.length && seen < base.length; i++) if (/[\p{L}\p{N}]/u.test(raw[i]!)) seen++;
    return raw.slice(i).trim();
  }

  /** A stretch is open, or its interim has no final yet. */
  get pending(): boolean {
    return this.open || this.interim !== "";
  }

  /** The finals so far. */
  get text(): string {
    return this.finals.join(" ");
  }

  /** The finals and the stretch in progress: what is shown, and what stands when the final never comes. */
  get display(): string {
    return [...this.finals, this.interim].filter(Boolean).join(" ");
  }
}

/** A close before the setup finished, as the refusal it is. */
function refusal(code: number, reason: string): RpcError {
  if (/quota|exhaust|rate.?limit|resource/i.test(reason)) return new RpcError("quota_exceeded", `gemini: ${reason}`, { provider: "gemini" });
  if (/authentication|api.?key|permission|credential/i.test(reason)) return new RpcError("unavailable", `gemini: the key was refused: ${reason}`, { provider: "gemini" });
  return new RpcError("unavailable", `gemini: the live session closed (${code}${reason ? ` ${reason}` : ""})`, { provider: "gemini" });
}

/** Live sessions with the user's own Gemini key. */
export function geminiLive(opts: GeminiLiveOptions): LiveOpener {
  const connect = opts.connect ?? bunConnect;
  const now = opts.now ?? Date.now;
  return ({ language, vocabulary }): LiveSession => {
    const transcript = new LiveTranscript();
    let socket: LiveSocket | undefined;
    let ready = false;
    let ending: ((r: LiveResult) => void) | undefined;
    let ended: LiveResult | undefined;
    let aborted = false;
    let sawGoAway = false;
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    let setupTimer: ReturnType<typeof setTimeout> | undefined;
    // Real time since the first audio, and how far the audio sent is ahead of it: a backlog still being heard.
    let lastSendAt = 0;
    let burst = 0;
    let lagUntil = 0;
    let resolveReady!: (v: { maxSeconds: number }) => void;
    let rejectReady!: (e: RpcError) => void;
    const readyP = new Promise<{ maxSeconds: number }>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // A session aborted before it was set up has nobody waiting on `ready`.
    readyP.catch(() => {});
    const session: LiveSession = {
      ready: readyP,
      send(pcm) {
        if (!socket || !ready || aborted || ending || ended) return false;
        const at = now();
        const seconds = pcm.length / IN_RATE;
        burst = at - lastSendAt < seconds * 500 ? burst + seconds : seconds;
        lastSendAt = at;
        lagUntil = Math.max(lagUntil, at + (burst * 1000) / CATCH_UP);
        try {
          socket.send(JSON.stringify({ realtimeInput: { audio: { data: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"), mimeType: `audio/pcm;rate=${IN_RATE}` } } }));
          return true;
        } catch {
          return false;
        }
      },
      end() {
        if (ended) return Promise.resolve(ended);
        if (!socket || !ready || aborted) return Promise.reject(new RpcError("unavailable", "gemini: the live session is not open", { provider: "gemini" }));
        return new Promise<LiveResult>((resolve) => {
          ending = resolve;
          try {
            socket!.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
          } catch {
            // the close that follows settles it
          }
          endTimer = setTimeout(() => settle({ text: transcript.display }), END_TIMEOUT_MS);
          check();
        });
      },
      buffered: () => socket?.bufferedAmount ?? 0,
      abort() {
        aborted = true;
        close();
      },
    };
    transcript.onText = (text, final) => session.onText?.(text, final);
    const close = () => {
      if (endTimer) clearTimeout(endTimer);
      endTimer = undefined;
      clearTimeout(setupTimer);
      const s = socket;
      socket = undefined;
      try {
        s?.close(1000, "done");
      } catch {
        // already closed
      }
    };
    const settle = (r: LiveResult) => {
      if (ended) return;
      ended = r;
      const done = ending;
      ending = undefined;
      close();
      done?.(r);
    };
    /** After the end of the audio: done once no stretch is open, none waits for its final, and a backlog had time to be heard. */
    const check = () => {
      if (!ending || transcript.pending) return;
      const wait = lagUntil - now();
      if (wait <= 0) settle({ text: transcript.text });
      else setTimeout(check, wait);
    };

    const key = opts.apiKey();
    if (!key) {
      rejectReady(new RpcError("unavailable", "no Gemini API key: set one in Settings, [providers.gemini] api_key or GEMINI_API_KEY", { provider: "gemini" }));
      return session;
    }
    const url = `${opts.baseUrl.replace(/\/$/, "").replace(/^http/, "ws")}${PATH}`;
    setupTimer = setTimeout(() => {
      if (ready) return;
      rejectReady(new RpcError("timeout", `gemini: the live session was not set up within ${SETUP_TIMEOUT_MS} ms`, { provider: "gemini" }));
      close();
    }, SETUP_TIMEOUT_MS);
    try {
      socket = connect(url, { "x-goog-api-key": key });
    } catch (e) {
      clearTimeout(setupTimer);
      rejectReady(new RpcError("unavailable", `gemini: ${e instanceof Error ? e.message : String(e)}`, { provider: "gemini" }));
      return session;
    }
    const s = socket;
    s.onopen = () => {
      const transcription: Record<string, unknown> = { mode: "SMART" };
      if (language) transcription["languageCodes"] = [language];
      if (vocabulary && vocabulary.length > 0) transcription["customVocabulary"] = vocabulary.slice(0, 100);
      s.send(
        JSON.stringify({
          setup: {
            model: `models/${opts.model}`,
            generationConfig: { responseModalities: ["TEXT"] },
            inputAudioTranscription: transcription,
            realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
          },
        }),
      );
    };
    s.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        const raw = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8");
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg["setupComplete"] !== undefined && !ready) {
        ready = true;
        clearTimeout(setupTimer);
        resolveReady({ maxSeconds: LIVE_MAX_SECONDS });
        return;
      }
      if (msg["goAway"] !== undefined) {
        sawGoAway = true;
        opts.log?.debug("gemini live: the session nears its end", { goAway: msg["goAway"] });
        return;
      }
      transcript.take(msg);
      check();
    };
    s.onerror = () => {
      // the close follows and says why
    };
    s.onclose = (ev) => {
      clearTimeout(setupTimer);
      if (socket === s) socket = undefined;
      if (aborted) return;
      if (!ready) {
        rejectReady(refusal(ev.code, ev.reason));
        return;
      }
      if (ended) return;
      if (ending) {
        settle({ text: transcript.display });
        return;
      }
      // Closed under an utterance: at the session's end, what was heard stands; otherwise it failed.
      const outcome = sawGoAway ? { text: transcript.display, stopped: "limit" as const } : undefined;
      if (outcome) ended = outcome;
      session.onEnded?.(outcome ?? { error: refusal(ev.code, ev.reason) });
    };
    return session;
  };
}
