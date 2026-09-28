// What the user hears and sees while the microphone records an utterance, however it began
// (the talk button, the talk key, the wake word): a short tone rising as recording starts and
// falling as it stops, and how loud each 20 ms of the microphone is while it records, for a
// view to draw as a wave. The tones are made here, two soft sine notes a fifth apart, so
// there is no file to ship; each is a fifth of a second and quiet, since the microphone is
// open while it plays.

/** Start rises, stop falls. */
export type CueKind = "start" | "stop";

/** The two notes, D5 and A5: a fifth, bright without being shrill. */
const LOW_HZ = 587.33;
const HIGH_HZ = 880;
/** The second note starts this long after the first, and each rings this long. */
const STEP_S = 0.075;
const RING_S = 0.13;
const ATTACK_S = 0.008;
/** The peak of each note, well under the replies' level. */
const PEAK = 0.16;
/** An octave over each note, quieter, so it rings rather than beeps. */
const OVERTONE = 0.18;

/** How long a cue sounds, from its first note to its second's end. */
export const CUE_S = STEP_S + RING_S;

/** The part of an `AudioContext` a cue plays through. */
export interface CueContext {
  readonly currentTime: number;
  readonly destination: AudioNode;
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
}

/** The notes a cue plays, in order: low then high to start, high then low to stop. */
export function cueNotes(kind: CueKind): [number, number] {
  return kind === "start" ? [LOW_HZ, HIGH_HZ] : [HIGH_HZ, LOW_HZ];
}

/** Plays a cue from `at` (now when earlier) and says when it ends, so the next can wait for it. */
export function playCue(ctx: CueContext, kind: CueKind, at = 0): number {
  const start = Math.max(ctx.currentTime, at);
  cueNotes(kind).forEach((hz, i) => note(ctx, hz, start + i * STEP_S));
  return start + CUE_S;
}

function note(ctx: CueContext, hz: number, at: number): void {
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(PEAK, at + ATTACK_S);
  env.gain.exponentialRampToValueAtTime(0.0001, at + RING_S);
  env.connect(ctx.destination);
  const tones: [number, number][] = [
    [hz, 1],
    [hz * 2, OVERTONE],
  ];
  for (const [freq, level] of tones) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    let out: AudioNode = osc;
    if (level !== 1) {
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g);
      out = g;
    }
    out.connect(env);
    osc.start(at);
    osc.stop(at + RING_S + 0.02);
  }
}

/** Levels per 40 ms frame: one for each 20 ms. */
export const LEVELS_PER_FRAME = 2;
/** The quietest level drawn above nothing, and the loudest drawn full, in dB of full scale. */
const FLOOR_DB = -60;
const CEIL_DB = -12;

/**
 * How loud each of `parts` equal slices of a frame is, 0 to 1: its RMS in dB of full scale,
 * from `FLOOR_DB` (0) to `CEIL_DB` (1), so a voice under the web view's gain control fills
 * most of the height and the room's hiss hardly shows.
 */
export function levelsOf(pcm: Int16Array, parts = LEVELS_PER_FRAME): number[] {
  const out: number[] = [];
  const size = Math.floor(pcm.length / parts);
  if (size === 0) return out;
  for (let p = 0; p < parts; p++) {
    let sum = 0;
    for (let i = p * size; i < (p + 1) * size; i++) {
      const s = pcm[i]! / 32768;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / size);
    const db = rms > 0 ? 20 * Math.log10(rms) : FLOOR_DB;
    out.push(Math.round(Math.min(1, Math.max(0, (db - FLOOR_DB) / (CEIL_DB - FLOOR_DB))) * 1000) / 1000);
  }
  return out;
}
