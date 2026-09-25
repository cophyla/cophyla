// What the page shows, as a value: which of the three screens, the line of status, the state
// of each control. Pure, so the rules about when a button is live are testable without a
// browser — and there are a few, because a phone can be paired but disconnected, connected
// but with no microphone yet, or listening while the node has nothing to transcribe with;
// and which way each microphone frame goes: up to the node, into the phone's own wake word,
// both, or nowhere.

import type { VoiceState } from "@cophyla/protocol";
import type { LinkState } from "@cophyla/viewhost";
import type { WakeMode } from "./wake/state.ts";

export type Screen = "pair" | "gate" | "main";

export interface ChromeInput {
  link: LinkState;
  /** Why the link is where it is: the node's own words. */
  error?: string;
  paired: boolean;
  /** The audio context exists and is running: the Start gesture happened, or the app started it itself. */
  audioReady: boolean;
  /** The app starts its audio itself, with no tap; the gate shows only once that failed. A browser needs the tap. */
  autoStart?: boolean;
  /** The node's voice state for this controller, when it has said one. */
  voice?: VoiceState;
  /** The node cannot transcribe: the stage is off or its engine did not load. */
  sttReady: boolean;
  /** Listening for the wake word, on unless turned off in the menu. */
  listening: boolean;
  /** Where the wake word is detected: the node's last answer, kept across reconnects; `node` before the first. */
  wake: WakeMode;
  /** The phone heard the word and the node has not yet said `listening`. */
  pending: boolean;
  /** The button is held. */
  talking: boolean;
  muted: boolean;
  /** A message to show over everything: a refusal the user must act on. */
  overlay?: string;
  /** Which way the link runs: on the LAN, through the server relay, or on a data channel. */
  via?: "lan" | "relay" | "p2p";
  /** On a data channel: straight to the node, or through TURN. */
  path?: "direct" | "turn";
  /** A remote desktop covers the app: nothing listens meanwhile. */
  watching?: boolean;
}

export interface Chrome {
  screen: Screen;
  status: string;
  /** The talk button's words: Hold to talk when it is live, else what it waits on, or what the conversation is doing. */
  pttLabel: string;
  /** The colour word the dot takes; a view's CSS keys on it. */
  dot: "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "offline";
  /** What the conversation is doing, in words. */
  voiceWord: string;
  /** Frames should be going up right now. */
  streaming: boolean;
  /** Frames should be going to the phone's own wake word right now. */
  detecting: boolean;
  /** The screen should stay on: something is listening, here or on the node. */
  awakeLock: boolean;
  pttEnabled: boolean;
  muted: boolean;
  overlay?: string;
}

const VOICE_WORD: Record<VoiceState, string> = {
  idle: "",
  listening: "listening",
  transcribing: "transcribing",
  thinking: "thinking",
  speaking: "speaking",
};

export function deriveChrome(input: ChromeInput): Chrome {
  const connected = input.link === "connected";
  const screen: Screen = !input.paired ? "pair" : !input.audioReady && !input.autoStart ? "gate" : "main";
  const dot = connected ? (input.voice ? (input.voice === "idle" ? "idle" : input.voice) : "idle") : "offline";
  const status = statusOf(input, connected);
  const live = connected && input.audioReady && input.watching !== true;
  const inUtterance = input.voice === "listening" || input.voice === "transcribing";
  const chrome: Chrome = {
    screen,
    status,
    pttLabel: pttLabelOf(input, connected),
    dot,
    voiceWord: connected && input.voice ? VOICE_WORD[input.voice] : "",
    // A held button beats the toggle: it is how you speak with the wake word off. Whenever the
    // node is listening to this phone, audio goes up, whatever else is true, so the node never
    // waits on a phone that stopped sending; and until it says so, the phone's own word is enough.
    streaming: live && (input.talking || input.voice === "listening" || input.pending || (input.listening && input.wake === "node")),
    // The phone's wake word runs whenever the node's would have: through a reply too, so a word
    // over it interrupts, but not over the utterance itself or while the button is held.
    detecting: live && input.listening && input.wake === "phone" && !input.talking && !input.pending && !inUtterance,
    awakeLock: live && (input.talking || input.voice === "listening" || (input.listening && input.wake !== "off")),
    pttEnabled: connected && input.audioReady && input.sttReady,
    muted: input.muted,
  };
  if (input.overlay !== undefined) chrome.overlay = input.overlay;
  return chrome;
}

function pttLabelOf(input: ChromeInput, connected: boolean): string {
  if (!connected) return input.link === "disconnected" ? "offline" : input.link === "unauthorized" ? "refused" : "connecting…";
  if (!input.audioReady) return "starting…";
  if (!input.sttReady) return "cannot transcribe";
  if (input.voice && input.voice !== "idle") return VOICE_WORD[input.voice];
  if (input.talking) return "listening";
  return "Hold to talk";
}

function statusOf(input: ChromeInput, connected: boolean): string {
  if (!input.paired) return "not paired";
  switch (input.link) {
    case "starting":
    case "connecting":
      return "connecting…";
    case "disconnected":
      return input.error ? `offline — ${input.error}` : "offline";
    case "unauthorized":
      return input.error ? `refused — ${input.error}` : "refused";
    case "connected":
      break;
  }
  if (!connected) return "offline";
  if (!input.audioReady) return input.autoStart ? "starting the microphone…" : "tap to start";
  const via = input.via === "relay" ? " (relay)" : input.via === "p2p" ? (input.path === "turn" ? " (TURN)" : " (direct)") : "";
  if (!input.sttReady) return `connected — the node cannot transcribe${via}`;
  if (input.voice && input.voice !== "idle") return VOICE_WORD[input.voice] + via;
  if (input.listening && input.wake === "off") return `ready — the wake word is off on the node${via}`;
  if (input.listening) return `listening for the wake word${via}`;
  return `ready${via}`;
}
