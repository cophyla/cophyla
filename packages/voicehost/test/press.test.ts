// A press on the user's own timeline, over a fake link and frames fed by hand: each frame's
// capture time on the wall clock however late the page took it, a press that names when it
// happened sending the frames captured since then first (none twice) and the live ones after,
// a release that stops at its own time, waits for the frames captured before it and names the
// last of them (`upTo`), the edges going out in order, one holder of the press at a time, and
// a view's talk button taken through `viewPtt`, its cancel included.

import { describe, expect, test } from "bun:test";
import { CaptureClock, DRIFT_MS_PER_S } from "../src/clock.ts";
import { decodeChunk } from "../src/pcm.ts";
import { RELEASE_WAIT_MS, VoiceHost } from "../src/voicehost.ts";
import { FrameRing } from "../src/wake/ring.ts";

describe("when a frame was captured", () => {
  test("the least gap between arrival and capture is the offset: a frame taken late still says when it was spoken", () => {
    const clock = new CaptureClock();
    // The audio clock at 10 s is the wall clock at 1,000,000 ms; the first frame came 5 ms late.
    expect(clock.wall(10, 1_000_005)).toBe(1_000_005);
    // One that came on time lowers the offset.
    expect(clock.wall(10.04, 1_000_040)).toBe(1_000_040);
    // A page that stalled a second and a half takes this one late: it was still captured at 1,000,080,
    // give or take what the offset may creep over the stall.
    const late = clock.wall(10.08, 1_001_580);
    expect(late).toBeGreaterThanOrEqual(1_000_080);
    expect(late - 1_000_080).toBeLessThanOrEqual(1.54 * DRIFT_MS_PER_S + 1e-6);
    expect(clock.at(10.2)! - 1_000_200).toBeLessThanOrEqual(1.54 * DRIFT_MS_PER_S + 1e-6);
  });

  test("the offset rises no faster than the clocks drift, and starts over after a reset", () => {
    const clock = new CaptureClock();
    clock.wall(0, 1000);
    // Ten seconds on, every frame two hundred ms late: the offset creeps up by the drift alone.
    expect(clock.wall(10, 11_200)).toBeCloseTo(11_000 + 10.2 * DRIFT_MS_PER_S, 6);
    clock.reset();
    expect(clock.at(10)).toBeUndefined();
    expect(clock.wall(10, 11_200)).toBe(11_200);
  });

  test("the ring gives the frames captured since a moment, and the last of a press sent before one", () => {
    const ring = new FrameRing();
    for (let n = 1; n <= 5; n++) ring.push(n, new Int16Array([n]), 1000 + n * 40);
    expect(ring.since(1100).map((f) => f.seq)).toEqual([3, 4, 5]);
    ring.since(0)[1]!.sent = true;
    ring.since(0)[3]!.sent = true;
    // Frame 4 ended at 1160, so began at 1120: before 1150, and sent.
    expect(ring.lastSentBefore(1150)?.seq).toBe(4);
    expect(ring.lastSentBefore(1110)?.seq).toBe(2);
  });
});

type Wire = { request: string; params: unknown } | { audio: number; seq: number };

