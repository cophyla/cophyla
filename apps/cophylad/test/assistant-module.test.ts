// The assistant module, the keeper of the session the chat runs in, with everything around it
// faked: a brain that answers its requests and records what it is told, a scripted host in
// place of a Codex thread, a sessions module that hands back a session in place of a terminal,
// a chat, a key-value store, a real bus and a data folder of its own. It comes up with an
// account and a brain and says where it stands; a user's message is handed to the session and
// the brain hears the prompt taken and the reply; prompts go one at a time, a wake waits, a
// user's message joins whatever turn runs and cuts none short; a chat thread opening clears
// the context once idle; a prompt that does not reach the session is tried once more and then
// said; a program that went is started again where it was; the session's tools are the
// brain's; what the user sets is kept and starts it again; and on Claude Code its hooks carry
// what it is told, in parts.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, RpcError } from "@cophyla/protocol";
import type { AssistantState, HarnessProfile, LlmTool, Message, Session, TerminalRef, ToolCallResult } from "@cophyla/protocol";
import { CLAUDE_PART_CHARS, CODEX_PART_CHARS, parts } from "../src/assistant/context.ts";
import { Assistant, NO_ACCOUNT } from "../src/assistant/index.ts";
import type { AssistantBrain, AssistantDeps, AssistantHost, AssistantSessions, HostEvents } from "../src/assistant/index.ts";
import type { FeedEvent } from "../src/brain-link/feed.ts";
import { Bus } from "../src/bus.ts";
import { AssistantConfig } from "../src/config/schema.ts";
import { silentLogger } from "../src/log.ts";
import { ASSISTANT_PART } from "../src/sessions/index.ts";
import type { AssistantSpawn, SendOptions } from "../src/sessions/index.ts";
import type { NormalisedHook } from "../src/sessions/model.ts";
import { sleep, waitFor } from "./helpers.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PORT = 4817;
const RULES = "You are Cophyla.";
const TOOLS: LlmTool[] = [{ name: "agents", description: "The agent sessions.", schema: { type: "object", properties: {} } }];
const UNDELIVERED = "Your message did not reach the chat's session. Send it again; if it keeps happening, restart the chat agent from the chat's menu.";
const UNTAKEN = "Your message has not reached the chat's agent yet. If no answer comes, send it again, or restart the chat agent from the chat's menu.";

type Json = Record<string, unknown>;
type Told = [string, Json];

/** One turn of the event loop: what a harness or a client does next never comes in the same tick. */
const tick = () => sleep(1);

function profile(harness: "claude" | "codex", name: string, over: Partial<HarnessProfile> = {}): HarnessProfile {
  return { id: newId("profile"), node: NODE, harness, name, configDir: `/home/me/.${harness}-${name}`, env: {}, origin: "discovered", status: "ok", ...over };
}

/** The chat's own session as the sessions module would hand it back. */
function session(profileId: string, native: string, cwd: string, terminal: string, over: Partial<Session> = {}): Session {
  return { id: newId("session"), node: NODE, harness: "claude", profile: profileId, native: { id: native, transport: "pipe", terminal: { host: "host-1", id: terminal } }, origin: "orchestrator", cwd, tags: [], status: "idle", startedAt: 1, lastActivity: 1, role: "assistant", ...over };
}

function hook(name: string, sessionId: string, extra: Partial<NormalisedHook> = {}): NormalisedHook {
  return { harness: "claude", name, sessionId, raw: {}, ...extra };
}

/** The brain: answers what the module asks, and keeps what it is told. */
class FakeBrain implements AssistantBrain {
  up = true;
  readonly asked: { method: string; params: Json; timeoutMs: number }[] = [];
  readonly events: FeedEvent[] = [];
  system = RULES;
  /** What it says the session is told; it may take its time, or throw. */
  context: (params: Json) => { text: string; seq?: number } | Promise<{ text: string; seq?: number }> = () => ({ text: "" });
  result: ToolCallResult = { content: "2 sessions" };
  /** Set, every request fails with it. */
  failing?: Error;

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    this.asked.push({ method, params: params as Json, timeoutMs });
    if (this.failing) throw this.failing;
    switch (method) {
      case "assistant.setup":
        return { system: this.system, instructions: "Cophyla's tools: call them." };
      case "tools.list":
        return { tools: TOOLS };
      case "tool.call":
        return this.result;
      case "assistant.context":
        return this.context(params as Json);
    }
    throw new RpcError("unsupported", `the brain has no ${method}`);
  }

  send(event: FeedEvent): void {
    this.events.push(event);
  }

  /** What it was told under a name, without the stamps every event carries. */
  told(name: string): Json[] {
    return this.events.filter((e) => e.name === name).map((e) => unstamped(e)[1]);
  }

  /** The session's turns as it heard them, in order: every event but where the session stands. */
  turns(): Told[] {
    return this.events.filter((e) => e.name !== "assistant.state").map(unstamped);
  }

  /** What it was asked under a method. */
  of(method: string): Json[] {
    return this.asked.filter((a) => a.method === method).map((a) => a.params);
  }
}

function unstamped(e: FeedEvent): Told {
  const { at: _at, eventId: _eventId, ...rest } = e.params as Json;
  return [e.name, rest];
}

/** The session on a harness, scripted: it records what it is asked and the test plays what it does. */
class FakeHost implements AssistantHost {
  readonly harness = "codex" as const;
  readonly events: HostEvents;
  readonly profile: HarnessProfile;
  readonly system: string;
  readonly cwd: string;
  /** What each start was to go on with. */
  readonly starts: (string | undefined)[] = [];
  /** Every prompt it was handed, the ones that failed too; `receipt` names it when it is taken, `told` is what went beside it. */
  readonly sent: { text: string; ref: string; receipt: string; told?: string[] }[] = [];
  /** What it did, in order. */
  readonly log: string[] = [];
  clears = 0;
  stops = 0;
  releases = 0;
  /** A prompt is taken as it is sent, as a Codex turn is; off, the test takes it (`take`), as a hook would. */
  takes = true;
  /** How many of the next sends fail. */
  failSends = 0;
  failStart?: (resume: string | undefined) => Error | undefined;
  failClear = false;
  /** A start waits on this. */
  gate?: Promise<void>;
  thread?: string;
  usedTokens?: number;
  /** Where its context is folded, when that is not the configured size. */
  limitTokens?: number;
  private n: number;

  constructor(n: number, profile: HarnessProfile, events: HostEvents, opts: { system: string; cwd: string }) {
    this.n = n;
    this.profile = profile;
    this.events = events;
    this.system = opts.system;
    this.cwd = opts.cwd;
  }

  async start(resume: string | undefined): Promise<{ native: string }> {
    this.starts.push(resume);
    await this.gate;
    const failed = this.failStart?.(resume);
    if (failed) throw failed;
    this.thread = resume ?? `thread-${this.n}`;
    return { native: this.thread };
  }

  async send(text: string, ref: string): Promise<{ ref?: string }> {
    const entry: FakeHost["sent"][number] = { text, ref, receipt: this.takes ? ref : `typed-${this.n}-${this.sent.length + 1}` };
    this.sent.push(entry);
    this.log.push(`send:${text}`);
    if (this.failSends > 0) {
      this.failSends--;
      throw new Error("the terminal is gone");
    }
    if (this.takes) entry.told = await this.events.prompted(ref, text, CODEX_PART_CHARS);
    return { ref: entry.receipt };
  }

  /** The harness takes a prompt that was sent and waited: its receipt. */
  async take(i: number = this.sent.length - 1): Promise<string[]> {
    const entry = this.sent[i]!;
    entry.told = await this.events.prompted(entry.receipt, entry.text, CODEX_PART_CHARS);
    return entry.told;
  }

  /** Its turn ends with these words; what comes next comes a moment later, as it does from a harness. */
  async reply(text: string): Promise<void> {
    this.events.replied(text);
    await tick();
  }

  async clear(): Promise<void> {
    this.clears++;
    this.log.push("clear");
    if (this.failClear) throw new Error("the thread would not start");
    this.thread = `${this.thread}-cleared`;
  }

  async stop(): Promise<void> {
    this.stops++;
  }

  async release(): Promise<void> {
    this.releases++;
  }

  native(): string | undefined {
    return this.thread;
  }

  terminal(): TerminalRef | undefined {
    return undefined;
  }

  used(): number | undefined {
    return this.usedTokens;
  }

  limit(): number | undefined {
    return this.limitTokens;
  }
}

/** The sessions module as the assistant uses it: a session handed back in place of a terminal. */
class FakeSessions implements AssistantSessions {
  hooks?: Parameters<AssistantSessions["setAssistant"]>[0];
  /** The chat's own session, live in its terminal. */
  live?: Session;
  readonly spawns: AssistantSpawn[] = [];
  readonly sends: { id: string; text: string; opts: SendOptions; part: string }[] = [];
  readonly stops: { id: string; opts: { as?: "user" | "brain" }; part: string }[] = [];
  readonly claims: string[] = [];
  /** The context its transcript's last turn counted, in tokens. */
  context?: number;

  setAssistant(hooks: Parameters<AssistantSessions["setAssistant"]>[0]): void {
    this.hooks = hooks;
  }

  assistantSession(): Session | undefined {
    return this.live;
  }

  assistantContext(): number | undefined {
    return this.context;
  }

  async spawnAssistant(p: AssistantSpawn): Promise<Session> {
    this.spawns.push(p);
    this.live = session(p.profile.id, p.resume ?? `native-${this.spawns.length}`, p.cwd, `t${this.spawns.length}`);
    return this.live;
  }

  claimAssistant(_harness: "codex", nativeId: string): void {
    this.claims.push(nativeId);
  }

  async send(id: string, text: string, opts: SendOptions, part: string): Promise<{ status: "queued" | "held"; ref?: string }> {
    this.sends.push({ id, text, opts, part });
    // a send that only prepares the session types no message of its own
    return opts.clear && text === "" ? { status: "queued" } : { status: "queued", ref: `cophylad-${this.sends.length}` };
  }

  async stopSession(id: string, opts: { as?: "user" | "brain" }, part: string): Promise<void> {
    this.stops.push({ id, opts, part });
    if (this.live?.id === id) this.live = undefined;
  }
}

interface WorldOptions {
  /** The session runs on Claude Code, through the sessions module; else on the scripted host, as a Codex thread. */
  claude?: boolean;
  config?: Record<string, unknown>;
  profiles?: HarnessProfile[];
  /** The brain at the start: up, still coming up, or none at all. */
  brain?: "up" | "down" | "none";
  /** The chat's open thread at the start; null for none yet. */
  thread?: string | null;
  timing?: AssistantDeps["timing"];
  takes?: boolean;
  /** Scripts a host as it is built, by its number from 0. */
  script?: (host: FakeHost, n: number) => void;
  /** No way to host a Codex thread on this node. */
  noCodex?: boolean;
  prefs?: unknown;
}

