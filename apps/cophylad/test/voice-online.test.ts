// The online engines over fakes of the vendors and the server: Gemini hears the utterance as a
// WAV and is asked for the words alone; DeepInfra's WAV plays as it streams, at 24 kHz; each
// engine tries its routes in order, a route that cannot serve passes the call on, and one that
// fails for another reason, or after it has spoken, is the answer. An utterance longer than a
// request carries goes in pieces cut at its quietest moments, each minute sent while the user
// still talks once speech was heard, and none before.

import { describe, expect, test } from "bun:test";
import { RpcError } from "@cophyla/protocol";
import { silentLogger } from "../src/log.ts";
import type { SttStream } from "../src/voice/engines.ts";
import type { OnlineDeps } from "../src/voice/online.ts";
import { CLEAN_MODEL, deepinfraSpeak, geminiSmartTranscribe, geminiTranscribe, interactionText, KOKORO_VOICES, MAX_SECONDS, onlineStt, onlineTts, PIECE_SECONDS, RATE_RETRY_MAX_S, rateLimited, routesFor, splitAtQuiet, transcribeLong, wavOf } from "../src/voice/online.ts";

type Call = { url: string; init: RequestInit };

function fakeFetch(answer: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const geminiSays = (text: string) => Response.json({ candidates: [{ content: { parts: [{ text }] } }] });

/** A WAV of `samples` at `rate`, streamed back in pieces of `piece` bytes. */
function streamedWav(samples: Int16Array, rate: number, piece: number): Response {
  const bytes = wavOf(samples, rate);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let o = 0; o < bytes.length; o += piece) c.enqueue(bytes.slice(o, o + piece));
      c.close();
    },
  });
  return new Response(body, { headers: { "content-type": "audio/wav" } });
}

const ramp = (n: number) => Int16Array.from({ length: n }, (_, i) => (i % 200) * 10);

function deps(over: Partial<OnlineDeps> = {}): OnlineDeps {
  return {
    sttRoutes: () => ["server", "byok:gemini"],
    ttsRoutes: () => ["server", "byok:deepinfra"],
    gemini: { apiKey: () => "g-key", baseUrl: "https://gemini.test", model: "gemini-2.5-flash-lite", liveModel: "gemini-3.5-transcribe-live", fetch: fakeFetch(() => geminiSays("unused")).fetch },
    deepinfra: { apiKey: () => "d-key", baseUrl: "https://deepinfra.test", model: "hexgrad/Kokoro-82M", fetch: fakeFetch(() => new Response("", { status: 500 })).fetch },
    log: silentLogger,
    ...over,
  };
}

async function transcribeWith(engine: ReturnType<typeof onlineStt>, samples: number): Promise<string> {
  const stream = engine.stream();
  stream.accept(ramp(samples));
  return stream.final();
}

