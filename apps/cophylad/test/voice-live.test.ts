// Live transcription: the stream that opens a session once speech is heard and tries the
// routes in order, sends what it holds then what comes, shows the words as they come, and
// falls back to the utterance whole when no session hears it or one fails under it; and the
// own-key Gemini Live client over a fake socket, with the transcript rules measured against
// the service.

import { describe, expect, test } from "bun:test";
import { RpcError } from "@cophyla/protocol";
import { silentLogger } from "../src/log.ts";
import type { LiveOpener, LiveResult, LiveSession, SttStream } from "../src/voice/engines.ts";
import { geminiLive, LIVE_MAX_SECONDS, LiveTranscript } from "../src/voice/gemini-live.ts";
import type { LiveSocket } from "../src/voice/gemini-live.ts";
import { LEAD_IN_SECONDS, liveStt, PIECE_MAX, SEND_MIN } from "../src/voice/live.ts";
import type { LiveSttDeps } from "../src/voice/live.ts";
import { waitFor } from "./helpers.ts";

const FRAME = 640;
const frame = (level = 1000) => new Int16Array(FRAME).fill(level);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A session the test drives: its readiness, its end, what it was sent. */
interface Scripted {
  route: string;
  opts: { language?: string; vocabulary?: string[] };
  sent: Int16Array[];
  aborted: boolean;
  ended: boolean;
  sendOk: boolean;
  bufferedBytes: number;
  session: LiveSession;
  ready(maxSeconds?: number): void;
  refuse(e: RpcError): void;
  finish(r: LiveResult): void;
  fail(e: RpcError): void;
}

function scripted(route: string, all: Scripted[]): LiveOpener {
  return (opts) => {
    let ready!: (v: { maxSeconds: number }) => void;
    let refuse!: (e: unknown) => void;
    let finish!: (r: LiveResult) => void;
    let fail!: (e: unknown) => void;
    const readyP = new Promise<{ maxSeconds: number }>((a, b) => ((ready = a), (refuse = b)));
    const endP = new Promise<LiveResult>((a, b) => ((finish = a), (fail = b)));
    const s: Scripted = {
      route,
      opts,
      sent: [],
      aborted: false,
      ended: false,
      sendOk: true,
      bufferedBytes: 0,
      session: undefined as unknown as LiveSession,
      ready: (maxSeconds = LIVE_MAX_SECONDS) => ready({ maxSeconds }),
      refuse: (e) => refuse(e),
      finish: (r) => finish(r),
      fail: (e) => fail(e),
    };
    s.session = {
      ready: readyP,
      send: (pcm) => {
        if (!s.sendOk) return false;
        s.sent.push(pcm);
        return true;
      },
      end: () => {
        s.ended = true;
        return endP;
      },
      buffered: () => s.bufferedBytes,
      abort: () => {
        s.aborted = true;
      },
    };
    all.push(s);
    return s.session;
  };
}

function setup(over: Partial<LiveSttDeps> & { routes?: () => string[] } = {}) {
  const sessions: Scripted[] = [];
  const batches: number[] = [];
  let batchAnswer: () => Promise<{ text: string; route?: string }> = async () => ({ text: "whole", route: "byok:gemini" });
  const deps: LiveSttDeps = {
    routes: () => ["server", "byok:gemini"],
    opener: (route) => (route === "server" || route === "byok:gemini" ? scripted(route, sessions) : undefined),
    batch: async (pcm) => {
      batches.push(pcm.length);
      return batchAnswer();
    },
    maxSeconds: 570,
    log: silentLogger,
    openWaitMs: 50,
    endWaitMs: 50,
    ...over,
  };
  const engine = liveStt(deps);
  const stream = engine.stream();
  const shown: string[] = [];
  const stops: string[] = [];
  stream.onPartial = (t) => shown.push(t);
  stream.onStop = (why) => stops.push(why);
  return { engine, stream, sessions, batches, shown, stops, answerBatch: (fn: typeof batchAnswer) => (batchAnswer = fn) };
}

