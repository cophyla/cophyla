// A teammate's own link: what two users' primaries say to each other once one made the other a
// teammate, in relay tunnels sealed from the first frame to the last, and nothing else. It
// rides the relay as a connection's does (a `connection` peer kind, `con_` peers), so the
// server routes it to each account's primary and meters it the same way. A tunnel of the
// invite's throwaway peer, keyed from the invite's secret, answers `team.redeem` and
// `team.confirm` alone; a tunnel of a live teammate's peer, keyed from the key the two share,
// answers the `team.*` requests alone, about that teammate and no other.
//
// Each side answers for its own agents alone: `team.directory` is what it lets the other reach
// now, and a `team.send` is checked against its own sharing before it delivers, never on the
// sender's word. A group chat with teammates in it has no host: each side writes what its own
// people and agents did into a log numbered on that side (`team.group`), and a side that was
// away asks for the entries after the last it took (`team.group.sync`).

import { z } from "zod";
import { Focus, GroupMention, GroupNotify, HarnessKind, SessionStatus, TeammateConnectionAgent, TeammateTheirs } from "./entities.ts";
import { AgentMessageId, GroupId, GroupPostId, SessionId, TeammateConnectionId, TeammateId, Timestamp } from "./ids.ts";
import { ConnectionRelay, Secret } from "./invite.ts";

/** The longest message a teammate's agent sends: as a connection's. */
export const TEAMMATE_MAX_CHARS = 16_000;
/** The longest post in a group chat. */
export const GROUP_POST_MAX_CHARS = 16_000;

/** An open agent as its own side tells the other: its name there, its harness, its workspace's name, how it stands, what it is for, its focus. */
export const TeamAgent = z.object({
  /** Its session record, which a group chat keeps it by on every side. */
  session: SessionId.optional(),
  name: z.string().min(1).max(120),
  harness: HarnessKind.optional(),
  workspace: z.string().max(200).optional(),
  status: SessionStatus.optional(),
  intent: z.string().max(300).optional(),
  focus: Focus.optional(),
});
export type TeamAgent = z.infer<typeof TeamAgent>;

/**
 * An agent in what a side shares that is not open to the other, named so the other side's user
 * may ask to connect to it: its session, name, harness and workspace's name, never how it stands,
 * what it is for or its focus. One already connected to an agent of the asking side says so, and
 * how it stands, since that connection is its user's word. None in a workspace shared closed.
 */
export const TeamClosedAgent = z.object({
  session: SessionId,
  name: z.string().min(1).max(120),
  harness: HarnessKind.optional(),
  workspace: z.string().max(200).optional(),
  connected: z.boolean().optional(),
  status: SessionStatus.optional(),
  intent: z.string().max(300).optional(),
  focus: Focus.optional(),
});
export type TeamClosedAgent = z.infer<typeof TeamClosedAgent>;

/** What a message from a teammate's agent became on the receiving side: delivered, held in the receiving terminal, or held while the agent is in focus. */
export const TeamSendStatus = z.enum(["sent", "held", "focus"]);
export type TeamSendStatus = z.infer<typeof TeamSendStatus>;

/** A member of a group chat as one side tells the others: the agent's session and its owner, or a person. */
export const GroupEntryMember = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent"),
    key: z.string().min(1).max(120),
    session: SessionId,
    /** The owner's account and login, as the owner's side knows them. */
    owner: z.string().min(1).max(120),
    user: z.string().min(1).max(64),
    /** Its name on its owner's side: the alias its own agents know it by. */
    name: z.string().min(1).max(120),
    harness: HarnessKind,
    workspace: z.string().max(200).optional(),
    notify: GroupNotify,
    addedBy: z.string().max(64),
    addedAt: Timestamp,
    gone: z.boolean().optional(),
    focus: Focus.optional(),
    /** When its row last changed, by its writer's clock. */
    at: Timestamp.optional(),
  }),
  z.object({ kind: z.literal("person"), key: z.string().min(1).max(120), owner: z.string().min(1).max(120), user: z.string().min(1).max(64) }),
]);
export type GroupEntryMember = z.infer<typeof GroupEntryMember>;

