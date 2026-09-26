// The online engines over fakes of the vendors and the server: Gemini hears the utterance as a
// WAV and is asked for the words alone; DeepInfra's WAV plays as it streams, at 24 kHz; each
// engine tries its routes in order, a route that cannot serve passes the call on, and one that
// fails for another reason, or after it has spoken, is the answer.

import { describe, expect, test } from "bun:test";
import { RpcError } from "@cophyla/protocol";
import { silentLogger } from "../src/log.ts";
import type { OnlineDeps } from "../src/voice/online.ts";
import { deepinfraSpeak, geminiTranscribe, KOKORO_VOICES, onlineStt, onlineTts, wavOf } from "../src/voice/online.ts";

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
    sttRoutes: ["server", "byok:gemini"],
    ttsRoutes: ["server", "byok:deepinfra"],
    gemini: { apiKey: () => "g-key", baseUrl: "https://gemini.test", model: "gemini-2.5-flash-lite", fetch: fakeFetch(() => geminiSays("unused")).fetch },
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

    const none = deps({ sttRoutes: ["server", "byok:gemini"], gemini: { ...deps().gemini, apiKey: () => undefined, fetch: g.fetch } });
    expect(await transcribeWith(onlineStt(none), 8000)).toBe("");
    expect(await onlineStt(deps({ gemini: { ...deps().gemini, fetch: g.fetch } })).stream().final()).toBe("");
    expect(g.calls).toHaveLength(0);
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
    const engine = onlineTts(deps({ ttsRoutes: ["byok:deepinfra"], deepinfra: { ...deps().deepinfra, apiKey: () => undefined } }));
    await expect(
      (async () => {
        for await (const _ of engine.synth("Hi.")) {
          // nothing
        }
      })(),
    ).rejects.toThrow("no DeepInfra API key");
  });
});
