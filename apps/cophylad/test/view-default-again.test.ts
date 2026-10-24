// The default view's lists that only the primary keeps, asked for again: a node claims the
// primary role a moment after it starts, and a view that connected before that was refused its
// groups, focus, teammates, leaders and conversations as kept by the primary. A change to the
// node's own row asks again for what was refused that way, once; what a node too old for it
// refused is not asked again.

import { describe, expect, test } from "bun:test";
import { ACCESS_PRESETS } from "@cophyla/protocol";
import type { ProtocolError } from "@cophyla/protocol";
import { apply, initialState } from "../views/default/model.ts";
import type { Action, ViewState } from "../views/default/model.ts";

// The controllers draw with the DOM, which the daemon's typecheck (it takes in these tests) has
// no types for: they are loaded by a name tsc does not follow.
const at = (name: string) => import(`../views/default/${name}.ts`);
const { TeamControl } = await at("teamctl");
const { LeadControl } = await at("leadctl");
const { TalkControl } = await at("talkctl");
const { newTalkUi } = await at("talkview");
const { ViewRpcError } = await at("rpc");

interface Control {
  connected(): void;
  again(): void;
}

const ANSWERS: Record<string, unknown> = {
  "group.list": { groups: [] },
  "focus.list": { focus: [] },
  "teammate.list": { teammates: [] },
  "lead.list": { leaders: [] },
  "talk.list": { talks: [] },
};

/** A node that refuses every list with `code` until it is the primary, then answers each. */
function rig(code: ProtocolError["code"] = "unavailable") {
  const state: ViewState = initialState();
  state.scopes = [...ACCESS_PRESETS.full.scopes];
  const ui = { team: { media: { attached: new Map() }, readSent: new Set(), drafts: new Map() }, talk: newTalkUi() };
  const asked: string[] = [];
  const node = { primary: false };
  const rpc = {
    request: async (method: string) => {
      asked.push(method);
      if (!node.primary) throw new ViewRpcError({ code, message: "kept by the primary", retryable: false });
      return ANSWERS[method];
    },
  };
  const deps = { rpc, state, ui, roots: {}, dispatch: (a: Action) => void apply(state, a), draw: () => undefined };
  const team: Control = new TeamControl({ ...deps, selectGroup: () => undefined, putRailAway: () => undefined });
  const lead: Control = new LeadControl(deps);
  const talks: Control = new TalkControl(deps);
  const connect = () => {
    team.connected();
    lead.connected();
    talks.connected();
  };
  const again = () => {
    team.again();
    lead.again();
    talks.again();
  };
  return { state, asked, node, connect, again };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("lists only the primary keeps, asked for again", () => {
  test("refused while the node claimed the role, they are asked again once it has it, and only once", async () => {
    const r = rig();
    r.connect();
    await settle();
    expect(r.asked.sort()).toEqual(["focus.list", "group.list", "lead.list", "talk.list", "teammate.list"]);
    expect(r.state.talkOn).toBe(false);

    r.node.primary = true;
    r.asked.length = 0;
    r.again();
    await settle();
    expect(r.asked.sort()).toEqual(["focus.list", "group.list", "lead.list", "talk.list", "teammate.list"]);
    expect(r.state.talkOn).toBe(true);

    // answered now: a later change to the node's row asks for none of them
    r.asked.length = 0;
    r.again();
    await settle();
    expect(r.asked).toEqual([]);
  });

  test("a node that kept them all along is not asked again", async () => {
    const r = rig();
    r.node.primary = true;
    r.connect();
    await settle();
    r.asked.length = 0;
    r.again();
    await settle();
    expect(r.asked).toEqual([]);
  });

  test("a node too old for them is not asked again", async () => {
    const r = rig("unsupported");
    r.connect();
    await settle();
    expect(r.state.talkOn).toBe(false);
    r.asked.length = 0;
    r.again();
    await settle();
    expect(r.asked).toEqual([]);
  });
});
