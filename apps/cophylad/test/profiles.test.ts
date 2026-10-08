// Profile discovery: the harness's own directory is always a profile, the directory the
// daemon's environment names is a second one when it is another, and a declared profile on a
// discovered directory wins. A login file that changes rebuilds them, and nothing else does.

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@cophyla/protocol";
import { parseConfig } from "../src/config/load.ts";
import { silentLogger } from "../src/log.ts";
import { CLAUDE_KEYCHAIN_SERVICE, claudeKeychainServices, Profiles, profileKey } from "../src/sessions/profiles.ts";
import type { ProfileChange } from "../src/sessions/profiles.ts";
import { Store } from "../src/store/index.ts";
import { tempHome, tomlString } from "./helpers.ts";

/** The machine's own Keychain is never asked: a Mac signed in to Claude would count every profile. */
const noKeychain = () => false;

function profiles(toml: string, env: Record<string, string | undefined>, home: string): Profiles {
  const store = new Store(":memory:");
  store.migrate();
  return new Profiles({ store, nodeId: newId("node"), config: parseConfig(toml), log: silentLogger, home, env, keychainHas: noKeychain });
}

describe("profiles", () => {
  test("discovery: the harness's own directory always, plus the one the environment names when it is another", () => {
    const home = tempHome();
    const own = join(home, ".claude");
    const other = join(home, "accounts", "extra");
    mkdirSync(own, { recursive: true });
    mkdirSync(other, { recursive: true });

    const plain = profiles("", {}, home).byHarness("claude");
    expect(plain.map((p) => [p.name, p.configDir.toLowerCase(), p.origin, p.default ?? false])).toEqual([["default", own.toLowerCase(), "discovered", true]]);

    const pointed = profiles("", { CLAUDE_CONFIG_DIR: other }, home).byHarness("claude");
    expect(pointed.map((p) => [p.name, p.configDir.toLowerCase(), p.origin, p.default ?? false])).toEqual([
      ["default", own.toLowerCase(), "discovered", true],
      ["extra", other.toLowerCase(), "discovered", false],
    ]);

    // The same directory under another spelling is one profile, not two.
    const same = profiles("", { CLAUDE_CONFIG_DIR: join(home, ".", ".claude") }, home).byHarness("claude");
    expect(same).toHaveLength(1);
  });

  test("Muse: its config home is discovered, signed in by a Meta login in auth.json, and a declared one is its XDG homes", () => {
    const home = tempHome();
    const own = join(home, ".config", "muse");
    const found = () => profiles("", {}, home).byHarness("muse");
    expect(found().map((p) => [p.name, p.configDir.toLowerCase(), p.status])).toEqual([["default", own.toLowerCase(), "missing"]]);
    mkdirSync(own, { recursive: true });
    expect(found()[0]!.status).toBe("unauthenticated");
    writeFileSync(join(own, "auth.json"), JSON.stringify({ schema_version: 1, providers: {} }));
    expect(found()[0]!.status).toBe("unauthenticated");
    writeFileSync(join(own, "auth.json"), JSON.stringify({ schema_version: 1, providers: { meta: { access_token: "x" } } }));
    expect(found()[0]!.status).toBe("ok");
    expect(found()[0]!.env).toEqual({});
    // XDG_CONFIG_HOME moves the discovered home, as it moves Muse's own.
    const xdg = join(home, "xdg");
    expect(profiles("", { XDG_CONFIG_HOME: xdg }, home).byHarness("muse")[0]!.configDir.toLowerCase()).toBe(join(xdg, "muse").toLowerCase());
    const work = join(home, "work", "config", "muse");
    const declared = profiles(`[sessions]\ndiscover = false\n\n[[profiles]]\nharness = "muse"\nname = "work"\nconfig_dir = ${tomlString(work)}\nenv = { XDG_DATA_HOME = ${tomlString(join(home, "work", "data"))} }\n`, {}, home).byHarness("muse");
    expect(declared.map((p) => [p.name, p.origin, p.env])).toEqual([["work", "user", { XDG_CONFIG_HOME: join(home, "work", "config"), XDG_DATA_HOME: join(home, "work", "data") }]]);
    expect(declared[0]!.default).toBe(true);
    expect(declared[0]!.launch).toBeUndefined();
  });

  test("the kv key that pins a profile id keeps its shape: the resolved directory, lower-cased on Windows, the host's separators", () => {
    // Existing installs hold `profiles/<key> -> prof_…` in kv; a changed key would mint new ids and orphan every session.
    const dir = join(tempHome(), "Accounts", "Extra");
    const expected = process.platform === "win32" ? dir.toLowerCase() : process.platform === "darwin" ? dir.toLowerCase() : dir;
    expect(profileKey("claude", dir)).toBe(`claude:${expected}`);
    expect(profileKey("codex", join(dir, ".", "..", "Extra"))).toBe(`codex:${expected}`);
    const store = new Store(":memory:");
    store.migrate();
    const p = new Profiles({ store, nodeId: newId("node"), config: parseConfig(`[[profiles]]\nharness = "claude"\nname = "x"\nconfig_dir = ${tomlString(dir)}\n`), log: silentLogger, home: tempHome(), env: {}, keychainHas: noKeychain });
    expect(store.kv.get("profiles", `claude:${expected}`)).toBe(p.byHarness("claude").find((x) => x.name === "x")!.id);
  });

  test("a Claude profile's Keychain item is its own: the unset name for ~/.claude, a hash of the directory for any other", () => {
    // Claude Code 2.1.283's rule: `-` and the first 8 hex digits of sha256(CLAUDE_CONFIG_DIR)
    const hash = (v: string) => new Bun.CryptoHasher("sha256").update(v).digest("hex").slice(0, 8);
    expect(claudeKeychainServices("/Users/u/.claude-accounts/extra", "/Users/u/.claude-accounts/extra", false)).toEqual([
      `Claude Code-credentials-${hash("/Users/u/.claude-accounts/extra")}`,
      `Claude Code-credentials-${hash("/Users/u/.claude-accounts/extra/")}`,
    ]);
    expect(claudeKeychainServices("~/x/../y", "/Users/u/y", false)).toHaveLength(3);
    expect(claudeKeychainServices("/Users/u/.claude", "/Users/u/.claude", true)[0]).toBe("Claude Code-credentials");

    const home = tempHome();
    const extra = join(home, ".claude-accounts", "extra");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
    writeFileSync(join(extra, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
    const build = (items: string[]) => {
      const store = new Store(":memory:");
      store.migrate();
      const toml = `[[profiles]]\nharness = "claude"\nname = "extra"\nconfig_dir = ${tomlString(extra)}\n`;
      return new Profiles({ store, nodeId: newId("node"), config: parseConfig(toml), log: silentLogger, home, env: {}, platform: "darwin", keychainHas: (s) => items.includes(s) });
    };
    const statusOf = (p: Profiles) => Object.fromEntries(p.byHarness("claude").map((x) => [x.name, x.status]));
    // only the usual account signed in: the second is not
    expect(statusOf(build([CLAUDE_KEYCHAIN_SERVICE]))).toMatchObject({ extra: "unauthenticated" });
    // the second signed in under its own item
    const own = `Claude Code-credentials-${hash(extra)}`;
    const both = statusOf(build([own]));
    expect(both["extra"]).toBe("ok");
  });

  test("on darwin a Keychain item counts as a login; elsewhere the Keychain is never asked", () => {
    const home = tempHome();
    const own = join(home, ".claude");
    mkdirSync(own, { recursive: true });
    const asked: string[] = [];
    const build = (platform: NodeJS.Platform, has: boolean) => {
      const store = new Store(":memory:");
      store.migrate();
      return new Profiles({
        store,
        nodeId: newId("node"),
        config: parseConfig(""),
        log: silentLogger,
        home,
        env: {},
        platform,
        keychainHas: (service) => {
          asked.push(service);
          return has;
        },
      });
    };
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
    expect(build("darwin", true).byHarness("claude")[0]!.status).toBe("ok");
    expect(asked).toEqual([CLAUDE_KEYCHAIN_SERVICE]);
    expect(build("darwin", false).byHarness("claude")[0]!.status).toBe("unauthenticated");
    asked.length = 0;
    expect(build("linux", true).byHarness("claude")[0]!.status).toBe("unauthenticated");
    expect(build("win32", true).byHarness("claude")[0]!.status).toBe("unauthenticated");
    expect(asked).toEqual([]);
    // a credentials file or a token in the environment still wins without the Keychain
    writeFileSync(join(own, ".credentials.json"), "{}");
    expect(build("linux", false).byHarness("claude")[0]!.status).toBe("ok");
  });

  test("a declared profile on the environment's directory replaces the discovered one and keeps its name", () => {
    const home = tempHome();
    const other = join(home, "accounts", "extra");
    mkdirSync(other, { recursive: true });
    const list = profiles(`[[profiles]]\nharness = "claude"\nname = "work"\nconfig_dir = ${tomlString(other)}\ndefault = true\n`, { CLAUDE_CONFIG_DIR: other }, home).byHarness("claude");
    expect(list.map((p) => [p.name, p.origin, p.default ?? false])).toEqual([
      ["default", "discovered", false],
      ["work", "user", true],
    ]);
  });
});

/** A home with Claude's own directory and a second account, both signed in and onboarded. */
function twoAccounts(): { home: string; own: string; work: string; toml: string } {
  const home = tempHome();
  const own = join(home, ".claude");
  const work = join(home, "accounts", "work");
  for (const dir of [own, work]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), "{}");
  }
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
  writeFileSync(join(work, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
  return { home, own, work, toml: `[[profiles]]\nharness = "claude"\nname = "work"\nconfig_dir = ${tomlString(work)}\n` };
}

function build(toml: string, home: string, store = new Store(":memory:"), nodeId = newId("node")): { p: Profiles; store: Store; nodeId: string } {
  store.migrate();
  return { p: new Profiles({ store, nodeId, config: parseConfig(toml), log: silentLogger, home, env: {}, keychainHas: noKeychain }), store, nodeId };
}

function userSession(store: Store, node: string, profile: string, startedAt: number, origin: "user" | "orchestrator" = "user"): void {
  store.sessions.insert({
    id: newId("session", startedAt),
    node,
    harness: "claude",
    profile,
    native: { id: `n-${startedAt}`, transport: "pipe" },
    origin,
    cwd: "/w",
    tags: [],
    status: "ended",
    startedAt,
    lastActivity: startedAt,
  });
}

describe("what Claude will show", () => {
  test("a login counts only with a global config that went through the first run: ~/.claude.json for Claude's own directory, <dir>/.claude.json for another", () => {
    const { home, own, work, toml } = twoAccounts();
    const status = () => Object.fromEntries(build(toml, home).p.byHarness("claude").map((x) => [x.name, x.status]));
    expect(status()).toEqual({ default: "ok", work: "ok" });
    // `~/.claude/.claude.json` is what Claude reads only when CLAUDE_CONFIG_DIR names ~/.claude: not the one that counts.
    writeFileSync(join(own, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 3 }));
    expect(status()).toEqual({ default: "unauthenticated", work: "ok" });
    writeFileSync(join(work, ".claude.json"), "{ not json");
    expect(status()).toEqual({ default: "unauthenticated", work: "unauthenticated" });
  });

  test("Claude's own directory is never named to it: not by discovery, and not by a profile that declares it", () => {
    const { home, own, work } = twoAccounts();
    const toml = `[[profiles]]\nharness = "claude"\nname = "own"\nconfig_dir = ${tomlString(own)}\n\n[[profiles]]\nharness = "claude"\nname = "work"\nconfig_dir = ${tomlString(work)}\nenv = { X = "1" }\n`;
    const list = build(toml, home).p.byHarness("claude");
    expect(list.find((x) => x.name === "own")!.env).toEqual({});
    expect(list.find((x) => x.name === "work")!.env).toEqual({ CLAUDE_CONFIG_DIR: work, X: "1" });
  });
});

describe("the account a profile is signed in as", () => {
  // Each reading is another home, as another machine is: the same login there has the same mark.
  test("Claude: its account in its organisation, from the global config, the same in any home signed in as it; none without a login", () => {
    const mark = (oauthAccount: object | undefined, signedIn = true) => {
      const home = tempHome();
      mkdirSync(join(home, ".claude"), { recursive: true });
      if (signedIn) writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
      writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, ...(oauthAccount ? { oauthAccount } : {}) }));
      return build("", home).p.byHarness("claude")[0]!.account;
    };
    const ann = { accountUuid: "acct-1", organizationUuid: "org-1", emailAddress: "ann@example.com", displayName: "Ann" };
    const first = mark(ann);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(mark({ ...ann, displayName: "Annie", profileFetchedAt: 5 })).toBe(first);
    // the same person in another organisation is another subscription
    expect(mark({ ...ann, organizationUuid: "org-2" })).not.toBe(first);
    expect(mark({ ...ann, accountUuid: "acct-2" })).not.toBe(first);
    expect(mark(ann, false)).toBeUndefined();
    expect(mark(undefined)).toBeUndefined();
  });

  test("Codex: its ChatGPT account and the user in it, from auth.json; a key has none", () => {
    const jwt = (claims: object) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
    const login = (account: string, user: string) => ({ auth_mode: "chatgpt", tokens: { account_id: account, id_token: jwt({ sub: "auth0|x", "https://api.openai.com/auth": { chatgpt_user_id: user } }), access_token: "a", refresh_token: "r" } });
    const mark = (auth: object) => {
      const home = tempHome();
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify(auth));
      return build("", home).p.byHarness("codex")[0]!.account;
    };
    const first = mark(login("ws-1", "user-1"));
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(mark(login("ws-1", "user-1"))).toBe(first);
    // a team's workspace is shared, its limits are each user's
    expect(mark(login("ws-1", "user-2"))).not.toBe(first);
    expect(mark({ OPENAI_API_KEY: "sk-x", tokens: null })).toBeUndefined();
  });
});

