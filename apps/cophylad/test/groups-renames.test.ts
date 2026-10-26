// A group's agents by the names they have now, and an agent asked for twice: the modules alone
// over a real store, bus and gate, with a fake teammates link whose side the test plays. A
// teammate's agent renamed on their side takes its new name here from its next post, and from
// their directory as the add list reads it; the add list carries its session. One of this side's
// own agents renamed tells the other sides the name it answers to now. Asking to add an agent
// that is in the group already (by the name it had, or its new one) adds no one and says so.

import { describe, expect, test } from "bun:test";
import { newId } from "@cophyla/protocol";
import type { GroupEntry, Session } from "@cophyla/protocol";
import type { EnvelopeInfo } from "../src/agentmsg/envelope.ts";
import { Focuses } from "../src/agentmsg/focus.ts";
import { Bus } from "../src/bus.ts";
import { Config } from "../src/config/schema.ts";
import { Asks } from "../src/gate/asks.ts";
import { Audit } from "../src/gate/audit.ts";
import { Gate } from "../src/gate/index.ts";
import { Policy } from "../src/gate/policy.ts";
import { Groups } from "../src/groups/index.ts";
import { silentLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";
import { waitFor } from "./helpers.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BOB = "usr_BOB";

let started = 1_000;
function sess(cwd: string): Session {
  return { id: newId("session"), node: DESK, harness: "claude", profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", native: { id: crypto.randomUUID(), transport: "pipe", pid: 4000 + started }, origin: "user", cwd, tags: [], status: "idle", startedAt: started++, lastActivity: 0 } as Session;
}

/** This side (ferit) with its agents, named by `aliases`, and bob as a teammate whose agent is `bob.name`. */
function rig(local: Session[], aliases: Map<string, string>) {
  const config = Config.parse({});
  const store = new Store(":memory:");
  store.migrate();
  const bus = new Bus();
  const asks = new Asks(store, DESK, bus);
  const audit = new Audit(store, DESK, config.gate.audit_result_cap, bus);
  const policy = new Policy(config.gate, store);
  const gate = new Gate({ config: config.gate, policy, asks, audit, log: silentLogger });
  const sentEntries: { seq: number; entry: GroupEntry }[] = [];
  const clock = { t: 1_758_000_000_000 };
  const deliver = async (_s: Session, _text: string, _info: EnvelopeInfo) => ({ status: "queued" as const });
  let groups: Groups;
  const focus = new Focuses({ store, bus, log: silentLogger, routes: () => true, sessions: () => local, deliver, linked: () => true, ended: (s, told) => groups.focusEnded(s, told), now: () => clock.t, sweepMs: 60_000 });
  const TM = newId("teammate");
  const bob = { session: newId("session"), name: "main" };
  const teams = {
    teammateOf: (owner: string) => (owner === BOB ? { id: TM, user: "bob" } : undefined),
    teammate: (_id: string) => ({ owner: BOB, user: "bob" }),
    agents: async () => ({ agents: [{ session: bob.session, name: bob.name, harness: "claude" as const, workspace: "web", status: "idle" as const }], closed: [] }),
    peers: async () => [],
    sharedTo: (_session: string, owner: string) => owner === BOB,
    send: async (_teammate: string, _group: string, seq: number, entry: GroupEntry) => {
      sentEntries.push({ seq, entry });
      return true;
    },
    sync: async () => undefined,
  };
  const names = () => new Map(local.filter((s) => s.status !== "ended").map((s) => [s.id, { alias: aliases.get(s.id)!, forms: [aliases.get(s.id)!] }]));
  groups = new Groups({
    store,
    bus,
    log: silentLogger,
    gate,
    routes: () => true,
    me: () => ({ owner: "usr_ME", user: "ferit" }),
    sessions: () => local,
    names,
    nodeName: () => "Desk",
    place: (s) => ({ workspace: s.cwd.split("/").pop()!, path: s.cwd }),
    deliver,
    holds: () => false,
    linked: () => true,
    focus,
    teams: () => teams as never,
    now: () => clock.t,
    sweepMs: 600_000,
    gatherMs: 5,
  });
  groups.teammateList = () => [{ id: TM, user: "bob" }];
  focus.start();
  groups.start();
  return { groups, sentEntries, clock, bob, TM, bus, stop: () => (groups.stop(), focus.stop()) };
}

const handles = (r: ReturnType<typeof rig>, id: string) => r.groups.list().find((g) => g.id === id)!.members.flatMap((m) => (m.kind === "agent" ? [m.handle] : []));

describe("a group's agents by the names they have now", () => {
  test("bob's agent renamed on his side takes the new name from his directory as the add list reads it, and from its next post", async () => {
    const a0 = sess("C:/code/api");
    const r = rig([a0], new Map([[a0.id, "api"]]));
    try {
      const g = await r.groups.create({ name: "release", members: [{ session: a0.id }, { teammate: r.TM, name: "main" }] });
      expect(handles(r, g.id)).toEqual(["api", "bob/main"]);

      // bob renamed it "stick-main": the add list reads his directory, the group follows, and the list carries its session
      r.bob.name = "stick-main";
      const cands = await r.groups.candidates();
      expect(cands.find((c) => "teammate" in c.ref && "name" in c.ref)).toMatchObject({ handle: "bob/stick-main", session: r.bob.session });
      expect(handles(r, g.id)).toEqual(["api", "bob/stick-main"]);

      // and again, seen first in a post of its own
      let seq = 0;
      await r.groups.take(BOB, g.id, ++seq, { kind: "post", post: { id: newId("groupPost"), from: { kind: "agent", key: `agent:${r.bob.session}`, session: r.bob.session, user: "bob", name: "black-main", harness: "claude" }, text: "renamed", mentions: [], at: r.clock.t } as never }, r.clock.t);
      expect(handles(r, g.id)).toEqual(["api", "bob/black-main"]);
      expect(r.groups.posts(g.id).posts.at(-1)!.from).toMatchObject({ handle: "bob/black-main" });
    } finally {
      r.stop();
    }
  });

  test("one of this side's agents renamed tells the other sides its new name", async () => {
    const a0 = sess("C:/code/api");
    const aliases = new Map([[a0.id, "unrealengine-1c"]]);
    const r = rig([a0], aliases);
    try {
      const g = await r.groups.create({ name: "release", members: [{ session: a0.id }, { teammate: r.TM, name: "main" }] });
      r.sentEntries.length = 0;
      aliases.set(a0.id, "shiitake");
      r.clock.t += 1_000;
      r.bus.emit("session.state", { ...a0 });
      await waitFor(() => r.sentEntries.some((e) => e.entry.kind === "member.add"));
      const told = r.sentEntries.find((e) => e.entry.kind === "member.add")!.entry as Extract<GroupEntry, { kind: "member.add" }>;
      expect(told.member).toMatchObject({ key: `agent:${a0.id}`, name: "shiitake", at: r.clock.t });
      expect(handles(r, g.id)).toEqual(["shiitake", "bob/main"]);
      // told once: the same name again tells no one
      r.sentEntries.length = 0;
      r.bus.emit("session.state", { ...a0 });
      await Bun.sleep(20);
      expect(r.sentEntries.filter((e) => e.entry.kind === "member.add")).toHaveLength(0);
    } finally {
      r.stop();
    }
  });
});

describe("an agent asked for twice", () => {
  test("adding agents already in the group adds no one and says so, by the names they have now", async () => {
    const a0 = sess("C:/code/api");
    const a1 = sess("C:/code/web");
    const r = rig([a0, a1], new Map([[a0.id, "api"], [a1.id, "web"]]));
    try {
      const g = await r.groups.create({ name: "release", members: [{ session: a0.id }, { teammate: r.TM, name: "main" }] });
      // bob's agent asked for by its new name: the same session, so no one is added, and it takes the name
      r.bob.name = "stick-main";
      await expect(r.groups.addMembers(g.id, [{ teammate: r.TM, name: "stick-main" }, { session: a0.id }])).rejects.toThrow("bob/stick-main, api are in #release already");
      expect(handles(r, g.id)).toEqual(["api", "bob/stick-main"]);
      // one new beside one there already: the new one is added and nothing is refused
      const after = await r.groups.addMembers(g.id, [{ session: a0.id }, { session: a1.id }]);
      expect(after.members.flatMap((m) => (m.kind === "agent" ? [m.handle] : []))).toEqual(["api", "bob/stick-main", "web"]);
    } finally {
      r.stop();
    }
  });
});
