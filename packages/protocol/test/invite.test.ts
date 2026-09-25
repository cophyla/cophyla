// The invite codec: text and link carry the same body and read back to it, a paste's
// whitespace and line breaks are forgiven, and anything else is refused with InviteError.

import { describe, expect, test } from "bun:test";
import { INVITE_LINK_PREFIX, INVITE_TEXT_PREFIX, InviteError, inviteLink, inviteText, parseInvite } from "../src/index.ts";
import type { InviteBody } from "../src/index.ts";

const body: InviteBody = {
  v: 1,
  kind: "node",
  grant: "grt_01ARZ3NDEKTSV4RRFFQ69G5FD1",
  secret: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  expiresAt: 1758200400000,
  node: { id: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "Ferit's desk ü" },
  lan: { hosts: ["192.168.1.44", "10.0.0.5"], port: 4818, spki: "q2f0y5Hk9u1m3C1vJb0pZ6oQnqQ8yWm3rX4vA1Rk2tE=" },
  relay: { url: "https://orc.example", peer: "grt_01ARZ3NDEKTSV4RRFFQ69G5FD9", token: "rly_abc" },
};

describe("invites", () => {
  test("the text and the link read back to the body", () => {
    const text = inviteText(body);
    const link = inviteLink(body);
    expect(text.startsWith(INVITE_TEXT_PREFIX)).toBe(true);
    expect(link.startsWith(INVITE_LINK_PREFIX)).toBe(true);
    expect(text).not.toMatch(/[+/=]/);
    expect(parseInvite(text)).toEqual(body);
    expect(parseInvite(link)).toEqual(body);
    expect(parseInvite(`cophyla://invite?x=1&i=${link.slice(INVITE_LINK_PREFIX.length)}`)).toEqual(body);
  });

  test("a paste's whitespace and line breaks are forgiven", () => {
    const text = inviteText(body);
    const wrapped = `  ${text.slice(0, 30)}\r\n${text.slice(30, 70)}\n  ${text.slice(70)}  \n`;
    expect(parseInvite(wrapped)).toEqual(body);
  });

  test("anything else is refused", () => {
    expect(() => parseInvite("hello")).toThrow(InviteError);
    expect(() => parseInvite(INVITE_TEXT_PREFIX)).toThrow(InviteError);
    expect(() => parseInvite(INVITE_TEXT_PREFIX + "!!!")).toThrow(InviteError);
    expect(() => parseInvite(INVITE_TEXT_PREFIX + btoa("not json"))).toThrow(InviteError);
    expect(() => parseInvite(inviteText({ ...body, v: 2 } as unknown as InviteBody))).toThrow(InviteError);
    expect(() => parseInvite(inviteText({ ...body, secret: "short" }))).toThrow(InviteError);
    const { lan: _lan, relay: _relay, ...bare } = body;
    expect(parseInvite(inviteText(bare))).toEqual(bare);
  });
});