describe("the usual account", () => {
  test("picked in the app, else config, else the profile of the user's latest own session, else the discovered one", () => {
    const { home, toml } = twoAccounts();
    const { p, store, nodeId } = build(toml, home);
    const id = (name: string) => p.byHarness("claude").find((x) => x.name === name)!.id;
    const usual = () => p.byHarness("claude").filter((x) => x.default).map((x) => [x.name, x.defaultBy]);
    expect(usual()).toEqual([["default", "discovered"]]);
    expect(p.byHarness("claude").filter((x) => x.automatic).map((x) => [x.name, x.automatic])).toEqual([["default", "discovered"]]);
    // The latest session the user started, not one cophylad started, and not another node's.
    userSession(store, nodeId, id("work"), 2000);
    userSession(store, nodeId, id("default"), 1000);
    userSession(store, nodeId, id("default"), 3000, "orchestrator");
    userSession(store, newId("node"), id("default"), 4000);
    expect(usual()).toEqual([["work", "recent"]]);
    expect(p.defaultFor("claude")!.name).toBe("work");
    userSession(store, nodeId, id("default"), 5000);
    expect(usual()).toEqual([["default", "recent"]]);
    p.update(id("work"), { usual: true });
    expect(usual()).toEqual([["work", "you"]]);
    expect(p.defaultFor("claude")!.name).toBe("work");
    // What Automatic would pick is named all the same, for the app to show beside the choice.
    expect(p.byHarness("claude").filter((x) => x.automatic).map((x) => [x.name, x.automatic])).toEqual([["default", "recent"]]);
    // Back to automatic; unmarking a profile that is not the picked one changes nothing.
    p.update(id("default"), { usual: false });
    expect(usual()).toEqual([["work", "you"]]);
    p.update(id("work"), { usual: null });
    expect(usual()).toEqual([["default", "recent"]]);
    const declared = build(`${toml}default = true\n`, home, store, nodeId).p;
    expect(declared.byHarness("claude").filter((x) => x.default).map((x) => [x.name, x.defaultBy])).toEqual([["work", "config"]]);
  });

  test("with discovery off the first declared profile stands", () => {
    const { home, toml } = twoAccounts();
    const list = build(`[sessions]\ndiscover = false\n\n${toml}`, home).p.byHarness("claude");
    expect(list.map((x) => [x.name, x.default ?? false, x.defaultBy])).toEqual([["work", true, "config"]]);
  });
});

