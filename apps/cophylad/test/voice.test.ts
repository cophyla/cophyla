// The voice pipeline over the socket, on fake engines: a wake word starts an utterance, the
// partials reach the brain while it grows, the end of the utterance is one `user.message`
// with `source: voice`, the brain's `voice.speak` comes back as audio to that one phone and
// to no one else, and what it says is composed for the ear with a lead-in before the quote.
// Push-to-talk, barge-in, two phones, an empty tap, a disconnect mid-turn and a stage that
// is off are the rest; then the wake word heard on the phone — where it is detected, the
// utterance `voice.wake` begins, and the abandons that end one nothing was said in. Then
// a phone that speaks Opus and acks what it played: its frames both ways, and `speaking`
// ending on its `voice.played`. Last, the speech engine picked in the app: over config.toml,
// loaded behind the answer, a voice per engine, kept across a restart, and a line to try it.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client, Message, RpcNotification, VoiceSettings, VoiceState, VoiceUnheard, WakewordMode } from "@cophyla/protocol";
import type { Daemon } from "../src/daemon.ts";
import { ClientRegistry } from "../src/api/clients.ts";
import { Bus } from "../src/bus.ts";
import { Activity } from "../src/chat/activity.ts";
import { Chat } from "../src/chat/index.ts";
import { Asks } from "../src/gate/asks.ts";
import { silentLogger } from "../src/log.ts";
import { Sidecars } from "../src/sidecars/index.ts";
import { Store } from "../src/store/index.ts";
import { PREVIEW_LINE, Voice } from "../src/voice/index.ts";
import { storePrefs, VOICE_KV_NS } from "../src/voice/prefs.ts";
import { EXCLUDED_KV_NS } from "../src/nodes/replication.ts";
import { FakeEngines, WAKE_MARKER, b64, silenceChunk, speechChunk, wakeChunk } from "../src/voice/fake.ts";
import { parseConfig } from "../src/config/load.ts";
import { Conversation, OUT_FRAME, PLAYBACK_SLACK_MS } from "../src/voice/conversation.ts";
import { OpusDecoder, OpusEncoder } from "../src/voice/opus.ts";
import type { SttEngine, SttStream, VadEngine } from "../src/voice/engines.ts";
import { brainFrames, isMethod, removeHome, sleep, stopDaemon, tempHome, TestClient, tomlString, waitFor } from "./helpers.ts";

const FAKE_BRAIN = join(import.meta.dir, "fakes", "brain.ts");
const TRANSCRIPT = "what time is the meeting tomorrow afternoon";

interface Started {
  d: Daemon & { home: string };
  ui: TestClient;
  phone: TestClient;
  engines: FakeEngines;
  scratch: string;
  log: string;
}

let current: Started | undefined;
const extra: TestClient[] = [];

afterEach(async () => {
  for (const c of extra.splice(0)) c.close();
  if (!current) return;
  current.ui.close();
  current.phone.close();
  await stopDaemon(current.d);
  removeHome(current.scratch);
  current = undefined;
});

interface StartOptions {
  /** The fake brain's script; no brain at all when absent. */
  script?: object;
  voice?: string;
  engines?: FakeEngines;
  /** A `meeting` memory the brain can quote. */
  memory?: string;
  /** Wait for every stage to settle before the clients connect; on unless a test holds a stage. */
  wait?: boolean;
  /** A home a daemon already ran on, for a restart: its store is kept. */
  home?: string;
  /** More `[gate.rules]` lines for the brain. */
  gateRules?: string;
  /** A `[speech]` section, or rules, appended to the file. */
  speech?: string;
}

/** A daemon with voice on fake engines, a desktop client and a controller client. */
async function start(opts: StartOptions = {}): Promise<Started> {
  const scratch = opts.home ?? tempHome();
  const log = join(scratch, "brain.log");
  const engines = opts.engines ?? new FakeEngines({ transcript: TRANSCRIPT });
  const brain = opts.script
    ? `[brain]\ncommand = ${tomlString(FAKE_BRAIN)}\nrestart_backoff_ms = 100\nhello_timeout_ms = 5000\n\n[gate.rules]\n"brain:voice.speak" = "allow"\n"brain:ui.say" = "allow"\n"brain:memory.read" = "allow"\n${opts.gateRules ?? ""}\n`
    : "";
  const toml = `[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\n\n[update]\nenabled = false\n\n${brain}[voice]\nenabled = true\n${opts.voice ?? ""}\n${opts.speech ?? ""}`;
  writeFileSync(join(scratch, "config.toml"), toml);
  if (opts.script) writeFileSync(join(scratch, "brain-script.json"), JSON.stringify(opts.script));
  if (opts.memory !== undefined) {
    mkdirSync(join(scratch, "memory"), { recursive: true });
    writeFileSync(join(scratch, "memory", "meeting.md"), `---\ndescription: the meeting\n---\n${opts.memory}\n`);
  }
  const { startDaemon } = await import("../src/daemon.ts");
  const { silentLogger } = await import("../src/log.ts");
  const d = Object.assign(
    await startDaemon({
      home: scratch,
      port: 0,
      log: silentLogger,
      brain: Boolean(opts.script),
      embedder: null,
      voice: { engines, affinity: null },
      env: { ...process.env, FAKE_BRAIN_SCRIPT: join(scratch, "brain-script.json"), FAKE_BRAIN_LOG: log, GEMINI_API_KEY: undefined },
    }),
    { home: scratch },
  );
  if (opts.wait !== false) await d.voice.ready();
  const ui = await TestClient.connect(d.api.url);
  await ui.hello(d.token, { name: "desktop" });
  const phone = await TestClient.connect(d.api.url);
  await phone.hello(d.token, { kind: "controller", name: "Pixel", audio: { in: true, out: true } });
  current = { d, ui, phone, engines, scratch, log };
  return current;
}

/** The client id the daemon gave a connection, from its `hello` result. */
async function idOf(c: TestClient, token: string, extraParams: Record<string, unknown> = {}): Promise<string> {
  const r = await c.request<{ client: Client }>("hello", { token, kind: "controller", audio: { in: true, out: true }, ...extraParams });
  return r.client.id;
}

const say = (c: TestClient, pcm: Int16Array) => c.signal("voice.audio", { chunk: b64(pcm) });
const speak = (c: TestClient, frames: number, level = 1000) => {
  for (let i = 0; i < frames; i++) say(c, speechChunk(level));
};
const hush = (c: TestClient, frames: number) => {
  for (let i = 0; i < frames; i++) say(c, silenceChunk());
};
const states = (c: TestClient): VoiceState[] => c.notifications.filter((n) => n.method === "voice.state").map((n) => (n.params as { state: VoiceState }).state);
const audioFrames = (c: TestClient): string[] => c.notifications.filter((n) => n.method === "voice.audio").map((n) => (n.params as { chunk: string }).chunk);

/** A whole utterance: the wake word, speech, then the silence that closes it. */
async function utterance(c: TestClient, opts: { wake?: boolean; frames?: number } = {}): Promise<void> {
  if (opts.wake !== false) say(c, wakeChunk());
  await sleep(30);
  speak(c, opts.frames ?? 6);
  hush(c, 20);
}