/** A host over a link that keeps, in order, what went on the wire: requests and frames (by the first sample's value). */
function harness(opts: { listening?: boolean; refuse?: string } = {}) {
  const wire: Wire[] = [];
  let now = 10_000;
  const answers: (() => void)[] = [];
  const link = {
    connected: true,
    state: { hello: { client: { id: "cli_me" }, audio: { codecs: ["pcm" as const], dictate: true as const } } },
    request: <T>(method: string, params: unknown): Promise<T> => {
      wire.push({ request: method, params });
      if (opts.refuse && (params as { active?: boolean }).active === true) return Promise.reject(Object.assign(new Error(opts.refuse), { code: "unavailable" }));
      return new Promise<T>((resolve) => answers.push(() => resolve({} as T)));
    },
    send: async (frame: object) => {
      if ((frame as { method?: string }).method !== "voice.audio") return;
      const p = (frame as { params: { chunk: string; seq: number } }).params;
      wire.push({ audio: decodeChunk(p.chunk)[0]!, seq: p.seq });
    },
  };
  const host = new VoiceHost({ link, listening: opts.listening ?? false, now: () => now, log: () => {} });
  const inner = host as unknown as { audioReady: boolean; onMic(pcm: Int16Array, at: number): void };
  inner.audioReady = true;
  host.linkChanged(true);
  wire.length = 0;
  let capturing = false;
  Object.defineProperty(host.audio, "capturing", { get: () => capturing });
  Object.defineProperty(host.audio, "capturedTo", { get: () => undefined });
  return {
    host,
    wire,
    /** A frame whose samples all say `n`, captured to `at` (40 ms ending there). */
    frame: (n: number, at: number) => inner.onMic(new Int16Array(640).fill(n), at),
    tick: (ms: number) => (now += ms),
    set now(v: number) {
      now = v;
    },
    capture: (on: boolean) => (capturing = on),
    /** The node answers every request so far. */
    answer: () => {
      for (const a of answers.splice(0)) a();
    },
    requests: () => wire.filter((w): w is { request: string; params: unknown } => "request" in w),
    audio: () => wire.filter((w): w is { audio: number; seq: number } => "audio" in w).map((w) => w.audio),
  };
}

describe("a press on the user's timeline", () => {
  test("a press the page took late sends the frames captured since the press first, then the live ones", () => {
    const h = harness();
    // Frames 1..5 captured from 10,000 to 10,200; nothing goes up while nobody holds the button.
    for (let n = 1; n <= 5; n++) h.frame(n, 10_000 + n * 40);
    expect(h.wire).toEqual([]);
    h.now = 10_220;
    // Pressed at 10,090: frames 3, 4 and 5 hold audio captured after it.
    h.host.ptt(true, { at: 10_090, dictate: true });
    h.frame(6, 10_240);
    expect(h.wire).toEqual([{ request: "voice.ptt", params: { active: true, dictate: true, at: 10_090 } }, { audio: 3, seq: 0 }, { audio: 4, seq: 1 }, { audio: 5, seq: 2 }, { audio: 6, seq: 3 }]);
  });

  test("frames already streamed for the node's wake word are not sent twice", () => {
    const h = harness({ listening: true });
    // Listening with the node detecting: every frame streams.
    for (let n = 1; n <= 3; n++) h.frame(n, 10_000 + n * 40);
    h.now = 10_130;
    h.host.ptt(true, { at: 10_010 });
    expect(h.audio()).toEqual([1, 2, 3]);
    expect(h.requests().map((r) => r.params)).toEqual([{ active: true, at: 10_010 }]);
  });

  test("a press further back than the ring keeps begins where the ring does; one from the future, now", () => {
    const h = harness();
    h.now = 50_000;
    h.host.ptt(true, { at: 0 });
    h.host.ptt(false, { at: 99_999 });
    expect(h.requests().map((r) => (r.params as { at: number }).at)).toEqual([40_000, 50_000]);
  });

  test("a release stops at its own time: frames captured before it still go up, the release names the last, and nothing after it goes", async () => {
    const h = harness();
    h.capture(true);
    h.host.ptt(true, { at: 10_000 });
    h.frame(1, 10_040);
    h.frame(2, 10_080);
    // Let go at 10,150, while frames 3 and 4 (captured up to 10,160) are still on their way to the page.
    h.now = 10_150;
    h.host.ptt(false, { at: 10_150 });
    expect(h.requests()).toHaveLength(1);
    h.frame(3, 10_120);
    h.frame(4, 10_160);
    // Frame 5 began at 10,160, after the release: it ends the wait and is not sent.
    h.frame(5, 10_200);
    expect(h.audio()).toEqual([1, 2, 3, 4]);
    expect(h.requests().at(-1)).toEqual({ request: "voice.ptt", params: { active: false, at: 10_150, upTo: 3 } });
    h.frame(6, 10_240);
    expect(h.audio()).toEqual([1, 2, 3, 4]);
  });

  test("a release the page took late names the last frame from before it, though later ones went up", () => {
    const h = harness();
    h.host.ptt(true, { at: 10_000 });
    for (let n = 1; n <= 5; n++) h.frame(n, 10_000 + n * 40);
    // Let go at 10,090: frames 3 to 5 went up live before the page heard of it.
    h.now = 10_300;
    h.host.ptt(false, { at: 10_090 });
    expect(h.requests().at(-1)?.params).toEqual({ active: false, at: 10_090, upTo: 2 });
  });

  test("with no capture running the release goes at once; with a capture that sends nothing, after the wait", async () => {
    const h = harness();
    h.host.ptt(true);
    h.host.ptt(false);
    expect(h.requests().map((r) => r.params)).toEqual([{ active: true, at: 10_000 }, { active: false, at: 10_000 }]);
    h.capture(true);
    h.host.ptt(true);
    h.host.ptt(false);
    expect(h.requests()).toHaveLength(3);
    await Bun.sleep(RELEASE_WAIT_MS + 50);
    expect(h.requests()).toHaveLength(4);
  });

  test("a press while the last release still waits sends that release first, then the press with its frames", () => {
    const h = harness();
    h.capture(true);
    h.host.ptt(true, { at: 10_000 });
    h.frame(1, 10_040);
    h.now = 10_060;
    h.host.ptt(false, { at: 10_060 });
    h.now = 10_070;
    h.host.ptt(true, { at: 10_070 });
    h.frame(2, 10_080);
    expect(h.wire).toEqual([
      { request: "voice.ptt", params: { active: true, at: 10_000 } },
      { audio: 1, seq: 0 },
      { request: "voice.ptt", params: { active: false, at: 10_060, upTo: 0 } },
      { request: "voice.ptt", params: { active: true, at: 10_070 } },
      { audio: 2, seq: 1 },
    ]);
  });

  test("the release is answered once the node answers it; a refused press rejects with the refusal and records nothing", async () => {
    const h = harness();
    let answered = false;
    const press = h.host.hold(true);
    const release = h.host.hold(false).then(() => (answered = true));
    await Bun.sleep(0);
    expect(answered).toBe(false);
    h.answer();
    await Promise.all([press, release]);
    expect(answered).toBe(true);
    const refused = harness({ refuse: "speech to text is loading" });
    await expect(refused.host.hold(true)).rejects.toThrow("speech to text is loading");
    expect(refused.host.view.refused).toBe("speech to text is loading");
    expect(refused.host.view.recording).toBe(false);
  });
});