const total = (pcm: Int16Array[]) => pcm.reduce((n, p) => n + p.length, 0);

describe("the live stream", () => {
  test("nothing opens until speech is heard; then what came shortly before goes first, a second at a time, and the rest a few frames at a time", async () => {
    const { stream, sessions } = setup();
    stream.accept(new Int16Array(3200));
    for (let i = 0; i < 100; i++) stream.accept(frame(0));
    expect(sessions).toHaveLength(0);
    for (let i = 0; i < 10; i++) stream.accept(frame());
    stream.heard!();
    stream.heard!();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.route).toBe("server");
    const held = 3200 + 110 * FRAME;
    sessions[0]!.ready();
    await sleep(0);
    // The last two seconds before the speech was heard, in pieces of a second at most.
    expect(total(sessions[0]!.sent)).toBe(LEAD_IN_SECONDS * 16000);
    expect(Math.max(...sessions[0]!.sent.map((p) => p.length))).toBeLessThanOrEqual(PIECE_MAX);
    expect(held - LEAD_IN_SECONDS * 16000).toBeGreaterThan(0);
    // Then nothing until three frames are waiting.
    stream.accept(frame());
    stream.accept(frame());
    expect(total(sessions[0]!.sent)).toBe(LEAD_IN_SECONDS * 16000);
    stream.accept(frame());
    expect(sessions[0]!.sent.at(-1)!.length).toBe(SEND_MIN);
  });

  test("the words shown are the stretches kept and the one in progress, never the same text twice", async () => {
    const { stream, sessions, shown } = setup();
    stream.accept(frame());
    stream.heard!();
    sessions[0]!.ready();
    await sleep(0);
    const s = sessions[0]!.session;
    s.onText!("What", false);
    s.onText!("What is", false);
    s.onText!("What is", false);
    s.onText!("What is it?", true);
    s.onText!("Tell", false);
    s.onText!("Tell me", false);
    expect(shown).toEqual(["What", "What is", "What is it?", "What is it? Tell", "What is it? Tell me"]);
  });

  test("a route that refuses before it hears passes to the next; the server's denial passes on too, another's is the end of trying", async () => {
    const a = setup();
    for (let i = 0; i < 3; i++) a.stream.accept(frame());
    a.stream.heard!();
    a.sessions[0]!.refuse(new RpcError("denied", "the plan has no hosted voice"));
    await waitFor(() => a.sessions.length === 2);
    expect(a.sessions[0]!.aborted).toBe(true);
    expect(a.sessions[1]!.route).toBe("byok:gemini");
    a.sessions[1]!.ready();
    await sleep(0);
    expect(a.sessions[1]!.sent.length).toBeGreaterThan(0);

    const b = setup({ routes: () => ["byok:gemini", "server"] });
    b.stream.accept(frame());
    b.stream.heard!();
    b.sessions[0]!.refuse(new RpcError("denied", "no"));
    await sleep(10);
    expect(b.sessions).toHaveLength(1);
    // Nothing hears: the utterance goes whole at its end.
    expect(await b.stream.final()).toBe("whole");
    expect(b.batches).toEqual([FRAME]);
    expect(b.stream.how).toEqual({ route: "byok:gemini", live: false });
  });

  test("at the end the rest goes, the session is ended, and its transcript is the utterance's", async () => {
    const { stream, sessions, batches } = setup();
    stream.accept(frame());
    stream.heard!();
    sessions[0]!.ready();
    await sleep(0);
    stream.accept(frame());
    const done = stream.final();
    await sleep(0);
    expect(sessions[0]!.ended).toBe(true);
    expect(total(sessions[0]!.sent)).toBe(2 * FRAME);
    sessions[0]!.finish({ text: "the whole of it" });
    expect(await done).toBe("the whole of it");
    expect(batches).toEqual([]);
    expect(stream.how).toEqual({ route: "server", live: true });
  });

  test("last words that do not come in time leave the words so far standing", async () => {
    const { stream, sessions } = setup();
    stream.accept(frame());
    stream.heard!();
    sessions[0]!.ready();
    await sleep(0);
    sessions[0]!.session.onText!("so far", true);
    sessions[0]!.session.onText!("and then", false);
    expect(await stream.final()).toBe("so far and then");
    expect(sessions[0]!.aborted).toBe(true);
  });

  test("a session still opening at the end is given a moment; one that never opens sends the utterance whole", async () => {
    const late = setup({ openWaitMs: 200 });
    late.stream.accept(frame());
    late.stream.heard!();
    const done = late.stream.final();
    await sleep(20);
    late.sessions[0]!.ready();
    await waitFor(() => late.sessions[0]!.ended);
    late.sessions[0]!.finish({ text: "just in time" });
    expect(await done).toBe("just in time");

    const never = setup();
    never.stream.accept(frame());
    never.stream.heard!();
    expect(await never.stream.final()).toBe("whole");
    expect(never.sessions[0]!.aborted).toBe(true);
    expect(never.batches).toEqual([FRAME]);
  });

  test("more than ten seconds never sent at the end sends the utterance whole", async () => {
    const { stream, sessions, batches } = setup();
    stream.accept(frame());
    stream.heard!();
    sessions[0]!.ready();
    await sleep(0);
    sessions[0]!.sendOk = false;
    // The session failed under the utterance: the rest piles up unsent.
    for (let i = 0; i < 300; i++) stream.accept(frame());
    expect(sessions[0]!.aborted).toBe(true);
    expect(await stream.final()).toBe("whole");
    expect(batches).toEqual([301 * FRAME]);
    expect(sessions).toHaveLength(1);
  });

  test("a session that fails under the utterance is not replaced mid-sentence; the words shown stand when the whole fails too", async () => {
    const { stream, sessions, shown, answerBatch } = setup();
    stream.accept(frame());
    stream.heard!();
    sessions[0]!.ready();
    await sleep(0);
    sessions[0]!.session.onText!("half a sentence", false);
    sessions[0]!.bufferedBytes = 300_000;
    for (let i = 0; i < 3; i++) stream.accept(frame());
    expect(sessions[0]!.aborted).toBe(true);
    // Words from the dead session are not shown.
    sessions[0]!.session.onText!("ghost", false);
    expect(shown).toEqual(["half a sentence"]);
    answerBatch(async () => Promise.reject(new RpcError("unavailable", "down")));
    expect(await stream.final()).toBe("half a sentence");
    expect(sessions).toHaveLength(1);
    expect(stream.how).toEqual({ route: "none", live: false });

    const dropped = setup();
    dropped.stream.accept(frame());
    dropped.stream.heard!();
    dropped.sessions[0]!.ready();
    await sleep(0);
    dropped.sessions[0]!.session.onEnded!({ error: new RpcError("unavailable", "the link dropped") });
    expect(await dropped.stream.final()).toBe("whole");
  });

  test("a route that stops hearing ends the utterance with what it heard, and says why once", async () => {
    const { stream, sessions, stops, batches } = setup();
    stream.accept(frame());
    stream.heard!();
    sessions[0]!.ready();
    await sleep(0);
    sessions[0]!.session.onEnded!({ text: "all it heard", stopped: "quota" });
    expect(stops).toEqual(["quota"]);
    expect(await stream.final()).toBe("all it heard");
    expect(batches).toEqual([]);
  });

  test("a route that hears less than an utterance may last stops it where its allowance ends", async () => {
    const { stream, sessions, stops } = setup();
    stream.accept(frame());
    stream.heard!();
    sessions[0]!.ready(1);
    await sleep(0);
    for (let i = 0; i < 23; i++) stream.accept(frame());
    expect(stops).toEqual([]);
    stream.accept(frame());
    stream.accept(frame());
    expect(stops).toEqual(["quota"]);
  });

  test("a stream dropped while its end is awaited answers nothing, and its session is aborted", async () => {
    const { stream, sessions } = setup();
    stream.accept(frame());
    stream.heard!();
    sessions[0]!.ready();
    await sleep(0);
    const done = stream.final();
    await sleep(0);
    stream.dispose();
    expect(await done).toBe("");
    expect(sessions[0]!.aborted).toBe(true);
  });

  test("the engine's limit is the online one, and the language and vocabulary reach the session", async () => {
    const { engine } = setup({ language: "tr", vocabulary: () => ["Cophyla"] });
    expect(engine.maxSeconds).toBe(570);
    const sessions: Scripted[] = [];
    const s: SttStream = liveStt({ routes: () => ["byok:gemini"], opener: (r) => scripted(r, sessions), batch: async () => ({ text: "" }), maxSeconds: 570, language: "tr", vocabulary: () => ["Cophyla"], log: silentLogger }).stream();
    s.accept(frame());
    s.heard!();
    expect(sessions[0]!.opts).toEqual({ language: "tr", vocabulary: ["Cophyla"] });
    s.dispose();
  });
});