describe("voice", () => {
  test("the wake word starts an utterance, the partials grow, and the end of it is one user message", async () => {
    const { d, ui, phone } = await start();
    expect(d.voice.capabilities()).toEqual({ wake: true, stt: true, tts: true });
    expect(d.node().capabilities.voice).toEqual({ wake: true, stt: true, tts: true });

    const transcripts: string[] = [];
    d.bus.on("voice.transcript", (t) => transcripts.push(t.text));
    const activity: string[] = [];
    d.bus.on("user.activity", (a) => activity.push(`${a.state}:${a.source}`));

    await utterance(phone);
    const message = await ui.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "user"));
    const m = (message.params as { message: Message }).message;
    expect(m.content).toEqual([{ type: "text", text: TRANSCRIPT }]);
    expect(m.source).toBe("voice");

    // The state went idle → listening → transcribing → thinking, and every client heard it.
    await waitFor(() => states(ui).includes("thinking"));
    expect(states(ui).slice(0, 3)).toEqual(["listening", "transcribing", "thinking"]);
    expect(states(phone)).toEqual(states(ui));
    const withClient = ui.notifications.find(isMethod("voice.state", (p) => (p as { state: string }).state === "listening"))!;
    expect((withClient.params as { client: string }).client).toMatch(/^cli_/);

    // The brain heard the words while they grew, at most once a second, never the same text twice.
    expect(transcripts.length).toBeGreaterThanOrEqual(1);
    expect(new Set(transcripts).size).toBe(transcripts.length);
    expect(TRANSCRIPT.startsWith(transcripts[0]!)).toBe(true);
    // The phone that spoke saw its words grow, only what changed each time, and the last named the
    // message they became; the desktop saw none of them.
    await waitFor(() => phone.notifications.some(isMethod("voice.partial", (p) => (p as { message?: string }).message === m.id)));
    const partials = phone.notifications.filter(isMethod("voice.partial")).map((n) => n.params as { client?: string; text: string; from?: number; message?: string });
    expect(partials.length).toBeGreaterThanOrEqual(2);
    expect(partials[0]!.from).toBeUndefined();
    expect(partials.every((p) => p.client === partials[0]!.client)).toBe(true);
    let shown = "";
    for (const p of partials) shown = shown.slice(0, p.from ?? 0) + p.text;
    expect(TRANSCRIPT.startsWith(shown) && shown.length > 0).toBe(true);
    expect(ui.notifications.some(isMethod("voice.partial"))).toBe(false);
    // The user's speaking was announced on its edges.
    expect(activity.filter((a) => a === "speaking:voice")).toHaveLength(1);
    await waitFor(() => activity.includes("idle:voice"));
  }, 20_000);

  test("what the brain speaks reaches that one phone, composed for the ear with a lead-in", async () => {
    const blocks = [
      { type: "text", text: "It is at half past three." },
      { type: "quote", cite: { request: "$req[0]", lines: [1, 1] } },
    ];
    const { d, ui, phone, engines } = await start({
      memory: "Tomorrow's meeting is at 15:30 in the blue room.",
      script: {
        on: [
          {
            event: "user.message",
            requests: [
              { method: "memory.read", params: { name: "meeting" } },
              { method: "ui.say", params: { blocks } },
              { method: "voice.speak", params: { blocks, interrupt: true } },
            ],
          },
        ],
      },
    });
    await waitFor(() => d.brain?.state === "up");
    await waitFor(() => d.memory.read("meeting") !== undefined);

    await utterance(phone);
    await waitFor(() => engines.spoken.length === 1, 10_000);
    // The quote is read out after a lead-in naming where it came from.
    expect(engines.spoken[0]).toBe("It is at half past three. From memory meeting: Tomorrow's meeting is at 15:30 in the blue room.");

    // The audio went to the phone and to nobody else.
    await waitFor(() => audioFrames(phone).length > 0, 10_000);
    expect(audioFrames(ui)).toEqual([]);
    expect(states(phone)).toContain("speaking");
    // And the phone hears it go quiet again on its own.
    await waitFor(() => states(phone).at(-1) === "idle", 10_000);

    // The brain's call was audited and allowed by the built-in rule, with no rule in the config.
    const rows = d.store.audit.list({ limit: 100 }).filter((e) => e.action === "voice.speak");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision).toBe("allow");
    expect(rows[0]!.outcome).toBe("ok");
    expect(brainFrames(current!.log).some((f) => f.dir === "out" && f.frame["method"] === "voice.speak")).toBe(true);
  }, 30_000);

  test("a turn holds the speech process from the word until its reply has played, and nothing is loaded to check it at start", async () => {
    const { d, phone, engines } = await start({
      script: {
        on: [
          {
            event: "user.message",
            requests: [
              { method: "ui.say", params: { blocks: [{ type: "text", text: "It is at three." }] } },
              { method: "voice.speak", params: { blocks: [{ type: "text", text: "It is at three." }], interrupt: true } },
            ],
          },
        ],
      },
    });
    await waitFor(() => d.brain?.state === "up");
    // At rest the process is let go of, and the stages came up without a load.
    expect(engines.turns.filter((t) => t)).toEqual([]);
    expect(engines.checks).toEqual([]);
    await utterance(phone);
    await waitFor(() => engines.turns.includes(true));
    await waitFor(() => engines.spoken.length === 1, 10_000);
    // Held through transcription, the brain's turn and the speech; let go once it has played.
    await waitFor(() => states(phone).at(-1) === "idle" && states(phone).includes("speaking"), 10_000);
    expect(engines.turns.at(-1)).toBe(false);
    expect(engines.turns.filter((t) => t)).toHaveLength(1);
  }, 20_000);

  test("push-to-talk with the wake word off: the release ends the utterance, with no silence to wait for", async () => {
    const { ui, phone } = await start({ voice: `wake = "off"\n` });
    await phone.request("voice.ptt", { active: true });
    speak(phone, 6);
    await sleep(50);
    expect(states(phone)).toEqual(["listening"]);
    await phone.request("voice.ptt", { active: false });
    const message = await ui.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "user"));
    expect((message.params as { message: Message }).message.content).toEqual([{ type: "text", text: TRANSCRIPT }]);
    // No wake event was needed, and no silence was fed.
    expect(states(phone)).toEqual(["listening", "transcribing", "thinking"]);
  }, 20_000);

  test("an utterance taken back is never sent, and another client's is not the caller's to take", async () => {
    const { ui, phone, engines } = await start({ voice: `wake = "off"\n` });
    await phone.request("voice.ptt", { active: true });
    speak(phone, 6);
    await waitFor(() => states(phone).at(-1) === "listening");
    // The desktop has no utterance of its own, nor a microphone: the phone's goes on, and the
    // desktop is not refused, since taking back needs nothing to transcribe with.
    await ui.request("voice.ptt", { active: false, cancel: true });
    await sleep(50);
    expect(states(phone)).toEqual(["listening"]);
    await phone.request("voice.ptt", { active: false, cancel: true });
    await waitFor(() => states(phone).at(-1) === "idle");
    // The button's own release, after, ends nothing.
    await phone.request("voice.ptt", { active: false });
    await sleep(100);
    expect(states(phone)).toEqual(["listening", "idle"]);
    expect(engines.finals).toBe(0);
    expect(ui.notifications.filter(isMethod("chat.message"))).toHaveLength(0);
    // With nothing in progress it is no error.
    expect(await phone.call("voice.ptt", { active: false, cancel: true })).toMatchObject({ result: {} });
  }, 20_000);

  test("a tap with nothing said wakes nobody, and its idle says why", async () => {
    const { ui, phone } = await start();
    await phone.request("voice.ptt", { active: true });
    await sleep(40);
    await phone.request("voice.ptt", { active: false });
    await waitFor(() => states(phone).at(-1) === "idle");
    expect(states(phone)).toEqual(["listening", "transcribing", "idle"]);
    const idle = phone.notifications.filter(isMethod("voice.state")).at(-1)!.params as { unheard?: VoiceUnheard };
    expect(idle.unheard).toBe("no-speech");
    await sleep(100);
    expect(ui.notifications.filter(isMethod("chat.message"))).toHaveLength(0);
  }, 20_000);

  test("speaking over the reply stops it and starts the next utterance", async () => {
    // Each sentence takes a moment to synthesise, as a real engine's does.
    const engines = new FakeEngines({ transcript: TRANSCRIPT, msPerSentence: 400, synthDelayMs: 120 });
    const { d, phone } = await start({ engines });
    await utterance(phone);
    await waitFor(() => states(phone).at(-1) === "thinking", 10_000);
    // A long reply, spoken as three sentences.
    d.voice.speak([{ type: "text", text: "One. Two. Three." }], {});
    await waitFor(() => states(phone).includes("speaking"));
    await waitFor(() => audioFrames(phone).length >= 1);

    // The wake word fires over the top of it.
    say(phone, wakeChunk());
    await waitFor(() => states(phone).at(-1) === "listening", 5000);
    const cut = audioFrames(phone).length;
    // The rest of the line was never synthesised, and none of it was sent.
    await waitFor(() => engines.aborted >= 1, 5000);
    await sleep(300);
    expect(audioFrames(phone).length).toBe(cut);
    expect(cut).toBeLessThan(3);
  }, 20_000);

  test("a second speak with interrupt replaces the first", async () => {
    const engines = new FakeEngines({ transcript: TRANSCRIPT, msPerSentence: 300, synthDelayMs: 120 });
    const { d, phone } = await start({ engines });
    await utterance(phone);
    await waitFor(() => states(phone).at(-1) === "thinking", 10_000);
    d.voice.speak([{ type: "text", text: "First line. Second line. Third line." }], {});
    await waitFor(() => engines.spoken.length === 1);
    d.voice.speak([{ type: "text", text: "Forget that." }], { interrupt: true });
    await waitFor(() => engines.spoken.length === 2);
    expect(engines.spoken).toEqual(["First line. Second line. Third line.", "Forget that."]);
    await waitFor(() => engines.aborted >= 1, 5000);
  }, 20_000);

  test("two phones keep their own conversations, and speech goes to the one that asked", async () => {
    const { d, ui, phone } = await start();
    const second = await TestClient.connect(d.api.url);
    extra.push(second);
    await idOf(second, d.token, { name: "iPad" });

    await utterance(phone);
    await ui.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "user"));
    const id = d.clients.list().find((c) => c.name === "Pixel")!.id;
    d.voice.speak([{ type: "text", text: "Answered." }], {});
    await waitFor(() => audioFrames(phone).length > 0, 10_000);
    expect(audioFrames(second)).toEqual([]);
    // Both phones still hear the state, with the client it belongs to named.
    const seen = second.notifications.filter(isMethod("voice.state")).map((n) => (n.params as { client?: string }).client);
    expect(new Set(seen)).toEqual(new Set([id]));
  }, 20_000);

  test("a desktop client has no microphone: its audio is ignored and its button is refused", async () => {
    const { d, ui } = await start();
    say(ui, wakeChunk());
    await sleep(100);
    expect(states(ui)).toEqual([]);
    expect(await ui.call("voice.ptt", { active: true })).toMatchObject({ error: { data: { code: "invalid" } } });
    expect(d.voice.idle()).toBe(true);
  }, 20_000);

  test("a phone that goes away mid-turn takes its conversation with it", async () => {
    const { d, phone } = await start();
    await utterance(phone);
    await waitFor(() => d.voice.snapshot().states.length === 1, 10_000);
    expect(d.voice.idle()).toBe(false);
    phone.close();
    await waitFor(() => d.voice.snapshot().states.length === 0);
    expect(d.voice.idle()).toBe(true);
    // Speaking into a conversation that is gone is a no-op, not a crash.
    d.voice.speak([{ type: "text", text: "anyone there" }], {});
  }, 20_000);

  test("a client that says hello mid-conversation is told what is in flight", async () => {
    const { d, phone } = await start();
    await utterance(phone);
    await waitFor(() => d.voice.snapshot().states.length === 1, 10_000);
    const late = await TestClient.connect(d.api.url);
    extra.push(late);
    await late.hello(d.token, { name: "late" });
    const seen = await late.next(isMethod("voice.state"));
    expect((seen.params as { state: string }).state).toBe("thinking");
  }, 20_000);

  test("with voice off nothing listens and the button says so", async () => {
    const scratch = tempHome();
    writeFileSync(join(scratch, "config.toml"), `[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\n\n[update]\nenabled = false\n\n[voice]\nenabled = false\n`);
    const { startDaemon } = await import("../src/daemon.ts");
    const { silentLogger } = await import("../src/log.ts");
    const d = Object.assign(await startDaemon({ home: scratch, port: 0, log: silentLogger, brain: false, embedder: null, voice: { engines: new FakeEngines(), affinity: null } }), { home: scratch });
    const c = await TestClient.connect(d.api.url);
    try {
      await c.hello(d.token, { kind: "controller", audio: { in: true, out: true } });
      expect(d.voice.capabilities()).toEqual({ wake: false, stt: false, tts: false });
      expect(await c.call("voice.ptt", { active: true })).toMatchObject({ error: { data: { code: "unavailable" } } });
      say(c, wakeChunk());
      await sleep(100);
      expect(c.notifications.filter(isMethod("voice.state"))).toHaveLength(0);
    } finally {
      c.close();
      await stopDaemon(d);
    }
  }, 20_000);

  test("a stage whose engine will not load leaves the rest working and says why", async () => {
    const engines = new FakeEngines({ transcript: TRANSCRIPT });
    engines.failStage = "tts";
    const { d, ui, phone } = await start({ engines });
    expect(d.voice.capabilities()).toEqual({ wake: true, stt: true, tts: false });
    expect(d.voice.stageStates().tts).toMatchObject({ status: "unavailable", engine: "piper" });
    expect(d.voice.stageStates().tts.reason).toContain("fake tts failure");
    // The utterance still reaches the brain; there is simply nothing to speak with.
    await utterance(phone);
    await ui.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "user"));
    d.voice.speak([{ type: "text", text: "nothing to say it with" }], {});
    await sleep(100);
    expect(audioFrames(phone)).toEqual([]);
    await waitFor(() => states(phone).at(-1) === "idle", 5000);
  }, 20_000);

  test("a reply that is not spoken still ends the turn on the phone", async () => {
    const { d, phone } = await start({ voice: "thinking_timeout_ms = 30000\n" });
    await utterance(phone);
    await waitFor(() => states(phone).at(-1) === "thinking", 10_000);
    // The chat answers without speaking: the grace takes the phone back to idle.
    d.chat.say([{ type: "text", text: "typed reply" }]);
    await waitFor(() => states(phone).at(-1) === "idle", 5000);
  }, 20_000);

  test("audio frames are validated: an odd length, an empty frame and a huge one are dropped", async () => {
    const { d, phone } = await start();
    phone.signal("voice.audio", { chunk: Buffer.from([1, 2, 3]).toString("base64") });
    phone.signal("voice.audio", { chunk: "" });
    phone.signal("voice.audio", { chunk: Buffer.alloc(70000).toString("base64") });
    phone.signal("voice.audio", { chunk: "not base64 at all ***" });
    await sleep(100);
    expect(states(phone)).toEqual([]);
    expect(d.voice.idle()).toBe(true);
    // A real frame still works after them.
    await utterance(phone);
    await waitFor(() => states(phone).includes("listening"));
  }, 20_000);

  test("speech is sliced into frames a controller can schedule", async () => {
    const engines = new FakeEngines({ transcript: TRANSCRIPT, msPerSentence: 1000 });
    const { d, phone } = await start({ engines });
    await utterance(phone);
    await waitFor(() => states(phone).at(-1) === "thinking", 10_000);
    d.voice.speak([{ type: "text", text: "A long single sentence with no full stops inside it" }], {});
    await waitFor(() => audioFrames(phone).length >= 2, 10_000);
    for (const chunk of audioFrames(phone)) {
      const bytes = Buffer.from(chunk, "base64");
      expect(bytes.byteLength % 2).toBe(0);
      expect(bytes.byteLength / 2).toBeLessThanOrEqual(OUT_FRAME);
    }
  }, 20_000);
});