describe("login files, looked at", () => {
  test("check() rebuilds when a harness is installed or signed in, and says what changed", () => {
    const home = tempHome();
    const claude = join(home, ".claude");
    const codex = join(home, ".codex");
    mkdirSync(claude, { recursive: true });
    const p = profiles("", {}, home);
    const changes: ProfileChange[] = [];
    p.onChange((c) => changes.push(c));
    const one = (h: "claude" | "codex") => p.byHarness(h)[0]!;
    expect([one("claude").status, one("codex").status]).toEqual(["unauthenticated", "missing"]);
    p.check();
    expect(changes).toEqual([]);
    // Codex installed: its directory is there, with no login yet.
    mkdirSync(codex, { recursive: true });
    p.check();
    expect(changes).toEqual([{ added: [], removed: [], status: [{ id: one("codex").id, from: "missing", to: "unauthenticated" }], login: [] }]);
    writeFileSync(join(codex, "auth.json"), "{}");
    p.check();
    expect(changes[1]).toEqual({ added: [], removed: [], status: [{ id: one("codex").id, from: "unauthenticated", to: "ok" }], login: [one("codex").id] });
    // A login again: the status stays, the login changed.
    writeFileSync(join(codex, "auth.json"), JSON.stringify({ tokens: "new" }));
    p.check();
    expect(changes[2]).toEqual({ added: [], removed: [], status: [], login: [one("codex").id] });
    // Claude counts with its credentials and a global config that went through the first run.
    writeFileSync(join(claude, ".credentials.json"), "{}");
    p.check();
    expect(one("claude").status).toBe("unauthenticated");
    expect(changes).toHaveLength(3);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
    p.check();
    expect(changes[3]).toEqual({ added: [], removed: [], status: [{ id: one("claude").id, from: "unauthenticated", to: "ok" }], login: [] });
    // `profile.list` rebuilds too, and says nothing when nothing changed.
    p.refresh();
    expect(changes).toHaveLength(4);
  });

  test("a Muse login is a change of its auth.json, as Codex's is", () => {
    const home = tempHome();
    const muse = join(home, ".config", "muse");
    mkdirSync(muse, { recursive: true });
    const p = profiles("", {}, home);
    const changes: ProfileChange[] = [];
    p.onChange((c) => changes.push(c));
    const id = p.byHarness("muse")[0]!.id;
    writeFileSync(join(muse, "auth.json"), JSON.stringify({ providers: { meta: {} } }));
    p.check();
    expect(changes).toEqual([{ added: [], removed: [], status: [{ id, from: "unauthenticated", to: "ok" }], login: [id] }]);
  });

  test("nothing changed: check() only stats, and the Keychain is not asked again", () => {
    const home = tempHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    let asked = 0;
    const store = new Store(":memory:");
    store.migrate();
    const p = new Profiles({ store, nodeId: newId("node"), config: parseConfig(""), log: silentLogger, home, env: {}, platform: "darwin", keychainHas: () => (asked++, false) });
    // one look is a few names (claudeKeychainServices), all asked while none is there
    const look = asked;
    expect(look).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) p.check();
    expect(asked).toBe(look);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
    p.check();
    expect(asked).toBe(2 * look);
  });

  test("a signed-in Claude's global config, which its sessions rewrite all the time, is not looked at", () => {
    const home = tempHome();
    const claude = join(home, ".claude");
    mkdirSync(claude, { recursive: true });
    writeFileSync(join(claude, ".credentials.json"), "{}");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
    const p = profiles("", {}, home);
    let rebuilt = 0;
    const refresh = p.refresh.bind(p);
    p.refresh = () => {
      rebuilt++;
      refresh();
    };
    expect(p.byHarness("claude")[0]!.status).toBe("ok");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 42 }));
    p.check();
    expect(rebuilt).toBe(0);
    // Signed out, it counts again.
    rmSync(join(claude, ".credentials.json"));
    p.check();
    expect(rebuilt).toBe(1);
    expect(p.byHarness("claude")[0]!.status).toBe("unauthenticated");
    // a size of its own: a rewrite of the same size in the same clock tick as the last one reads unchanged
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 4300 }));
    p.check();
    expect(rebuilt).toBe(2);
  });
});

