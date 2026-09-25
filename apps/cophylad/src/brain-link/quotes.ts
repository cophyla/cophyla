// Quote expansion. A `ui.say` block that cites a request and lines is expanded here from the
// audit table: the request id the brain used maps to the audit entry, the entry's stored
// result is projected the way the brain saw it, the cited lines are taken verbatim, and the
// source is attached. Anything missing (no entry, a body over the cap, nothing quotable, an
// empty selection) leaves the block's own text with `unresolved: true`.

import { quotable, selectLines } from "@cophyla/protocol";
import type { AuditEntry, ContentBlock, NodeId, OutBlock } from "@cophyla/protocol";

export interface QuoteLookup {
  /** The audit entry a brain request id (or an `aud_` id) refers to. */
  entry(request: string): AuditEntry | undefined;
}

export function expandBlock(block: OutBlock, lookup: QuoteLookup, node: NodeId): ContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "ref":
      return block;
    case "quote": {
      if (!block.cite) return { type: "quote", text: block.text ?? "" };
      const unresolved: ContentBlock = { type: "quote", text: block.text ?? "", unresolved: true };
      const entry = lookup.entry(block.cite.request);
      if (!entry || entry.outcome !== "ok" || !entry.result || !("body" in entry.result)) return unresolved;
      const q = quotable(entry.action, entry.args, entry.result.body, node);
      if (!q) return unresolved;
      const sel = selectLines(q, block.cite.lines);
      if (!sel) return unresolved;
      const out: ContentBlock = { type: "quote", text: sel.text };
      if (sel.source) out.source = sel.source;
      return out;
    }
  }
}

export function expandBlocks(blocks: OutBlock[], lookup: QuoteLookup, node: NodeId): ContentBlock[] {
  return blocks.map((b) => expandBlock(b, lookup, node));
}