// --- the wake word on the phone ----------------------------------------------------------------

const HEAD = "cophyla_v0.1.onnx";
/** Every head the node listens with by default: a client that carries them all hears the words itself. */
const HEADS = ["cophyla_v0.1.onnx", "hey_phyla_v0.1.onnx"];
const PHONE_MODE: WakewordMode = {
  mode: "phone",
  head: HEAD,
  threshold: 0.7,
  scale: "int16",
  heads: [
    { head: HEAD, threshold: 0.7, scale: "int16", phrase: "cophyla" },
    { head: "hey_phyla_v0.1.onnx", threshold: 0.7, scale: "int16", phrase: "hey phyla" },
  ],
};
const idByName = (d: Daemon, name: string): string => d.clients.list().find((c) => c.name === name)!.id;
const userMessages = (c: TestClient) => c.notifications.filter(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "user"));

/** A conversation on its own, over the fake engines, for the timers a daemon test would wait seconds on. */
async function bare(opts: { stt?: SttEngine; vad?: (() => VadEngine) | null; stallMs?: number; now?: () => number } = {}) {
  const engines = new FakeEngines({ transcript: TRANSCRIPT });
  const makeVad = opts.vad === null ? undefined : (opts.vad ?? (await engines.vad()));
  const stt = opts.stt ?? (await engines.stt());
  const seen: VoiceState[] = [];
  const unheard: VoiceUnheard[] = [];
  const details: { state: VoiceState; limit?: number; stopped?: string }[] = [];
  const finals: string[] = [];
  const partials: string[] = [];
  const c = new Conversation({
    client: "cli_bare",
    ...(makeVad ? { vad: makeVad } : {}),
    stt: () => stt,
    thinkingTimeoutMs: 60_000,
    stallMs: opts.stallMs ?? 150,
    ...(opts.now ? { now: opts.now } : {}),
    on: {
      state: (s, detail) => {
        seen.push(s);
        if (detail?.unheard) unheard.push(detail.unheard);
        details.push({ state: s, ...(detail?.limit !== undefined ? { limit: detail.limit } : {}), ...(detail?.stopped ? { stopped: detail.stopped } : {}) });
      },
      partial: (text) => partials.push(text),
      final: (text) => finals.push(text),
      speaking: () => {},
      audio: () => {},
    },
  });
  return { c, seen, unheard, details, finals, partials, engines };
}