/** A post as it crosses between sides: its text holds each tag as `@[<member key>]`, which each side writes as it names the member. */
export const GroupEntryPost = z.object({
  id: GroupPostId,
  from: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("agent"), key: z.string().min(1).max(120), session: SessionId, user: z.string().max(64), name: z.string().min(1).max(120), harness: HarnessKind }),
    z.object({ kind: z.literal("person"), key: z.string().min(1).max(120), user: z.string().min(1).max(64) }),
    z.object({ kind: z.literal("cophyla") }),
  ]),
  text: z.string().max(20_000),
  mentions: z.array(GroupMention).max(100),
  replyTo: GroupPostId.optional(),
  expectsReply: z.boolean().optional(),
  at: Timestamp,
});
export type GroupEntryPost = z.infer<typeof GroupEntryPost>;

/** The group itself, as a side hands it to one newly in it: who is in it and the posts so far (the last two hundred). */
export const GroupSnapshot = z.object({
  id: GroupId,
  name: z.string().min(1).max(80),
  purpose: z.string().max(300).optional(),
  by: z.string().min(1).max(64),
  notify: GroupNotify,
  createdAt: Timestamp,
  /** When its name, purpose or setting last changed. */
  updatedAt: Timestamp.optional(),
  ended: z.object({ at: Timestamp, by: z.string().max(64) }).optional(),
  members: z.array(GroupEntryMember).max(64),
  posts: z.array(GroupEntryPost).max(200),
});
export type GroupSnapshot = z.infer<typeof GroupSnapshot>;

/** One thing a side's own people or agents did in a group, as it is logged on that side and told to the others. */
export const GroupEntry = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), group: GroupSnapshot }),
  z.object({ kind: z.literal("post"), post: GroupEntryPost }),
  z.object({ kind: z.literal("ack"), post: GroupPostId, member: z.string().min(1).max(120) }),
  z.object({ kind: z.literal("read"), member: z.string().min(1).max(120), post: GroupPostId }),
  z.object({ kind: z.literal("member.add"), member: GroupEntryMember }),
  z.object({ kind: z.literal("member.remove"), member: z.string().min(1).max(120), why: z.string().max(200).optional() }),
  z.object({ kind: z.literal("member.state"), member: z.string().min(1).max(120), gone: z.boolean().optional(), focus: Focus.optional(), notify: GroupNotify.optional() }),
  z.object({ kind: z.literal("update"), name: z.string().min(1).max(80).optional(), purpose: z.string().max(300).optional(), notify: GroupNotify.optional() }),
  z.object({ kind: z.literal("end"), by: z.string().max(64) }),
  z.object({ kind: z.literal("leave"), person: z.string().min(1).max(120) }),
]);
export type GroupEntry = z.infer<typeof GroupEntry>;