describe("Gemini transcription", () => {
  test("hears the utterance as a WAV in the prompt, asks for the words alone, and answers them trimmed", async () => {
    const f = fakeFetch(() => geminiSays("  What time is it?\n"));
    const text = await geminiTranscribe(ramp(16000), "en", { apiKey: () => "g-key", baseUrl: "https://gemini.test/", model: "gemini-2.5-flash-lite", fetch: f.fetch });
    expect(text).toBe("What time is it?");
    const call = f.calls[0]!;
    expect(call.url).toBe("https://gemini.test/v1beta/models/gemini-2.5-flash-lite:generateContent");
    expect((call.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-key");
    const body = JSON.parse(String(call.init.body)) as { contents: { parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] }[]; generationConfig: Record<string, unknown> };
    const [prompt, audio] = body.contents[0]!.parts;
    expect(prompt!.text).toContain("transcript alone");
    expect(prompt!.text).toContain("The language is en.");
    expect(audio!.inlineData!.mimeType).toBe("audio/wav");
    const wav = Buffer.from(audio!.inlineData!.data, "base64");
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.length).toBe(44 + 32000);
    expect(body.generationConfig).toMatchObject({ temperature: 0, thinkingConfig: { thinkingBudget: 0 } });
    // Gemini 3 turns thinking off with its level, not a budget.
    await geminiTranscribe(ramp(160), undefined, { apiKey: () => "g-key", baseUrl: "https://gemini.test", model: "gemini-3.5-flash-lite", fetch: f.fetch });
    expect(JSON.parse(String(f.calls[1]!.init.body)).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
  });

  test("no key, a throttle and a refusal are each the error a route passes on or stops at", async () => {
    const opts = (status: number) => ({ apiKey: () => "k", baseUrl: "https://gemini.test", model: "m", fetch: fakeFetch(() => Response.json({ error: { message: "nope" } }, { status })).fetch });
    await expect(geminiTranscribe(ramp(10), undefined, { ...opts(200), apiKey: () => undefined })).rejects.toMatchObject({ code: "unavailable" });
    await expect(geminiTranscribe(ramp(10), undefined, opts(429))).rejects.toMatchObject({ code: "quota_exceeded" });
    await expect(geminiTranscribe(ramp(10), undefined, opts(400))).rejects.toMatchObject({ code: "invalid" });
    await expect(geminiTranscribe(ramp(10), undefined, opts(503))).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("Clean up speech", () => {
  const answered = (text: string) => Response.json({ id: "interactions/1", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text }] }] });

  test("Gemini's transcription model in smart mode, over the Interactions API, the WAV inline and the key in a header", async () => {
    const f = fakeFetch(() => answered(" Move the meeting to Tuesday. "));
    const text = await geminiSmartTranscribe(ramp(16000), "en", { apiKey: () => "g-key", baseUrl: "https://gemini.test/", model: CLEAN_MODEL, fetch: f.fetch });
    expect(text).toBe("Move the meeting to Tuesday.");
    expect(f.calls[0]!.url).toBe("https://gemini.test/v1beta/interactions");
    expect(f.calls[0]!.url).not.toContain("g-key");
    expect((f.calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-key");
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body.model).toBe("models/gemini-3.5-transcribe");
    expect(body.generation_config).toEqual({ transcription_config: { mode: "smart", language_codes: ["en"] } });
    expect(body.input[0].type).toBe("audio");
    expect(body.input[0].mime_type).toBe("audio/wav");
    expect(Buffer.from(body.input[0].data, "base64").subarray(0, 4).toString()).toBe("RIFF");
    // no language: Gemini hears which
    await geminiSmartTranscribe(ramp(1600), undefined, { apiKey: () => "g-key", baseUrl: "https://gemini.test", model: CLEAN_MODEL, fetch: f.fetch });
    expect(JSON.parse(String(f.calls[1]!.init.body)).generation_config).toEqual({ transcription_config: { mode: "smart" } });
    await expect(geminiSmartTranscribe(ramp(1600), "en", { apiKey: () => undefined, baseUrl: "https://gemini.test", model: CLEAN_MODEL, fetch: f.fetch })).rejects.toMatchObject({ code: "unavailable" });
    const throttled = fakeFetch(() => new Response("{}", { status: 429 }));
    await expect(geminiSmartTranscribe(ramp(1600), "en", { apiKey: () => "g-key", baseUrl: "https://gemini.test", model: CLEAN_MODEL, fetch: throttled.fetch })).rejects.toBeInstanceOf(RpcError);
  });

  test("the transcript is the answer's output text, or its steps' text", () => {
    expect(interactionText({ output_text: " Said. " })).toBe("Said.");
    expect(interactionText({ steps: [{ content: [{ type: "text", text: "One. " }, { type: "thought", text: "no" }] }, { content: [{ type: "text", text: "Two." }] }] })).toBe("One. Two.");
    expect(interactionText({})).toBe("");
  });

  test("on, the user's key goes to the cleanup model and the server is asked to clean up; off, both give the words as said", async () => {
    let clean = false;
    const asked: (boolean | undefined)[] = [];
    const g = fakeFetch((call) => (call.url.endsWith("/interactions") ? answered("cleaned") : geminiSays("as said")));
    const own = deps({ sttRoutes: () => ["byok:gemini"], gemini: { ...deps().gemini, cleanModel: "my-clean-model", fetch: g.fetch }, clean: () => clean });
    expect(await transcribeWith(onlineStt(own), 8000)).toBe("as said");
    clean = true;
    expect(await transcribeWith(onlineStt(own), 8000)).toBe("cleaned");
    expect(JSON.parse(String(g.calls[1]!.init.body)).model).toBe("models/my-clean-model");
    const server = deps({
      server: {
        transcribe: async (_pcm, _language, c) => {
          asked.push(c);
          return "from the server";
        },
        speak: () => ({ async *[Symbol.asyncIterator]() {} }),
      },
      clean: () => clean,
    });
    expect(await transcribeWith(onlineStt(server), 8000)).toBe("from the server");
    clean = false;
    await transcribeWith(onlineStt(server), 8000);
    expect(asked).toEqual([true, false]);
  });

  test("every piece of a long utterance is cleaned up or none is, as it was when its first piece went", async () => {
    let clean = true;
    const asked: (boolean | undefined)[] = [];
    const server = deps({
      server: {
        transcribe: async (_pcm, _language, c) => {
          asked.push(c);
          clean = false;
          return "piece";
        },
        speak: () => ({ async *[Symbol.asyncIterator]() {} }),
      },
      clean: () => clean,
    });
    await transcribeWith(onlineStt(server), 150 * 16000);
    expect(asked).toEqual([true, true, true]);
  });
});

describe("transcription over the routes", () => {
  test("the server first; a refusal there passes the utterance to the user's own key", async () => {
    const heard: number[] = [];
    const g = fakeFetch(() => geminiSays("from gemini"));
    const refused = deps({
      server: { transcribe: async () => Promise.reject(new RpcError("unavailable", "not signed in")), speak: () => ({ async *[Symbol.asyncIterator]() {} }) },
      gemini: { ...deps().gemini, fetch: g.fetch },
    });
    expect(await transcribeWith(onlineStt(refused), 8000)).toBe("from gemini");
    expect(g.calls).toHaveLength(1);

    const served = deps({
      server: {
        transcribe: async (pcm) => {
          heard.push(pcm.length);
          return "from the server";
        },
        speak: () => ({ async *[Symbol.asyncIterator]() {} }),
      },
      gemini: { ...deps().gemini, fetch: g.fetch },
    });
    expect(await transcribeWith(onlineStt(served), 8000)).toBe("from the server");
    expect(heard).toEqual([8000]);
    expect(g.calls).toHaveLength(1);
  });

  test("a failure that is not a refusal is the answer, every route refusing is an empty utterance, and silence sends nothing", async () => {
    const g = fakeFetch(() => geminiSays("never"));
    const broken = deps({ server: { transcribe: async () => Promise.reject(new RpcError("invalid", "bad audio")), speak: () => ({ async *[Symbol.asyncIterator]() {} }) }, gemini: { ...deps().gemini, fetch: g.fetch } });
    expect(await transcribeWith(onlineStt(broken), 8000)).toBe("");
    expect(g.calls).toHaveLength(0);

    const none = deps({ sttRoutes: () => ["server", "byok:gemini"], gemini: { ...deps().gemini, apiKey: () => undefined, fetch: g.fetch } });
    expect(await transcribeWith(onlineStt(none), 8000)).toBe("");
    expect(await onlineStt(deps({ gemini: { ...deps().gemini, fetch: g.fetch } })).stream().final()).toBe("");
    expect(g.calls).toHaveLength(0);
  });
});

describe("long utterances", () => {
  /** Speech with a silent stretch of `gapMs` at each of `gaps` seconds. */
  const speechWithGaps = (seconds: number, gaps: number[], gapMs = 300) => {
    const pcm = ramp(seconds * 16000).map((v) => v + 500);
    for (const at of gaps) pcm.fill(0, at * 16000, at * 16000 + (gapMs / 1000) * 16000);
    return pcm;
  };

  test("an utterance is cut before each minute at its quietest moment, and the pieces make it whole again", () => {
    const pcm = speechWithGaps(150, [57, 116]);
    const pieces = splitAtQuiet(pcm);
    expect(pieces).toHaveLength(3);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(PIECE_SECONDS * 16000);
    // Each cut falls in the gap before its mark.
    expect(pieces[0]!.length / 16000).toBeGreaterThan(57);
    expect(pieces[0]!.length / 16000).toBeLessThan(57.3);
    expect((pieces[0]!.length + pieces[1]!.length) / 16000).toBeGreaterThan(116);
    expect((pieces[0]!.length + pieces[1]!.length) / 16000).toBeLessThan(116.3);
    expect(pieces.reduce((n, p) => n + p.length, 0)).toBe(pcm.length);
    // A minute or less is one piece.
    expect(splitAtQuiet(ramp(60 * 16000))).toHaveLength(1);
  });

  test("the pieces go two at a time, their words joined in order; a piece that fails is left out", async () => {
    const pcm = speechWithGaps(250, [58, 117, 176, 235]);
    let inFlight = 0;
    let most = 0;
    const seen: number[] = [];
    const r = await transcribeLong(pcm, async (piece) => {
      inFlight++;
      most = Math.max(most, inFlight);
      const i = seen.length;
      seen.push(piece.length);
      await new Promise((res) => setTimeout(res, 5 * (5 - i)));
      inFlight--;
      if (i === 2) throw new RpcError("unavailable", "one piece lost");
      return { text: `piece ${i}`, route: "byok:gemini" };
    });
    expect(most).toBe(2);
    expect(seen).toHaveLength(5);
    expect(r).toEqual({ text: "piece 0 piece 1 piece 3 piece 4", route: "byok:gemini" });
    await expect(transcribeLong(ramp(16000), async () => Promise.reject(new RpcError("unavailable", "down")))).rejects.toThrow("down");
  });

  test("a four-minute utterance on the batch engine goes to the server in pieces of at most a minute, none of it dropped", async () => {
    const heard: number[] = [];
    const engine = onlineStt(
      deps({
        server: {
          transcribe: async (pcm) => {
            heard.push(pcm.length);
            return `part ${heard.length}`;
          },
          speak: () => ({ async *[Symbol.asyncIterator]() {} }),
        },
      }),
    );
    expect(engine.maxSeconds).toBe(MAX_SECONDS);
    const stream = engine.stream();
    const pcm = speechWithGaps(240, [55, 110, 170, 225]);
    for (let o = 0; o < pcm.length; o += 640) stream.accept(pcm.subarray(o, o + 640));
    expect(await stream.final()).toBe("part 1 part 2 part 3 part 4 part 5");
    expect(heard.reduce((a, b) => a + b, 0)).toBe(pcm.length);
    for (const n of heard) expect(n).toBeLessThanOrEqual(60 * 16000);
    expect(stream.how).toEqual({ route: "server", live: false });
  });

  /** An engine whose server keeps each piece it was sent, and answers once `answer` is called. */
  const holding = (clean?: () => boolean) => {
    const sent: { samples: number; clean: boolean | undefined }[] = [];
    const answers: (() => void)[] = [];
    const engine = onlineStt(
      deps({
        server: {
          transcribe: async (pcm, _language, c) => {
            const n = sent.push({ samples: pcm.length, clean: c });
            await new Promise<void>((go) => answers.push(go));
            return `part ${n}`;
          },
          speak: () => ({ async *[Symbol.asyncIterator]() {} }),
        },
        ...(clean ? { clean } : {}),
      }),
    );
    const answerAll = async () => {
      // pieces waiting for a slot are sent as the ones before them are answered
      for (let i = 0; i < 20 && answers.length > 0; i++) {
        answers.splice(0).forEach((go) => go());
        await Bun.sleep(1);
      }
    };
    return { engine, sent, answerAll };
  };
  const say = (stream: SttStream, pcm: Int16Array) => {
    for (let o = 0; o < pcm.length; o += 640) stream.accept(pcm.subarray(o, o + 640));
  };

  test("once speech is heard, each minute goes while the user still talks, so the stop waits on the last alone", async () => {
    const { engine, sent, answerAll } = holding();
    const stream = engine.stream();
    const pcm = speechWithGaps(200, [55, 110, 170]);
    say(stream, pcm.subarray(0, 5 * 16000));
    stream.heard?.();
    say(stream, pcm.subarray(5 * 16000, 130 * 16000));
    await Bun.sleep(1);
    // two minutes said: both are on their way before the user stops
    expect(sent.map((s) => Math.round(s.samples / 16000))).toEqual([55, 55]);
    say(stream, pcm.subarray(130 * 16000));
    await Bun.sleep(1);
    // the third minute is cut too, and waits for one of the two on their way
    expect(sent).toHaveLength(2);
    const text = stream.final();
    await answerAll();
    expect(await text).toBe("part 1 part 2 part 3 part 4");
    // cut where the whole utterance would have been cut, and nothing dropped
    expect(sent.map((s) => s.samples)).toEqual(splitAtQuiet(pcm).map((p) => p.length));
    expect(stream.how).toEqual({ route: "server", live: false });
  });

  test("before speech is heard nothing is sent, and a recording taken back lets its pieces go", async () => {
    const { engine, sent, answerAll } = holding();
    const quiet = engine.stream();
    say(quiet, speechWithGaps(130, [55, 110]));
    await Bun.sleep(1);
    expect(sent).toHaveLength(0);
    quiet.dispose();
    const dropped = engine.stream();
    dropped.heard?.();
    say(dropped, speechWithGaps(70, [55]));
    await Bun.sleep(1);
    expect(sent).toHaveLength(1);
    dropped.dispose();
    await answerAll();
    // what was on its way comes back to nothing, and nothing more goes
    expect(await dropped.final()).toBe("");
    expect(sent).toHaveLength(1);
  });

  test("every piece of an utterance is cleaned up as its first was, though the setting changed while it was said", async () => {
    let clean = true;
    const { engine, sent, answerAll } = holding(() => clean);
    const stream = engine.stream();
    stream.heard?.();
    say(stream, speechWithGaps(70, [55]));
    clean = false;
    say(stream, speechWithGaps(60, [50]));
    const text = stream.final();
    await answerAll();
    await text;
    expect(sent.map((s) => s.clean)).toEqual([true, true, true]);
  });

  test("the server refusing a plan the node thought it had passes on; any other route's refusal is the answer", async () => {
    const g = fakeFetch(() => geminiSays("from gemini"));
    const stale = deps({ server: { transcribe: async () => Promise.reject(new RpcError("denied", "the plan has no hosted voice")), speak: () => ({ async *[Symbol.asyncIterator]() {} }) }, gemini: { ...deps().gemini, fetch: g.fetch } });
    expect(await transcribeWith(onlineStt(stale), 8000)).toBe("from gemini");
    const denied = fakeFetch(() => Response.json({ error: { message: "no" } }, { status: 400 }));
    const own = deps({ sttRoutes: () => ["byok:gemini", "server"], server: { transcribe: async () => "never", speak: () => ({ async *[Symbol.asyncIterator]() {} }) }, gemini: { ...deps().gemini, fetch: denied.fetch } });
    expect(await transcribeWith(onlineStt(own), 8000)).toBe("");
  });

  test("the app's pick says where the routes go first; with none they are config.toml's", () => {
    expect(routesFor(["server", "byok:gemini"], undefined)).toEqual(["server", "byok:gemini"]);
    expect(routesFor(["server", "byok:gemini"], "own")).toEqual(["byok:gemini"]);
    expect(routesFor(["byok:gemini"], "cloud")).toEqual(["server", "byok:gemini"]);
    expect(routesFor(["byok:gemini", "server"], "cloud")).toEqual(["server", "byok:gemini"]);
  });
});

describe("Kokoro online", () => {
  test("DeepInfra's WAV plays as it streams, at 24 kHz, in the voice asked for", async () => {
    const samples = ramp(24000);
    const f = fakeFetch(() => streamedWav(samples, 24000, 3001));
    const chunks: Int16Array[] = [];
    for await (const c of deepinfraSpeak("Hello there.", "af_bella", { apiKey: () => "d-key", baseUrl: "https://deepinfra.test", model: "hexgrad/Kokoro-82M", fetch: f.fetch })) chunks.push(c);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const all = Int16Array.from(chunks.flatMap((c) => [...c]));
    expect(all.length).toBe(samples.length);
    expect([...all.subarray(0, 500)]).toEqual([...samples.subarray(0, 500)]);
    expect(f.calls[0]!.url).toBe("https://deepinfra.test/v1/openai/audio/speech");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ model: "hexgrad/Kokoro-82M", input: "Hello there.", voice: "af_bella", response_format: "wav" });
  });

  test("the server first, the user's DeepInfra key when it refuses; the voice is counted from Kokoro's list", async () => {
    const f = fakeFetch(() => streamedWav(ramp(4800), 24000, 9600));
    const asked: string[] = [];
    const engine = onlineTts(
      deps({
        server: {
          transcribe: async () => "",
          speak: (_text, voice) => ({
            async *[Symbol.asyncIterator]() {
              asked.push(voice);
              throw new RpcError("unavailable", "the plan has no hosted voice");
            },
          }),
        },
        deepinfra: { ...deps().deepinfra, fetch: f.fetch },
      }),
    );
    expect(engine.name).toBe("kokoro-online");
    expect(engine.voices).toBe(KOKORO_VOICES.length);
    engine.useVoice?.(2);
    expect(engine.voice).toBe(2);
    const got: Int16Array[] = [];
    for await (const c of engine.synth("Hi.")) got.push(c);
    expect(got.reduce((n, c) => n + c.length, 0)).toBe(4800);
    expect(asked).toEqual([KOKORO_VOICES[2]]);
    expect(JSON.parse(String(f.calls[0]!.init.body)).voice).toBe(KOKORO_VOICES[2]);
  });

  test("a route that fails after it has spoken is the answer: the line is not said twice", async () => {
    const f = fakeFetch(() => streamedWav(ramp(4800), 24000, 9600));
    const engine = onlineTts(
      deps({
        server: {
          transcribe: async () => "",
          speak: () => ({
            async *[Symbol.asyncIterator]() {
              yield new Int16Array(4800);
              throw new RpcError("unavailable", "the link dropped");
            },
          }),
        },
        deepinfra: { ...deps().deepinfra, fetch: f.fetch },
      }),
    );
    const got: Int16Array[] = [];
    await expect(
      (async () => {
        for await (const c of engine.synth("Hi.")) got.push(c);
      })(),
    ).rejects.toThrow("the link dropped");
    expect(got).toHaveLength(1);
    expect(f.calls).toHaveLength(0);
  });

  test("with no route that can speak, the line fails with every route's reason", async () => {
    const engine = onlineTts(deps({ ttsRoutes: () => ["byok:deepinfra"], deepinfra: { ...deps().deepinfra, apiKey: () => undefined } }));
    await expect(
      (async () => {
        for await (const _ of engine.synth("Hi.")) {
          // nothing
        }
      })(),
    ).rejects.toThrow("no DeepInfra API key");
  });
});

