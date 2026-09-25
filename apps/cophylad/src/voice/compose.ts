// Turning a reply into something worth hearing. The brain writes for the ear on a spoken
// turn, but it still quotes by reference and still points at sessions and files by id: a
// quote arrives as text with a source attached, and a reference as an id. Read out as they
// stand, an id is noise and a quote begins with no warning. So the platform composes the
// lead-in from the quote's own source — "From the architecture document:" — and reads a
// reference as the name of the thing it points at. The brain never writes these, which is
// why the same reply can be shown on screen and spoken without being written twice.

import { basename } from "node:path";
import type { ContentBlock, Source } from "@cophyla/protocol";

/** What the things a reply points at are called, for the ear. */
export interface SpeechNames {
  /** A session: its workspace's name, else its intent. */
  session?(id: string): string | undefined;
  task?(id: string): string | undefined;
  thread?(id: string): string | undefined;
  ask?(id: string): string | undefined;
}

/** Markdown a model writes anyway, stripped: on screen it renders, in the ear it is noise. */
export function plain(text: string): string {
  return text
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(?<![A-Za-z0-9])[*_](\S(?:.*?\S)?)[*_](?![A-Za-z0-9])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** The words before a quote, naming where it came from. */
export function leadIn(source: Source | undefined, names: SpeechNames = {}): string {
  if (!source) return "Quote:";
  switch (source.kind) {
    case "file":
      return `From ${basename(source.path)}:`;
    case "session": {
      const name = names.session?.(source.session);
      return `From the agent in ${name ?? "a session"}:`;
    }
    case "memory":
      return `From memory ${source.name}:`;
    case "thread":
      return "From the thread:";
  }
}

/** What a reference is called when it is read out; nothing when it names nothing knowable. */
export function refWords(block: Extract<ContentBlock, { type: "ref" }>, names: SpeechNames = {}): string | undefined {
  if (block.session) return names.session?.(block.session) ?? "the agent";
  if (block.task) return names.task?.(block.task) ?? "the task";
  if (block.thread) return names.thread?.(block.thread) ?? "the thread";
  if (block.ask) return names.ask?.(block.ask) ?? "the question";
  if (block.file) return basename(block.file.path);
  if (block.audit) return "an audit entry";
  return undefined;
}

/**
 * One utterance from a reply's blocks: text as it stands, a quote after a lead-in naming
 * its source, a reference as a name, audio skipped. Sentences are kept apart so the engine
 * can split on them and the first one can leave early.
 */
export function composeSpeech(blocks: ContentBlock[], names: SpeechNames = {}): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text": {
        const text = plain(block.text);
        if (text) parts.push(text);
        break;
      }
      case "quote": {
        const text = plain(block.text);
        if (!text) break;
        parts.push(block.unresolved ? "Quote:" : leadIn(block.source, names));
        parts.push(/[.!?]\s*$/.test(text) ? text : text + ".");
        break;
      }
      case "ref": {
        const words = refWords(block, names);
        if (words) parts.push(words);
        break;
      }
      case "audio":
        break;
    }
  }
  return parts
    .join(" ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}