describe("the wake word on the phone", () => {
  test("the phone is told where its wake word is heard, and a client with no microphone is refused", async () => {
    const { d, ui, phone } = await start();
    expect(await phone.request<WakewordMode>("voice.wakeword", { heads: HEADS })).toEqual(PHONE_MODE);
    expect(d.voice.phoneWakeClients()).toEqual([idByName(d, "Pixel")]);
    // A phone without one of the configured heads streams while it listens, and the node detects.
    expect(await phone.request<WakewordMode>("voice.wakeword", { heads: [HEAD] })).toEqual({ mode: "node" });
    expect(d.voice.phoneWakeClients()).toEqual([]);
    expect(await phone.request<WakewordMode>("voice.wakeword", { heads: ["hey_mycroft_v0.1.onnx"] })).toEqual({ mode: "node" });
    expect(await ui.call("voice.wakeword", { heads: HEADS })).toMatchObject({ error: { data: { code: "invalid" } } });
  }, 20_000);

  test("a wake stage still loading is waited for, and one that did not come up leaves the words to the node", async () => {
    let release!: () => void;
    const engines = new FakeEngines({ transcript: TRANSCRIPT });
    engines.hold.wake = new Promise<void>((resolve) => (release = resolve));
    const { phone } = await start({ engines, wait: false });
    const answer = phone.request<WakewordMode>("voice.wakeword", { heads: HEADS });
    await sleep(100);
    release();
    expect(await answer).toEqual(PHONE_MODE);

    const failing = new FakeEngines({ transcript: TRANSCRIPT });
    failing.failStage = "wake";
    const second = await start({ engines: failing });
    expect(await second.phone.request<WakewordMode>("voice.wakeword", { heads: HEADS })).toEqual({ mode: "node" });
  }, 20_000);

  test("a client that asks while the daemon is still starting, before voice has begun to load, is answered once the wake stage is up", async () => {
    // The daemon takes clients seconds before it starts voice (the brain comes first), and the
    // desktop app asks the moment it reconnects: answered `node` then, it streamed for good.
    const home = tempHome();
    try {
      const store = new Store(":memory:");
      store.migrate();
      const bus = new Bus();
      const clients = new ClientRegistry();
      const client: Client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind: "ui", scopes: ["voice", "chat"], via: "direct", audio: { in: true, out: true }, connectedAt: 1 };
      clients.add(client, { send: () => {}, close: () => {} }, "loopback");
      const voice = () =>
        new Voice({
          config: parseConfig("[voice]\nenabled = true\n").voice,
          dataDir: join(home, "data"),
          bus,
          log: silentLogger,
          clients,
          chat: new Chat({ store, bus, asks: new Asks(store, "node_start", bus) }),
          activity: new Activity({ bus }),
          models: { resolve: async () => "" },
          sidecars: new Sidecars({ dir: join(home, "sidecars"), log: silentLogger }),
          engines: new FakeEngines({ transcript: TRANSCRIPT }),
        });
      const starting = voice();
      const answer = starting.wakeword(client, HEADS);
      await sleep(100);
      await starting.start();
      expect(await answer).toEqual(PHONE_MODE);
      await starting.stop();

      // A daemon that stops before it got to voice answers too, rather than holding the request.
      const stopping = voice();
      const late = stopping.wakeword(client, HEADS);
      await sleep(100);
      await stopping.stop();
      expect(await late).toEqual({ mode: "node" });
    } finally {
      removeHome(home);
    }
  }, 20_000);

  test("with the wake word off on the node there is nothing to detect, on the phone or anywhere", async () => {
    const { d, phone } = await start({ voice: `wake = "off"\n` });
    expect(await phone.request<WakewordMode>("voice.wakeword", { heads: HEADS })).toEqual({ mode: "off" });
    expect(d.voice.phoneWakeClients()).toEqual([]);
  }, 20_000);

  test("the heads and the thresholds the phone runs are the node's", async () => {
    const { phone } = await start({ voice: `wake_model = "${HEAD}"\nwake_threshold = 0.55\nwake_scale = "unit"\n` });
    expect(await phone.request<WakewordMode>("voice.wakeword", { heads: ["other.onnx", HEAD] })).toEqual({
      mode: "phone",
      head: HEAD,
      threshold: 0.55,
      scale: "unit",
      heads: [{ head: HEAD, threshold: 0.55, scale: "unit", phrase: "cophyla" }],
    });
  }, 20_000);

  test("a threshold per head", async () => {
    const { phone } = await start({ voice: `wake_model = ["a.onnx", "b.onnx"]\nwake_threshold = { "b.onnx" = 0.4 }\n` });
    const mode = await phone.request<WakewordMode>("voice.wakeword", { heads: ["b.onnx", "a.onnx"] });
    expect(mode.mode === "phone" ? mode.heads : undefined).toEqual([
      { head: "a.onnx", threshold: 0.7, scale: "int16", phrase: "a" },
      { head: "b.onnx", threshold: 0.4, scale: "int16", phrase: "b" },
    ]);
  }, 20_000);

  test("a phone that detects the word is not listened for by the node, until an empty list hands it back", async () => {
    const { phone } = await start();
    await phone.request<WakewordMode>("voice.wakeword", { heads: HEADS });
    say(phone, wakeChunk());
    await sleep(150);
    expect(states(phone)).toEqual([]);
    expect(await phone.request<WakewordMode>("voice.wakeword", { heads: [] })).toEqual({ mode: "node" });
    say(phone, wakeChunk());
    await waitFor(() => states(phone).includes("listening"));
  }, 20_000);

  test("voice.wake starts the utterance and silence ends it", async () => {
    const { ui, phone } = await start();
    await phone.request<WakewordMode>("voice.wakeword", { heads: HEADS });
    await phone.request("voice.wake", { score: 0.93 });
    speak(phone, 6);
    hush(phone, 20);
    const message = await ui.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "user"));
    expect((message.params as { message: Message }).message.content).toEqual([{ type: "text", text: TRANSCRIPT }]);
    await waitFor(() => states(phone).includes("thinking"));
    expect(states(phone).slice(0, 3)).toEqual(["listening", "transcribing", "thinking"]);
  }, 20_000);

  test("voice.wake over the reply cuts the speech", async () => {
    const engines = new FakeEngines({ transcript: TRANSCRIPT, msPerSentence: 400, synthDelayMs: 120 });
    const { d, phone } = await start({ engines });
    await phone.request<WakewordMode>("voice.wakeword", { heads: HEADS });
    await phone.request("voice.wake", { score: 0.9 });
    speak(phone, 6);
    hush(phone, 20);
    await waitFor(() => states(phone).at(-1) === "thinking", 10_000);
    d.voice.speak([{ type: "text", text: "One. Two. Three." }], {});
    await waitFor(() => audioFrames(phone).length >= 1);
    await phone.request("voice.wake", { score: 0.9 });
    await waitFor(() => states(phone).at(-1) === "listening", 5000);
    const cut = audioFrames(phone).length;
    await waitFor(() => engines.aborted >= 1, 5000);
    await sleep(300);
    expect(audioFrames(phone).length).toBe(cut);
  }, 20_000);

  test("voice.wake in the middle of an utterance is ignored", async () => {
    const { phone } = await start();
    await phone.request<WakewordMode>("voice.wakeword", { heads: HEADS });
    await phone.request("voice.wake", { score: 0.9 });
    speak(phone, 3);
    await phone.request("voice.wake", { score: 0.9 });
    hush(phone, 20);
    await waitFor(() => states(phone).at(-1) === "thinking");
    expect(states(phone)).toEqual(["listening", "transcribing", "thinking"]);
  }, 20_000);

  test("a wake with nothing said after it is abandoned, without transcribing and without a message", async () => {
    const { ui, phone, engines } = await start();
    await phone.request<WakewordMode>("voice.wakeword", { heads: HEADS });
    await phone.request("voice.wake", { score: 0.8 });
    // Five seconds and a little more of a quiet room.
    hush(phone, 130);
    await waitFor(() => states(phone).at(-1) === "idle");
    expect(states(phone)).toEqual(["listening", "idle"]);
    expect(engines.finals).toBe(0);
    await sleep(100);
    expect(userMessages(ui)).toHaveLength(0);
  }, 20_000);

  test("a false accept on the node in a quiet room goes idle again", async () => {
    const { phone, engines } = await start();
    say(phone, wakeChunk());
    hush(phone, 130);
    await waitFor(() => states(phone).at(-1) === "idle");
    expect(states(phone)).toEqual(["listening", "idle"]);
    expect(engines.finals).toBe(0);
  }, 20_000);

  test("held, the button is not abandoned for silence", async () => {
    const { phone, engines } = await start();
    await phone.request("voice.ptt", { active: true });
    hush(phone, 130);
    await sleep(300);
    expect(states(phone)).toEqual(["listening"]);
    await phone.request("voice.ptt", { active: false });
    await waitFor(() => states(phone).at(-1) === "idle");
    expect(states(phone)).toEqual(["listening", "transcribing", "idle"]);
    // Nothing was said in it: the recogniser is not asked to read silence.
    expect(engines.finals).toBe(0);
  }, 20_000);

  test("the stall backstop abandons a wake whose phone stopped sending", async () => {
    const { c, seen, engines } = await bare();
    expect(c.wakeHeard()).toBe(true);
    c.push(speechChunk());
    await sleep(80);
    expect(seen).toEqual(["listening"]);
    await waitFor(() => seen.at(-1) === "idle");
    expect(seen).toEqual(["listening", "idle"]);
    expect(engines.finals).toBe(0);
    c.dispose();
  });

  test("the frames from before the phone's word are the recogniser's alone: a quiet room after them is still abandoned", async () => {
    const accepted: number[] = [];
    const engines = new FakeEngines({ transcript: TRANSCRIPT });
    const stt: SttEngine = { stream: () => ({ accept: (pcm) => accepted.push(pcm[0]!), final: async () => "", reset: () => {}, dispose: () => {} }), close: () => {} };
    const { c, seen } = await bare({ stt });
    expect(c.wakeHeard(3)).toBe(true);
    // Three frames of the word's tail, then nothing: the VAD never heard speech after the word.
    for (let i = 0; i < 3; i++) c.push(speechChunk(500 + i));
    // The recogniser's stream hears its silence first.
    await waitFor(() => accepted.length === 4);
    for (let i = 0; i < 140; i++) c.push(silenceChunk());
    await waitFor(() => seen.at(-1) === "idle");
    expect(seen).toEqual(["listening", "idle"]);
    expect(accepted.slice(0, 4)).toEqual([0, 500, 501, 502]);
    expect(engines.finals).toBe(0);
    c.dispose();
  });

  test("the node's own word gives the recogniser the frames it heard the word in", async () => {
    const accepted: number[] = [];
    const engines = new FakeEngines({ transcript: TRANSCRIPT });
    const makeVad = await engines.vad();
    const wakeModel = await engines.wake("", parseConfig("[voice]\nenabled = true\n").voice);
    const stt: SttEngine = { stream: () => ({ accept: (pcm) => accepted.push(pcm[0]!), final: async () => "", reset: () => {}, dispose: () => {} }), close: () => {} };
    const seen: VoiceState[] = [];
    const c = new Conversation({
      client: "cli_lead",
      wake: wakeModel.stream(),
      vad: makeVad,
      stt: () => stt,
      thinkingTimeoutMs: 60_000,
      on: { state: (s) => seen.push(s), partial: () => {}, final: () => {}, speaking: () => {}, audio: () => {} },
    });
    for (let i = 0; i < 8; i++) c.push(speechChunk(100 + i));
    c.push(wakeChunk());
    c.push(speechChunk(900));
    await waitFor(() => accepted.includes(900));
    expect(seen).toEqual(["listening"]);
    // Silence, the last three frames before the word and the one it fired on, then what followed.
    expect(accepted).toEqual([0, 105, 106, 107, WAKE_MARKER, 900]);
    c.dispose();
  });

  test("a wake the button then holds is the button's to end, however long it is quiet", async () => {
    const { c, seen } = await bare();
    c.wakeHeard();
    c.ptt(true);
    for (let i = 0; i < 130; i++) c.push(silenceChunk());
    await sleep(400);
    expect(seen).toEqual(["listening"]);
    c.ptt(false);
    await waitFor(() => seen.at(-1) === "idle");
    expect(seen).toEqual(["listening", "transcribing", "idle"]);
    c.dispose();
  });

  test("a press with nothing said drops its stream undrained, so nothing is left open in the speech process", async () => {
    const calls: string[] = [];
    const stt: SttEngine = { stream: () => ({ accept: () => {}, final: async () => (calls.push("final"), "words"), reset: () => {}, dispose: () => calls.push("dispose") }), close: () => {} };
    const { c, seen } = await bare({ stt });
    c.ptt(true);
    c.push(silenceChunk());
    await sleep(10);
    c.ptt(false);
    await waitFor(() => seen.at(-1) === "idle");
    expect(calls).toEqual(["dispose"]);
    c.dispose();
  });

  test("a press no frame reached says no audio came, once it was held a second; a quicker tap says only that nothing was heard", async () => {
    let at = 0;
    const { c, seen, unheard } = await bare({ now: () => at });
    c.ptt(true);
    at += 1500;
    c.ptt(false);
    await waitFor(() => seen.at(-1) === "idle");
    c.ptt(true);
    at += 300;
    c.ptt(false);
    await waitFor(() => seen.length === 6);
    expect(unheard).toEqual(["no-audio", "no-speech"]);
    c.dispose();
  });

  test("a press that heard only digital silence says so: an unplugged or muted microphone sends that", async () => {
    const { c, seen, unheard, finals } = await bare();
    c.ptt(true);
    for (let i = 0; i < 10; i++) c.push(silenceChunk());
    await sleep(20);
    c.ptt(false);
    await waitFor(() => seen.at(-1) === "idle");
    expect(unheard).toEqual(["silence"]);
    expect(finals).toEqual([]);
    c.dispose();
  });

  test("a press with sound and no speech in it, and one with speech the recogniser made no words of, each say which", async () => {
    const deaf: VadEngine = { feed: () => false, heard: false, reset: () => {}, close: () => {} };
    const quiet = await bare({ vad: () => deaf });
    quiet.c.ptt(true);
    for (let i = 0; i < 5; i++) quiet.c.push(speechChunk(40));
    await sleep(20);
    quiet.c.ptt(false);
    await waitFor(() => quiet.seen.at(-1) === "idle");
    expect(quiet.unheard).toEqual(["no-speech"]);
    quiet.c.dispose();

    const stt: SttEngine = { stream: () => ({ accept: () => {}, final: async () => "", reset: () => {}, dispose: () => {} }), close: () => {} };
    const mumbled = await bare({ stt });
    mumbled.c.ptt(true);
    for (let i = 0; i < 5; i++) mumbled.c.push(speechChunk());
    await sleep(20);
    mumbled.c.ptt(false);
    await waitFor(() => mumbled.seen.at(-1) === "idle");
    expect(mumbled.unheard).toEqual(["no-words"]);
    mumbled.c.dispose();
  });

  test("a wake that comes to nothing gives no reason: a false accept is not the user's to hear about", async () => {
    const { c, seen, unheard } = await bare();
    c.wakeHeard();
    c.push(speechChunk());
    for (let i = 0; i < 20; i++) c.push(silenceChunk());
    await waitFor(() => seen.at(-1) === "idle" || seen.at(-1) === "thinking");
    expect(unheard).toEqual([]);
    c.dispose();
  });

  test("the phone's wake is ignored while listening, while transcribing and while the button is held", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const stt: SttEngine = { stream: () => ({ accept: () => {}, final: () => held.then(() => ""), reset: () => {}, dispose: () => {} }), close: () => {} };
    const { c, seen } = await bare({ stt });
    c.ptt(true);
    expect(c.wakeHeard()).toBe(false);
    // Something said, so the release has an utterance to transcribe.
    c.push(speechChunk());
    await sleep(10);
    c.ptt(false);
    expect(seen).toEqual(["listening", "transcribing"]);
    expect(c.wakeHeard()).toBe(false);
    release();
    await waitFor(() => seen.at(-1) === "idle");
    expect(c.wakeHeard()).toBe(true);
    expect(c.wakeHeard()).toBe(false);
    c.dispose();
  });

  test("taken back while it is heard, a held press is let go with nothing sent, and its own release ends nothing", async () => {
    const calls: string[] = [];
    const stt: SttEngine = { stream: () => ({ accept: () => {}, final: async () => (calls.push("final"), "words"), reset: () => {}, dispose: () => calls.push("dispose") }), close: () => {} };
    const { c, seen, finals } = await bare({ stt });
    c.ptt(true);
    c.push(speechChunk());
    await sleep(10);
    expect(c.cancel()).toBe(true);
    expect(seen).toEqual(["listening", "idle"]);
    // Let go with it: the frames that follow are nobody's, and the button's own release transcribes nothing.
    c.push(speechChunk());
    await sleep(10);
    c.ptt(false);
    await sleep(20);
    expect(seen).toEqual(["listening", "idle"]);
    expect(calls).toEqual(["dispose"]);
    expect(finals).toEqual([]);
    // Let go, a phone's word is heard again.
    expect(c.wakeHeard()).toBe(true);
    expect(c.cancel()).toBe(true);
    // The next press is an utterance of its own.
    c.ptt(true);
    c.push(speechChunk());
    await sleep(10);
    c.ptt(false);
    await waitFor(() => seen.at(-1) === "thinking");
    expect(finals).toEqual(["words"]);
    c.dispose();
  });

  test("taken back while it is transcribed, the transcript that lands after is dropped", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const stt: SttEngine = { stream: () => ({ accept: () => {}, final: () => held.then(() => "words"), reset: () => {}, dispose: () => calls.push("dispose") }), close: () => {} };
    const { c, seen, finals } = await bare({ stt });
    c.ptt(true);
    c.push(speechChunk());
    await sleep(10);
    c.ptt(false);
    expect(seen).toEqual(["listening", "transcribing"]);
    expect(c.cancel()).toBe(true);
    expect(seen).toEqual(["listening", "transcribing", "idle"]);
    expect(calls).toEqual(["dispose"]);
    release();
    await sleep(20);
    expect(seen).toEqual(["listening", "transcribing", "idle"]);
    expect(finals).toEqual([]);
    // Nothing is left to take back, and the wake word may begin the next one.
    expect(c.cancel()).toBe(false);
    expect(c.wakeHeard()).toBe(true);
    c.dispose();
  });

  test("a wake taken back goes idle at once, with no stall left to fire", async () => {
    const { c, seen, finals, engines } = await bare({ stallMs: 50 });
    expect(c.wakeHeard()).toBe(true);
    c.push(speechChunk());
    await sleep(10);
    expect(c.cancel()).toBe(true);
    await sleep(120);
    expect(seen).toEqual(["listening", "idle"]);
    expect(engines.finals).toBe(0);
    expect(finals).toEqual([]);
    c.dispose();
  });

  test("a phone that streamed before the stages were up is heard once they are", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const engines = new FakeEngines({ transcript: TRANSCRIPT });
    engines.hold = { wake: gate, stt: gate };
    const { d, ui, phone } = await start({ engines, wait: false });
    // The conversation is made now, with no wake word and nothing to transcribe with.
    hush(phone, 5);
    await sleep(100);
    open();
    await d.voice.ready();
    await utterance(phone);
    const message = await ui.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "user"));
    expect((message.params as { message: Message }).message.content).toEqual([{ type: "text", text: TRANSCRIPT }]);
  }, 20_000);

  test("a controller that never asks is still listened for by the node, beside one that detects its own", async () => {
    const { d, phone } = await start();
    const old = await TestClient.connect(d.api.url);
    extra.push(old);
    await idOf(old, d.token, { name: "old app" });
    await phone.request<WakewordMode>("voice.wakeword", { heads: HEADS });
    say(phone, wakeChunk());
    say(old, wakeChunk());
    await waitFor(() => d.voice.snapshot().states.length === 1);
    await sleep(100);
    expect(d.voice.snapshot().states).toEqual([{ state: "listening", client: idByName(d, "old app") }]);
  }, 20_000);

  test("a phone that goes away is forgotten, though it never sent a frame", async () => {
    const { d, phone } = await start();
    await phone.request<WakewordMode>("voice.wakeword", { heads: HEADS });
    expect(d.voice.phoneWakeClients()).toHaveLength(1);
    phone.close();
    await waitFor(() => d.voice.phoneWakeClients().length === 0);
  }, 20_000);
});