describe("one holder of the press", () => {
  test("a view's press while the talk key holds is nobody's, and only the key lets go", async () => {
    const h = harness();
    h.host.ptt(true, { at: 10_000 });
    await h.host.viewPtt({ active: true, dictate: true, at: 10_010 });
    await h.host.viewPtt({ active: false, at: 10_020 });
    expect(h.host.view.talking).toBe(true);
    expect(h.requests().map((r) => r.params)).toEqual([{ active: true, at: 10_000 }]);
    h.now = 10_030;
    h.host.ptt(false, { at: 10_030 });
    expect(h.host.view.talking).toBe(false);
    expect(h.requests().map((r) => r.params)).toEqual([{ active: true, at: 10_000 }, { active: false, at: 10_030 }]);
  });

  test("the view's button holds it through the bridge, with its time, and the host's release is not its own", () => {
    const h = harness();
    void h.host.viewPtt({ active: true, dictate: true, at: 9_990 });
    h.host.ptt(false);
    expect(h.host.view.talking).toBe(true);
    void h.host.viewPtt({ active: false, at: 10_000 });
    expect(h.requests().map((r) => r.params)).toEqual([{ active: true, dictate: true, at: 9_990 }, { active: false, at: 10_000 }]);
  });

  test("a view's cancel lets go of the press, whoever held it, sends nothing more of it, and asks the node to drop it", async () => {
    const h = harness();
    h.capture(true);
    h.host.ptt(true, { at: 10_000 });
    h.frame(1, 10_040);
    h.now = 10_060;
    // The release waits for its frames; the cancel comes first.
    h.host.ptt(false, { at: 10_060 });
    const cancel = h.host.viewPtt({ active: false, cancel: true });
    h.frame(2, 10_080);
    h.answer();
    await cancel;
    expect(h.host.view.talking).toBe(false);
    expect(h.requests().map((r) => r.params)).toEqual([{ active: true, at: 10_000 }, { active: false, cancel: true }]);
    expect(h.audio()).toEqual([1]);
  });
});