export const teammateLinkRequests = {
  /**
   * The redeemer, on the invite's tunnel: who it is (an identity whose `aud` is the invite's
   * `redeemer` audience), what it shares, and the relay peer the inviter is to reach it by.
   * Answered with the inviter's identity, what it shares, its relay peer and the key the
   * teammate's tunnels are keyed from. The invite is spent; it opens again if no
   * `team.confirm` follows on this tunnel.
   */
  "team.redeem": {
    params: z.object({ id: TeammateId, identity: z.string().min(1).max(4096), theirs: TeammateTheirs, relay: ConnectionRelay }),
    result: z.object({ identity: z.string().min(1).max(4096), theirs: TeammateTheirs, relay: ConnectionRelay, key: Secret }),
  },
  /** The redeemer kept the teammate: both sides hold it from here. */
  "team.confirm": { params: z.object({ id: TeammateId }), result: z.object({}) },
  /**
   * The agents this side lets the asking side reach now, and what it shares; with `closed`, also
   * the agents in what it shares that are not open, for the asking side's user to ask for.
   */
  "team.directory": {
    params: z.object({ closed: z.boolean().optional() }),
    result: z.object({ agents: z.array(TeamAgent).max(500), theirs: TeammateTheirs, closed: z.array(TeamClosedAgent).max(500).optional() }),
  },
  /** What the sending side shares changed. */
  "team.share": { params: TeammateTheirs, result: z.object({}) },
  /**
   * A message from an agent of the sending side to `to`, an open agent of this side by its
   * name here. `replyTo` lets an agent that is not open be answered: one that sent the message
   * it names, within a day. `toSession` and `from.session` name the two agents by session, which
   * a teammate connection between them lets through whether or not the receiver is open.
   */
  "team.send": {
    params: z.object({
      id: AgentMessageId,
      to: z.string().min(1).max(120),
      toSession: SessionId.optional(),
      text: z.string().min(1).max(TEAMMATE_MAX_CHARS),
      replyTo: AgentMessageId.optional(),
      from: z.object({ name: z.string().min(1).max(120), harness: HarnessKind.optional(), session: SessionId.optional() }),
      sentAt: Timestamp,
    }),
    result: z.object({ status: TeamSendStatus, focus: Focus.optional() }),
  },
  /** A message this side sent was not delivered after all: refused once it waited, or kept past its time. */
  "team.notice": { params: z.object({ about: AgentMessageId, why: z.string().min(1).max(300) }), result: z.object({}) },
  /** The sending side ended the teammate. */
  "team.end": { params: z.object({ reason: z.string().min(1).max(200) }), result: z.object({}) },
  /**
   * The sending side's user joins `from`, an agent of theirs in what they share, to `to`, an
   * agent of this side's. Open to the sending side: `active` at once, its being open being this
   * side's word. Closed but in what this side shares: this side asks its user and answers
   * `asked`, and the answer comes back as `team.connect.state`. An ask this side made for the
   * same two agents is the answer: `active`, under `id` this side's own.
   */
  "team.connect": {
    params: z.object({
      id: TeammateConnectionId,
      from: TeammateConnectionAgent.extend({ intent: z.string().max(300).optional() }),
      to: SessionId,
    }),
    result: z.object({ state: z.enum(["active", "asked"]), id: TeammateConnectionId.optional() }),
  },
  /** The answer to an ask the receiving side made: its user connected the two agents, or declined. */
  "team.connect.state": {
    params: z.object({ id: TeammateConnectionId, state: z.enum(["active", "declined"]), reason: z.string().max(300).optional() }),
    result: z.object({}),
  },
  /** The sending side ended a teammate connection, or took back an ask: its user did, its agent's session ended, or its share no longer holds the agent. */
  "team.disconnect": { params: z.object({ id: TeammateConnectionId, reason: z.string().min(1).max(300) }), result: z.object({}) },
  /**
   * One entry of the sending side's log for a group both are in, in order, with when it was
   * written by the writer's clock (of two changes to one thing, the later stands). A gap is
   * answered `conflict`, and the receiver catches up with `team.group.sync`.
   */
  "team.group": {
    params: z.object({ group: GroupId, seq: z.number().int().positive(), entry: GroupEntry, at: Timestamp }),
    result: z.object({}),
  },
  /** This side's entries for a group after `after`, in order, at most two hundred at a time. */
  "team.group.sync": {
    params: z.object({ group: GroupId, after: z.number().int().nonnegative() }),
    result: z.object({ entries: z.array(z.object({ seq: z.number().int().positive(), entry: GroupEntry, at: Timestamp })).max(200), more: z.boolean().optional() }),
  },
} as const;

export type TeammateLinkRequestName = keyof typeof teammateLinkRequests;

/** The audiences of a teammate redemption's two identities: bound to the invite, and to which side speaks. */
export function teamAudience(secretHash: string, end: "redeemer" | "inviter"): string {
  return `cophyla-team/1|${secretHash}|${end}`;
}
