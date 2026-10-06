// What a host with a microphone of its own says of its voice in its settings, and the
// microphone it kept from last time. Shared by the hosts that have a Voice section: the
// desktop app, and the controller page in a desktop browser.

import type { MicChoice } from "./mics.ts";
import type { VoiceView } from "./voicehost.ts";

/** What the Voice section says voice is doing, in words; `talk` names what still works with the wake words off ("the talk key", "the talk button"). */
export function statusWords(v: VoiceView, connected: boolean, talk = "the talk key"): string {
  if (!connected) return "Not connected to cophylad.";
  if (!v.audioReady) return "Starting the microphone…";
  if (v.refused) return `Cophyla cannot listen: ${v.refused}`;
  if (v.voice && v.voice !== "idle") return v.voice === "listening" ? "Listening to you…" : `${v.voice[0]!.toUpperCase()}${v.voice.slice(1)}…`;
  if (v.wake === "off") return `The wake words are off on this node; ${talk} still works.`;
  if (!v.listening) return `Not listening for the wake words; ${talk} still works.`;
  if (v.wake === "node") return "Listening: this computer streams to the node, which hears the wake words.";
  return "Listening for the wake words, here on this computer.";
}

/** The microphone kept in storage, when what is kept reads as one. */
export function readMic(raw: string | null): MicChoice | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as { id?: unknown; label?: unknown };
    return typeof v.id === "string" && v.id !== "" && typeof v.label === "string" ? { id: v.id, label: v.label } : undefined;
  } catch {
    return undefined;
  }
}