// --- Gemini Live with the user's own key -------------------------------------------------------

class FakeSocket implements LiveSocket {
  url: string;
  headers: Record<string, string>;
  sent: Record<string, unknown>[] = [];
  closedWith?: { code?: number; reason?: string };
  bufferedAmount = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(url: string, headers: Record<string, string>) {
    this.url = url;
    this.headers = headers;
    queueMicrotask(() => this.onopen?.({}));
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    if (this.closedWith) return;
    this.closedWith = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
    queueMicrotask(() => this.onclose?.({ code: code ?? 1000, reason: reason ?? "" }));
  }

  say(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  drop(code: number, reason: string): void {
    this.closedWith = { code, reason };
    this.onclose?.({ code, reason });
  }
}

function gemini(key: string | null = "g-key") {
  const sockets: FakeSocket[] = [];
  const opener = geminiLive({
    apiKey: () => key ?? undefined,
    baseUrl: "https://generativelanguage.googleapis.com/",
    model: "gemini-3.5-transcribe-live",
    connect: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
  });
  return { opener, sockets };
}

const interim = (text: string) => ({ serverContent: { interimInputTranscription: { text } } });
const final = (text: string) => ({ serverContent: { inputTranscription: { text } } });
const activity = (type: "ACTIVITY_START" | "ACTIVITY_END") => ({ serverContent: {}, voiceActivity: { type, audioOffset: "1s" } });

async function opened(opts: { language?: string; vocabulary?: string[] } = {}) {
  const g = gemini();
  const session = g.opener(opts);
  await sleep(0);
  const socket = g.sockets[0]!;
  socket.say({ setupComplete: {} });
  expect(await session.ready).toEqual({ maxSeconds: LIVE_MAX_SECONDS });
  return { session, socket };
}

describe("Gemini Live with the user's own key", () => {
  test("the key goes in a header, never the URL, and the setup asks for SMART transcription and nothing said back", async () => {
    const g = gemini();
    const session = g.opener({ language: "en", vocabulary: ["Cophyla"] });
    await sleep(0);
    const s = g.sockets[0]!;
    expect(s.url).toBe("wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent");
    expect(s.url).not.toContain("g-key");
    expect(s.headers).toEqual({ "x-goog-api-key": "g-key" });
    expect(s.sent[0]).toEqual({
      setup: {
        model: "models/gemini-3.5-transcribe-live",
        generationConfig: { responseModalities: ["TEXT"] },
        inputAudioTranscription: { mode: "SMART", languageCodes: ["en"], customVocabulary: ["Cophyla"] },
        realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
      },
    });
    session.abort();
    expect(s.closedWith).toBeDefined();
  });

  test("no key, a key refused and a quota each refuse before hearing, as the routes pass on", async () => {
    const none = gemini(null);
    await expect(none.opener({}).ready).rejects.toMatchObject({ code: "unavailable" });
    expect(none.sockets).toHaveLength(0);

    const refused = gemini();
    const a = refused.opener({});
    await sleep(0);
    refused.sockets[0]!.drop(1008, "Request had invalid authentication credentials.");
    await expect(a.ready).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("the key was refused") });

    const quota = gemini();
    const b = quota.opener({});
    await sleep(0);
    quota.sockets[0]!.drop(1011, "Resource has been exhausted (e.g. check quota).");
    await expect(b.ready).rejects.toMatchObject({ code: "quota_exceeded" });
  });