// --- Opus and the played ack ------------------------------------------------------------------

describe("a phone that speaks Opus and acks", () => {
  interface Speech {
    chunk: string;
    codec?: string;
    rate?: number;
    seq?: number;
    reply?: number;
    end?: true;
  }
  const speech = (c: TestClient): Speech[] => c.notifications.filter((n) => n.method === "voice.audio").map((n) => n.params as Speech);

  /** A second phone, saying it takes Opus and reports playback. */
  async function opusPhone(d: Daemon & { token?: string }, token: string): Promise<{ phone: TestClient; hello: { audio?: { codecs: string[] }; client: Client } }> {
    const phone = await TestClient.connect(d.api.url);
    extra.push(phone);
    const hello = await phone.request<{ audio?: { codecs: string[] }; client: Client }>("hello", { token, kind: "controller", name: "Opus", audio: { in: true, out: true, codecs: ["opus", "pcm"], played: true } });
    return { phone, hello };
  }

  /** 40 ms of a tone at 16 kHz, as Opus: what the phone's encoder sends. */
  function opusFrames(n: number): string[] {
    const enc = new OpusEncoder(16000, 24_000);
    const out: string[] = [];
    for (let f = 0; f < n; f++) {
      const pcm = new Int16Array(640);
      for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(3000 * Math.sin((2 * Math.PI * 300 * (f * 640 + i)) / 16000));
      out.push(Buffer.from(enc.encode(pcm)).toString("base64"));
    }
    enc.close();
    return out;
  }

  test("hello names the node's codecs; Opus goes up, is heard, and a malformed frame is dropped", async () => {
    const { d, ui } = await start({ voice: `wake = "off"\n` });
    const { phone, hello } = await opusPhone(d, d.token);
    expect(hello.audio?.codecs).toEqual(["opus", "pcm"]);
    expect(hello.client.audio).toEqual({ in: true, out: true, codecs: ["opus", "pcm"], played: true });
    phone.signal("voice.audio", { chunk: Buffer.from([5, 0, 1, 2]).toString("base64"), codec: "opus", seq: 0 });
    await phone.request("voice.ptt", { active: true });
    const frames = opusFrames(6);
    frames.forEach((chunk, i) => phone.signal("voice.audio", { chunk, codec: "opus", seq: i + 1 }));
    await sleep(100);
    await phone.request("voice.ptt", { active: false });
    const message = await ui.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "user"));
    expect((message.params as { message: Message }).message.content).toEqual([{ type: "text", text: TRANSCRIPT }]);
  }, 20_000);

  test("speech comes down as Opus at the voice's rate, numbered, with an end; voice.played ends speaking before the estimate would", async () => {
    const engines = new FakeEngines({ transcript: TRANSCRIPT, msPerSentence: 300 });
    const { d } = await start({ engines, voice: `wake = "off"\n` });
    const { phone } = await opusPhone(d, d.token);
    await phone.request("voice.ptt", { active: true });
    for (const chunk of opusFrames(4)) phone.signal("voice.audio", { chunk, codec: "opus" });
    await sleep(50);
    await phone.request("voice.ptt", { active: false });
    await waitFor(() => states(phone).at(-1) === "thinking", 10_000);
    d.voice.speak([{ type: "text", text: "One. Two." }], {});
    await waitFor(() => speech(phone).some((s) => s.end), 10_000);
    const endAt = performance.now();
    const frames = speech(phone);
    expect(frames.every((s) => s.codec === "opus" && s.rate === 24000 && s.reply === 1)).toBe(true);
    expect(frames.map((s) => s.seq)).toEqual(frames.map((_, i) => i));
    expect(frames.at(-1)!.end).toBe(true);
    // two sentences of 300 ms, padded to whole 20 ms packets
    const dec = new OpusDecoder(24000);
    const samples = frames.reduce((n, s) => n + dec.decode(Buffer.from(s.chunk, "base64")).length, 0);
    dec.close();
    expect(samples).toBe(2 * 7200);
    // A moment later the phone says it is done: idle follows at once, well inside the estimate.
    await sleep(100);
    expect(states(phone).at(-1)).toBe("speaking");
    phone.signal("voice.played", { reply: 1, stats: { underruns: 0, maxLateMs: 0, targetMs: 300, frames: frames.length } });
    await waitFor(() => states(phone).at(-1) === "idle", 2000);
    expect(performance.now() - endAt).toBeLessThan(600 + PLAYBACK_SLACK_MS);
  }, 20_000);

  test("a phone without the ack is spoken to in PCM and goes idle on the estimate", async () => {
    const { d, phone } = await start({ voice: `wake = "off"\n` });
    await phone.request("voice.ptt", { active: true });
    speak(phone, 4);
    await phone.request("voice.ptt", { active: false });
    await waitFor(() => states(phone).at(-1) === "thinking", 10_000);
    d.voice.speak([{ type: "text", text: "Hello." }], {});
    await waitFor(() => states(phone).at(-1) === "idle", 10_000);
    const frames = speech(phone);
    expect(frames.every((s) => s.codec === "pcm" && s.rate === 24000)).toBe(true);
    expect(frames.at(-1)).toMatchObject({ chunk: "", end: true, reply: 1 });
  }, 20_000);
});

