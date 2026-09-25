// Prefixed ULIDs: time-ordered, readable in logs, unique across nodes without coordination.
// See entities.md, "Conventions".

import { z } from "zod";

export const ID_PREFIXES = {
  node: "node",
  workspace: "ws",
  profile: "prof",
  session: "sess",
  task: "task",
  thread: "thr",
  message: "msg",
  ask: "ask",
  audit: "aud",
  client: "cli",
  controller: "ctl",
  grant: "grt",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = 0;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
  let out = "";
  let t = time;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomDigits(): number[] {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b % 32);
}

function increment(digits: number[]): number[] {
  const next = digits.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    const d = next[i]!;
    if (d < 31) {
      next[i] = d + 1;
      return next;
    }
    next[i] = 0;
  }
  return next;
}

/** A bare ULID. Monotonic within one process for ids created in the same millisecond. */
export function ulid(now: number = Date.now()): string {
  let random: number[];
  if (now === lastTime) {
    random = increment(lastRandom);
  } else {
    random = randomDigits();
    lastTime = now;
  }
  lastRandom = random;
  return encodeTime(now) + random.map((d) => CROCKFORD[d]).join("");
}

export function newId(kind: IdKind, now?: number): string {
  return `${ID_PREFIXES[kind]}_${ulid(now)}`;
}

const ULID_BODY = "[0-7][0-9A-HJKMNP-TV-Z]{25}";

export function idSchema(kind: IdKind) {
  const prefix = ID_PREFIXES[kind];
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${ULID_BODY}$`), { message: `expected a ${prefix}_ id` })
    .describe(`${kind} id`);
}

export const NodeId = idSchema("node");
export const WorkspaceId = idSchema("workspace");
export const ProfileId = idSchema("profile");
export const SessionId = idSchema("session");
export const TaskId = idSchema("task");
export const ThreadId = idSchema("thread");
export const MessageId = idSchema("message");
export const AskId = idSchema("ask");
export const AuditId = idSchema("audit");
export const ClientId = idSchema("client");
export const ControllerId = idSchema("controller");
/** A node's grant; a phone's grant is its controller id. */
export const GrantId = idSchema("grant");
/** Any grant's id: a phone's `ctl_`, a node's `grt_`. */
export const GrantRef = z.union([ControllerId, GrantId]);

export type NodeId = z.infer<typeof NodeId>;
export type WorkspaceId = z.infer<typeof WorkspaceId>;
export type ProfileId = z.infer<typeof ProfileId>;
export type SessionId = z.infer<typeof SessionId>;
export type TaskId = z.infer<typeof TaskId>;
export type ThreadId = z.infer<typeof ThreadId>;
export type MessageId = z.infer<typeof MessageId>;
export type AskId = z.infer<typeof AskId>;
export type AuditId = z.infer<typeof AuditId>;
export type ClientId = z.infer<typeof ClientId>;
export type ControllerId = z.infer<typeof ControllerId>;
export type GrantId = z.infer<typeof GrantId>;
export type GrantRef = z.infer<typeof GrantRef>;

/** Epoch milliseconds. Every time in every protocol is one of these. */
export const Timestamp = z.number().int().nonnegative().describe("epoch milliseconds");
export type Timestamp = z.infer<typeof Timestamp>;