interface World {
  dir: string;
  bus: Bus;
  assistant: Assistant;
  brain: FakeBrain;
  noBrain: boolean;
  sessions: FakeSessions;
  hosts: FakeHost[];
  /** The first host, once it is built. */
  readonly host: FakeHost;
  kv: Map<string, unknown>;
  profiles: { all: HarnessProfile[]; changed: (() => void)[]; refreshed: number };
  /** What the chat was made to say, and the words stored for what was typed into the session's terminal. */
  said: string[];
  typed: { text: string; source: string; id: string }[];
  /** Every `assistant.state` the clients were told. */
  states: AssistantState[];
  thread: string | undefined;
  /** A user's message from the chat, as the bus carries it; its id. */
  say(text: string): string;
  /** A chat thread opens; its id. */
  open(id?: string): string;
  /** What is kept of the session between daemon runs. */
  saved(): Json | undefined;
}

const worlds: World[] = [];

afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.assistant.stop();
    rmSync(w.dir, { recursive: true, force: true });
  }
});

function world(o: WorldOptions = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "cophyla-assistant-"));
  const bus = new Bus();
  const brain = new FakeBrain();
  brain.up = o.brain !== "down";
  const sessions = new FakeSessions();
  const hosts: FakeHost[] = [];
  const kv = new Map<string, unknown>();
  if (o.prefs !== undefined) kv.set("assistant/prefs", o.prefs);
  const all = o.profiles ?? [profile(o.claude ? "claude" : "codex", "work", { default: true })];
  const profiles = { all, changed: [] as (() => void)[], refreshed: 0 };
  const said: string[] = [];
  const typed: World["typed"] = [];
  const states: AssistantState[] = [];
  bus.on("assistant.state", (s) => states.push(s));
  const w: World = {
    dir,
    bus,
    brain,
    noBrain: o.brain === "none",
    sessions,
    hosts,
    get host() {
      return hosts[0]!;
    },
    kv,
    profiles,
    said,
    typed,
    states,
    thread: o.thread === null ? undefined : (o.thread ?? newId("thread")),
    assistant: undefined as unknown as Assistant,
    say: (text) => {
      const id = newId("message");
      bus.emit("user.message", { at: Date.now(), text, source: "ui", message: id, thread: w.thread ?? newId("thread") });
      return id;
    },
    open: (id = newId("thread")) => {
      w.thread = id;
      bus.emit("thread.state", { id, startedAt: Date.now(), tags: [], sessions: [] });
      return id;
    },
    saved: () => {
      const file = join(dir, "assistant", "session.json");
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Json) : undefined;
    },
  };
  const chat: AssistantDeps["chat"] = {
    peek: () => (w.thread ? { id: w.thread, startedAt: 1, tags: [], sessions: [] } : undefined),
    // as the chat does: the message is stored, and raised as any user's message is
    userMessage: (input) => {
      const m: Message = { id: newId("message"), thread: w.thread ?? newId("thread"), at: Date.now(), role: "user", source: input.source, content: [{ type: "text", text: input.text }] };
      typed.push({ text: input.text, source: input.source, id: m.id });
      bus.emit("user.message", { at: m.at, text: input.text, source: input.source, message: m.id, thread: m.thread });
      return m;
    },
    say: (blocks) => {
      said.push(blocks.map((b) => (b.type === "text" ? b.text : `<${b.type}>`)).join(""));
      return { id: newId("message"), thread: w.thread ?? newId("thread"), at: Date.now(), role: "orchestrator", source: "brain", content: blocks };
    },
  };
  w.assistant = new Assistant({
    config: AssistantConfig.parse({ ...(o.claude ? {} : { harness: "codex" }), ...o.config }),
    dataDir: dir,
    nodeId: NODE,
    kv: { get: (ns, key) => kv.get(`${ns}/${key}`), put: (ns, key, value) => void kv.set(`${ns}/${key}`, value), delete: (ns, key) => void kv.delete(`${ns}/${key}`) },
    bus,
    log: silentLogger,
    sessions,
    profiles: {
      list: (node) => all.filter((p) => node === undefined || p.node === node),
      defaultFor: (h) => all.find((p) => p.harness === h && p.default),
      hooksMode: () => "http",
      onChange: (fn) => {
        profiles.changed.push(fn);
        return () => void profiles.changed.splice(profiles.changed.indexOf(fn), 1);
      },
      refresh: () => void profiles.refreshed++,
    },
    chat,
    brain: () => (w.noBrain ? undefined : brain),
    port: () => PORT,
    hookToken: "hook-token",
    ...(o.noCodex
      ? {}
      : {
          codex: (p, events, opts) => {
            const host = new FakeHost(hosts.length + 1, p, events, opts);
            host.takes = o.takes ?? true;
            o.script?.(host, hosts.length);
            hosts.push(host);
            return host;
          },
        }),
    timing: { backoffMs: 20, receiptMs: 5000, contextMs: 500, ...o.timing },
  });
  worlds.push(w);
  return w;
}

const until = <T>(check: () => T | undefined | false) => waitFor(check, 3000, 2);
const status = (w: World) => w.assistant.state().status;

/** A world whose session is up and idle. */
async function up(o: WorldOptions = {}): Promise<World> {
  const w = world(o);
  w.assistant.start();
  await until(() => status(w) === "idle");
  return w;
}

let named: Promise<string> | undefined;
/** The short name the module keeps the brain's rules under, learnt from a session it started with them. */
function rulesName(): Promise<string> {
  return (named ??= up().then((w) => String(w.saved()!["rules"])));
}

/** What an earlier daemon kept of the session, written where the module looks for it. */
function keep(w: World, saved: Json): void {
  mkdirSync(join(w.dir, "assistant"), { recursive: true });
  writeFileSync(join(w.dir, "assistant", "session.json"), JSON.stringify(saved));
}

/** A text long enough to be told in three parts to a Claude session. */
const LONG = Array.from({ length: 400 }, (_, i) => `${String(i).padStart(4, "0")} ${"s".repeat(45)}`).join("\n");