describe("the speech engine picked in the app", () => {
  const settings = (c: TestClient) => c.request<VoiceSettings>("voice.settings", {});

  test("a pick loads the engine once to check it; an online engine unloads the local one", async () => {
    const { ui, engines } = await start();
    await ui.request("voice.configure", { stt: "moonshine-tiny" });
    await waitFor(() => engines.checks.includes("stt"));
    await ui.request("voice.configure", { tts: "kokoro-online" });
    await waitFor(() => engines.unloads.includes("tts"));
    expect(engines.checks).toEqual(["stt"]);
    const s = await settings(ui);
    expect(s).toMatchObject({ tts: "kokoro-online", stt: "moonshine-tiny" });
  }, 20_000);
  const configure = (c: TestClient, patch: object) => c.request<VoiceSettings>("voice.configure", patch);
  const ready = (d: Daemon, engine: string) => waitFor(() => d.voice.stageStates().tts.status === "ready" && d.voice.stageStates().tts.engine === engine);

  test("config.toml's engine until the app picks another, which loads behind the answer and hands back with null", async () => {
    const { d, ui, engines } = await start();
    const first = await settings(ui);
    expect(first).toMatchObject({ enabled: true, tts: "piper", source: "config", voice: 0, voices: 4, stage: { status: "ready", engine: "piper" } });
    expect(first.engines.filter((e) => e.stage === "tts").map((e) => e.id)).toEqual(["piper", "kokoro", "supertonic", "chatterbox", "kokoro-online", "off"]);
    expect(first.engines.filter((e) => e.stage === "stt").map((e) => e.id)).toEqual(["moonshine-tiny", "moonshine-base", "whisper-base", "nemotron", "gemini-live", "gemini", "off"]);
    // A local engine says what it comes under; a hosted one runs nowhere here and needs no install.
    expect(first.engines.find((e) => e.id === "piper")).toMatchObject({ local: true, installed: true });
    expect(first.engines.find((e) => e.id === "piper")!.licences!.map((l) => l.name)).toContain("GPL-3.0");
    expect(first.engines.find((e) => e.stage === "tts" && e.id === "kokoro-online")).toMatchObject({ local: false });

    const picked = await configure(ui, { tts: "kokoro" });
    // Answered before the load: the stage is still loading, and the engine before it still speaks.
    expect(picked).toMatchObject({ tts: "kokoro", source: "app", stage: { status: "loading", engine: "kokoro" } });
    await ready(d, "kokoro");
    expect(engines.ttsLoads.map((l) => l.engine)).toEqual(["piper", "kokoro"]);
    expect(engines.ttsClosed).toBe(1);
    expect(d.store.kv.get(VOICE_KV_NS, "prefs")).toEqual({ tts: "kokoro" });
    expect(await settings(ui)).toMatchObject({ tts: "kokoro", source: "app", stage: { status: "ready" } });

    const back = await configure(ui, { tts: null });
    expect(back).toMatchObject({ tts: "piper", source: "config" });
    await ready(d, "piper");
    expect(d.store.kv.get(VOICE_KV_NS, "prefs")).toBeUndefined();
    // The pick is audited like any other change the app makes.
    expect(d.store.audit.list({ limit: 50 }).some((e) => e.action === "voice.configure")).toBe(true);
  }, 20_000);

  test("a voice belongs to its engine: set with no reload, and remembered when the engine comes back", async () => {
    const { d, ui, engines } = await start();
    const set = await configure(ui, { voice: 2 });
    expect(set).toMatchObject({ tts: "piper", voice: 2, source: "app" });
    expect(engines.ttsLoads).toHaveLength(1);
    await configure(ui, { tts: "kokoro" });
    await ready(d, "kokoro");
    expect(engines.ttsLoads.at(-1)).toEqual({ engine: "kokoro" });
    await configure(ui, { tts: "piper" });
    await ready(d, "piper");
    expect(engines.ttsLoads.at(-1)).toEqual({ engine: "piper", voice: 2 });
    expect(await settings(ui)).toMatchObject({ tts: "piper", voice: 2 });
    // Handing the voice back leaves the model's own.
    expect(await configure(ui, { voice: null })).toMatchObject({ voice: 0 });
  }, 20_000);

  test("a voice picked while its engine loads is that engine's, not the one still speaking", async () => {
    const { d, ui, engines } = await start();
    const piper = d.voice["ttsEngine"] as { voice?: number };
    let release!: () => void;
    engines.hold.tts = new Promise<void>((r) => (release = r));
    await configure(ui, { tts: "kokoro" });
    await configure(ui, { voice: 3 });
    expect(piper.voice).toBe(0);
    release();
    await ready(d, "kokoro");
    expect((d.voice["ttsEngine"] as { voice?: number }).voice).toBe(3);
    expect(await settings(ui)).toMatchObject({ tts: "kokoro", voice: 3 });
  }, 20_000);

  test("a pick another one overtook is dropped when it lands", async () => {
    const { d, ui, engines } = await start();
    let release!: () => void;
    engines.hold.tts = new Promise<void>((r) => (release = r));
    await configure(ui, { tts: "kokoro" });
    await configure(ui, { tts: "supertonic" });
    expect(d.voice.stageStates().tts).toMatchObject({ status: "loading", engine: "supertonic" });
    release();
    await ready(d, "supertonic");
    await sleep(50);
    expect(d.voice.stageStates().tts).toMatchObject({ status: "ready", engine: "supertonic" });
    // Piper went when Supertonic took its place, Kokoro the moment it loaded.
    expect(engines.ttsClosed).toBe(2);
  }, 20_000);

  test("an engine that will not load leaves nothing speaking and says why; another pick brings speech back", async () => {
    const { d, ui, phone, engines } = await start();
    engines.failStage = "tts";
    await configure(ui, { tts: "chatterbox" });
    await waitFor(() => d.voice.stageStates().tts.status === "unavailable");
    expect(await settings(ui)).toMatchObject({ tts: "chatterbox", stage: { status: "unavailable", engine: "chatterbox", reason: "fake tts failure" } });
    expect(d.voice.capabilities().tts).toBe(false);
    expect(await phone.call("voice.preview", {})).toMatchObject({ error: { data: { code: "unavailable" } } });
    engines.failStage = undefined;
    await configure(ui, { tts: "piper" });
    await ready(d, "piper");
    expect(d.voice.capabilities().tts).toBe(true);
  }, 20_000);

  test("off speaks nothing", async () => {
    const { d, ui, phone } = await start();
    expect(await configure(ui, { tts: "off" })).toMatchObject({ tts: "off", stage: { status: "off" } });
    expect(d.voice.capabilities().tts).toBe(false);
    await utterance(phone);
    await waitFor(() => states(phone).includes("thinking"));
    d.voice.speak([{ type: "text", text: "nobody hears this" }], {});
    await sleep(100);
    expect(audioFrames(phone)).toEqual([]);
  }, 20_000);

  test("the pick is kept across a restart, and stays this machine's own", async () => {
    const first = await start();
    await configure(first.ui, { tts: "kokoro", voice: 3 });
    await ready(first.d, "kokoro");
    first.ui.close();
    first.phone.close();
    await first.d.stop();
    current = undefined;
    const engines = new FakeEngines({ transcript: TRANSCRIPT });
    const again = await start({ home: first.scratch, engines });
    expect(again.d.voice.stageStates().tts).toMatchObject({ status: "ready", engine: "kokoro" });
    expect(engines.ttsLoads).toEqual([{ engine: "kokoro", voice: 3 }]);
    expect(await settings(again.ui)).toMatchObject({ tts: "kokoro", voice: 3, source: "app" });
    expect(EXCLUDED_KV_NS).toContain(VOICE_KV_NS);
  }, 30_000);

  test("a preview speaks to the client that asked, in the voice set now; one that cannot play is refused", async () => {
    const { ui, phone, engines } = await start();
    await phone.request("voice.preview", {});
    await waitFor(() => audioFrames(phone).length > 0);
    expect(engines.spoken.at(-1)).toBe(PREVIEW_LINE);
    await phone.request("voice.preview", { text: "Testing, one two." });
    await waitFor(() => engines.spoken.at(-1) === "Testing, one two.");
    // The desktop client here said it has no speaker.
    expect(await ui.call("voice.preview", {})).toMatchObject({ error: { data: { code: "invalid" } } });
    expect(audioFrames(ui)).toEqual([]);
  }, 20_000);

  test("the speed is every engine's, from the next line, at the engine's own pace kept as none", async () => {
    const { d, ui, phone } = await start({ engines: new FakeEngines({ transcript: TRANSCRIPT, msPerSentence: 500 }) });
    const ends = () => phone.notifications.filter((n) => n.method === "voice.audio" && (n.params as { end?: boolean }).end).length;
    /** The samples of the line the phone is sent for a preview. */
    const heard = async (): Promise<number> => {
      const before = audioFrames(phone).length;
      const ended = ends();
      await phone.request("voice.preview", { text: "One. Two." });
      await waitFor(() => ends() > ended);
      return audioFrames(phone)
        .slice(before)
        .reduce((n, chunk) => n + Buffer.from(chunk, "base64").length / 2, 0);
    };
    expect(await settings(ui)).toMatchObject({ speed: 1, source: "config" });
    const own = await heard();
    expect(own).toBe(2 * 12000);

    // The speed is not the engine's pick: config.toml's engine is still the one reading.
    expect(await configure(ui, { speed: 2 })).toMatchObject({ tts: "piper", speed: 2, source: "config" });
    expect(d.store.kv.get(VOICE_KV_NS, "prefs")).toEqual({ speed: 2 });
    expect(Math.abs((await heard()) - own / 2)).toBeLessThan(own * 0.01);

    await configure(ui, { tts: "kokoro" });
    await ready(d, "kokoro");
    expect(await settings(ui)).toMatchObject({ tts: "kokoro", speed: 2 });
    expect(Math.abs((await heard()) - own / 2)).toBeLessThan(own * 0.01);
    // Handing the engine back leaves the speed.
    expect(await configure(ui, { tts: null, voice: null })).toMatchObject({ tts: "piper", speed: 2 });

    expect(await configure(ui, { speed: 1 })).toMatchObject({ speed: 1 });
    expect(d.store.kv.get(VOICE_KV_NS, "prefs")).toBeUndefined();
    await configure(ui, { speed: 0.75 });
    expect(await configure(ui, { speed: null })).toMatchObject({ speed: 1 });
    expect(await ui.call("voice.configure", { speed: 4 })).toMatchObject({ error: { data: { code: "invalid" } } });
    expect(await heard()).toBe(own);
  }, 20_000);

  test("a stored pick that no longer parses reads as none", () => {
    const store = new Store(":memory:");
    store.migrate();
    const prefs = storePrefs(store);
    store.kv.put(VOICE_KV_NS, "prefs", { tts: "espeak", voices: { piper: 7, kokoro: -1, espeak: 2 }, speed: 9 });
    expect(prefs.read()).toEqual({ voices: { piper: 7 } });
    store.kv.put(VOICE_KV_NS, "prefs", { speed: 1.5 });
    expect(prefs.read()).toEqual({ speed: 1.5 });
    prefs.write({});
    expect(store.kv.get(VOICE_KV_NS, "prefs")).toBeUndefined();
  });
});