describe("a profile's launch", () => {
  test("set in the app, else [[profiles]].args, else mirrored from the user's own last session; the mode apart", () => {
    const { home, work } = twoAccounts();
    const toml = `[[profiles]]\nharness = "claude"\nname = "work"\nconfig_dir = ${tomlString(work)}\nargs = ["--permission-mode", "auto", "--effort", "high"]\n`;
    const { p } = build(toml, home);
    const id = (name: string) => p.byHarness("claude").find((x) => x.name === name)!.id;
    expect(p.launch(id("work"))).toEqual({ mode: "auto", args: ["--effort", "high"], source: "config" });
    expect(p.launch(id("default"))).toBeUndefined();
    expect(p.mirror(id("default"), { mode: "bypassPermissions", args: ["--settings", "/s.json"] }, 1000, "sess_a")).toBe(true);
    expect(p.launch(id("default"))).toEqual({ mode: "bypassPermissions", args: ["--settings", "/s.json"], source: "mirrored", at: 1000 });
    // An older session's launch does not replace a newer one's.
    expect(p.mirror(id("default"), { args: [] }, 500, "sess_b")).toBe(false);
    expect(p.byHarness("claude").find((x) => x.name === "default")!.launch?.source).toBe("mirrored");
    // What the user sets wins, and a mode typed among the flags becomes the mode.
    const updated = p.update(id("default"), { launch: { args: ["--dangerously-skip-permissions", "--effort", "low"] } });
    expect(updated.launch).toEqual({ mode: "bypassPermissions", args: ["--effort", "low"], source: "you" });
    expect(p.update(id("default"), { launch: { mode: "plan", args: ["--permission-mode", "auto"] } }).launch).toEqual({ mode: "plan", args: [], source: "you" });
    expect(p.update(id("default"), { launch: null }).launch).toEqual({ mode: "bypassPermissions", args: ["--settings", "/s.json"], source: "mirrored", at: 1000 });
    // A Codex profile has none.
    expect(p.byHarness("codex").every((x) => x.launch === undefined)).toBe(true);
  });

  test("an update refuses what would not start the session cophylad means to start", () => {
    const { home, toml } = twoAccounts();
    const { p } = build(toml, home);
    const claude = p.byHarness("claude")[0]!.id;
    const codex = p.byHarness("codex")[0]!.id;
    expect(() => p.update(claude, { launch: { args: ["--resume", "abc"] } })).toThrow("--resume is cophylad's to set");
    expect(() => p.update(claude, { launch: { args: ["hello"] } })).toThrow('"hello" is not a flag');
    expect(() => p.update(codex, { launch: { args: [] } })).toThrow("a codex profile has no launch settings");
    // ~/.codex does not exist in this home.
    expect(() => p.update(codex, { usual: true })).toThrow("has no configuration directory");
    expect(() => p.update("prof_nope", { usual: true })).toThrow("no profile prof_nope");
  });
});
