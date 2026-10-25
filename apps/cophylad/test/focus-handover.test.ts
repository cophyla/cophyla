// What focus held, handed over as one message: the notice of what came first, then each held
// message in its own envelope, so another person's agent's stays marked external and a reply
// names the message it answers. Each is recorded as its sender's turn when the session takes
// it, and so is each in an echo that comes with no send waiting for it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@cophyla/protocol";
import type { AgentRef, SessionEvent } from "@cophyla/protocol";
import { envelope, readEnvelopes } from "../src/agentmsg/envelope.ts";
import type { EnvelopeInfo } from "../src/agentmsg/envelope.ts";
import { bundles, leadRuns } from "../src/agentmsg/focus.ts";
import type { HeldMessage } from "../src/agentmsg/focus.ts";
import { ClaudeAdapter } from "../src/sessions/claude/adapter.ts";
import type { SendOutcome, SessionRecord } from "../src/sessions/model.ts";
import { miniSessions, tempHome, tomlString } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

/** Claude over its pipe, the messages it was given kept rather than sent. */
class RecordingClaude extends ClaudeAdapter {
  sent: { session: string; text: string }[] = [];
  override async send(rec: SessionRecord, text: string, _ref: string): Promise<SendOutcome> {
    this.sent.push({ session: rec.session.id, text });
    return { status: "queued" };
  }
}

let mini: Mini;
let claude: RecordingClaude;
let cwd: string;
let profile: string;

beforeAll(async () => {
  const scratch = tempHome();
  const profileDir = join(scratch, "claude-profile");
  cwd = join(scratch, "work");
  mkdirSync(join(profileDir, "sessions"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mini = await miniSessions(
    `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(profileDir)}\n`,
    (host, log) => [(claude = new RecordingClaude({ host, log, isAlive: () => true, sharedSettings: join(profileDir, "none.json") }))],
  );
  profile = mini.profiles.defaultFor("claude")!.id;
});

afterAll(() => mini.stop());

let pid = 900;
function session(nativeId: string) {
  const rec = mini.sessions.ensure({ harness: "claude", nativeId, profile, cwd, transport: "pipe", pid: pid++, origin: "user" });
  mini.sessions.setStatus(rec, "idle");
  return rec;
}

const sentTo = (id: string) => claude.sent.filter((m) => m.session === id);
const turns = (id: string) => mini.store.sessionEvents.history(id, { limit: 100 }).filter((e: SessionEvent) => e.kind === "user_turn");

const api: AgentRef = { session: newId("session"), alias: "api-codex", harness: "codex", node: newId("node"), nodeName: "Laptop", folder: "api" };

/** What focus held for a session: the notice, one of the user's agents' answering a message, and a teammate's agent's. */
function held(): { notice: EnvelopeInfo; more: { info: EnvelopeInfo; text: string }[] } {
  return {
    notice: { messageId: newId("agentMessage") },
    more: [
      { info: { from: api, messageId: newId("agentMessage"), replyTo: newId("agentMessage") }, text: "the schema is merged" },
      { info: { peer: { teammate: newId("teammate"), user: "bob", name: "site-claude", harness: "claude" }, messageId: newId("agentMessage") }, text: "ping" },
    ],
  };
}

describe("what focus held, handed over as one message", () => {
  test("goes in one send, each in its own envelope after the notice, and each is recorded as its sender's turn once it lands", async () => {
    const rec = session("h-one");
    const { notice, more } = held();
    await mini.sessions.send(rec.session.id, "Your focus ended with your turn. While you were in focus: 2 messages (from api-codex, bob/site-claude), below.", { from: "agent", agent: notice, more });
    expect(sentTo(rec.session.id)).toHaveLength(1);
    const body = sentTo(rec.session.id)[0]!.text;
    expect(body).toBe([envelope(notice, "Your focus ended with your turn. While you were in focus: 2 messages (from api-codex, bob/site-claude), below."), envelope(more[0]!.info, "the schema is merged"), envelope(more[1]!.info, "ping")].join("\n\n"));
    // the teammate's stays marked external, and the reply names what it answers
    expect(body).toContain(`<cophyla-message from="bob/site-claude" harness="claude" user="bob" teammate="${(more[1]!.info.peer as { teammate: string }).teammate}" external="true"`);
    expect(body).toContain(`reply_to="${more[0]!.info.replyTo}"`);
    expect(readEnvelopes(body).map((e) => e.messageId)).toEqual([notice.messageId, more[0]!.info.messageId, more[1]!.info.messageId]);

    // the session takes it: one turn per envelope, the send's ref on the first
    expect(mini.sessions.receiptByText(rec, body)).toBe(true);
    const got = turns(rec.session.id).map((e) => e.payload as { messageId: string; text: string; ref?: string; from?: AgentRef; peer?: { user: string } });
    expect(got.map((p) => p.messageId)).toEqual([notice.messageId, more[0]!.info.messageId, more[1]!.info.messageId]);
    expect(got[0]!.ref).toMatch(/^cophylad-/);
    expect(got[1]).toMatchObject({ source: "agent", from: { alias: "api-codex" }, text: "the schema is merged" });
    expect(got[1]!.ref).toBeUndefined();
    expect(got[2]).toMatchObject({ source: "agent", peer: { user: "bob", name: "site-claude" }, text: "ping" });
  });

  test("an echo that comes with no send waiting for it records each envelope in it, once", () => {
    const rec = session("h-echo");
    const { notice, more } = held();
    const body = [envelope(notice, "Your focus ran its time."), ...more.map((m) => envelope(m.info, m.text))].join("\n\n");
    expect(mini.sessions.agentEcho(rec, body)).toBe(true);
    expect(mini.sessions.agentEcho(rec, body)).toBe(true);
    const got = turns(rec.session.id).map((e) => e.payload as { messageId: string; late?: boolean });
    expect(got.map((p) => p.messageId)).toEqual([notice.messageId, more[0]!.info.messageId, more[1]!.info.messageId]);
    expect(got.every((p) => p.late === true)).toBe(true);
  });
});

describe("how what focus held is split", () => {
  const h = (text: string, from?: string): HeldMessage => ({ text, info: { messageId: newId("agentMessage"), ...(from ? { from: { ...api, session: from } } : {}) }, at: 0, label: from ?? "cophyla", lead: true });

  test("a leader's words: one message per leader, in the order each first spoke, and a slash command alone", () => {
    const a = newId("session");
    const b = newId("session");
    const runs = leadRuns([h("one", a), h("two", b), h("three", a), h("/compact", a), h("four", a)]);
    expect(runs.map((r) => r.map((x) => x.text))).toEqual([["one", "three"], ["/compact"], ["four"], ["two"]]);
  });

  test("as few messages as fit: a long one goes on in the next, and one alone however long", () => {
    const big = "x".repeat(40_000);
    expect(bundles([{ text: "notice" }, { text: big }, { text: big }, { text: "short" }]).map((b) => b.length)).toEqual([2, 2]);
    expect(bundles([{ text: "x".repeat(70_000) }]).map((b) => b.length)).toEqual([1]);
    expect(bundles(Array.from({ length: 70 }, () => ({ text: "a" }))).map((b) => b.length)).toEqual([64, 6]);
  });
});