describe("transcription under a rate limit", () => {
  const limit = (what: string, retryS?: number) => new RpcError("quota_exceeded", `gemini: Rate limit exceeded for model ${what} (limit: 100 requests per day on Tier 1).${retryS !== undefined ? ` Please retry in ${retryS}s or upgrade your tier at https://ai.dev/rate-limit.` : ""}`, { provider: "gemini", status: 429 });
  const silent = () => ({ async *[Symbol.asyncIterator]() {} });

  test("a rate limit is told apart from other refusals, with the wait it names", () => {
    expect(rateLimited(limit("gemini-3.5-transcribe", 13))).toEqual({ retryS: 13 });
    expect(rateLimited(limit("gemini-3.5-transcribe"))).toEqual({});
    expect(rateLimited(new RpcError("unavailable", "server: gemini: Rate limit exceeded for model x. Please retry in 2.5s"))).toEqual({ retryS: 2.5 });
    expect(rateLimited(new RpcError("quota_exceeded", "the account's transcription allowance is spent"))).toBeUndefined();
    expect(rateLimited(new RpcError("unavailable", "not signed in"))).toBeUndefined();
  });

  test("the clean-up model rate-limited, the same route transcribes the words as said, before any other route", async () => {
    const asked: string[] = [];
    const g = fakeFetch(() => geminiSays("from my key"));
    const d = deps({
      server: {
        transcribe: async (_pcm, _language, clean) => {
          asked.push(clean ? "server clean" : "server as said");
          if (clean) throw limit("gemini-3.5-transcribe", 13);
          return "as said by the server";
        },
        speak: silent,
      },
      gemini: { ...deps().gemini, fetch: g.fetch },
      clean: () => true,
    });
    const stream = onlineStt(d).stream();
    stream.accept(ramp(8000));
    expect(await stream.final()).toBe("as said by the server");
    expect(asked).toEqual(["server clean", "server as said"]);
    expect(g.calls).toHaveLength(0);
    expect(stream.how).toEqual({ route: "server", live: false });
  });

  test("every route rate-limited with a short wait: tried again once after it, and taken then", async () => {
    let calls = 0;
    const waited: number[] = [];
    const g = fakeFetch(() => new Response(JSON.stringify({ error: { message: "Rate limit exceeded for model gemini-3.5-transcribe. Please retry in 12s." } }), { status: 429 }));
    const d = deps({
      server: {
        transcribe: async () => {
          if (++calls <= 1) throw limit("gemini-2.5-flash-lite", 13);
          return "after the wait";
        },
        speak: silent,
      },
      gemini: { ...deps().gemini, fetch: g.fetch },
      sleep: async (ms) => {
        waited.push(ms);
      },
    });
    expect(await transcribeWith(onlineStt(d), 8000)).toBe("after the wait");
    // the shortest wait named, and a little more
    expect(waited).toEqual([12_250]);
  });

  test("still limited after the wait, or a wait too long to sit out: no words, and the stream says it was the limit", async () => {
    const waited: number[] = [];
    const always = (retryS: number) =>
      deps({
        sttRoutes: () => ["server"],
        server: { transcribe: async () => Promise.reject(limit("gemini-2.5-flash-lite", retryS)), speak: silent },
        sleep: async (ms) => {
          waited.push(ms);
        },
      });
    const stream = onlineStt(always(5)).stream();
    stream.accept(ramp(8000));
    expect(await stream.final()).toBe("");
    expect(stream.how).toEqual({ route: "none", live: false, failed: "limited" });
    expect(waited).toEqual([5_250]);
    const long = onlineStt(always(RATE_RETRY_MAX_S + 1)).stream();
    long.accept(ramp(8000));
    expect(await long.final()).toBe("");
    expect(long.how?.failed).toBe("limited");
    expect(waited).toHaveLength(1);
    // a route down is not a limit, and nothing is waited for
    const down = onlineStt(deps({ sttRoutes: () => ["server"], server: { transcribe: async () => Promise.reject(new RpcError("unavailable", "the server is down")), speak: silent } })).stream();
    down.accept(ramp(8000));
    expect(await down.final()).toBe("");
    expect(down.how?.failed).toBe("unavailable");
  });

  test("a long utterance whose every piece was rate-limited fails as limited; one piece down makes it unavailable", async () => {
    const pcm = ramp(150 * 16000);
    await expect(transcribeLong(pcm, async () => Promise.reject(limit("x")))).rejects.toMatchObject({ code: "quota_exceeded" });
    let n = 0;
    await expect(transcribeLong(pcm, async () => Promise.reject(n++ === 0 ? new RpcError("unavailable", "down") : limit("x")))).rejects.toMatchObject({ code: "unavailable" });
  });
});