  test("audio goes as base64 PCM at 16 kHz; the words come as they are heard", async () => {
    const { session, socket } = await opened();
    const words: [string, boolean][] = [];
    session.onText = (t, f) => words.push([t, f]);
    expect(session.send(new Int16Array([1, -1]))).toBe(true);
    expect(socket.sent[1]).toEqual({ realtimeInput: { audio: { data: Buffer.from(new Int16Array([1, -1]).buffer).toString("base64"), mimeType: "audio/pcm;rate=16000" } } });
    socket.say(activity("ACTIVITY_START"));
    socket.say(interim("What"));
    socket.say(interim("What is the"));
    socket.say(final("What is the status?"));
    expect(words).toEqual([
      ["What", false],
      ["What is the", false],
      ["What is the status?", true],
    ]);
  });

  test("an interim that carries the last stretch's on as its start has it cut off", () => {
    const t = new LiveTranscript();
    const seen: string[] = [];
    t.onText = (text) => seen.push(text);
    t.take(interim("Part 14 and the choice for um for speech both"));
    t.take(final("Part 14. And the choice, for speech. Both."));
    t.take(interim("Part 14 and the choice for um for speech bothsaid I"));
    t.take(interim("part 14, and the choice for um for speech both said I thank. No, wait"));
    t.take(interim("Tell me"));
    expect(seen).toEqual(["Part 14 and the choice for um for speech both", "Part 14. And the choice, for speech. Both.", "said I", "said I thank. No, wait", "Tell me"]);
    expect(t.display).toBe("Part 14. And the choice, for speech. Both. Tell me");
  });