describe("local engines are installed only when asked", () => {
  const settings = (c: TestClient) => c.request<VoiceSettings>("voice.settings", {});
  const setupSteps = (c: TestClient) => c.notifications.filter((n) => n.method === "voice.setup").map((n) => (n.params as { engine: string; step: string }).step);

  test("an engine not installed leaves its stage uninstalled and fetches nothing; the rest of voice works", async () => {
    const engines = new FakeEngines({ transcript: TRANSCRIPT });
    engines.notInstalled.add("piper");
    engines.notInstalled.add("nemotron");
    const { d, ui } = await start({ engines });
    expect(d.voice.stageStates()).toMatchObject({ wake: { status: "ready" }, stt: { status: "uninstalled", engine: "nemotron" }, tts: { status: "uninstalled", engine: "piper" } });
    expect(d.voice.capabilities()).toEqual({ wake: true, stt: false, tts: false });
    expect(engines.installs).toEqual([]);
    expect(engines.ttsLoads).toEqual([]);
    const s = await settings(ui);
    expect(s.sttStage).toMatchObject({ status: "uninstalled", reason: "not installed on this computer" });
    expect(s.engines.find((e) => e.id === "piper")).toMatchObject({ local: true, installed: false, bytes: 1000 });
  }, 20_000);

  test("the online recogniser needs no install: the VAD is the platform's own, and `server` is its old name", async () => {
    const engines = new FakeEngines({ transcript: TRANSCRIPT });
    engines.notInstalled.add("nemotron");
    const { d, ui } = await start({ engines });
    expect(d.voice.stageStates().stt.status).toBe("uninstalled");
    await ui.request("voice.configure", { stt: "server" });
    // Up with nothing installed: what it needs besides a route is the VAD, which ships.
    await waitFor(() => d.voice.stageStates().stt.status === "ready");
    expect(d.voice.stageStates().stt).toMatchObject({ engine: "gemini-live" });
    expect(engines.installs).toEqual([]);
    expect(await settings(ui)).toMatchObject({ stt: "gemini-live", sttSource: "app" });
    await ui.request("voice.configure", { stt: null });
    await waitFor(() => d.voice.stageStates().stt.status === "uninstalled");
  }, 20_000);

  test("an install asked for runs behind the answer, is told as it goes, and the stage loads when it is in", async () => {
    const engines = new FakeEngines({ transcript: TRANSCRIPT });
    engines.notInstalled.add("piper");
    let release!: () => void;
    engines.holdInstall = new Promise<void>((r) => (release = r));
    const { d, ui } = await start({ engines });
    const started = await ui.request<VoiceSettings>("voice.install", { engine: "piper" });
    expect(started.installing).toMatchObject({ engine: "piper" });
    await waitFor(async () => (await settings(ui)).installing?.step === "runtime");
    // One at a time.
    expect(await ui.call("voice.install", { engine: "kokoro" })).toMatchObject({ error: { data: { code: "conflict" } } });
    release();
    await waitFor(() => d.voice.stageStates().tts.status === "ready");
    expect(engines.installs).toEqual(["piper"]);
    expect(engines.ttsLoads.map((l) => l.engine)).toEqual(["piper"]);
    await waitFor(() => setupSteps(ui).includes("ready"));
    expect(setupSteps(ui)[0]).toBe("runtime");
    const after = await settings(ui);
    expect(after.installing).toBeUndefined();
    expect(after.engines.find((e) => e.id === "piper")).toMatchObject({ installed: true });
    // Installed already: nothing to do.
    await ui.request("voice.install", { engine: "piper" });
    expect(engines.installs).toEqual(["piper"]);
  }, 20_000);

  test("a failed install says why and leaves the stage uninstalled; what is not an engine is refused", async () => {
    const engines = new FakeEngines({ transcript: TRANSCRIPT });
    engines.notInstalled.add("kokoro");
    engines.failInstall = "https://example.test/kokoro.tar.bz2: sha256 0000, expected 9128";
    const { d, ui } = await start({ engines, voice: 'tts = "kokoro"\n' });
    await ui.request("voice.install", { engine: "kokoro" });
    await waitFor(() => setupSteps(ui).includes("failed"));
    expect(await settings(ui)).toMatchObject({ installError: { engine: "kokoro", message: engines.failInstall } });
    expect(d.voice.stageStates().tts.status).toBe("uninstalled");
    expect(await ui.call("voice.install", { engine: "chatterbox" })).toMatchObject({ error: { data: { code: "invalid" } } });
    expect(await ui.call("voice.install", { engine: "rm -rf" })).toMatchObject({ error: { data: { code: "invalid" } } });
    // The install is audited as a network action.
    expect(d.store.audit.list({ limit: 50 }).some((e) => e.action === "voice.install" && e.target === "kokoro")).toBe(true);
  }, 20_000);
});

// --- an utterance's limit, and a recogniser that stops hearing --------------------------------

/** A recogniser that keeps count of what it heard and when it was told of speech. */
function counting(opts: { maxSeconds?: number; final?: (i: number) => Promise<string> } = {}) {
  const seen = { samples: 0, heard: 0, streams: [] as SttStream[] };
  const engine: SttEngine = {
    ...(opts.maxSeconds !== undefined ? { maxSeconds: opts.maxSeconds } : {}),
    stream: () => {
      const i = seen.streams.length;
      const s: SttStream = {
        accept: (pcm) => {
          seen.samples += pcm.length;
        },
        heard: () => {
          seen.heard++;
        },
        final: () => (opts.final ? opts.final(i) : Promise.resolve("words")),
        reset: () => {},
        dispose: () => {},
      };
      seen.streams.push(s);
      return s;
    },
    close: () => {},
  };
  return { engine, seen };
}

const PRIME = 3200;

describe("an utterance's limit, and a recogniser that stops hearing", () => {
  test("held past the recogniser's limit, the utterance ends on the frame that reaches it and says why; the frames after are not heard", async () => {
    const { engine, seen } = counting({ maxSeconds: 0.4 });
    const { c, details, finals } = await bare({ stt: engine });
    c.ptt(true);
    for (let i = 0; i < 15; i++) c.push(speechChunk());
    await waitFor(() => details.at(-1)?.state === "thinking");
    expect(details).toEqual([{ state: "listening", limit: 0.4 }, { state: "transcribing", stopped: "limit" }, { state: "thinking" }]);
    expect(seen.samples).toBe(PRIME + 10 * 640);
    expect(finals).toEqual(["words"]);
    // The button is still held and the phone still sends: nothing more is heard, and the release ends nothing.
    for (let i = 0; i < 5; i++) c.push(speechChunk());
    await sleep(20);
    c.ptt(false);
    await sleep(20);
    expect(seen.samples).toBe(PRIME + 10 * 640);
    expect(details.map((d) => d.state)).toEqual(["listening", "transcribing", "thinking"]);
    c.dispose();
  });

  test("a press while the last utterance is still transcribed begins the next, which that transcript leaves alone", async () => {
    let release!: (text: string) => void;
    const first = new Promise<string>((r) => (release = r));
    const { engine } = counting({ final: (i) => (i === 0 ? first : Promise.resolve("second")) });
    const { c, seen, finals } = await bare({ stt: engine });
    c.ptt(true);
    c.push(speechChunk());
    await sleep(10);
    c.ptt(false);
    await waitFor(() => seen.at(-1) === "transcribing");
    c.ptt(true);
    expect(seen.at(-1)).toBe("listening");
    release("first");
    await waitFor(() => finals.length === 1);
    // The first transcript still reached the chat, and the new utterance is still being heard.
    expect(finals).toEqual(["first"]);
    expect(seen.at(-1)).toBe("listening");
    c.push(speechChunk());
    await sleep(10);
    c.ptt(false);
    await waitFor(() => seen.at(-1) === "thinking");
    expect(finals).toEqual(["first", "second"]);
    expect(seen).toEqual(["listening", "transcribing", "listening", "transcribing", "thinking"]);
    c.dispose();
  });

  test("the recogniser is told of speech once, when the VAD hears it; with no VAD, when the utterance begins", async () => {
    const withVad = counting();
    const a = await bare({ stt: withVad.engine });
    a.c.ptt(true);
    a.c.push(silenceChunk());
    a.c.push(silenceChunk());
    await sleep(10);
    expect(withVad.seen.heard).toBe(0);
    for (let i = 0; i < 5; i++) a.c.push(speechChunk());
    await sleep(10);
    expect(withVad.seen.heard).toBe(1);
    a.c.dispose();

    const noVad = counting();
    const b = await bare({ stt: noVad.engine, vad: null });
    b.c.ptt(true);
    expect(noVad.seen.heard).toBe(1);
    b.c.push(speechChunk());
    await sleep(10);
    expect(noVad.seen.heard).toBe(1);
    b.c.dispose();
  });

  test("a recogniser that stops hearing (the allowance ran out) ends the utterance with what it heard, and says why", async () => {
    const { engine, seen } = counting({ final: async () => "what was heard" });
    const { c, details, finals } = await bare({ stt: engine });
    c.ptt(true);
    c.push(speechChunk());
    await sleep(10);
    seen.streams[0]!.onStop!("quota");
    await waitFor(() => finals.length === 1);
    expect(finals).toEqual(["what was heard"]);
    expect(details.map((d) => d.state)).toEqual(["listening", "transcribing", "thinking"]);
    expect(details[1]).toEqual({ state: "transcribing", stopped: "quota" });
    // A stop from a stream that is no longer the utterance's changes nothing.
    seen.streams[0]!.onStop!("limit");
    await sleep(10);
    expect(details).toHaveLength(3);
    c.dispose();
  });

  test("the words keep coming while the utterance is transcribed, and a later utterance's are its own", async () => {
    let release!: (text: string) => void;
    const held = new Promise<string>((r) => (release = r));
    const { engine, seen } = counting({ final: (i) => (i === 0 ? held : Promise.resolve("")) });
    const { c, partials } = await bare({ stt: engine });
    c.ptt(true);
    c.push(speechChunk());
    await sleep(10);
    seen.streams[0]!.onPartial!("hello");
    c.ptt(false);
    await sleep(10);
    seen.streams[0]!.onPartial!("hello there");
    expect(partials).toEqual(["hello", "hello there"]);
    // A new press: the first stream's late words are not the new utterance's.
    c.ptt(true);
    seen.streams[0]!.onPartial!("hello there you");
    expect(partials).toEqual(["hello", "hello there"]);
    release("hello there you");
    c.dispose();
  });

  test("the clients hear the utterance's limit with `listening`, and why it stopped with `transcribing`", async () => {
    const engines = new FakeEngines({ transcript: TRANSCRIPT, maxSeconds: 0.4 });
    const { ui, phone } = await start({ engines });
    await phone.request("voice.ptt", { active: true });
    speak(phone, 15);
    await waitFor(() => states(ui).includes("thinking"));
    const voiceStates = ui.notifications.filter(isMethod("voice.state")).map((n) => n.params as { state: string; limit?: number; stopped?: string });
    expect(voiceStates.find((v) => v.state === "listening")).toMatchObject({ limit: 0.4 });
    expect(voiceStates.find((v) => v.state === "transcribing")).toMatchObject({ stopped: "limit" });
    await phone.request("voice.ptt", { active: false });
  }, 20_000);
});