describe("coming up", () => {
  test("with no account signed in it is unavailable and says why; a message to the chat gets the reason back", async () => {
    const w = world({ profiles: [] });
    expect(w.assistant.state()).toEqual({ status: "off" });
    w.assistant.start();
    await sleep(20);
    expect(w.assistant.state()).toEqual({ status: "unavailable", detail: NO_ACCOUNT });
    expect(w.brain.told("assistant.state")).toEqual([{ status: "unavailable" }]);
    // the brain is asked for nothing, and nothing is started
    expect(w.brain.asked).toEqual([]);
    expect(w.hosts).toEqual([]);
    expect(w.assistant.mcpToken).toBeUndefined();
    w.say("hello");
    expect(w.said).toEqual([NO_ACCOUNT]);
    // an account that is there but not signed in is none
    const out = world({ profiles: [profile("codex", "work", { default: true, status: "unauthenticated" })] });
    out.assistant.start();
    await sleep(20);
    expect(status(out)).toBe("unavailable");
  });

  test("an account signed in since brings it up", async () => {
    const w = world({ profiles: [] });
    w.assistant.start();
    await sleep(20);
    expect(status(w)).toBe("unavailable");
    w.profiles.all.push(profile("codex", "work", { default: true }));
    for (const fn of [...w.profiles.changed]) fn();
    await until(() => status(w) === "idle");
    expect(w.hosts).toHaveLength(1);
    w.say("hello");
    await until(() => w.host.sent.length === 1);
    expect(w.said).toEqual([]);
  });

  test("while the brain is not up it waits in starting, and comes up when the brain says it is", async () => {
    for (const how of ["down", "none"] as const) {
      const w = world({ brain: how });
      w.assistant.start();
      await sleep(20);
      expect(w.assistant.state()).toEqual({ status: "starting", harness: "codex", model: "gpt-6.1-sol", effort: "low", profile: w.profiles.all[0]!.id });
      expect(w.brain.asked).toEqual([]);
      expect(w.hosts).toEqual([]);
      // a message meanwhile is kept for it
      w.say("hello");
      w.brain.up = true;
      w.noBrain = false;
      w.assistant.onBrainUp();
      await until(() => status(w) === "busy");
      expect(w.host.sent.map((s) => s.text)).toEqual(["hello"]);
      expect(w.said).toEqual([]);
    }
  });

  test("it asks the brain what the session is started with, starts it, and says where it stands", async () => {
    const w = await up();
    const p = w.profiles.all[0]!;
    expect(w.assistant.state()).toEqual({ status: "idle", harness: "codex", model: "gpt-6.1-sol", effort: "low", profile: p.id });
    expect(w.brain.asked).toEqual([{ method: "assistant.setup", params: { harness: "codex" }, timeoutMs: 10_000 }]);
    expect(w.profiles.refreshed).toBe(1);
    // the host is built for the account, with the brain's rules and a folder of cophylad's own
    expect(w.hosts).toHaveLength(1);
    expect(w.host.profile).toBe(p);
    expect(w.host.system).toBe(RULES);
    expect(w.host.cwd).toBe(join(w.dir, "assistant", "work"));
    expect(existsSync(w.host.cwd)).toBe(true);
    expect(w.host.starts).toEqual([undefined]);
    // the brain and the clients are told, each of the change
    const named = { harness: "codex", profile: p.id, model: "gpt-6.1-sol" };
    expect(w.brain.told("assistant.state")).toEqual([{ status: "starting", ...named }, { status: "idle", ...named }]);
    expect(w.states.map((s) => s.status)).toEqual(["starting", "idle"]);
    for (const e of w.brain.events) expect(e.params).toMatchObject({ at: expect.any(Number), eventId: expect.stringMatching(/^evt_/) });
    // it has a token of its own for its tool server, and what is known of it is kept beside its files
    expect(w.assistant.mcpToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(w.saved()).toEqual({ harness: "codex", profile: p.id, native: "thread-1", token: w.assistant.mcpToken, port: PORT, rules: await rulesName() });
    expect(w.assistant.busy).toBe(false);
  });

  test("the rules it was started with are kept by a short name of their own: the same for the same rules, another for others", async () => {
    const name = await rulesName();
    expect(name).toMatch(/^[0-9a-z]+$/);
    expect((await up()).saved()!["rules"]).toBe(name);
    const other = world();
    other.brain.system = `${RULES} And then some.`;
    other.assistant.start();
    await until(() => status(other) === "idle");
    expect(other.saved()!["rules"]).not.toBe(name);
    // the rules themselves are not kept there
    expect(JSON.stringify(other.saved())).not.toContain("Cophyla");
  });

  test("the context it holds is told against where it is folded: the configured size, or the host's own where that is another", async () => {
    const w = await up();
    expect(w.assistant.state().context).toBeUndefined();
    w.host.usedTokens = 41_000;
    w.host.events.changed();
    expect(w.assistant.state().context).toEqual({ used: 41_000, limit: 300_000 });
    w.host.limitTokens = 230_000;
    w.host.events.changed();
    expect(w.states.at(-1)!.context).toEqual({ used: 41_000, limit: 230_000 });
    // the brain is told of where it stands alone, not of every size
    expect(w.brain.told("assistant.state").map((s) => s["status"])).toEqual(["starting", "idle"]);
  });

  test("which account: the user's choice, then config, then the usual one, Claude Code first", async () => {
    const claude = profile("claude", "personal", { default: true });
    const usual = profile("codex", "work", { default: true });
    const side = profile("codex", "Side");
    const chosen = async (o: WorldOptions) => {
      const w = await up({ claude: true, profiles: [claude, usual, side], ...o });
      const s = w.assistant.state();
      return [s.harness, s.profile];
    };
    expect(await chosen({})).toEqual(["claude", claude.id]);
    expect(await chosen({ config: { harness: "codex" } })).toEqual(["codex", usual.id]);
    // an account named in config, by its name whatever its case, or by its id
    expect(await chosen({ config: { profile: "side" } })).toEqual(["codex", side.id]);
    expect(await chosen({ config: { profile: side.id } })).toEqual(["codex", side.id]);
    // what the user chose in the app comes first
    expect(await chosen({ config: { harness: "claude" }, prefs: { harness: "codex" } })).toEqual(["codex", usual.id]);
    expect(await chosen({ config: { profile: "personal" }, prefs: { profile: side.id } })).toEqual(["codex", side.id]);
    // an account named that is not signed in here: the usual one
    expect(await chosen({ prefs: { profile: "gone" } })).toEqual(["claude", claude.id]);
    // a choice that is not one is no choice
    expect(await chosen({ prefs: { harness: "muse", profile: 7 } })).toEqual(["claude", claude.id]);
    // with no usual account of a harness, any signed in to it will do
    const only = await up({ profiles: [side] });
    expect(only.assistant.state().profile).toBe(side.id);
  });

  test("where it stands names what the user picked, apart from what it runs on, and nothing when they picked nothing", async () => {
    const usual = profile("codex", "work", { default: true });
    const side = profile("codex", "side");
    expect(Object.keys((await up({ profiles: [usual, side] })).assistant.state())).not.toContain("chosen");
    expect((await up({ profiles: [usual, side], prefs: { harness: "codex" } })).assistant.state()).toMatchObject({ profile: usual.id, chosen: { harness: "codex" } });
    expect((await up({ profiles: [usual, side], prefs: { profile: side.id } })).assistant.state()).toMatchObject({ profile: side.id, chosen: { profile: side.id } });
    // a pick that cannot be had is their pick still: the session runs on the usual account meanwhile
    const gone = newId("profile");
    expect((await up({ profiles: [usual, side], prefs: { harness: "codex", profile: gone } })).assistant.state()).toMatchObject({ profile: usual.id, chosen: { harness: "codex", profile: gone } });
    // and it is known before anything runs
    const cold = world({ profiles: [], prefs: { harness: "claude" } });
    expect(cold.assistant.state()).toEqual({ status: "off", chosen: { harness: "claude" } });
  });

  test("a start that fails leaves it down with why, and is tried again", async () => {
    const w = world({ script: (host, n) => void (host.failStart = n === 0 ? () => new Error("codex is not signed in") : undefined) });
    w.assistant.start();
    await until(() => status(w) === "down");
    expect(w.assistant.state().detail).toBe("codex is not signed in");
    expect(w.assistant.wake({ id: "w1", text: "The build finished." })).toEqual({ queued: false });
    await until(() => status(w) === "idle");
    expect(w.hosts).toHaveLength(2);
    expect(w.assistant.state().detail).toBeUndefined();
  });

  test("a brain that cannot say what it is started with leaves it down, and it comes up once the brain can", async () => {
    const w = world();
    w.brain.failing = new RpcError("unsupported", "the brain knows no assistant.setup");
    w.assistant.start();
    await until(() => status(w) === "down");
    expect(w.assistant.state().detail).toBe("the brain knows no assistant.setup");
    expect(w.hosts).toEqual([]);
    w.brain.failing = undefined;
    await until(() => status(w) === "idle");
  });

  test("turned off in config it stays off, and answers nothing", async () => {
    const w = world({ config: { enabled: false } });
    w.assistant.start();
    await sleep(20);
    expect(w.assistant.state()).toEqual({ status: "off", detail: "the chat's session is turned off in config.toml ([assistant] enabled)" });
    w.say("hello");
    await sleep(20);
    expect(w.said).toEqual([]);
    expect(w.hosts).toEqual([]);
    expect(w.brain.asked).toEqual([]);
  });

  test("a Codex account on a node that cannot host its thread is down, saying so", async () => {
    const w = world({ noCodex: true });
    w.assistant.start();
    await until(() => status(w) === "down");
    expect(w.assistant.state().detail).toBe("a Codex account cannot run the chat on this node");
  });
});

describe("a prompt and its turn", () => {
  test("a user's message is handed to the session; the brain hears the prompt taken, then the reply; it is busy only between", async () => {
    const w = await up();
    const id = w.say("what is open?");
    await until(() => w.host.sent.length === 1);
    expect(w.host.sent[0]).toMatchObject({ text: "what is open?", ref: "prompt-1" });
    expect(status(w)).toBe("busy");
    expect(w.assistant.busy).toBe(true);
    expect(w.brain.turns()).toEqual([["assistant.prompted", { prompt: { kind: "user", message: id } }]]);
    await w.host.reply("Two sessions are open.");
    expect(w.brain.turns()).toEqual([
      ["assistant.prompted", { prompt: { kind: "user", message: id } }],
      ["assistant.replied", { text: "Two sessions are open.", prompt: { kind: "user", message: id } }],
    ]);
    expect(status(w)).toBe("idle");
    expect(w.assistant.busy).toBe(false);
    expect(w.brain.told("assistant.state").map((s) => s["status"])).toEqual(["starting", "idle", "busy", "idle"]);
    expect(w.said).toEqual([]);
  });

  test("the mark of a quick message is dropped from the words typed", async () => {
    const w = await up();
    w.say("/quick what is open?");
    await until(() => w.host.sent.length === 1);
    await w.host.reply("Two.");
    w.say("/QUICK   and the tasks?");
    await until(() => w.host.sent.length === 2);
    expect(w.host.sent.map((s) => s.text)).toEqual(["what is open?", "and the tasks?"]);
  });

  test("what the brain says goes beside a prompt, in parts, and each ask names the last telling that reached the session until it forgot", async () => {
    const w = await up();
    w.brain.context = () => ({ text: "Now: Tuesday", seq: 5 });
    const a = w.say("what is open?");
    await until(() => w.host.sent[0]?.told);
    expect(w.host.sent[0]!.told).toEqual(["Now: Tuesday"]);
    // the first prompt of a thread's context names no telling: none has reached it
    expect(w.brain.asked.at(-1)).toEqual({ method: "assistant.context", params: { kind: "prompt", prompt: { kind: "user", message: a }, source: "fresh" }, timeoutMs: 500 });
    await w.host.reply("Two.");
    // a longer telling is cut for the harness that carries it
    w.brain.context = () => ({ text: LONG, seq: 6 });
    const b = w.say("and the tasks?");
    await until(() => w.host.sent[1]?.told);
    expect(w.host.sent[1]!.told).toEqual(parts(LONG, CODEX_PART_CHARS));
    expect(w.host.sent[1]!.told!.length).toBeGreaterThan(1);
    expect(w.brain.of("assistant.context").at(-1)).toEqual({ kind: "prompt", prompt: { kind: "user", message: b }, have: 5 });
    await w.host.reply("None.");
    // an answer that names no telling leaves the last one standing
    w.brain.context = () => ({ text: "" });
    w.say("thanks");
    await until(() => w.host.sent[2]?.told);
    expect(w.host.sent[2]!.told).toEqual([]);
    expect(w.brain.of("assistant.context").at(-1)!["have"]).toBe(6);
    await w.host.reply("Sure.");
    w.say("one more");
    await until(() => w.host.sent[3]?.told);
    expect(w.brain.of("assistant.context").at(-1)!["have"]).toBe(6);
    await w.host.reply("Yes.");
    // what it held was cleared or folded away: the next ask names none, and the brain tells it whole
    w.host.events.forgot();
    w.say("still there?");
    await until(() => w.host.sent[4]?.told);
    expect(Object.keys(w.brain.of("assistant.context").at(-1)!)).toEqual(["kind", "prompt"]);
  });

  test("on a harness that says nothing of its start, the prompt a context begins with says so: the first, and the first after a clear", async () => {
    const w = await up();
    const sources = () => w.brain.of("assistant.context").map((p) => p["source"]);
    w.say("one");
    await until(() => w.host.sent[0]?.told);
    await w.host.reply("One.");
    w.say("two");
    await until(() => w.host.sent[1]?.told);
    await w.host.reply("Two.");
    expect(sources()).toEqual(["fresh", undefined]);
    // what it held was folded away, not cleared: the context goes on
    w.host.events.forgot();
    w.say("three");
    await until(() => w.host.sent[2]?.told);
    await w.host.reply("Three.");
    expect(sources()).toEqual(["fresh", undefined, undefined]);
    w.open();
    w.say("four");
    await until(() => w.host.sent[3]?.told);
    expect(w.host.clears).toBe(1);
    expect(sources()).toEqual(["fresh", undefined, undefined, "fresh"]);
    // a wake that begins a context says so as well
    const woken = await up();
    woken.assistant.wake({ id: "w1", text: "The build finished." });
    await until(() => woken.host.sent[0]?.told);
    expect(woken.brain.of("assistant.context")).toEqual([{ kind: "prompt", prompt: { kind: "wake", wake: "w1" }, source: "fresh" }]);
  });

  // `fresh` is "nothing was typed into the session since its context began", and the comment at
  // its use says the prompt a context begins with tells the brain so. A session started with a
  // context of its own (`restart({fresh: true})`, `configure`) keeps the flag its last context
  // left, so on Codex the first prompt after it is not marked.
  test("the first prompt after the session was started with a context of its own says the context is fresh", async () => {
    const w = await up();
    w.say("one");
    await until(() => w.host.sent[0]?.told);
    await w.host.reply("One.");
    await w.assistant.restart({ fresh: true });
    w.say("two");
    await until(() => w.hosts[1]!.sent[0]?.told);
    expect(w.brain.of("assistant.context").at(-1)).toMatchObject({ source: "fresh" });
  });

  test("a brain that does not say what goes beside a prompt leaves it with nothing: the prompt is taken all the same", async () => {
    const w = await up();
    w.brain.context = () => {
      throw new RpcError("timeout", "no answer in 500 ms");
    };
    const id = w.say("what is open?");
    await until(() => w.host.sent[0]?.told);
    expect(w.host.sent[0]!.told).toEqual([]);
    expect(w.brain.turns()).toEqual([["assistant.prompted", { prompt: { kind: "user", message: id } }]]);
    expect(w.assistant.busy).toBe(true);
  });

  test("prompts go one at a time: a wake waits for the turn that runs, and the next wake for that one", async () => {
    const w = await up();
    const id = w.say("hello");
    await until(() => w.host.sent.length === 1);
    expect(w.assistant.wake({ id: "w1", text: "The build finished." })).toEqual({ queued: true });
    expect(w.assistant.wake({ id: "w2", text: "The tests passed." })).toEqual({ queued: true });
    await sleep(30);
    expect(w.host.sent).toHaveLength(1);
    await w.host.reply("Hi.");
    await until(() => w.host.sent.length === 2);
    await sleep(30);
    expect(w.host.sent.map((s) => s.text)).toEqual(["hello", "The build finished."]);
    await w.host.reply("Told.");
    await until(() => w.host.sent.length === 3);
    expect(w.host.sent[2]!.text).toBe("The tests passed.");
    expect(w.brain.turns()).toEqual([
      ["assistant.prompted", { prompt: { kind: "user", message: id } }],
      ["assistant.replied", { text: "Hi.", prompt: { kind: "user", message: id } }],
      ["assistant.prompted", { prompt: { kind: "wake", wake: "w1" } }],
      ["assistant.replied", { text: "Told.", prompt: { kind: "wake", wake: "w1" } }],
      ["assistant.prompted", { prompt: { kind: "wake", wake: "w2" } }],
    ]);
  });

  test("a prompt sent and not yet taken holds the next back, a user's message too", async () => {
    const w = await up({ takes: false });
    const a = w.say("first");
    await until(() => w.host.sent.length === 1);
    const b = w.say("second");
    w.assistant.wake({ id: "w1", text: "The build finished." });
    await sleep(30);
    expect(w.host.sent).toHaveLength(1);
    // sent is not taken: no turn runs yet
    expect(w.assistant.busy).toBe(false);
    expect(w.brain.turns()).toEqual([]);
    await w.host.take(0);
    await until(() => w.host.sent.length === 2);
    expect(w.host.sent[1]!.text).toBe("second");
    await w.host.take(1);
    await sleep(30);
    expect(w.host.sent).toHaveLength(2);
    await w.host.reply("Both.");
    await until(() => w.host.sent.length === 3);
    expect(w.host.sent[2]!.text).toBe("The build finished.");
    expect(w.brain.turns()).toEqual([
      ["assistant.prompted", { prompt: { kind: "user", message: a } }],
      ["assistant.prompted", { prompt: { kind: "user", message: b } }],
      ["assistant.replied", { text: "Both.", prompt: { kind: "user", message: b } }],
    ]);
  });

  test("a user's message during a wake's turn is sent into it at once and cuts nothing short: the brain hears it taken, and the turn's end is the wake's", async () => {
    const w = await up();
    w.assistant.wake({ id: "w1", text: "The build finished." });
    await until(() => w.host.sent[0]?.told);
    expect(w.assistant.busy).toBe(true);
    const id = w.say("wait, what is open?");
    await until(() => w.host.sent[1]?.told);
    // nothing but the two prompts was asked of the session
    expect(w.host.log).toEqual(["send:The build finished.", "send:wait, what is open?"]);
    expect(w.brain.turns()).toEqual([
      ["assistant.prompted", { prompt: { kind: "wake", wake: "w1" } }],
      ["assistant.prompted", { prompt: { kind: "user", message: id } }],
    ]);
    // the one reply serves both, and settles the wake
    await w.host.reply("The build is done, and two sessions are open.");
    expect(w.brain.turns().at(-1)).toEqual(["assistant.replied", { text: "The build is done, and two sessions are open.", prompt: { kind: "wake", wake: "w1" } }]);
    expect(w.brain.turns().some(([, p]) => "interrupted" in p)).toBe(false);
    expect(w.brain.told("assistant.state").map((s) => s["status"])).toEqual(["starting", "idle", "busy", "idle"]);
    expect(w.assistant.busy).toBe(false);
    // nothing is owed again: the session is sent no more
    await sleep(30);
    expect(w.host.sent).toHaveLength(2);
  });

  test("several messages into a wake's turn leave it the wake's to its end", async () => {
    const w = await up();
    w.assistant.wake({ id: "w1", text: "The build finished." });
    await until(() => w.host.sent[0]?.told);
    const a = w.say("what is open?");
    await until(() => w.host.sent[1]?.told);
    const b = w.say("and the tasks?");
    await until(() => w.host.sent[2]?.told);
    await w.host.reply("All of it.");
    expect(w.brain.turns()).toEqual([
      ["assistant.prompted", { prompt: { kind: "wake", wake: "w1" } }],
      ["assistant.prompted", { prompt: { kind: "user", message: a } }],
      ["assistant.prompted", { prompt: { kind: "user", message: b } }],
      ["assistant.replied", { text: "All of it.", prompt: { kind: "wake", wake: "w1" } }],
    ]);
  });

  test("a user's message goes ahead of the wakes that wait: it joins the turn that runs, and they follow its end", async () => {
    const w = await up();
    w.assistant.wake({ id: "w1", text: "The build finished." });
    await until(() => w.host.sent[0]?.told);
    w.assistant.wake({ id: "w2", text: "The tests passed." });
    await tick();
    w.say("what is open?");
    await until(() => w.host.sent[1]?.told);
    expect(w.host.sent[1]!.text).toBe("what is open?");
    await sleep(30);
    expect(w.host.sent).toHaveLength(2);
    await w.host.reply("Two.");
    await until(() => w.host.sent.length === 3);
    expect(w.host.sent[2]!.text).toBe("The tests passed.");
    expect(w.brain.turns().at(-1)).toEqual(["assistant.prompted", { prompt: { kind: "wake", wake: "w2" } }]);
  });

  test("a user's message during a turn of the user's joins it at once, and the reply answers the last", async () => {
    const w = await up();
    const a = w.say("what is open?");
    await until(() => w.host.sent.length === 1);
    const b = w.say("and the tasks?");
    await until(() => w.host.sent.length === 2);
    expect(w.host.log).toEqual(["send:what is open?", "send:and the tasks?"]);
    await w.host.reply("Two sessions, no tasks.");
    expect(w.brain.turns()).toEqual([
      ["assistant.prompted", { prompt: { kind: "user", message: a } }],
      ["assistant.prompted", { prompt: { kind: "user", message: b } }],
      ["assistant.replied", { text: "Two sessions, no tasks.", prompt: { kind: "user", message: b } }],
    ]);
    expect(w.assistant.busy).toBe(false);
  });

  test("a wake is taken only while the session is up", async () => {
    const w = world();
    expect(w.assistant.wake({ id: "w0", text: "early" })).toEqual({ queued: false });
    w.assistant.start();
    await until(() => status(w) === "idle");
    expect(w.assistant.wake({ id: "w1", text: "The build finished." })).toEqual({ queued: true });
    await until(() => w.host.sent.length === 1);
    // mid-turn it is up still
    expect(w.assistant.wake({ id: "w2", text: "The tests passed." })).toEqual({ queued: true });
    await w.assistant.stop();
    expect(w.assistant.wake({ id: "w3", text: "late" })).toEqual({ queued: false });
    expect(w.host.sent.map((s) => s.text)).toEqual(["The build finished."]);
  });

  // `pump` lets go of its flag in a `.finally`, a few microtasks after `drain` has already found
  // nothing to do; what is queued in between is not drained until something else pumps. Two
  // events rarely share a tick in the daemon, but nothing but timing keeps them apart.
  test("a message that comes in the very tick a turn ended is sent like any other", async () => {
    const w = await up();
    w.say("one");
    await until(() => w.host.sent[0]?.told);
    w.host.events.replied("One.");
    w.say("two");
    await waitFor(() => w.host.sent.length === 2, 500, 2);
  });

  test("a tool of the harness's own that the session ran is a step of the turn to the brain", async () => {
    const w = await up();
    w.say("search for it");
    await until(() => w.host.sent.length === 1);
    w.host.events.step("web_search", { query: "bun test todo" });
    expect(w.brain.turns().at(-1)).toEqual(["assistant.step", { tool: "web_search", input: { query: "bun test todo" } }]);
  });

  test("a reply with no turn known for it is told as it is", async () => {
    const w = await up();
    await w.host.reply("Something it said on its own.");
    expect(w.brain.turns()).toEqual([["assistant.replied", { text: "Something it said on its own." }]]);
    expect(status(w)).toBe("idle");
  });
});

describe("a chat thread opening", () => {
  test("clears the session's context once it is idle", async () => {
    const w = await up();
    w.say("hello");
    await until(() => w.host.sent.length === 1);
    w.open();
    await sleep(30);
    expect(w.host.clears).toBe(0);
    await w.host.reply("Hi.");
    await until(() => w.host.clears === 1);
    // what is known of it is kept again: its conversation is another now
    expect(w.saved()!["native"]).toBe("thread-1-cleared");
  });

  test("clears nothing when nothing was typed since its context began", async () => {
    const w = await up();
    w.open();
    await sleep(30);
    expect(w.host.clears).toBe(0);
    w.say("hello");
    await until(() => w.host.sent.length === 1);
    await w.host.reply("Hi.");
    w.open();
    await until(() => w.host.clears === 1);
    // cleared, it is fresh again: the next thread has nothing to clear
    w.open();
    await sleep(30);
    expect(w.host.clears).toBe(1);
  });

  test("a thread that ended, the thread it is in already, and the first thread there ever was, clear nothing", async () => {
    const w = await up();
    w.say("hello");
    await until(() => w.host.sent.length === 1);
    await w.host.reply("Hi.");
    w.bus.emit("thread.state", { id: newId("thread"), startedAt: 1, endedAt: 2, tags: [], sessions: [] });
    w.bus.emit("thread.state", { id: w.thread!, startedAt: 1, tags: [], sessions: [], topic: "renamed" });
    await sleep(30);
    expect(w.host.clears).toBe(0);
    // no thread was open when it came up: the first is the one its context belongs to
    const first = await up({ thread: null });
    first.say("hello");
    await until(() => first.host.sent.length === 1);
    await first.host.reply("Hi.");
    first.open();
    await sleep(30);
    expect(first.host.clears).toBe(0);
    first.open();
    await until(() => first.host.clears === 1);
  });

  // The module starts out taking its session's context for fresh, and nothing says otherwise
  // when the conversation is one an earlier daemon left (resumed here, or met again in its
  // terminal): a thread that opens before anything is typed leaves that conversation in place.
  test("a conversation gone on with from an earlier daemon is not fresh: a thread opening clears it", async () => {
    const p = profile("codex", "work", { default: true });
    const w = world({ profiles: [p] });
    keep(w, { harness: "codex", profile: p.id, native: "thread-kept", token: "t", port: PORT });
    w.assistant.start();
    await until(() => status(w) === "idle");
    expect(w.host.starts).toEqual(["thread-kept"]);
    w.open();
    await waitFor(() => w.host.clears === 1, 500, 2);
  });

  test("two threads opening while a turn runs are one clear", async () => {
    const w = await up();
    w.say("hello");
    await until(() => w.host.sent.length === 1);
    w.open();
    w.open();
    await w.host.reply("Hi.");
    await until(() => w.host.clears === 1);
    await sleep(30);
    expect(w.host.clears).toBe(1);
  });

  test("a message of the new thread waits behind the clear instead of joining the old thread's turn", async () => {
    const w = await up();
    w.say("the old thread's last");
    await until(() => w.host.sent.length === 1);
    w.open();
    w.say("the new thread's first");
    await sleep(30);
    expect(w.host.sent).toHaveLength(1);
    await w.host.reply("Done.");
    await until(() => w.host.sent.length === 2);
    expect(w.host.log).toEqual(["send:the old thread's last", "clear", "send:the new thread's first"]);
  });

  test("a context that could not be cleared is kept, and what follows goes on", async () => {
    const w = await up();
    w.say("hello");
    await until(() => w.host.sent.length === 1);
    await w.host.reply("Hi.");
    w.host.failClear = true;
    w.open();
    w.say("next");
    await until(() => w.host.sent.length === 2);
    expect(w.host.log).toEqual(["send:hello", "clear", "send:next"]);
    expect(w.saved()!["native"]).toBe("thread-1");
  });
});

describe("a prompt that does not reach the session", () => {
  test("a user's message whose send fails is tried once more, and then they are told", async () => {
    const w = await up();
    w.host.failSends = 2;
    w.say("hello");
    await until(() => w.said.length === 1);
    expect(w.said).toEqual([UNDELIVERED]);
    expect(w.host.sent.map((s) => s.text)).toEqual(["hello", "hello"]);
    expect(w.brain.turns()).toEqual([]);
    expect(w.assistant.busy).toBe(false);
    // and the next message goes as any other
    const id = w.say("again");
    await until(() => w.host.sent.length === 3);
    expect(w.brain.turns()).toEqual([["assistant.prompted", { prompt: { kind: "user", message: id } }]]);
  });

  test("one that reaches it the second time is said nothing about", async () => {
    const w = await up();
    w.host.failSends = 1;
    const id = w.say("hello");
    await until(() => w.host.sent.length === 2);
    await sleep(30);
    expect(w.said).toEqual([]);
    expect(w.brain.turns()).toEqual([["assistant.prompted", { prompt: { kind: "user", message: id } }]]);
  });

  test("a wake whose send fails goes back to the brain as interrupted, and is not tried again", async () => {
    const w = await up();
    w.host.failSends = 1;
    expect(w.assistant.wake({ id: "w1", text: "The build finished." })).toEqual({ queued: true });
    await until(() => w.brain.turns().length === 1);
    expect(w.brain.turns()).toEqual([["assistant.replied", { text: "", prompt: { kind: "wake", wake: "w1" }, interrupted: true }]]);
    await sleep(30);
    expect(w.host.sent).toHaveLength(1);
    expect(w.said).toEqual([]);
    expect(w.assistant.busy).toBe(false);
  });

  test("a user's message never taken in its time is not typed a second time: the user is told it waits", async () => {
    const w = await up({ takes: false, timing: { receiptMs: 40 } });
    w.say("hello");
    await until(() => w.host.sent.length === 1);
    expect(w.said).toEqual([]);
    await until(() => w.said.length === 1);
    expect(w.said).toEqual([UNTAKEN]);
    await sleep(120);
    // Both would land, so it is not sent again; the brain has heard of no turn.
    expect(w.host.sent).toHaveLength(1);
    expect(w.said).toHaveLength(1);
    expect(w.brain.turns()).toEqual([]);
  });

  test("a wake never taken in its time goes back to the brain as interrupted, and the next prompt may go", async () => {
    const w = await up({ takes: false, timing: { receiptMs: 40 } });
    w.assistant.wake({ id: "w1", text: "The build finished." });
    w.assistant.wake({ id: "w2", text: "The tests passed." });
    await until(() => w.host.sent.length === 1);
    await until(() => w.brain.turns().length === 1);
    expect(w.brain.turns()).toEqual([["assistant.replied", { text: "", prompt: { kind: "wake", wake: "w1" }, interrupted: true }]]);
    await until(() => w.host.sent.length === 2);
    expect(w.host.sent.map((s) => s.text)).toEqual(["The build finished.", "The tests passed."]);
  });

  test("a prompt taken in its time is neither sent again nor said anything about", async () => {
    const w = await up({ takes: false, timing: { receiptMs: 40 } });
    const id = w.say("hello");
    await until(() => w.host.sent.length === 1);
    await w.host.take();
    await sleep(120);
    expect(w.host.sent).toHaveLength(1);
    expect(w.said).toEqual([]);
    expect(w.brain.turns()).toEqual([["assistant.prompted", { prompt: { kind: "user", message: id } }]]);
  });

  test("a wake taken after its time was up is no wake's turn to the brain, which was told it went unanswered", async () => {
    const w = await up({ takes: false, timing: { receiptMs: 40 } });
    w.assistant.wake({ id: "w1", text: "The build finished." });
    await until(() => w.brain.turns().length === 1);
    await w.host.take(0);
    expect(w.brain.turns()).toEqual([
      ["assistant.replied", { text: "", prompt: { kind: "wake", wake: "w1" }, interrupted: true }],
      ["assistant.prompted", { prompt: { kind: "terminal" } }],
    ]);
  });

  test("a user's message taken after its time was up is still the user's message to the brain", async () => {
    const w = await up({ takes: false, timing: { receiptMs: 40 } });
    const id = w.say("hello");
    await until(() => w.said.length === 1);
    expect(w.host.sent).toHaveLength(1);
    await w.host.take(0);
    expect(w.brain.turns()).toEqual([["assistant.prompted", { prompt: { kind: "user", message: id } }]]);
    expect(w.assistant.busy).toBe(true);
  });
});

describe("its program going", () => {
  test("it is down, then started again where it was, and a message sent and never taken is sent again", async () => {
    const w = await up({ takes: false });
    const id = w.say("hello");
    await until(() => w.host.sent.length === 1);
    w.host.events.ended("its app-server went");
    await until(() => w.hosts.length === 2 && w.hosts[1]!.sent.length === 1);
    expect(w.states.map((s) => s.status)).toEqual(["starting", "idle", "down", "starting", "idle"]);
    expect(w.states[2]!.detail).toBe("the chat's session ended and is being started again");
    expect(w.hosts[1]!.starts).toEqual(["thread-1"]);
    expect(w.hosts[1]!.sent[0]!.text).toBe("hello");
    await w.hosts[1]!.take();
    expect(w.brain.turns()).toEqual([["assistant.prompted", { prompt: { kind: "user", message: id } }]]);
    // the host that went is not asked to stop: its program is gone
    expect(w.host.stops).toBe(0);
  });

  test("its turn goes with it, and a wake that waited is sent once it is back", async () => {
    const w = await up();
    w.say("hello");
    await until(() => w.host.sent[0]?.told);
    expect(w.assistant.wake({ id: "w1", text: "The build finished." })).toEqual({ queued: true });
    expect(w.assistant.busy).toBe(true);
    await tick();
    w.host.events.ended("its app-server went");
    expect(w.assistant.busy).toBe(false);
    await until(() => w.hosts.length === 2 && w.hosts[1]!.sent.length === 1);
    expect(w.hosts[1]!.sent[0]!.text).toBe("The build finished.");
  });

  test("a turn of the user's that went with it had no answer: the user is told so, and the brain that nothing was said", async () => {
    const w = await up();
    const id = w.say("hello");
    await until(() => w.host.sent[0]?.told);
    w.host.events.ended("its app-server went");
    expect(w.said).toEqual(["The chat's agent stopped before it answered, and is being started again. Send your message again."]);
    expect(w.brain.turns()).toEqual([
      ["assistant.prompted", { prompt: { kind: "user", message: id } }],
      ["assistant.replied", { text: "", prompt: { kind: "user", message: id }, interrupted: true }],
    ]);
    // The session holds their message already: it is not typed again.
    await until(() => w.hosts.length === 2 && status(w) === "idle");
    await sleep(40);
    expect(w.hosts[1]!.sent).toEqual([]);
  });

  test("a wake's turn that went with it, and a wake it had not taken, go back to the brain; nothing is said to the user", async () => {
    const w = await up({ takes: false });
    w.assistant.wake({ id: "w1", text: "The build finished." });
    await until(() => w.host.sent.length === 1);
    w.host.events.ended("its app-server went");
    expect(w.brain.turns()).toEqual([["assistant.replied", { text: "", prompt: { kind: "wake", wake: "w1" }, interrupted: true }]]);
    expect(w.said).toEqual([]);
    await until(() => w.hosts.length === 2 && status(w) === "idle");
    // The brain owes it again: the module does not type it of its own accord.
    await sleep(40);
    expect(w.hosts[1]!.sent).toEqual([]);
  });

  test("each start has a token of its own, and the one before is no longer the session's", async () => {
    const w = await up();
    const first = w.assistant.mcpToken;
    w.host.events.ended("its app-server went");
    await until(() => w.hosts.length === 2 && status(w) === "idle");
    expect(w.assistant.mcpToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(w.assistant.mcpToken).not.toBe(first);
    expect(w.saved()!["token"]).toBe(w.assistant.mcpToken);
  });
});

describe("the session's tools", () => {
  test("they are the brain's, with what their server says of itself", async () => {
    const w = await up();
    expect(await w.assistant.tools()).toEqual({ tools: TOOLS, instructions: "Cophyla's tools: call them." });
    expect(w.brain.asked.at(-1)).toEqual({ method: "tools.list", params: {}, timeoutMs: 10_000 });
    // a host the harness calls back on reaches the same
    expect(await w.host.events.tools()).toEqual(TOOLS);
    w.brain.failing = new RpcError("unavailable", "the brain restarted");
    await expect(w.assistant.tools()).rejects.toThrow("the brain restarted");
  });

  test("a call is run by the brain, and may take as long as a held tool does", async () => {
    const w = await up();
    w.brain.result = { content: "the desktop", image: { mime: "image/png", base64: "iVBORw0KGgo=" } };
    expect(await w.assistant.call("agents", { status: ["busy"] })).toEqual(w.brain.result);
    expect(w.brain.asked.at(-1)).toEqual({ method: "tool.call", params: { tool: "agents", input: { status: ["busy"] } }, timeoutMs: 300_000 });
    expect(await w.host.events.call("agents", {})).toEqual(w.brain.result);
  });

  test("a brain that fails, or is not there, is an error the model reads: the call never throws", async () => {
    const w = await up();
    w.brain.failing = new RpcError("unavailable", "the brain restarted");
    expect(await w.assistant.call("agents", {})).toEqual({ content: "agents was not run: the brain restarted. Tell the user in a line and end the turn.", isError: true });
    w.brain.failing = new Error("the pipe closed");
    expect(await w.assistant.call("tasks", {})).toEqual({ content: "tasks was not run: the pipe closed. Tell the user in a line and end the turn.", isError: true });
    w.noBrain = true;
    expect(await w.assistant.call("agents", {})).toEqual({ content: "agents was not run: the brain is not running. Tell the user in a line and end the turn.", isError: true });
    await expect(w.assistant.tools()).rejects.toThrow("the brain is not running");
  });
});

describe("what the user sets", () => {
  test("a choice of account or harness is kept, and the session is started again under it with a context of its own", async () => {
    const usual = profile("codex", "work", { default: true });
    const side = profile("codex", "side");
    const w = await up({ profiles: [usual, side] });
    expect(w.assistant.prefs()).toEqual({});
    const state = await w.assistant.configure({ profile: side.id });
    expect(state).toEqual({ status: "idle", harness: "codex", model: "gpt-6.1-sol", effort: "low", profile: side.id, chosen: { profile: side.id } });
    expect(w.kv.get("assistant/prefs")).toEqual({ profile: side.id });
    expect(w.assistant.prefs()).toEqual({ profile: side.id });
    // the session before ends, and the one after goes on with nothing
    expect([w.hosts[0]!.stops, w.hosts[0]!.releases]).toEqual([1, 0]);
    expect(w.hosts).toHaveLength(2);
    expect(w.hosts[1]!.profile).toBe(side);
    expect(w.hosts[1]!.starts).toEqual([undefined]);
    expect(w.saved()).toMatchObject({ profile: side.id, native: "thread-2" });
    // a harness is kept beside it; one left to cophylad again is dropped, and with nothing left so is the key
    await w.assistant.configure({ harness: "codex" });
    expect(w.kv.get("assistant/prefs")).toEqual({ profile: side.id, harness: "codex" });
    await w.assistant.configure({ profile: null });
    expect(w.kv.get("assistant/prefs")).toEqual({ harness: "codex" });
    expect(w.hosts.at(-1)!.profile).toBe(usual);
    expect((await w.assistant.configure({ harness: null })).chosen).toBeUndefined();
    expect(w.kv.has("assistant/prefs")).toBe(false);
    // the clients heard each choice as it was made
    expect(w.states.filter((s) => s.status === "idle").map((s) => s.chosen)).toEqual([undefined, { profile: side.id }, { profile: side.id, harness: "codex" }, { harness: "codex" }, undefined]);
    expect(w.hosts.map((h) => h.starts)).toEqual([[undefined], [undefined], [undefined], [undefined], [undefined]]);
    expect(w.hosts.slice(0, -1).every((h) => h.stops === 1)).toBe(true);
  });

  test("a restart goes on with the conversation it had; a fresh one does not", async () => {
    const w = await up();
    expect((await w.assistant.restart()).status).toBe("idle");
    expect(w.hosts[0]!.stops).toBe(1);
    expect(w.hosts[1]!.starts).toEqual(["thread-1"]);
    expect(w.saved()!["native"]).toBe("thread-1");
    await w.assistant.restart({ fresh: true });
    expect(w.hosts[1]!.stops).toBe(1);
    expect(w.hosts[2]!.starts).toEqual([undefined]);
    expect(w.saved()!["native"]).toBe("thread-3");
  });

  test("a conversation that is not there to go on with is started fresh", async () => {
    const w = await up({ script: (host, n) => void (host.failStart = n === 1 ? (resume) => (resume !== undefined ? new Error("no thread thread-1") : undefined) : undefined) });
    await w.assistant.restart();
    expect(w.hosts[1]!.starts).toEqual(["thread-1", undefined]);
    expect(status(w)).toBe("idle");
    expect(w.saved()!["native"]).toBe("thread-2");
  });

  test("a restart mid-turn takes the turn with it: the brain is told nothing was said", async () => {
    const w = await up();
    const id = w.say("hello");
    await until(() => w.host.sent.length === 1);
    await w.assistant.restart();
    expect(w.brain.turns()).toEqual([
      ["assistant.prompted", { prompt: { kind: "user", message: id } }],
      ["assistant.replied", { text: "", prompt: { kind: "user", message: id }, interrupted: true }],
    ]);
    expect(w.assistant.busy).toBe(false);
    expect(status(w)).toBe("idle");
  });

  test("what an earlier daemon kept is gone on with, unless it was another account's or another harness's", async () => {
    const p = profile("codex", "work", { default: true });
    const kept = (saved: Json) => {
      const w = world({ profiles: [p] });
      keep(w, saved);
      w.assistant.start();
      return until(() => status(w) === "idle").then(() => w.host.starts);
    };
    expect(await kept({ harness: "codex", profile: p.id, native: "thread-kept", token: "t", port: PORT })).toEqual(["thread-kept"]);
    // a thread is no terminal's: the port it was kept under does not matter to it
    expect(await kept({ harness: "codex", profile: p.id, native: "thread-kept", token: "t", port: 1 })).toEqual(["thread-kept"]);
    expect(await kept({ harness: "codex", profile: newId("profile"), native: "thread-kept", token: "t", port: PORT })).toEqual([undefined]);
    expect(await kept({ harness: "claude", profile: p.id, native: "thread-kept", token: "t", port: PORT })).toEqual([undefined]);
    expect(await kept({ harness: "codex", profile: p.id, token: "t", port: PORT })).toEqual([undefined]);
  });
});

describe("going down", () => {
  test("stopped to be kept, its program is let go for the next daemon; stopped for good, it ends", async () => {
    const w = await up();
    w.say("hello");
    await until(() => w.host.sent.length === 1);
    await w.assistant.stop({ keep: true });
    expect([w.host.releases, w.host.stops]).toEqual([1, 0]);
    expect(status(w)).toBe("off");
    expect(w.assistant.busy).toBe(false);
    expect(w.assistant.mcpToken).toBeUndefined();
    expect(w.sessions.hooks).toBeUndefined();
    expect(w.brain.told("assistant.state").at(-1)).toMatchObject({ status: "off" });
    // what is known of it stays, for the next daemon to go on with
    expect(w.saved()!["native"]).toBe("thread-1");
    // nothing reaches it from here
    w.say("anyone?");
    await sleep(30);
    expect(w.host.sent).toHaveLength(1);
    expect(await w.assistant.part({ hook_event_name: "SessionStart", session_id: "thread-1" }, 1)).toEqual({});
    // a second stop is none
    await w.assistant.stop();
    expect([w.host.releases, w.host.stops]).toEqual([1, 0]);

    const gone = await up();
    await gone.assistant.stop();
    expect([gone.host.releases, gone.host.stops]).toEqual([0, 1]);
    expect(status(gone)).toBe("off");
  });

  test("stopped while it starts, the session that comes up is let go and never the chat's", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const w = world({ script: (host) => void (host.gate = gate) });
    w.assistant.start();
    await until(() => w.hosts.length === 1 && w.host.starts.length === 1);
    const stopping = w.assistant.stop();
    open();
    await stopping;
    expect([w.host.releases, w.host.stops]).toEqual([1, 0]);
    expect(status(w)).toBe("off");
    expect(w.assistant.mcpToken).toBeUndefined();
  });

  test("started again after a stop, it comes up as at first", async () => {
    const w = await up();
    await w.assistant.stop({ keep: true });
    w.assistant.start();
    await until(() => status(w) === "idle");
    expect(w.hosts[1]!.starts).toEqual(["thread-1"]);
    w.say("hello");
    await until(() => w.hosts[1]!.sent.length === 1);
  });
});

describe("a brain that comes back", () => {
  test("is told where the session stands again; with the same rules the session is left as it is", async () => {
    const w = await up();
    const before = w.brain.told("assistant.state").length;
    w.assistant.onBrainUp();
    await until(() => w.brain.of("assistant.setup").length === 2);
    await sleep(30);
    expect(w.brain.told("assistant.state").slice(before)).toEqual([{ status: "idle", harness: "codex", profile: w.profiles.all[0]!.id, model: "gpt-6.1-sol" }]);
    expect(w.hosts).toHaveLength(1);
    expect(w.host.stops).toBe(0);
  });

  test("with other rules the session is started again under them, where it was, once its turn has ended", async () => {
    const w = await up();
    w.say("hello");
    await until(() => w.host.sent.length === 1);
    w.brain.system = "You are Cophyla, as of today.";
    w.assistant.onBrainUp();
    await until(() => w.brain.of("assistant.setup").length === 2);
    await sleep(30);
    expect(w.hosts).toHaveLength(1);
    await w.host.reply("Hi.");
    await until(() => w.hosts.length === 2 && status(w) === "idle");
    expect(w.host.stops).toBe(1);
    expect(w.hosts[1]!.system).toBe("You are Cophyla, as of today.");
    expect(w.hosts[1]!.starts).toEqual(["thread-1"]);
    // the turn that ran was heard to its end, not cut
    expect(w.brain.turns().at(-1)![1]).toMatchObject({ text: "Hi." });
    expect(w.brain.turns().some(([, p]) => p["interrupted"] === true)).toBe(false);
  });

  test("with other rules and the session idle, it is started again at once", async () => {
    const w = await up();
    w.brain.system = "You are Cophyla, as of today.";
    w.assistant.onBrainUp();
    await until(() => w.hosts.length === 2 && status(w) === "idle");
    expect(w.hosts[1]!.system).toBe("You are Cophyla, as of today.");
    expect(w.hosts[1]!.starts).toEqual(["thread-1"]);
  });
});

describe("on Claude Code", () => {
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
  const EXPECTED = parts(LONG, CLAUDE_PART_CHARS);
  const told = (event: string, text: string) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

  test("the telling used here takes three parts", () => {
    expect(EXPECTED).toHaveLength(3);
  });

  test("it is the CLI started through the sessions module, its files written with the token of this spawn", async () => {
    const w = await up({ claude: true });
    const p = w.profiles.all[0]!;
    expect(w.hosts).toEqual([]);
    expect(w.sessions.spawns).toHaveLength(1);
    const spawn = w.sessions.spawns[0]!;
    const dir = join(w.dir, "assistant");
    expect(spawn.profile).toBe(p);
    expect(spawn.cwd).toBe(join(dir, "work"));
    expect(spawn.resume).toBeUndefined();
    expect(spawn.env).toEqual({ MCP_TOOL_TIMEOUT: "300000" });
    expect(spawn.args).toContain("--strict-mcp-config");
    expect(flag(spawn.args, "--mcp-config")).toBe(join(dir, "mcp.json"));
    expect(flag(spawn.args, "--settings")).toBe(join(dir, "settings.json"));
    expect(flag(spawn.args, "--model")).toBe("sonnet");
    expect(readFileSync(join(dir, "system.md"), "utf8")).toBe(`${RULES}\n`);
    const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")) as { mcpServers: { cophyla: { env: Json } } };
    expect(mcp.mcpServers.cophyla.env).toEqual({ COPHYLA_MCP_PORT: String(PORT), COPHYLA_MCP_TOKEN: w.assistant.mcpToken });
    const settings = readFileSync(join(dir, "settings.json"), "utf8");
    expect(settings).toContain(`http://127.0.0.1:${PORT}/hooks/assistant-part-1`);
    expect(settings).toContain("Bearer hook-token");
    expect(settings).toContain(p.id);
    // where it stands names its terminal, for the pane that opens it
    expect(w.assistant.state()).toEqual({ status: "idle", harness: "claude", model: "sonnet", effort: "low", profile: p.id, terminal: { host: "host-1", id: "t1" } });
    expect(w.saved()).toEqual({ harness: "claude", profile: p.id, native: "native-1", token: w.assistant.mcpToken, port: PORT, rules: await rulesName() });
    expect(w.sessions.hooks).toBeDefined();
  });

  test("its start is told the situation whole, in parts: the first with the hook's own answer, the rest as each is asked for", async () => {
    const w = await up({ claude: true });
    w.brain.context = () => ({ text: LONG, seq: 3 });
    const answer = await w.sessions.hooks!.hook(hook("SessionStart", "native-1", { source: "startup" }), {});
    expect(answer).toEqual(told("SessionStart", EXPECTED[0]!));
    expect(w.brain.asked.at(-1)).toEqual({ method: "assistant.context", params: { kind: "start", source: "startup" }, timeoutMs: 500 });
    const body = { hook_event_name: "SessionStart", session_id: "native-1", source: "startup" };
    expect(await w.assistant.part(body, 1)).toEqual(told("SessionStart", EXPECTED[1]!));
    expect(await w.assistant.part(body, 2)).toEqual(told("SessionStart", EXPECTED[2]!));
    // a hook installed for a part there is none of answers nothing
    expect(await w.assistant.part(body, 3)).toEqual({});
    // a start is no prompt: the brain hears of no turn, and the session is idle still
    expect(w.brain.turns()).toEqual([]);
    expect(w.assistant.busy).toBe(false);
    // the telling that reached it is named in the next ask
    await w.sessions.hooks!.hook(hook("SessionStart", "native-1", { source: "compact" }), {});
    expect(w.brain.of("assistant.context").at(-1)).toEqual({ kind: "start", source: "compact", have: 3 });
  });

  test("a start with nothing to tell, or a brain that does not say, answers the hook with nothing", async () => {
    const w = await up({ claude: true });
    expect(await w.sessions.hooks!.hook(hook("SessionStart", "native-1", { source: "resume" }), {})).toEqual({});
    w.brain.failing = new RpcError("timeout", "no answer in 500 ms");
    expect(await w.sessions.hooks!.hook(hook("SessionStart", "native-1"), {})).toEqual({});
    // with no source said, it is a start from nothing
    expect(w.brain.of("assistant.context").at(-1)).toEqual({ kind: "start", source: "startup" });
  });

  test("a part asked for before the hook itself was answered waits for it", async () => {
    const w = await up({ claude: true });
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    w.brain.context = async () => {
      await gate;
      return { text: LONG };
    };
    const body = { hook_event_name: "SessionStart", session_id: "native-1" };
    const second = w.assistant.part(body, 1);
    const first = w.sessions.hooks!.hook(hook("SessionStart", "native-1", { source: "startup" }), {});
    const third = w.assistant.part(body, 2);
    open();
    expect(await first).toEqual(told("SessionStart", EXPECTED[0]!));
    expect(await second).toEqual(told("SessionStart", EXPECTED[1]!));
    expect(await third).toEqual(told("SessionStart", EXPECTED[2]!));
  });

  test("a user's message is typed into its terminal as theirs, and what is told beside it comes with its prompt, in parts", async () => {
    const w = await up({ claude: true });
    const live = w.sessions.live!;
    const id = w.say("what is open?");
    await until(() => w.sessions.sends.length === 1);
    expect(w.sessions.sends[0]).toEqual({ id: live.id, text: "what is open?", opts: { from: "user" }, part: ASSISTANT_PART });
    // typed, not yet submitted: no turn
    expect(w.assistant.busy).toBe(false);
    w.brain.context = () => ({ text: LONG, seq: 4 });
    const answer = await w.sessions.hooks!.hook(hook("UserPromptSubmit", "native-1", { prompt: "what is open?", promptId: "p-1" }), { ref: "cophylad-1" });
    expect(answer).toEqual(told("UserPromptSubmit", EXPECTED[0]!));
    expect(w.brain.turns()).toEqual([["assistant.prompted", { prompt: { kind: "user", message: id } }]]);
    expect(w.assistant.busy).toBe(true);
    const body = { hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt_id: "p-1", prompt: "what is open?" };
    expect(await w.assistant.part(body, 1)).toEqual(told("UserPromptSubmit", EXPECTED[1]!));
    expect(await w.assistant.part(body, 2)).toEqual(told("UserPromptSubmit", EXPECTED[2]!));
    // its turn ends with the words its Stop hook carries
    expect(await w.sessions.hooks!.hook(hook("Stop", "native-1", { lastAssistantMessage: "Two sessions are open." }), {})).toEqual({});
    expect(w.brain.turns().at(-1)).toEqual(["assistant.replied", { text: "Two sessions are open.", prompt: { kind: "user", message: id } }]);
    expect(w.assistant.busy).toBe(false);
    expect(w.typed).toEqual([]);
  });

  test("words typed straight into its terminal are stored as the user's message, and not typed again", async () => {
    const w = await up({ claude: true });
    await w.sessions.hooks!.hook(hook("UserPromptSubmit", "native-1", { prompt: "and the tasks?", promptId: "p-2" }), {});
    expect(w.typed).toEqual([{ text: "and the tasks?", source: "ui", id: expect.any(String) }]);
    expect(w.brain.turns()).toEqual([["assistant.prompted", { prompt: { kind: "user", message: w.typed[0]!.id } }]]);
    await sleep(30);
    expect(w.sessions.sends).toEqual([]);
  });

  test("what was pasted there is stored without the tags the harness puts round it; a paste of nothing is no message", async () => {
    const w = await up({ claude: true });
    const pasted = '\n\n<pasted_content id="d39b">\nthe log says:\n  error: no such file\n</pasted_content id="d39b">\n';
    await w.sessions.hooks!.hook(hook("UserPromptSubmit", "native-1", { prompt: pasted, promptId: "p-3" }), {});
    expect(w.typed.map((t) => t.text)).toEqual(["the log says:\n  error: no such file"]);
    expect(w.brain.turns()).toEqual([["assistant.prompted", { prompt: { kind: "user", message: w.typed[0]!.id } }]]);
    await w.sessions.hooks!.hook(hook("Stop", "native-1", { lastAssistantMessage: "It is gone." }), {});
    await w.sessions.hooks!.hook(hook("UserPromptSubmit", "native-1", { prompt: '<pasted_content id="e1">\n\n</pasted_content id="e1">', promptId: "p-4" }), {});
    await w.sessions.hooks!.hook(hook("UserPromptSubmit", "native-1", { prompt: "   \n", promptId: "p-5" }), {});
    expect(w.typed).toHaveLength(1);
    expect(w.brain.turns().slice(-2)).toEqual([
      ["assistant.prompted", { prompt: { kind: "terminal" } }],
      ["assistant.prompted", { prompt: { kind: "terminal" } }],
    ]);
  });

  test("a command of the harness's own typed there is no message, and the /clear cophylad types is no prompt at all", async () => {
    const w = await up({ claude: true });
    const asked = w.brain.asked.length;
    // what cophylad typed that is no prompt of the chat's: nothing is told beside it, and the brain hears of no turn
    expect(await w.sessions.hooks!.hook(hook("UserPromptSubmit", "native-1", { prompt: "/clear" }), { ref: "cophylad-9" })).toEqual({});
    expect(w.brain.turns()).toEqual([]);
    expect(w.brain.asked.length).toBe(asked);
    expect(w.assistant.busy).toBe(false);
    // what the user typed there themselves is a turn, of no message
    await w.sessions.hooks!.hook(hook("UserPromptSubmit", "native-1", { prompt: "  /compact" }), {});
    expect(w.brain.turns()).toEqual([["assistant.prompted", { prompt: { kind: "terminal" } }]]);
    expect(w.typed).toEqual([]);
    expect(w.assistant.busy).toBe(true);
  });

  test("a tool of the harness's own is a step to the brain; Cophyla's own are not; another harness's hook is none of its", async () => {
    const w = await up({ claude: true });
    await w.sessions.hooks!.hook(hook("PostToolUse", "native-1", { toolName: "Read", toolInput: { file_path: "notes.md" } }), {});
    await w.sessions.hooks!.hook(hook("PostToolUseFailure", "native-1", { toolName: "WebFetch", toolInput: { url: "https://example.com" } }), {});
    await w.sessions.hooks!.hook(hook("PostToolUse", "native-1", { toolName: "mcp__cophyla__agents", toolInput: {} }), {});
    expect(w.brain.turns()).toEqual([
      ["assistant.step", { tool: "Read", input: { file_path: "notes.md" } }],
      ["assistant.step", { tool: "WebFetch", input: { url: "https://example.com" } }],
    ]);
    expect(await w.sessions.hooks!.hook({ ...hook("UserPromptSubmit", "native-1", { prompt: "hello" }), harness: "codex" }, {})).toEqual({});
    expect(await w.sessions.hooks!.hook(hook("Notification", "native-1", { message: "idle" }), {})).toEqual({});
    expect(w.brain.turns()).toHaveLength(2);
  });

  test("a user's message during a wake's turn is typed into it, words typed by hand join it too, and the turn's end is the wake's", async () => {
    const w = await up({ claude: true });
    const live = w.sessions.live!;
    w.assistant.wake({ id: "w1", text: "The build finished." });
    await until(() => w.sessions.sends.length === 1);
    await w.sessions.hooks!.hook(hook("UserPromptSubmit", "native-1", { prompt: "The build finished." }), { ref: "cophylad-1" });
    expect(w.brain.turns()).toEqual([["assistant.prompted", { prompt: { kind: "wake", wake: "w1" } }]]);
    const id = w.say("wait");
    await until(() => w.sessions.sends.length === 2);
    // typed as any message of theirs: nothing else was asked of the session's terminal
    expect(w.sessions.sends[1]).toEqual({ id: live.id, text: "wait", opts: { from: "user" }, part: ASSISTANT_PART });
    await w.sessions.hooks!.hook(hook("UserPromptSubmit", "native-1", { prompt: "wait" }), { ref: "cophylad-2" });
    await w.sessions.hooks!.hook(hook("UserPromptSubmit", "native-1", { prompt: "and one by hand" }), {});
    await w.sessions.hooks!.hook(hook("Stop", "native-1", { lastAssistantMessage: "The build is done; waiting." }), {});
    expect(w.brain.turns()).toEqual([
      ["assistant.prompted", { prompt: { kind: "wake", wake: "w1" } }],
      ["assistant.prompted", { prompt: { kind: "user", message: id } }],
      ["assistant.prompted", { prompt: { kind: "user", message: w.typed[0]!.id } }],
      ["assistant.replied", { text: "The build is done; waiting.", prompt: { kind: "wake", wake: "w1" } }],
    ]);
    expect(w.typed.map((t) => t.text)).toEqual(["and one by hand"]);
    expect(w.sessions.stops).toEqual([]);
  });

  test("a new thread's clear is typed into its terminal once its turn has ended", async () => {
    const w = await up({ claude: true });
    const live = w.sessions.live!;
    w.say("hello");
    await until(() => w.sessions.sends.length === 1);
    await w.sessions.hooks!.hook(hook("UserPromptSubmit", "native-1", { prompt: "hello" }), { ref: "cophylad-1" });
    w.open();
    await sleep(30);
    expect(w.sessions.sends).toHaveLength(1);
    await w.sessions.hooks!.hook(hook("Stop", "native-1", { lastAssistantMessage: "Hi." }), {});
    await until(() => w.sessions.sends.length === 2);
    expect(w.sessions.sends[1]).toEqual({ id: live.id, text: "", opts: { from: "user", clear: true }, part: ASSISTANT_PART });
    // its start over tells it the situation whole, and its context is fresh again: the next thread has nothing to clear
    await w.sessions.hooks!.hook(hook("SessionStart", "native-2", { source: "clear" }), {});
    expect(w.brain.of("assistant.context").at(-1)).toMatchObject({ kind: "start", source: "clear" });
    await tick();
    w.open();
    await sleep(30);
    expect(w.sessions.sends).toHaveLength(2);
  });

  test("its row as it changes: its size is told, a new id after a clear is kept, and its end starts it again where it was", async () => {
    const w = await up({ claude: true });
    const live = w.sessions.live!;
    expect(w.assistant.state().context).toBeUndefined();
    // what it holds is what its transcript's last turn counted, read from the sessions module as its row moves
    w.sessions.context = 41_000;
    w.sessions.hooks!.changed({ ...live, lastActivity: 2, stats: { turns: 1, cost: 0, tokens: { in: 1200, out: 800 }, context: { used: 9_000, limit: 200_000 } } });
    // against the size configured, where a Claude session is folded
    expect(w.assistant.state().context).toEqual({ used: 41_000, limit: 300_000 });
    expect(w.states.at(-1)!.context).toEqual({ used: 41_000, limit: 300_000 });
    const cleared = { ...live, native: { ...live.native, id: "native-after-clear" } };
    w.sessions.hooks!.changed(cleared);
    expect(w.saved()!["native"]).toBe("native-after-clear");
    // the row of a session that is not it changes nothing
    w.sessions.hooks!.changed({ ...live, id: newId("session"), status: "ended" });
    expect(status(w)).toBe("idle");
    w.sessions.live = undefined;
    w.sessions.hooks!.changed({ ...cleared, status: "ended", endedAt: 5 });
    await until(() => w.sessions.spawns.length === 2 && status(w) === "idle");
    expect(w.sessions.spawns[1]!.resume).toBe("native-after-clear");
    expect(w.states.map((s) => s.status)).toContain("down");
  });

  test("the session of an earlier daemon, still in its terminal, is met again as it is, under the token it was started with", async () => {
    const p = profile("claude", "personal", { default: true });
    const w = world({ claude: true, profiles: [p] });
    const live = session(p.id, "native-kept", join(w.dir, "assistant", "work"), "t-kept");
    w.sessions.live = live;
    keep(w, { harness: "claude", profile: p.id, native: "native-kept", token: "kept-token", port: PORT, rules: await rulesName() });
    w.assistant.start();
    await until(() => status(w) === "idle");
    await sleep(30);
    expect(w.sessions.spawns).toEqual([]);
    expect(w.sessions.stops).toEqual([]);
    expect(w.assistant.mcpToken).toBe("kept-token");
    expect(w.assistant.state().terminal).toEqual({ host: "host-1", id: "t-kept" });
    w.say("hello");
    await until(() => w.sessions.sends.length === 1);
    expect(w.sessions.sends[0]!.id).toBe(live.id);
  });

  test("met again mid-turn, it is busy until that turn ends, and its words are told", async () => {
    const p = profile("claude", "personal", { default: true });
    const w = world({ claude: true, profiles: [p] });
    w.sessions.live = session(p.id, "native-kept", join(w.dir, "assistant", "work"), "t-kept", { status: "busy" });
    keep(w, { harness: "claude", profile: p.id, native: "native-kept", token: "kept-token", port: PORT, rules: await rulesName() });
    w.assistant.start();
    await until(() => status(w) === "busy");
    expect(w.assistant.busy).toBe(true);
    expect(w.sessions.spawns).toEqual([]);
    await w.sessions.hooks!.hook(hook("Stop", "native-kept", { lastAssistantMessage: "Done." }), {});
    expect(w.brain.turns()).toEqual([["assistant.replied", { text: "Done.", prompt: { kind: "terminal" } }]]);
    expect(status(w)).toBe("idle");
    await sleep(30);
    expect(w.sessions.spawns).toEqual([]);
  });

  test("met again under rules the brain no longer has, or kept by a daemon that named none, it is started again where it was", async () => {
    const p = profile("claude", "personal", { default: true });
    for (const rules of [{ rules: "0ther" }, {}]) {
      const w = world({ claude: true, profiles: [p] });
      const live = session(p.id, "native-kept", join(w.dir, "assistant", "work"), "t-kept");
      w.sessions.live = live;
      keep(w, { harness: "claude", profile: p.id, native: "native-kept", token: "kept-token", port: PORT, ...rules });
      w.assistant.start();
      await until(() => w.sessions.spawns.length === 1 && status(w) === "idle");
      // the one met is ended, and the conversation goes on in another, under a token of its own
      expect(w.sessions.stops).toEqual([{ id: live.id, opts: { as: "brain" }, part: ASSISTANT_PART }]);
      expect(w.sessions.spawns[0]!.resume).toBe("native-kept");
      expect(w.assistant.mcpToken).not.toBe("kept-token");
      expect(w.saved()).toMatchObject({ native: "native-kept", rules: await rulesName() });
      // once: the one started under the brain's rules stays
      await sleep(30);
      expect(w.sessions.spawns).toHaveLength(1);
    }
  });

  test("met again mid-turn under other rules, it is started again only once that turn has ended", async () => {
    const p = profile("claude", "personal", { default: true });
    const w = world({ claude: true, profiles: [p] });
    w.sessions.live = session(p.id, "native-kept", join(w.dir, "assistant", "work"), "t-kept", { status: "busy" });
    keep(w, { harness: "claude", profile: p.id, native: "native-kept", token: "kept-token", port: PORT, rules: "0ther" });
    w.assistant.start();
    await until(() => status(w) === "busy");
    await sleep(30);
    expect(w.sessions.spawns).toEqual([]);
    expect(w.assistant.mcpToken).toBe("kept-token");
    await w.sessions.hooks!.hook(hook("Stop", "native-kept", { lastAssistantMessage: "Done." }), {});
    await until(() => w.sessions.spawns.length === 1 && status(w) === "idle");
    expect(w.sessions.spawns[0]!.resume).toBe("native-kept");
    // its turn was heard to its end, not cut
    expect(w.brain.turns()).toEqual([["assistant.replied", { text: "Done.", prompt: { kind: "terminal" } }]]);
  });

  test("one whose hooks and tool server name another port is ended and started again where it was; another account's is ended and left behind", async () => {
    const p = profile("claude", "personal", { default: true });
    const rules = await rulesName();
    const met = async (saved: Json) => {
      const w = world({ claude: true, profiles: [p] });
      const live = session(p.id, "native-kept", join(w.dir, "assistant", "work"), "t-kept");
      w.sessions.live = live;
      keep(w, saved);
      w.assistant.start();
      await until(() => status(w) === "idle");
      expect(w.sessions.stops).toEqual([{ id: live.id, opts: { as: "brain" }, part: ASSISTANT_PART }]);
      expect(w.sessions.spawns).toHaveLength(1);
      expect(w.assistant.mcpToken).not.toBe("kept-token");
      return w.sessions.spawns[0]!.resume;
    };
    expect(await met({ harness: "claude", profile: p.id, native: "native-kept", token: "kept-token", port: PORT + 1, rules })).toBe("native-kept");
    expect(await met({ harness: "claude", profile: newId("profile"), native: "native-kept", token: "kept-token", port: PORT, rules })).toBeUndefined();
  });

  test("stopped for good, its program is ended through the sessions module; stopped to be kept, nothing is asked of it", async () => {
    const w = await up({ claude: true });
    const live = w.sessions.live!;
    await w.assistant.stop();
    expect(w.sessions.stops).toEqual([{ id: live.id, opts: { as: "brain" }, part: ASSISTANT_PART }]);
    expect(w.sessions.hooks).toBeUndefined();
    const kept = await up({ claude: true });
    await kept.assistant.stop({ keep: true });
    expect(kept.sessions.stops).toEqual([]);
    expect(kept.sessions.live).toBeDefined();
  });

  test("a hook that carries no part is answered nothing at once; a part of a telling nobody began, once its wait is up", async () => {
    const w = await up({ claude: true });
    const began = Date.now();
    expect(await w.assistant.part({ hook_event_name: "PostToolUse", session_id: "native-1" }, 1)).toEqual({});
    expect(await w.assistant.part({}, 1)).toEqual({});
    expect(await w.assistant.part(undefined, 1)).toEqual({});
    expect(await w.assistant.part("not a hook", 1)).toEqual({});
    expect(Date.now() - began).toBeLessThan(1000);
    // a prompt whose own hook never came: the session is not kept waiting past the hook's time
    expect(await w.assistant.part({ hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt_id: "p-9", prompt: "never seen" }, 1)).toEqual({});
    expect(Date.now() - began).toBeGreaterThan(3000);
    expect(Date.now() - began).toBeLessThan(8000);
  }, 15_000);
});
