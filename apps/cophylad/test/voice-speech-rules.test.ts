// The `[speech]` rules applied to one reply: the first rule that matches and can be heard
// decides, one that cannot be heard gives way to the next, `off` ends the list, `recent` is the
// device used last, `used_within_min` counts from the device's last action, and whether the
// session is watched is asked only of a rule that cares.

import { describe, expect, test } from "bun:test";
import { BUILTIN_SPEECH_RULES } from "../src/config/schema.ts";
import type { SpeechRule } from "../src/config/schema.ts";
import { decide } from "../src/voice/speech-rules.ts";
import type { SpeechFacts, SpeechWorld } from "../src/voice/speech-rules.ts";

const NOW = 1_000_000_000;
const MIN = 60_000;

/** A world of devices, each with its last action and whether it can be heard. */
function world(devices: Record<string, { at?: number; heard?: boolean }>): SpeechWorld {
  return {
    recent: () => Object.entries(devices).sort(([, a], [, b]) => (b.at ?? -Infinity) - (a.at ?? -Infinity))[0]?.[0],
    lastAction: (d) => devices[d]?.at,
    heard: (d) => devices[d]?.heard ?? true,
    now: () => NOW,
  };
}

const facts = (over: Partial<SpeechFacts> = {}): SpeechFacts => ({ reply: "answer", asked: "voice", asker: "phone:a", watching: () => false, ...over });
const rule = (r: Partial<SpeechRule> & Pick<SpeechRule, "reply">): SpeechRule => ({ asked: "any", speak_on: "asker", ...r });

describe("the speech rules", () => {
  test("built in: a spoken request's answer is read where it was asked; a typed one's is not", () => {
    const w = world({ "phone:a": { at: NOW - 60 * MIN } });
    expect(decide(BUILTIN_SPEECH_RULES, facts(), w)).toEqual({ speak: true, device: "phone:a", rule: 0 });
    expect(decide(BUILTIN_SPEECH_RULES, facts({ asked: "typed" }), w)).toEqual({ speak: false });
  });

  test("built in: a spoken request's result is read out only unwatched, and on a device used in the last five minutes", () => {
    const result = facts({ reply: "result", asker: "desktop@n1" });
    expect(decide(BUILTIN_SPEECH_RULES, result, world({ "desktop@n1": { at: NOW - 4 * MIN } }))).toEqual({ speak: true, device: "desktop@n1", rule: 1 });
    expect(decide(BUILTIN_SPEECH_RULES, { ...result, watching: () => true }, world({ "desktop@n1": { at: NOW - 4 * MIN } }))).toEqual({ speak: false });
    expect(decide(BUILTIN_SPEECH_RULES, result, world({ "desktop@n1": { at: NOW - 6 * MIN } }))).toEqual({ speak: false });
    expect(decide(BUILTIN_SPEECH_RULES, result, world({ "desktop@n1": {} }))).toEqual({ speak: false });
    expect(decide(BUILTIN_SPEECH_RULES, { ...result, asked: "typed" }, world({ "desktop@n1": { at: NOW } }))).toEqual({ speak: false });
  });

  test("the first rule that matches decides", () => {
    const rules = [rule({ reply: "answer", speak_on: "recent" }), rule({ reply: "answer" })];
    const w = world({ "phone:a": { at: NOW - MIN }, "desktop@n1": { at: NOW } });
    expect(decide(rules, facts(), w)).toEqual({ speak: true, device: "desktop@n1", rule: 0 });
  });

  test("a rule whose device cannot be heard falls through to the next", () => {
    const rules = [rule({ reply: "answer" }), rule({ reply: "answer", speak_on: "recent" })];
    const w = world({ "phone:a": { at: NOW, heard: false }, "desktop@n1": { at: NOW - MIN } });
    // The asker cannot be heard, and it is also the one used last: nothing is read out.
    expect(decide(rules, facts(), w)).toEqual({ speak: false });
    const w2 = world({ "phone:a": { at: NOW - 2 * MIN, heard: false }, "desktop@n1": { at: NOW - MIN } });
    expect(decide(rules, facts(), w2)).toEqual({ speak: true, device: "desktop@n1", rule: 1 });
    // No asker known: an asker rule has nowhere to read.
    expect(decide([rule({ reply: "answer" })], facts({ asker: undefined }), w2)).toEqual({ speak: false });
  });

  test("off ends the list, once its own conditions match", () => {
    const rules = [rule({ reply: "result", watching: true, speak_on: "off" }), rule({ reply: "result" })];
    const w = world({ "phone:a": { at: NOW } });
    expect(decide(rules, facts({ reply: "result", watching: () => true }), w)).toEqual({ speak: false, rule: 0 });
    expect(decide(rules, facts({ reply: "result" }), w)).toEqual({ speak: true, device: "phone:a", rule: 1 });
    expect(decide([rule({ reply: "answer", speak_on: "off" }), rule({ reply: "answer" })], facts(), w)).toEqual({ speak: false, rule: 0 });
  });

  test("recent is the device used last, held to used_within_min like any other", () => {
    const rules = [rule({ reply: "result", speak_on: "recent", used_within_min: 2 })];
    expect(decide(rules, facts({ reply: "result" }), world({ "phone:a": { at: NOW - 10 * MIN }, "desktop@n1": { at: NOW - MIN } }))).toEqual({ speak: true, device: "desktop@n1", rule: 0 });
    expect(decide(rules, facts({ reply: "result" }), world({ "phone:a": { at: NOW - 10 * MIN }, "desktop@n1": { at: NOW - 3 * MIN } }))).toEqual({ speak: false });
    expect(decide(rules, facts({ reply: "result" }), world({}))).toEqual({ speak: false });
  });

  test("no rules reads nothing out, and watching is asked only of a rule that cares, once", () => {
    let asked = 0;
    const counted = facts({ reply: "result", watching: () => (asked++, false) });
    expect(decide([], counted, world({ "phone:a": { at: NOW } }))).toEqual({ speak: false });
    decide([rule({ reply: "result", speak_on: "recent" })], counted, world({ "phone:a": { at: NOW } }));
    expect(asked).toBe(0);
    decide([rule({ reply: "result", watching: false, speak_on: "off" }), rule({ reply: "result", watching: false })], counted, world({ "phone:a": { at: NOW } }));
    expect(asked).toBe(1);
  });
});