// --- where answers and results are read out ------------------------------------------------------

const S_AGENT = "sess_01ARZ3NDEKTSV4RRFFQ69G5FC9";

/**
 * A brain that answers every message aloud and leaves a listener serving it, on node pressure,
 * `until` the agent's session; and reads out each fire's result, naming the request and the
 * fire, whatever the node told it: the node decides, and drops what it said not to speak.
 */
const RESULT_BRAIN = {
  on: [
    {
      event: "user.message",
      requests: [
        { method: "listener.add", params: { on: ["node.pressure"], until: S_AGENT, deliver: "wake", why: "the tests the user asked for", asked: "$event.message" } },
        { method: "ui.say", params: { blocks: [{ type: "text", text: "Started." }] } },
        { method: "voice.speak", params: { blocks: [{ type: "text", text: "Started." }], interrupt: true, asked: "$event.message" } },
      ],
    },
    {
      event: "listener.fired",
      requests: [
        { method: "ui.say", params: { blocks: [{ type: "text", text: "The tests pass." }] } },
        { method: "voice.speak", params: { blocks: [{ type: "text", text: "The tests pass." }], interrupt: false, asked: "$event.listener.asked", fire: { listener: "$event.listener.id", n: "$event.listener.fired" } } },
      ],
    },
  ],
};
const RESULT_RULES = `"brain:listener.add" = "allow"\n`;

const nexts = (c: TestClient) => c.notifications.filter(isMethod("voice.next")).map((n) => n.params as { speak: boolean; hushed?: boolean; target?: string; name?: string });
const fires = () => brainFrames(current!.log).filter((f) => f.dir === "in" && f.frame["method"] === "listener.fired").map((f) => f.frame["params"] as { speak?: boolean; listener: { fired: number } });
/** Node pressure, which the listener serves the request on. */
const pressure = (d: Daemon) => d.bus.emit("node.pressure", { at: Date.now(), node: d.node().id, resource: "cpu", level: "warn" });

/** A spoken request answered aloud, with its listener in place: the result is pending. */
async function asked(opts: { speech?: string; engines?: FakeEngines } = {}) {
  const started = await start({ script: RESULT_BRAIN, gateRules: RESULT_RULES, ...(opts.speech !== undefined ? { speech: opts.speech } : {}), ...(opts.engines ? { engines: opts.engines } : {}) });
  const { d, phone, engines } = started;
  await waitFor(() => d.brain?.state === "up");
  await utterance(phone);
  await waitFor(() => engines.spoken.includes("Started."), 10_000);
  await waitFor(() => d.listeners.list().length === 1, 5000);
  await waitFor(() => states(phone).at(-1) === "idle", 10_000);
  return started;
}

describe("answers and results read out where the rules say", () => {
  test("a spoken request's answer is read on the phone that asked, and its result is too, told to the brain before it writes", async () => {
    const { d, ui, phone, engines } = await asked();
    const phoneId = idByName(d, "Pixel");
    // The answer lit the button on the phone while the brain thought, and the result keeps it lit.
    await waitFor(() => nexts(ui).some((n) => n.speak && n.target === phoneId));
    expect(d.listeners.list()[0]!.asked).toMatch(/^msg_/);
    const before = audioFrames(phone).length;
    pressure(d);
    await waitFor(() => engines.spoken.includes("The tests pass."), 10_000);
    expect(fires().map((f) => f.speak)).toEqual([true]);
    await waitFor(() => audioFrames(phone).length > before, 10_000);
    expect(audioFrames(ui)).toEqual([]);
    // The user message told the brain the answer was to be read out.
    const message = brainFrames(current!.log).find((f) => f.dir === "in" && f.frame["method"] === "user.message");
    expect((message?.frame["params"] as { speak?: boolean }).speak).toBe(true);
  }, 30_000);

  test("nothing is read out while the session is in front of the user", async () => {
    const { d, phone, engines } = await asked();
    await phone.request("session.watch", { ids: [S_AGENT] });
    pressure(d);
    await waitFor(() => fires().length === 1, 10_000);
    expect(fires()[0]!.speak).toBe(false);
    await sleep(300);
    expect(engines.spoken).toEqual(["Started."]);
    // Out of sight again, the next result is read out.
    await phone.request("session.watch", { ids: [] });
    pressure(d);
    await waitFor(() => engines.spoken.includes("The tests pass."), 10_000);
    expect(fires().map((f) => f.speak)).toEqual([false, true]);
  }, 30_000);

  test("nothing is read out once the device was not used within the rule's minutes", async () => {
    const speech = `[[speech.rules]]\nreply = "answer"\nasked = "voice"\n\n[[speech.rules]]\nreply = "result"\nasked = "voice"\nused_within_min = 0.005\n`;
    const { d, engines } = await asked({ speech });
    await sleep(400);
    pressure(d);
    await waitFor(() => fires().length === 1, 10_000);
    expect(fires()[0]!.speak).toBe(false);
    await sleep(300);
    expect(engines.spoken).toEqual(["Started."]);
  }, 30_000);

  test("nothing is read out to a phone that muted its speaker or went away", async () => {
    const { d, phone, engines } = await asked();
    phone.signal("voice.presence", { speaker: false });
    await sleep(100);
    pressure(d);
    await waitFor(() => fires().length === 1, 10_000);
    expect(fires()[0]!.speak).toBe(false);
    phone.signal("voice.presence", { speaker: true });
    await sleep(100);
    phone.close();
    await waitFor(() => !d.clients.list().some((c) => c.name === "Pixel"));
    pressure(d);
    await waitFor(() => fires().length === 2, 10_000);
    expect(fires()[1]!.speak).toBe(false);
    expect(engines.spoken).toEqual(["Started."]);
  }, 30_000);

  /** A request typed on a desktop app that plays audio and never spoke. */
  async function typed(speech?: string) {
    const started = await start({ script: RESULT_BRAIN, gateRules: RESULT_RULES, ...(speech !== undefined ? { speech } : {}) });
    const { d } = started;
    await waitFor(() => d.brain?.state === "up");
    const desk = await TestClient.connect(d.api.url);
    extra.push(desk);
    await desk.hello(d.token, { name: "desktop", audio: { in: false, out: true } });
    await desk.request("chat.send", { text: "run the tests and tell me" });
    await waitFor(() => d.listeners.list().length === 1, 10_000);
    return { ...started, desk };
  }

  test("a typed request's answer and result are not read out by the built-in rules", async () => {
    const { d, engines } = await typed();
    pressure(d);
    await waitFor(() => fires().length === 1, 10_000);
    expect(fires()[0]!.speak).toBe(false);
    await sleep(300);
    expect(engines.spoken).toEqual([]);
  }, 30_000);

  test("a rule for typed requests reads the result on the machine it was typed on, which never spoke", async () => {
    const { d, engines, desk } = await typed(`[[speech.rules]]\nreply = "result"\n`);
    pressure(d);
    await waitFor(() => engines.spoken.includes("The tests pass."), 10_000);
    await waitFor(() => audioFrames(desk).length > 0, 10_000);
    expect(fires()[0]!.speak).toBe(true);
  }, 30_000);

  test("a hush stops the speech now, silences the pending result until it is undone, and the button says so", async () => {
    const engines = new FakeEngines({ transcript: TRANSCRIPT, msPerSentence: 400, synthDelayMs: 120 });
    const { d, ui, phone } = await asked({ engines });
    await waitFor(() => nexts(ui).at(-1)?.speak === true);
    // Hushed before the fire: the brain is told not to speak, and nothing is.
    expect(await ui.request<{ speak: boolean; hushed?: boolean }>("voice.hush", { on: true })).toEqual({ speak: false, hushed: true });
    await waitFor(() => nexts(ui).at(-1)?.hushed === true);
    pressure(d);
    await waitFor(() => fires().length === 1, 10_000);
    expect(fires()[0]!.speak).toBe(false);
    await sleep(300);
    expect(engines.spoken).toEqual(["Started."]);
    // Undone: the next fire is read out, and a hush while it plays stops it where it is.
    expect(await ui.request<{ speak: boolean }>("voice.hush", { on: false })).toMatchObject({ speak: true });
    await waitFor(() => nexts(ui).at(-1)?.speak === true);
    pressure(d);
    await waitFor(() => states(phone).at(-1) === "speaking", 10_000);
    await ui.request("voice.hush", { on: true });
    await waitFor(() => states(phone).at(-1) === "idle", 5000);
    await waitFor(() => engines.aborted >= 1, 5000);
  }, 30_000);

  test("the button's state reaches every client with voice as it changes, and a client that says hello hears it", async () => {
    const { d, ui } = await asked();
    const phoneId = idByName(d, "Pixel");
    await waitFor(() => nexts(ui).at(-1)?.speak === true);
    expect(nexts(ui).at(-1)).toMatchObject({ speak: true, target: phoneId, name: "Pixel" });
    const late = await TestClient.connect(d.api.url);
    extra.push(late);
    await late.hello(d.token, { name: "late" });
    const told = await late.next(isMethod("voice.next"));
    expect(told.params).toMatchObject({ speak: true, target: phoneId });
    // The listener gone, nothing is pending: the button dims.
    d.listeners.remove(d.listeners.list()[0]!.id, "user");
    await waitFor(() => nexts(ui).at(-1)?.speak === false);
  }, 30_000);

  test("a voice.speak that names neither the request nor the fire is spoken where the last utterance came from", async () => {
    const { d, phone, engines } = await start({ script: { on: [{ event: "listener.fired", requests: [{ method: "voice.speak", params: { blocks: [{ type: "text", text: "Old brain." }], interrupt: false } }] }] }, gateRules: RESULT_RULES });
    await waitFor(() => d.brain?.state === "up");
    await utterance(phone);
    await waitFor(() => states(phone).at(-1) === "thinking", 10_000);
    d.listeners.add({ on: ["node.pressure"], deliver: "wake", why: "an older brain's" });
    pressure(d);
    await waitFor(() => engines.spoken.includes("Old brain."), 10_000);
    await waitFor(() => audioFrames(phone).length > 0, 10_000);
  }, 30_000);
});
