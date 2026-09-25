// How long `speaking` is held: for a phone that cannot say it finished, until the audio
// already sent will have played, counted from when each chunk left rather than from when
// speech began, so a voice that is slow to start is not cut off at the phone — which drops
// its queue the moment the state leaves `speaking`. For a phone that acks, until its
// `voice.played` for the last reply, with the estimate plus a fallback if none comes.

import { describe, expect, test } from "bun:test";
import type { VoiceState } from "@cophyla/protocol";
import { Conversation, PLAYBACK_SLACK_MS } from "../src/voice/conversation.ts";
import type { PlayedStats } from "../src/voice/conversation.ts";
import type { Logger } from "../src/log.ts";
import type { TtsEngine } from "../src/voice/engines.ts";

const RATE = 24000;

/** A voice whose first sentence takes `delayMs` to come, then `seconds` of audio in one chunk. */
function slowVoice(delayMs: number, seconds: number): TtsEngine {
  return {
    name: "slow",
    sampleRate: RATE,
    async *synth() {
      await Bun.sleep(delayMs);
      yield new Int16Array(Math.round(RATE * seconds));
    },
    close() {},
  };
}

describe("the speaking hold", () => {
  test("a voice slow to start: idle comes no sooner than the last chunk's playback after it was sent, plus the slack", async () => {
    const states: { state: VoiceState; at: number }[] = [];
    let firstAudioAt = 0;
    const tts = slowVoice(600, 0.5);
    const c = new Conversation({
      client: "cli_test",
      tts: () => tts,
      wakeThreshold: 0.5,
      thinkingTimeoutMs: 10_000,
      on: {
        state: (state) => states.push({ state, at: performance.now() }),
        partial: () => {},
        final: () => {},
        speaking: () => {},
        audio: () => {
          if (!firstAudioAt) firstAudioAt = performance.now();
        },
      },
    });
    await c.speak("There are no sessions online right now.");
    while (states.at(-1)?.state !== "idle") await Bun.sleep(20);
    expect(states.map((s) => s.state)).toEqual(["speaking", "idle"]);
    const heldAfterFirstChunk = states.at(-1)!.at - firstAudioAt;
    // the phone starts playing when the chunk arrives: 500 ms of it, and the hop on top
    expect(heldAfterFirstChunk).toBeGreaterThanOrEqual(500 + PLAYBACK_SLACK_MS - 30);
    c.dispose();
  });
});

/** A conversation with a phone that acks, keeping the frames it sent and the lines it logged. */
function acking(opts: { fallbackMs: number; seconds?: number }) {
  const states: VoiceState[] = [];
  const frames: { samples: number; reply: number; end?: true }[] = [];
  const lines: { message: string; fields?: Record<string, unknown> }[] = [];
  const log = {
    info: (message: string, fields?: Record<string, unknown>) => lines.push({ message, ...(fields ? { fields } : {}) }),
    debug: () => {},
    warn: () => {},
    error: () => {},
    child: () => log,
  } as unknown as Logger;
  const tts = slowVoice(0, opts.seconds ?? 0.2);
  const c = new Conversation({
    client: "cli_ack",
    tts: () => tts,
    acksPlayed: true,
    playedFallbackMs: opts.fallbackMs,
    wakeThreshold: 0.5,
    thinkingTimeoutMs: 10_000,
    log,
    on: {
      state: (state) => states.push(state),
      partial: () => {},
      final: () => {},
      speaking: () => {},
      audio: (pcm, _rate, frame) => frames.push({ samples: pcm.length, ...frame }),
    },
  });
  return { c, states, frames, lines };
}

describe("the speaking hold with a phone that acks", () => {
  test("each reply is numbered and ends with an empty end frame", async () => {
    const { c, frames } = acking({ fallbackMs: 5000 });
    await c.speak("One.");
    await c.speak("Two.");
    expect(frames.filter((f) => f.end).map((f) => [f.reply, f.samples])).toEqual([
      [1, 0],
      [2, 0],
    ]);
    expect(frames.filter((f) => !f.end).every((f) => f.samples > 0)).toBe(true);
    c.dispose();
  });

  test("speaking lasts past the estimate until voice.played, then ends at once with a turn line", async () => {
    const { c, states, lines } = acking({ fallbackMs: 5000 });
    await c.speak("There are no sessions online right now.");
    // 200 ms of audio: the estimate alone would have ended it after ~1 s.
    await Bun.sleep(200 + PLAYBACK_SLACK_MS + 300);
    expect(states).toEqual(["speaking"]);
    // an ack for an older reply changes nothing
    c.played(0);
    expect(states).toEqual(["speaking"]);
    const stats: PlayedStats = { underruns: 1, maxLateMs: 40, targetMs: 400, frames: 2 };
    c.played(1, stats);
    expect(states).toEqual(["speaking", "idle"]);
    const turn = lines.find((l) => l.message === "voice turn");
    expect(turn?.fields).toMatchObject({ outcome: "played", phone: stats });
    expect(typeof turn?.fields?.["playedAfterMs"]).toBe("number");
    c.dispose();
  });

  test("with no ack the state still ends, the fallback after the estimate", async () => {
    const { c, states, lines } = acking({ fallbackMs: 150 });
    const t0 = performance.now();
    await c.speak("Nobody answers.");
    while (states.at(-1) !== "idle") await Bun.sleep(20);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(200 + PLAYBACK_SLACK_MS + 150 - 30);
    expect(lines.some((l) => l.message === "no voice.played came; going idle")).toBe(true);
    expect(lines.find((l) => l.message === "voice turn")?.fields).toMatchObject({ outcome: "no ack" });
    c.dispose();
  });
});
