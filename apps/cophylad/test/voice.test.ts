// The voice pipeline over the socket, on fake engines: a wake word starts an utterance, the
// partials reach the brain while it grows, the end of the utterance is one `user.message`
// with `source: voice`, the brain's `voice.speak` comes back as audio to that one phone and
// to no one else, and what it says is composed for the ear with a lead-in before the quote.
// Push-to-talk, barge-in, two phones, an empty tap, a disconnect mid-turn and a stage that
// is off are the rest; then the wake word heard on the phone — where it is detected, the
// utterance `voice.wake` begins, and the abandons that end one nothing was said in. Last,
// a phone that speaks Opus and acks what it played: its frames both ways, and `speaking`
// ending on its `voice.played`.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client, Message, RpcNotification, VoiceState, WakewordMode } from "@cophyla/protocol";
import type { Daemon } from "../src/daemon.ts";
import { ClientRegistry } from "../src/api/clients.ts";
import { Bus } from "../src/bus.ts";
import { Activity } from "../src/chat/activity.ts";
import { Chat } from "../src/chat/index.ts";
import { Asks } from "../src/gate/asks.ts";
import { silentLogger } from "../src/log.ts";
import { Sidecars } from "../src/sidecars/index.ts";
import { Store } from "../src/store/index.ts";
import { Voice } from "../src/voice/index.ts";
import { FakeEngines, WAKE_MARKER, b64, silenceChunk, speechChunk, wakeChunk } from "../src/voice/fake.ts";
import { parseConfig } from "../src/config/load.ts";
import { Conversation, OUT_FRAME, PLAYBACK_SLACK_MS } from "../src/voice/conversation.ts";
import { OpusDecoder, OpusEncoder } from "../src/voice/opus.ts";
import type { SttEngine } from "../src/voice/engines.ts";
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
}

/** A daemon with voice on fake engines, a desktop client and a controller client. */
async function start(opts: StartOptions = {}): Promise<Started> {
  const scratch = tempHome();
  const log = join(scratch, "brain.log");
  const engines = opts.engines ?? new FakeEngines({ transcript: TRANSCRIPT });
  const brain = opts.script
    ? `[brain]\ncommand = ${tomlString(FAKE_BRAIN)}\nrestart_backoff_ms = 100\nhello_timeout_ms = 5000\n\n[gate.rules]\n"brain:voice.speak" = "allow"\n"brain:ui.say" = "allow"\n"brain:memory.read" = "allow"\n\n`
    : "";
  const toml = `[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\n\n[update]\nenabled = false\n\n${brain}[voice]\nenabled = true\n${opts.voice ?? ""}`;
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

    // Partials went out while it grew, and never the same text twice.
    expect(transcripts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(transcripts).size).toBe(transcripts.length);
    expect(TRANSCRIPT.startsWith(transcripts[0]!)).toBe(true);
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

  test("a tap with nothing said wakes nobody", async () => {
    const { ui, phone } = await start();
    await phone.request("voice.ptt", { active: true });
    await sleep(40);
    await phone.request("voice.ptt", { active: false });
    await waitFor(() => states(phone).at(-1) === "idle");
    expect(states(phone)).toEqual(["listening", "transcribing", "idle"]);
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
    expect(d.voice.stageStates().tts).toMatchObject({ status: "unavailable", engine: "kokoro" });
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

const HEAD = "hey_jarvis_v0.1.onnx";
/** Every head the node listens with by default: a client that carries them all hears the words itself. */
const HEADS = ["hey_jarvis_v0.1.onnx", "cophyla_v0.1.onnx", "hey_phyla_v0.1.onnx"];
const PHONE_MODE: WakewordMode = {
  mode: "phone",
  head: HEAD,
  threshold: 0.7,
  scale: "int16",
  heads: [
    { head: HEAD, threshold: 0.7, scale: "int16", phrase: "hey jarvis" },
    { head: "cophyla_v0.1.onnx", threshold: 0.7, scale: "int16", phrase: "cophyla" },
    { head: "hey_phyla_v0.1.onnx", threshold: 0.7, scale: "int16", phrase: "hey phyla" },
  ],
};
const idByName = (d: Daemon, name: string): string => d.clients.list().find((c) => c.name === name)!.id;
const userMessages = (c: TestClient) => c.notifications.filter(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "user"));

/** A conversation on its own, over the fake engines, for the timers a daemon test would wait seconds on. */
async function bare(opts: { stt?: SttEngine; stallMs?: number } = {}) {
  const engines = new FakeEngines({ transcript: TRANSCRIPT });
  const makeVad = await engines.vad();
  const stt = opts.stt ?? (await engines.stt());
  const seen: VoiceState[] = [];
  const c = new Conversation({
    client: "cli_bare",
    vad: makeVad,
    stt: () => stt,
    thinkingTimeoutMs: 60_000,
    stallMs: opts.stallMs ?? 150,
    on: { state: (s) => seen.push(s), partial: () => {}, final: () => {}, speaking: () => {}, audio: () => {} },
  });
  return { c, seen, engines };
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
      heads: [{ head: HEAD, threshold: 0.55, scale: "unit", phrase: "hey jarvis" }],
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
    expect(engines.finals).toBe(1);
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

  test("the phone's wake is ignored while listening, while transcribing and while the button is held", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const stt: SttEngine = { stream: () => ({ accept: () => {}, final: () => held.then(() => ""), reset: () => {}, dispose: () => {} }), close: () => {} };
    const { c, seen } = await bare({ stt });
    c.ptt(true);
    expect(c.wakeHeard()).toBe(false);
    c.ptt(false);
    expect(seen).toEqual(["listening", "transcribing"]);
    expect(c.wakeHeard()).toBe(false);
    release();
    await waitFor(() => seen.at(-1) === "idle");
    expect(c.wakeHeard()).toBe(true);
    expect(c.wakeHeard()).toBe(false);
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
