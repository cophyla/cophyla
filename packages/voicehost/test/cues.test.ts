// Recording an utterance, as the user hears and sees it, over fakes: the tones' notes and when
// they play, how loud each 20 ms of a frame is, and when the host says recording started and
// stopped: from the button held, a word the host heard, and the node listening (a word it
// heard, a view's own button), never from frames streamed only for the node's wake word, and
// a quick tap whose `listening` comes after it was let go not starting it again.

import { describe, expect, test } from "bun:test";
import type { VoiceState } from "@cophyla/protocol";
import { CUE_S, cueNotes, levelsOf, playCue } from "../src/cues.ts";
import type { CueContext, CueKind } from "../src/cues.ts";
import { recordingOf, VoiceHost } from "../src/voicehost.ts";
import type { RecordingInput } from "../src/voicehost.ts";

/** An audio context that keeps what it was asked to play: each oscillator's pitch and start. */
function fakeContext(now = 0) {
  const started: { hz: number; at: number }[] = [];
  const param = () => ({ value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const ctx = {
    currentTime: now,
    destination: {} as AudioNode,
    createGain: () => ({ gain: param(), connect() {} }) as unknown as GainNode,
    createOscillator: () => {
      const osc = { type: "sine", frequency: param(), connect() {}, start: (at: number) => started.push({ hz: osc.frequency.value, at }), stop() {} };
      return osc as unknown as OscillatorNode;
    },
  };
  return { ctx: ctx as CueContext & { currentTime: number }, started };
}

describe("the tones", () => {
  test("recording's start rises and its stop falls", () => {
    const [a, b] = cueNotes("start");
    expect(b).toBeGreaterThan(a);
    expect(cueNotes("stop")).toEqual([b, a]);
  });

  test("a tone plays its two notes, each with its octave, and says when it ends", () => {
    const { ctx, started } = fakeContext(5);
    const end = playCue(ctx, "start");
    expect(end).toBeCloseTo(5 + CUE_S);
    const [low, high] = cueNotes("start");
    expect(started.map((s) => s.hz)).toEqual([low, low * 2, high, high * 2]);
    expect(started[0]!.at).toBe(5);
    expect(started[2]!.at).toBeGreaterThan(5);
  });

  test("a tone asked for while the last still sounds waits for it", () => {
    const { ctx, started } = fakeContext(1);
    const end = playCue(ctx, "start");
    playCue(ctx, "stop", end);
    expect(started[4]!.at).toBeCloseTo(end);
    expect(started[4]!.hz).toBe(cueNotes("stop")[0]);
    // One asked for after the last ended plays at once.
    started.length = 0;
    playCue(ctx, "stop", 0.5);
    expect(started[0]!.at).toBe(1);
  });
});

describe("how loud the microphone is", () => {
  const frame = (fill: (i: number) => number) => Int16Array.from({ length: 640 }, (_, i) => fill(i));

  test("silence is nothing, full scale is full, each 20 ms on its own", () => {
    expect(levelsOf(frame(() => 0))).toEqual([0, 0]);
    expect(levelsOf(frame((i) => (i % 2 ? 32767 : -32768)))).toEqual([1, 1]);
    const [first, second] = levelsOf(frame((i) => (i < 320 ? (i % 2 ? 20000 : -20000) : 0)));
    expect(first).toBeGreaterThan(0.9);
    expect(second).toBe(0);
  });

  test("halfway between the floor and the ceiling in dB is half the height", () => {
    // A square wave's RMS is its height: -36 dBFS, halfway from -60 to -12.
    const [level] = levelsOf(frame((i) => (i % 2 ? 519 : -519)));
    expect(level).toBeCloseTo(0.5, 2);
  });
});

describe("when the microphone records", () => {
  const base: RecordingInput = { connected: true, audioReady: true, talking: false, pending: false, listening: true, wake: "node", released: false, talkRefused: false };

  test("the button held, a word heard here, or the node listening; not frames streamed for the node's word", () => {
    expect(recordingOf(base)).toBe(false);
    expect(recordingOf({ ...base, talking: true })).toBe(true);
    expect(recordingOf({ ...base, pending: true })).toBe(true);
    expect(recordingOf({ ...base, voice: "listening" })).toBe(true);
    expect(recordingOf({ ...base, voice: "transcribing" })).toBe(false);
    expect(recordingOf({ ...base, voice: "speaking" })).toBe(false);
  });

  test("nothing records off the line, before the audio, under a remote desktop, or held after the node refused", () => {
    expect(recordingOf({ ...base, talking: true, connected: false })).toBe(false);
    expect(recordingOf({ ...base, talking: true, audioReady: false })).toBe(false);
    expect(recordingOf({ ...base, talking: true, watching: true })).toBe(false);
    expect(recordingOf({ ...base, talking: true, talkRefused: true })).toBe(false);
    // The node's `listening` for a press already let go is not a new recording.
    expect(recordingOf({ ...base, voice: "listening", released: true })).toBe(false);
  });
});

describe("the host says recording started and stopped", () => {
  function fixture(opts: { refuse?: boolean } = {}) {
    const answers: { method: string; params: unknown; answer: () => void; refuse: () => void }[] = [];
    const link = {
      connected: true,
      state: { hello: { client: { id: "cli_me" } } },
      request: <T>(method: string, params?: unknown): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          const entry = { method, params, answer: () => resolve({} as T), refuse: () => reject(Object.assign(new Error("speech to text is loading"), { code: "unavailable" })) };
          answers.push(entry);
          if (opts.refuse) entry.refuse();
        }),
      send: async () => {},
    };
    const said: boolean[] = [];
    const levels: number[][] = [];
    const host = new VoiceHost({ link, listening: true, onRecording: (on) => said.push(on), onLevels: (l) => levels.push(l), log: () => {} });
    const cues: CueKind[] = [];
    host.audio.cue = (kind) => void cues.push(kind);
    // The audio as if started: no audio context in Bun.
    (host as unknown as { audioReady: boolean }).audioReady = true;
    const state = (s: VoiceState) => host.handleFrame({ method: "voice.state", params: { state: s, client: "cli_me" } });
    const frame = (pcm: Int16Array) => (host.audio as unknown as { deps: { onFrame: (pcm: Int16Array) => void } }).deps.onFrame(pcm);
    return { host, said, levels, cues, state, frame, answers };
  }

  test("the button held and let go: up, then down, once each, whatever the node says between", async () => {
    const { host, said, cues, state, answers } = fixture();
    host.ptt(true);
    state("listening");
    answers[0]!.answer();
    host.ptt(false);
    state("transcribing");
    answers[1]!.answer();
    await Bun.sleep(0);
    state("thinking");
    expect(said).toEqual([true, false]);
    expect(cues).toEqual(["start", "stop"]);
    expect(host.view.recording).toBe(false);
  });

  test("a tap let go before the node's listening came does not start again", async () => {
    const { host, said, state, answers } = fixture();
    host.ptt(true);
    host.ptt(false);
    state("listening");
    state("idle");
    answers[0]!.answer();
    answers[1]!.answer();
    await Bun.sleep(0);
    expect(said).toEqual([true, false]);
    // And the next utterance the node hears on its own records as usual.
    state("listening");
    expect(said).toEqual([true, false, true]);
  });

  test("a view's own button, or a word the node heard: the node's listening is the recording", () => {
    const { said, cues, state } = fixture();
    state("listening");
    state("transcribing");
    expect(said).toEqual([true, false]);
    expect(cues).toEqual(["start", "stop"]);
  });

  test("a word heard here records at once, and stops when the node refuses it", () => {
    const { host, said } = fixture();
    const dispatch = (event: object) => (host as unknown as { dispatch: (e: object) => void }).dispatch(event);
    dispatch({ type: "answer", mode: "phone" });
    dispatch({ type: "heard", at: Date.now() });
    expect(said).toEqual([true]);
    dispatch({ type: "refused", code: "unavailable" });
    expect(said).toEqual([true, false]);
  });

  test("a press the node refuses stops at once, though the button is still held", async () => {
    const { host, said, cues } = fixture({ refuse: true });
    host.ptt(true);
    await Bun.sleep(0);
    expect(said).toEqual([true, false]);
    expect(cues).toEqual(["start", "stop"]);
    host.ptt(false);
    await Bun.sleep(0);
    expect(said).toEqual([true, false]);
  });

  test("the line going down stops it", () => {
    const { host, said, state } = fixture();
    state("listening");
    host.linkChanged(false);
    expect(said).toEqual([true, false]);
  });

  test("the levels go to the host only while it records", () => {
    const { host, levels, frame } = fixture();
    const loud = Int16Array.from({ length: 640 }, (_, i) => (i % 2 ? 8000 : -8000));
    frame(loud);
    expect(levels).toEqual([]);
    host.ptt(true);
    frame(loud);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toHaveLength(2);
    expect(levels[0]![0]).toBeGreaterThan(0.5);
    host.ptt(false);
    frame(loud);
    expect(levels).toHaveLength(1);
  });
});
