// The provisional reply. Only an `llm.complete` the brain flags as `reply` streams: brain-link
// makes that request the owner with `begin`, and its text deltas become `chat.delta` on a
// message id allocated at the first visible text, with the citation and reference tags
// stripped so nothing half-written reaches the view. A text-only end keeps the id for the
// `ui.say` that follows, which takes it and stores the final message under it, and the view
// replaces the placeholder. Every other way a placeholder can end is a `chat.retract`: a step
// that ended in tool calls or an error (that text is never said), `<silent/>`, a route that
// failed over mid-stream, the next reply beginning with the last one unsaid, a user message,
// or the brain exiting. Nothing here is stored.

import { newId } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";

/** A tag is held back from `<` until its `>`, or given up on after this many characters. */
const HOLD_MAX = 200;

const TAG = /^<(quote|ref|silent)\b/;

/** How the owning request ended. */
export interface StreamEnd {
  ok: boolean;
  /** The step ended in tool calls: its text is not the reply. */
  toolUse?: boolean;
}

export class ReplyStream {
  private bus: Bus;
  private now: () => number;
  /** The request whose deltas stream; any other request's are ignored. */
  private owner?: string;
  private id?: string;
  private held = "";
  /** Inside a `<quote …>…</quote>` block: everything up to the closing tag is dropped. */
  private inQuote = false;
  /** The owner wrote `<silent/>`: the rest of its text is swallowed. */
  private silent = false;

  constructor(bus: Bus, now: () => number = Date.now) {
    this.bus = bus;
    this.now = now;
  }

  /** The id of the message being streamed, if any. */
  get current(): string | undefined {
    return this.id;
  }

  /** A reply request starts: whatever was left streaming is abandoned, and `req` owns the stream. */
  begin(req: string): void {
    this.retract();
    this.owner = req;
    this.clearParser();
  }

  /** A text delta from the model, for request `req`. */
  push(req: string, text: string): void {
    if (req !== this.owner || this.silent) return;
    let out = "";
    let buf = this.held + text;
    this.held = "";
    for (;;) {
      if (this.inQuote) {
        const end = buf.indexOf("</quote>");
        if (end < 0) {
          // Keep enough to recognise a closing tag split across deltas.
          this.held = buf.slice(-8);
          buf = "";
          break;
        }
        buf = buf.slice(end + "</quote>".length);
        this.inQuote = false;
        continue;
      }
      const lt = buf.indexOf("<");
      if (lt < 0) {
        out += buf;
        buf = "";
        break;
      }
      out += buf.slice(0, lt);
      const rest = buf.slice(lt);
      const gt = rest.indexOf(">");
      if (gt < 0) {
        if (rest.length > HOLD_MAX) {
          // Not a tag after all.
          out += rest;
          buf = "";
        } else {
          this.held = rest;
          buf = "";
        }
        break;
      }
      const tag = rest.slice(0, gt + 1);
      buf = rest.slice(gt + 1);
      if (TAG.test(tag)) {
        if (/^<silent\b/.test(tag)) {
          // Nothing of this request is said.
          this.silent = true;
          this.held = "";
          this.retract();
          return;
        }
        if (/^<quote\b/.test(tag) && !tag.endsWith("/>")) this.inQuote = true;
        continue;
      }
      out += tag;
    }
    // A placeholder opens on visible text only: leading whitespace would be an empty bubble.
    if (!this.id) out = out.trimStart();
    if (!out) return;
    if (!this.id) this.id = newId("message", this.now());
    this.bus.emit("chat.delta", { message: this.id, block: 0, delta: { type: "text", text: out } });
  }

  /** Request `req` is answered: an error or tool calls retract its text; a text-only end keeps the id for the `ui.say`. */
  end(req: string, outcome: StreamEnd): void {
    if (req !== this.owner) return;
    if (!outcome.ok || outcome.toolUse) this.retract();
    this.owner = undefined;
    this.clearParser();
  }

  /** Another route took over request `req` mid-stream: the text so far goes, and the new route streams afresh. */
  restart(req: string): void {
    if (req !== this.owner) return;
    this.retract();
    this.clearParser();
  }

  /** Hands the streamed id to the `ui.say` that stores the final message, and starts afresh. A reply still streaming keeps its id. */
  take(): string | undefined {
    if (this.owner !== undefined) return undefined;
    const id = this.id;
    this.id = undefined;
    this.clearParser();
    return id;
  }

  /** On a new user message or a brain exit: whatever was streaming is abandoned, and late deltas are dropped. */
  reset(): void {
    this.retract();
    this.owner = undefined;
    this.clearParser();
  }

  private retract(): void {
    const id = this.id;
    this.id = undefined;
    if (id) this.bus.emit("chat.retract", { message: id });
  }

  private clearParser(): void {
    this.held = "";
    this.inQuote = false;
    this.silent = false;
  }
}