  test("the end: at once with no stretch open, after the last final with one open, and the words so far when it never comes", async () => {
    const quiet = await opened();
    quiet.socket.say(activity("ACTIVITY_START"));
    quiet.socket.say(final("Done."));
    quiet.socket.say(activity("ACTIVITY_END"));
    expect(await quiet.session.end()).toEqual({ text: "Done." });
    expect(quiet.socket.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } });
    expect(quiet.socket.closedWith).toBeDefined();

    const open = await opened();
    open.socket.say(activity("ACTIVITY_START"));
    open.socket.say(interim("still"));
    const ending = open.session.end();
    await sleep(5);
    open.socket.say(final("Still talking."));
    open.socket.say(activity("ACTIVITY_END"));
    expect(await ending).toEqual({ text: "Still talking." });
  });

  test("a session closed at its time limit keeps what it heard; one that drops is a failure", async () => {
    const limit = await opened();
    const ended: unknown[] = [];
    limit.session.onEnded = (o) => ended.push(o);
    limit.socket.say(final("Heard so far."));
    limit.socket.say({ goAway: { timeLeft: "50s" } });
    limit.socket.drop(1008, "Connection aborted because the client failed to close the connection after receiving a GoAway signal");
    expect(ended).toEqual([{ text: "Heard so far.", stopped: "limit" }]);

    const dropped = await opened();
    const failed: unknown[] = [];
    dropped.session.onEnded = (o) => failed.push(o);
    dropped.socket.drop(1011, "Internal error");
    expect(failed).toHaveLength(1);
    expect((failed[0] as { error: RpcError }).error.code).toBe("unavailable");
  });
});
