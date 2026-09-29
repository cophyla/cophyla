// config.toml's `[speech]` rules applied to one reply: the first rule that matches it and can be
// heard decides. A rule matches on what the reply is (an answer, or a result), how the request
// was made, and whether the session it is about is in front of the user; `off` then ends the
// list with nothing read out. Otherwise the rule names a device, the one asked on or the one
// used last, which must have been used in the app lately when the rule says so, and must be
// heard now (see `Presence.speakable`); a rule whose device cannot be falls through to the next.

import type { SpeechRule } from "../config/schema.ts";

/** What a reply is, as the rules read it. */
export interface SpeechFacts {
  reply: "answer" | "result";
  asked: "voice" | "typed";
  /** The device the request came from, when it is known. */
  asker?: string;
  /** Whether the session the reply is about is in front of the user; asked only of a rule that cares. */
  watching: () => boolean;
}

/** What the rules ask of the devices. */
export interface SpeechWorld {
  /** The device the user acted on last. */
  recent(): string | undefined;
  /** When the user last acted on a device. */
  lastAction(device: string): number | undefined;
  /** Whether a device can be heard now. */
  heard(device: string): boolean;
  now(): number;
}

/** The rules' word: read out on `device`, or not at all; `rule` is the index of the rule that decided, none when none did or the user turned speech on. */
export type SpeechVerdict = { speak: true; device: string; rule?: number } | { speak: false; rule?: number };

export function decide(rules: readonly SpeechRule[], facts: SpeechFacts, world: SpeechWorld): SpeechVerdict {
  let watching: boolean | undefined;
  for (const [i, r] of rules.entries()) {
    if (r.reply !== facts.reply) continue;
    if (r.asked !== "any" && r.asked !== facts.asked) continue;
    if (r.watching !== undefined && (watching ??= facts.watching()) !== r.watching) continue;
    if (r.speak_on === "off") return { speak: false, rule: i };
    const device = r.speak_on === "asker" ? facts.asker : world.recent();
    if (device === undefined) continue;
    if (r.used_within_min !== undefined) {
      const at = world.lastAction(device);
      if (at === undefined || world.now() - at > r.used_within_min * 60_000) continue;
    }
    if (!world.heard(device)) continue;
    return { speak: true, device, rule: i };
  }
  return { speak: false };
}
