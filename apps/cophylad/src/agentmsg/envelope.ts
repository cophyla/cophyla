// The envelope an agent's message travels in, the same on every harness:
//
//   <cophyla-message from="api-codex" harness="codex" machine="Laptop" folder="api" id="pmsg_…" reply_to="pmsg_…">
//   text
//   </cophyla-message>
//
// Neither harness says who a message is from (Claude's own wrapper says only "another Claude
// session", Codex and Muse show it as the user's words), so the envelope is the provenance,
// and the MCP server's instructions say what it means. A notice of cophyla's own about a
// message the session sent is `from="cophyla"`. Attribute values are cut to one short line
// with nothing that could close the tag, and a closing tag inside the text is broken, so the
// text cannot end the envelope early and pass what follows as cophyla's words.

import type { AgentRef } from "@cophyla/protocol";
import { capText } from "../sessions/model.ts";

/** What every envelope starts with: how a harness's echo of one is known. */
export const ENVELOPE_TAG = "<cophyla-message";
const CLOSE_TAG = "</cophyla-message>";
/** The sender named in a notice of cophyla's own. */
export const NOTICE_FROM = "cophyla";
const ATTR_CHARS = 80;

/** What an envelope carries beside its text. */
export interface EnvelopeInfo {
  /** Absent: a notice of cophyla's own. */
  from?: AgentRef;
  messageId: string;
  replyTo?: string;
}

/** What an envelope said, read back from a harness's echo of it. */
export interface ReadEnvelope {
  from: { alias: string; harness?: string; nodeName?: string; folder?: string };
  messageId: string;
  replyTo?: string;
  text: string;
}

/** One attribute value: one line, no quote or angle bracket, and short. */
export function attrValue(value: string): string {
  const flat = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/["<>&]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > ATTR_CHARS ? flat.slice(0, ATTR_CHARS - 1) + "…" : flat;
}

/** The text with any closing tag of the envelope broken, so it cannot end the envelope early. */
export function neutralise(text: string): string {
  return text.replace(/<\/(\s*)cophyla-message/gi, "</$1cophyla‑message");
}

export function envelope(info: EnvelopeInfo, text: string): string {
  const attrs: [string, string | undefined][] = info.from
    ? [
        ["from", info.from.alias],
        ["harness", info.from.harness],
        ["machine", info.from.nodeName],
        ["folder", info.from.folder],
      ]
    : [["from", NOTICE_FROM]];
  attrs.push(["id", info.messageId], ["reply_to", info.replyTo]);
  const head = attrs.flatMap(([k, v]) => (v !== undefined && v !== "" ? [`${k}="${attrValue(v)}"`] : [])).join(" ");
  return `${ENVELOPE_TAG} ${head}>\n${neutralise(text)}\n${CLOSE_TAG}`;
}

/** The turn an agent's message is recorded as in the session it reached: who it is from, its id, what it answers, and its text. */
export function agentTurn(info: EnvelopeInfo, text: string, ref?: string): Record<string, unknown> {
  return { source: "agent", ...(info.from ? { from: info.from } : {}), messageId: info.messageId, ...(info.replyTo ? { replyTo: info.replyTo } : {}), text: capText(text), ...(ref ? { ref } : {}) };
}

const ENVELOPE = /<cophyla-message ([^>]*)>\r?\n?([\s\S]*?)\r?\n?<\/cophyla-message>/;
const ATTR = /([a-z_]+)="([^"]*)"/g;

/** The envelope in a harness's echo of a message, when there is one with an id. */
export function readEnvelope(text: string): ReadEnvelope | undefined {
  const m = ENVELOPE.exec(text);
  if (!m) return undefined;
  const attrs = new Map<string, string>();
  for (const a of m[1]!.matchAll(ATTR)) attrs.set(a[1]!, a[2]!);
  const id = attrs.get("id");
  const from = attrs.get("from");
  if (!id || !from) return undefined;
  const harness = attrs.get("harness");
  const nodeName = attrs.get("machine");
  const folder = attrs.get("folder");
  const replyTo = attrs.get("reply_to");
  return {
    from: { alias: from, ...(harness ? { harness } : {}), ...(nodeName ? { nodeName } : {}), ...(folder ? { folder } : {}) },
    messageId: id,
    ...(replyTo ? { replyTo } : {}),
    text: m[2]!,
  };
}
