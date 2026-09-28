// The audit table: every request with its decision and result. The result is kept whole up
// to the configured cap and as hash and size beyond it, and streamed as `audit.entry` with
// the result summarised.

import { createHash } from "node:crypto";
import { actionDefinition, newId } from "@cophyla/protocol";
import type { AuditEntry, AuditResult, Decision, NodeId, Outcome, Principal } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { Store } from "../store/index.ts";
import { BUILTIN_RULES, ruleKey } from "./policy.ts";

export interface AuditOpen {
  principal: Principal;
  via?: string;
  action: string;
  target?: string;
  args: unknown;
  decision: Decision;
  ask?: string;
  thread?: string;
  task?: string;
  correlation?: string;
}

const SUMMARY_CHARS = 200;
/** Credential-shaped keys; `username` and `credential` are a TURN server's. */
const REDACTED_KEYS = new Set(["token", "password", "secret", "authorization", "apikey", "api_key", "pin", "otp", "passphrase", "usercode", "devicecode", "username", "credential"]);
/** The query parameters of a URL that carry a secret: an invite link's code and passphrase, a login page's code. */
const REDACTED_QUERY = /([?&](?:pin|passphrase|otp|token|code)=)[^&#]*/gi;
/** A stream page's one-use ticket: `t` anywhere else is too common a name to hide. */
const STREAM_TICKET = /(\/remote\/\?(?:[^#]*&)?t=)[^&#]*/g;

/**
 * Replaces the values of credential-shaped keys anywhere in a JSON value, and the secret query
 * values of a URL in a string, a stream page's ticket in a bare `/remote/` path too. Encoded
 * bytes (a `base64` field: a screenshot, an image in a model call) are kept as their size
 * only: the audit log records that a screen was seen, and must not become a copy of it. A
 * session description (`sdp`) is kept as its size too: it names every address of both ends.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(k.toLowerCase())) out[k] = "[redacted]";
      else if (k === "base64" && typeof v === "string") out[k] = `[${Math.floor((v.length * 3) / 4)} bytes]`;
      else if (k === "sdp" && typeof v === "string") out[k] = `[${v.length} characters]`;
      else out[k] = redact(v);
    }
    return out;
  }
  if (typeof value === "string" && value.includes("=")) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value.replace(REDACTED_QUERY, "$1[redacted]").replace(STREAM_TICKET, "$1[redacted]");
    if (value.startsWith("/remote/")) return value.replace(STREAM_TICKET, "$1[redacted]");
  }
  return value;
}

export function summarise(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > SUMMARY_CHARS ? oneLine.slice(0, SUMMARY_CHARS - 1) + "…" : oneLine;
}

/** Serialises a result and decides whether its body is kept, by the cap. */
export function describeResult(result: unknown, cap: number): AuditResult {
  const text = result === undefined ? "null" : JSON.stringify(result);
  const bytes = Buffer.byteLength(text, "utf8");
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const out: AuditResult = { summary: summarise(text), bytes, sha256 };
  if (bytes <= cap) out.body = result === undefined ? null : result;
  return out;
}

/**
 * Whether clients are told of an entry. A read's is kept, not streamed: every client's own
 * loading would otherwise be told to every other. So is the brain's own bookkeeping, what a
 * built-in rule allowed it (a reply, an ask, a model call, a thread, a task, an annotation,
 * a memory): what it made shows as itself, and the call behind it is no one's news.
 */
export function toldToClients(entry: AuditEntry): boolean {
  if (actionDefinition(entry.action)?.risk === "read") return false;
  return !(entry.principal.kind === "brain" && entry.decision === "allow" && BUILTIN_RULES[ruleKey("brain", entry.action)] === "allow");
}

export class Audit {
  private store: Store;
  private nodeId: NodeId;
  private cap: number;
  private bus: Bus;

  constructor(store: Store, nodeId: NodeId, cap: number, bus: Bus) {
    this.store = store;
    this.nodeId = nodeId;
    this.cap = cap;
    this.bus = bus;
  }

  /** Records the request and the decision, on `node`'s behalf (a workspace node's gate names its own). The outcome comes with `complete`. */
  open(input: AuditOpen, now = Date.now(), node?: NodeId): AuditEntry {
    const entry: AuditEntry = {
      id: newId("audit", now),
      node: node ?? this.nodeId,
      at: now,
      principal: input.principal,
      action: input.action,
      args: redact(input.args),
      decision: input.decision,
    };
    if (input.via !== undefined) entry.via = input.via;
    if (input.target !== undefined) entry.target = input.target;
    if (input.ask !== undefined) entry.ask = input.ask;
    if (input.thread !== undefined) entry.thread = input.thread;
    if (input.task !== undefined) entry.task = input.task;
    if (input.correlation !== undefined) entry.correlation = input.correlation;
    this.store.audit.insert(entry);
    this.bus.emit("audit.entry", entry);
    return entry;
  }

  /** Records the outcome and the result, and streams the entry with the body left out. */
  complete(
    entry: AuditEntry,
    outcome: Outcome,
    opts: { result?: unknown; error?: string; startedAt: number; ask?: string },
    now = Date.now(),
  ): AuditEntry {
    const durationMs = Math.max(0, now - opts.startedAt);
    let result: AuditResult | undefined;
    // The result is redacted like the arguments: an invite's code and link would otherwise sit in the table whole.
    if (outcome === "ok") result = describeResult(opts.result === undefined ? undefined : redact(opts.result), this.cap);
    else if (opts.error !== undefined) result = describeResult({ error: opts.error }, this.cap);

    const patch: Parameters<Store["audit"]["complete"]>[1] = { outcome, durationMs };
    if (result) patch.result = result;
    if (opts.ask !== undefined) patch.ask = opts.ask;
    this.store.audit.complete(entry.id, patch);

    const done: AuditEntry = { ...entry, outcome, durationMs };
    if (opts.ask !== undefined) done.ask = opts.ask;
    if (result) done.result = result;

    const streamed: AuditEntry = { ...done };
    if (result) {
      const { body: _body, ...rest } = result;
      void _body;
      streamed.result = rest;
    }
    this.bus.emit("audit.entry", streamed);
    return done;
  }
}
