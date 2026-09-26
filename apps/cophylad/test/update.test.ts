// The update module over the socket, against a fake feed on loopback and an install tree in
// a temp directory: `update.check` reads exactly `<channel>/<os>-<arch>.json` with no query
// and no header of ours and publishes what is available; a brain release is downloaded with
// progress, staged, and applied by `update.apply` (the fake brain reports the new version and
// the previous release is kept); a brain whose bytes changed after signing is refused at
// start, rolled back and the previous one runs; entries with a bad signature or a protocol
// range outside ours are dropped and logged and nothing is staged; a platform release is
// staged into `versions/<v>` behind the `staged` pointer; `update.apply {platform}` is a
// `conflict` while an ask is open or an agent prompt is in flight and, idle, publishes the
// final state and exits; a daemon whose `current` pointer names another version stops when
// idle with no desktop app attached; a checkout takes brain updates and no platform ones;
// `.broken` versions are never staged again; both methods leave audit rows with their risk;
// the scheduler never runs two checks at once; a bundled brain is found and verified.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuditEntry, ClientNotificationParams, Release, Session } from "@cophyla/protocol";
import type { Daemon, DaemonOptions } from "../src/daemon.ts";
import { PLATFORM_VERSION } from "../src/daemon.ts";
import { createLogger } from "../src/log.ts";
import { BUN_NAME, defaultTar, detectInstall, LAUNCHER_NAME, SHELL_NAME } from "../src/update/platform.ts";
import { sha256File, signRelease } from "../src/update/verify.ts";
import { ARCH, FakeFeed, KEY, OS } from "./fakes/feed.ts";
import { isMethod, removeHome, sleep, stopDaemon, tempHome, TestClient, tomlString, waitFor } from "./helpers.ts";

type UpdateState = ClientNotificationParams<"update.state">;

const FAKE_BRAIN = join(import.meta.dir, "fakes", "brain.ts");
const FAKE_AGENT = join(import.meta.dir, "fakes", "acp-agent.ts");
const TAR = defaultTar();
/** One patch above the tree's own version, whatever it is. */
const NEXT_PLATFORM = PLATFORM_VERSION.replace(/(\d+)$/, (n) => String(Number(n) + 1));
const BRAIN_CURRENT = "0.1.1";
const BRAIN_NEXT = "0.1.2";

// --- fixtures -------------------------------------------------------------------------------

const brainBytes = (tag: string): Uint8Array => Buffer.from(readFileSync(FAKE_BRAIN, "utf8") + `\n// release ${tag}\n`, "utf8");

/** A brain release directory: the fake brain as `brain.ts` with a signed entry beside it. */
async function writeBrainDir(dir: string, version: string, opts: { tamper?: boolean } = {}): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "brain.ts");
  writeFileSync(file, brainBytes(version));
  const release = signRelease(
    { component: "brain", name: `brain-${version}-${OS}-${ARCH}.ts`, version, channel: "stable", os: OS, arch: ARCH, protocol: { min: 1, max: 1 }, url: "https://example.invalid/brain.ts", size: 0, sha256: await sha256File(file), publishedAt: 1 } as Omit<Release, "signature">,
    KEY.pem,
  );
  writeFileSync(join(dir, "release.json"), JSON.stringify(release, null, 2));
  if (opts.tamper) writeFileSync(file, brainBytes(version) + "// changed after signing\n");
}

/** An install tree: the launcher stub (Windows' layout, unless `launcher: false`), `versions/<own>` complete, `current` at it. */
function writeInstall(dir: string, opts: { current?: string; extra?: string[]; broken?: string[]; launcher?: boolean } = {}): void {
  mkdirSync(join(dir, "versions"), { recursive: true });
  if (opts.launcher !== false) writeFileSync(join(dir, LAUNCHER_NAME), "launcher stub");
  for (const v of [PLATFORM_VERSION, ...(opts.extra ?? []), ...(opts.broken ?? [])]) {
    const shell = join(dir, "versions", v, SHELL_NAME);
    mkdirSync(dirname(shell), { recursive: true });
    writeFileSync(shell, `shell ${v}`);
    writeFileSync(join(dir, "versions", v, "release.json"), JSON.stringify({ component: "platform", version: v }));
  }
  for (const v of opts.broken ?? []) writeFileSync(join(dir, "versions", v, ".broken"), "x");
  writeFileSync(join(dir, "current"), (opts.current ?? PLATFORM_VERSION) + "\n");
}

/** A platform archive: what `versions/<v>` holds, minus `release.json`. */
async function platformArchive(scratch: string, version: string, opts: { withShell?: boolean } = {}): Promise<Uint8Array> {
  const src = join(scratch, `platform-${version}`);
  mkdirSync(join(src, "cophylad"), { recursive: true });
  if (opts.withShell !== false) {
    mkdirSync(dirname(join(src, SHELL_NAME)), { recursive: true });
    writeFileSync(join(src, SHELL_NAME), `shell ${version}`);
  }
  writeFileSync(join(src, BUN_NAME), "runtime stub");
  writeFileSync(join(src, "cophylad", "main.ts"), "// cophylad");
  const out = join(scratch, `platform-${version}.tar.gz`);
  const proc = Bun.spawn([TAR, "-czf", out, "-C", src, ...readdirSync(src)], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`tar failed: ${await new Response(proc.stderr).text()}`);
  return new Uint8Array(readFileSync(out));
}

interface Started {
  d: Daemon & { home: string };
  c?: TestClient;
  feed: FakeFeed;
  scratch: string;
  install: string;
  lines: string[];
  exits: number[];
}

let current: Started | undefined;

afterEach(async () => {
  if (!current) return;
  current.c?.close();
  await stopDaemon(current.d);
  await current.feed.stop();
  removeHome(current.scratch);
  current = undefined;
});

interface StartOptions {
  /** Run as installed at a temp tree; default true. */
  installed?: boolean;
  install?: Parameters<typeof writeInstall>[1];
  /** The brain under `data/brain/current`: a version, or `none`, or `bundled` for `<install>/brain` only. */
  brain?: string | "none" | "bundled";
  tamper?: boolean;
  previous?: string;
  update?: string;
  client?: boolean;
  acp?: boolean;
  daemon?: Partial<DaemonOptions["update"]>;
}

async function start(opts: StartOptions = {}): Promise<Started> {
  const scratch = tempHome();
  const install = join(scratch, "install");
  const feed = new FakeFeed();
  const installed = opts.installed ?? true;
  if (installed) writeInstall(install, opts.install ?? {});
  const brain = opts.brain ?? BRAIN_CURRENT;
  if (brain === "bundled") await writeBrainDir(join(install, "brain"), BRAIN_CURRENT);
  else if (brain !== "none") await writeBrainDir(join(scratch, "data", "brain", "current"), brain, { tamper: opts.tamper ?? false });
  if (opts.previous) await writeBrainDir(join(scratch, "data", "brain", "previous"), opts.previous);
  const configDir = join(scratch, "claude-home");
  mkdirSync(configDir, { recursive: true });
  const acp = opts.acp ? `[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(configDir)}\n\n[acp.claude]\ncommand = ${tomlString(FAKE_AGENT)}\n\n` : "";
  const toml = `[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\nlaunch = "acp"\n\n[brain]\nrestart_backoff_ms = 100\nhello_timeout_ms = 5000\n\n${acp}[update]\nfeed = ${tomlString(feed.url)}\n${opts.update ?? "enabled = false\nauto_apply = false\n"}`;
  writeFileSync(join(scratch, "config.toml"), toml);
  const lines: string[] = [];
  const exits: number[] = [];
  const { startDaemon } = await import("../src/daemon.ts");
  const d = Object.assign(
    await startDaemon({
      home: scratch,
      port: 0,
      log: createLogger("info", (line) => lines.push(line)),
      env: { ...process.env, COPHYLA_BRAIN: undefined, COPHYLA_INSTALL_DIR: undefined, COPHYLA_PLATFORM_DIR: undefined, FAKE_BRAIN_SCRIPT: undefined },
      update: { keys: [KEY.pub], ...(installed ? { installDir: install } : {}), exit: (code) => exits.push(code), applyRetryMs: 50, exitDelayMs: 20, ...opts.daemon },
    }),
    { home: scratch },
  );
  let c: TestClient | undefined;
  if (opts.client !== false) {
    c = await TestClient.connect(d.api.url);
    await c.hello(d.token, { name: "test" });
  }
  current = { d, ...(c ? { c } : {}), feed, scratch, install, lines, exits };
  return current;
}

const stateOf = (n: { params?: unknown }) => n.params as UpdateState;
const audit = (d: Daemon, action: string): AuditEntry[] => d.store.audit.list({ limit: 200 }).filter((e) => e.action === action);
const logged = (lines: string[], text: string) => lines.filter((l) => l.includes(text));

async function feedBoth(s: Started, scratch: string): Promise<{ platform: Release; brain: Release }> {
  const platform = await s.feed.entry("platform", NEXT_PLATFORM, `platform-${NEXT_PLATFORM}-${OS}-${ARCH}.tar.gz`, await platformArchive(scratch, NEXT_PLATFORM));
  const brain = await s.feed.entry("brain", BRAIN_NEXT, `brain-${BRAIN_NEXT}-${OS}-${ARCH}.ts`, brainBytes(BRAIN_NEXT));
  s.feed.body = { generatedAt: 1, releases: [platform, brain] };
  return { platform, brain };
}

describe("update", () => {
  test("update.check reads one path with nothing else, publishes what is available, stages both with progress, and both methods are audited with their risk", async () => {
    const s = await start();
    const { d, c, feed } = s;
    const c1 = c!;
    await waitFor(() => d.brain?.state === "up");
    expect(d.brain!.brainVersion).toBe(BRAIN_CURRENT);
    expect(d.brain!.location?.origin).toBe("installed");
    // The post-hello snapshot carries both components.
    await c1.next(isMethod("update.state", (p) => (p as UpdateState).component === "brain"));
    const snapshot = c1.notifications.filter(isMethod("update.state")).map(stateOf);
    expect(snapshot.map((u) => [u.component, u.current])).toEqual([
      ["platform", PLATFORM_VERSION],
      ["brain", BRAIN_CURRENT],
    ]);
    await feedBoth(s, s.scratch);

    await c1.request("update.check");
    // the artifacts may be on their way already; the feed itself was read once
    const reads = feed.seen.filter((r) => !r.path.startsWith("/artifacts/"));
    expect(reads).toHaveLength(1);
    const req = reads[0]!;
    expect(req.method).toBe("GET");
    expect(req.path).toBe(`/stable/${OS}-${ARCH}.json`);
    expect(req.search).toBe("");
    for (const h of Object.keys(req.headers)) expect(h).not.toMatch(/^(authorization|cookie|x-|cophyla)/);

    const availablePlatform = await c1.next(isMethod("update.state", (p) => (p as UpdateState).component === "platform" && (p as UpdateState).available === NEXT_PLATFORM));
    expect(stateOf(availablePlatform)).toMatchObject({ node: d.identity.id, current: PLATFORM_VERSION, available: NEXT_PLATFORM });
    await c1.next(isMethod("update.state", (p) => (p as UpdateState).component === "brain" && (p as UpdateState).available === BRAIN_NEXT));
    await c1.next(isMethod("update.state", (p) => (p as UpdateState).component === "brain" && (p as UpdateState).staged === BRAIN_NEXT));
    await c1.next(isMethod("update.state", (p) => (p as UpdateState).component === "platform" && (p as UpdateState).staged === NEXT_PLATFORM));
    const progress = c1.notifications.filter(isMethod("update.state", (p) => (p as UpdateState).component === "brain" && (p as UpdateState).progress !== undefined)).map((n) => stateOf(n).progress!);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);
    expect(feed.seen.map((r) => r.path)).toEqual([`/stable/${OS}-${ARCH}.json`, `/artifacts/platform-${NEXT_PLATFORM}-${OS}-${ARCH}.tar.gz`, `/artifacts/brain-${BRAIN_NEXT}-${OS}-${ARCH}.ts`]);

    // On disk: the version directory complete behind the pointer; the brain under staged/.
    const vdir = join(s.install, "versions", NEXT_PLATFORM);
    expect(existsSync(join(vdir, SHELL_NAME))).toBe(true);
    expect(existsSync(join(vdir, "cophylad", "main.ts"))).toBe(true);
    expect(JSON.parse(readFileSync(join(vdir, "release.json"), "utf8")).version).toBe(NEXT_PLATFORM);
    expect(readFileSync(join(s.install, "staged"), "utf8").trim()).toBe(NEXT_PLATFORM);
    expect(existsSync(join(vdir + ".partial"))).toBe(false);
    expect(existsSync(join(s.scratch, "data", "brain", "staged", BRAIN_NEXT, "brain.ts"))).toBe(true);
    expect(existsSync(join(s.scratch, "data", "downloads", `brain-${BRAIN_NEXT}-${OS}-${ARCH}.ts`))).toBe(false);
    // Nothing applied by itself: auto_apply is off here.
    await sleep(150);
    expect(d.brain!.brainVersion).toBe(BRAIN_CURRENT);
    expect(s.exits).toEqual([]);

    // Apply the brain: the link restarts, promotes, verifies; the fake reports the new version.
    await c1.request("update.apply", { component: "brain" });
    await waitFor(() => d.brain?.brainVersion === BRAIN_NEXT);
    expect(d.brain!.state).toBe("up");
    expect(JSON.parse(readFileSync(join(s.scratch, "data", "brain", "current", "release.json"), "utf8")).version).toBe(BRAIN_NEXT);
    expect(JSON.parse(readFileSync(join(s.scratch, "data", "brain", "previous", "release.json"), "utf8")).version).toBe(BRAIN_CURRENT);
    expect(existsSync(join(s.scratch, "data", "brain", "staged"))).toBe(false);
    const after = await c1.next(isMethod("update.state", (p) => (p as UpdateState).component === "brain" && (p as UpdateState).staged === undefined && (p as UpdateState).current === BRAIN_NEXT), 3000);
    expect(stateOf(after).current).toBe(BRAIN_NEXT);
    expect(logged(s.lines, "brain verified").length).toBeGreaterThanOrEqual(2);

    // Audit rows with the gate's risk classes.
    await waitFor(() => audit(d, "update.apply").length === 1);
    const check = audit(d, "update.check")[0]!;
    const apply = audit(d, "update.apply")[0]!;
    expect(check).toMatchObject({ principal: { kind: "user" }, decision: "allow", outcome: "ok" });
    expect(apply).toMatchObject({ principal: { kind: "user" }, decision: "allow", outcome: "ok", target: "brain" });
  }, 20_000);

  test("the methods carry their risk classes through the gate: network for check, exec for apply", async () => {
    const s = await start({ update: 'enabled = false\n\n[gate.policy.user]\nnetwork = "deny"\nexec = "deny"\n' });
    const { d, c } = s;
    await waitFor(() => d.brain?.state === "up");
    expect(await c!.call("update.check")).toMatchObject({ error: { data: { code: "denied", message: "policy for user/network" } } });
    expect(await c!.call("update.apply", { component: "brain" })).toMatchObject({ error: { data: { code: "denied", message: "policy for user/exec" } } });
    expect(s.feed.seen).toEqual([]);
    await waitFor(() => audit(d, "update.apply").length === 1);
    expect(audit(d, "update.check")[0]).toMatchObject({ decision: "deny", outcome: "denied" });
    expect(audit(d, "update.apply")[0]).toMatchObject({ decision: "deny", outcome: "denied" });
  }, 15_000);

  test("a brain whose bytes changed after signing is refused at start, rolled back, and the previous one runs", async () => {
    const s = await start({ brain: BRAIN_NEXT, tamper: true, previous: BRAIN_CURRENT });
    const { d } = s;
    await waitFor(() => d.brain?.state === "up", 5000);
    expect(d.brain!.brainVersion).toBe(BRAIN_CURRENT);
    const refused = logged(s.lines, "brain refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('"reason":"hash"');
    expect(logged(s.lines, "brain release rolled back")).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(s.scratch, "data", "brain", "current", "release.json"), "utf8")).version).toBe(BRAIN_CURRENT);
    expect(existsSync(join(s.scratch, "data", "brain", "previous"))).toBe(false);
    expect(d.brain!.spawnCount).toBe(1);
  }, 15_000);

  test("a refused brain with nothing to put back stays refused; restart() gives it another turn once a release is staged", async () => {
    const s = await start({ brain: BRAIN_NEXT, tamper: true });
    const { d, c } = s;
    await waitFor(() => d.brain?.state === "down" || d.brain?.state === "refused", 5000);
    // No previous, no bundled seed, no dev tree from this home: rolled back to nothing.
    expect(logged(s.lines, "brain release rolled back")[0]).toContain('"now":"none"');
    expect(existsSync(join(s.scratch, "data", "brain", "current"))).toBe(false);
    expect(d.brain!.state).toBe("down");
    expect(d.brain!.brainVersion).toBeUndefined();
    // A staged release from the feed brings it back: the check treats "no brain" as version 0.0.0.
    s.feed.body = { releases: [await s.feed.entry("brain", BRAIN_NEXT, `brain-${BRAIN_NEXT}-${OS}-${ARCH}.ts`, brainBytes(BRAIN_NEXT))] };
    await c!.request("update.check");
    await c!.next(isMethod("update.state", (p) => (p as UpdateState).component === "brain" && (p as UpdateState).staged === BRAIN_NEXT));
    await c!.request("update.apply", { component: "brain" });
    await waitFor(() => d.brain?.state === "up" && d.brain.brainVersion === BRAIN_NEXT, 5000);
  }, 15_000);

  test("a bad signature and a protocol range outside ours are dropped and logged; nothing is staged", async () => {
    const s = await start();
    const { d, c, feed } = s;
    await waitFor(() => d.brain?.state === "up");
    const good = await feed.entry("brain", BRAIN_NEXT, `brain-${BRAIN_NEXT}-${OS}-${ARCH}.ts`, brainBytes(BRAIN_NEXT));
    const sig = Buffer.from(good.signature.slice("ed25519:".length), "base64");
    sig[10]! ^= 0x01;
    const flipped = { ...good, signature: "ed25519:" + sig.toString("base64") };
    const outside = await feed.entry("platform", NEXT_PLATFORM, `platform-${NEXT_PLATFORM}-${OS}-${ARCH}.tar.gz`, await platformArchive(s.scratch, NEXT_PLATFORM), { protocol: { min: 2, max: 2 } });
    feed.body = { releases: [flipped, outside] };
    await c!.request("update.check");
    await waitFor(() => logged(s.lines, "release dropped").length === 2);
    const dropped = logged(s.lines, "release dropped");
    expect(dropped[0]).toContain('"reason":"bad signature"');
    expect(dropped[0]).toContain(`"version":"${BRAIN_NEXT}"`);
    expect(dropped[1]).toContain('"reason":"protocol range 2-2 excludes 1"');
    await sleep(100);
    expect(feed.seen.map((r) => r.path)).toEqual([`/stable/${OS}-${ARCH}.json`]);
    expect(existsSync(join(s.install, "staged"))).toBe(false);
    expect(existsSync(join(s.install, "versions", NEXT_PLATFORM))).toBe(false);
    expect(existsSync(join(s.scratch, "data", "brain", "staged"))).toBe(false);
    const states = c!.notifications.filter(isMethod("update.state")).map(stateOf);
    expect(states.every((u) => u.available === undefined && u.staged === undefined)).toBe(true);
  }, 15_000);

  test("update.apply {platform} is a conflict while an ask is open or an agent prompt is in flight; idle, it publishes the final state and exits", async () => {
    const s = await start({ acp: true });
    const { d, c, feed } = s;
    const c1 = c!;
    await waitFor(() => d.brain?.state === "up");
    feed.body = { releases: [await feed.entry("platform", NEXT_PLATFORM, `platform-${NEXT_PLATFORM}-${OS}-${ARCH}.tar.gz`, await platformArchive(s.scratch, NEXT_PLATFORM))] };
    await c1.request("update.check");
    await c1.next(isMethod("update.state", (p) => (p as UpdateState).component === "platform" && (p as UpdateState).staged === NEXT_PLATFORM));

    // Nothing staged for the brain: apply {brain} is not_found; a model without its name is invalid.
    expect(await c1.call("update.apply", { component: "brain" })).toMatchObject({ error: { data: { code: "not_found" } } });
    expect(await c1.call("update.apply", { component: "model" })).toMatchObject({ error: { data: { code: "invalid" } } });
    expect(await c1.call("update.apply", { component: "model", name: "tts-kokoro-en" })).toMatchObject({ error: { data: { code: "not_found" } } });

    // An open ask.
    const ask = d.asks.open({ type: "permission", source: { kind: "brain" }, title: "may I", options: [{ id: "yes", label: "yes" }, { id: "no", label: "no" }], answerableBy: ["user"] });
    const busy = await c1.call("update.apply", { component: "platform" });
    expect(busy).toMatchObject({ error: { data: { code: "conflict" } } });
    expect(JSON.stringify(busy)).toContain("1 open ask");
    d.asks.answer(ask.id, { option: "yes" }, { kind: "user", client: "test" });

    // An agent prompt in flight: the fake agent's `slow` turn ends only on cancel.
    const wsId = d.workspaces.put({ node: d.identity.id, path: s.scratch, name: "scratch" }).id;
    const session: Session = await d.sessions.spawn({ harness: "claude", workspace: wsId, prompt: "slow" }, { profiles: d.profiles });
    await waitFor(() => d.sessions.acpInFlight() === 1);
    const busy2 = await c1.call("update.apply", { component: "platform" });
    expect(busy2).toMatchObject({ error: { data: { code: "conflict" } } });
    expect(JSON.stringify(busy2)).toContain("1 agent prompt in flight");
    d.sessions.cancelTurn(session.id);
    await waitFor(() => d.sessions.acpInFlight() === 0);
    await d.sessions.stopSession(session.id);
    expect(s.exits).toEqual([]);

    // Idle: the final state, the answer, then the exit.
    await c1.request("update.apply", { component: "platform" });
    const final = c1.notifications.filter(isMethod("update.state", (p) => (p as UpdateState).component === "platform")).map(stateOf).pop()!;
    expect(final).toMatchObject({ current: PLATFORM_VERSION, staged: NEXT_PLATFORM });
    await waitFor(() => s.exits.length === 1);
    expect(s.exits).toEqual([0]);
    expect(logged(s.lines, "platform release applies at the next start")).toHaveLength(1);
    // The pointers are the launcher's: cophylad wrote only `staged`.
    expect(readFileSync(join(s.install, "current"), "utf8").trim()).toBe(PLATFORM_VERSION);
    expect(existsSync(join(s.install, "previous"))).toBe(false);
    expect(readFileSync(join(s.install, "staged"), "utf8").trim()).toBe(NEXT_PLATFORM);
    // Six apply attempts: not_found, invalid, not_found, two conflicts, then the one that went through.
    await waitFor(() => audit(d, "update.apply").length === 6);
    const outcomes = audit(d, "update.apply").map((e) => e.outcome);
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    expect(outcomes.filter((o) => o !== "ok")).toHaveLength(5);
  }, 30_000);

  test("a daemon whose current pointer names another version is stale and stops when idle with no desktop app attached", async () => {
    const s = await start({ install: { current: NEXT_PLATFORM, extra: [NEXT_PLATFORM] }, client: false, update: "enabled = true\nauto_apply = true\nfirst_check_delay_ms = 0\ncheck_interval_ms = 60000\n" });
    const { d } = s;
    await waitFor(() => d.brain?.state === "up");
    expect(logged(s.lines, "platform stale")).toHaveLength(1);
    expect(d.update.isStale()).toBe(true);
    await waitFor(() => s.exits.length === 1, 5000);
    expect(s.exits).toEqual([0]);
    // The empty feed was read once, on the schedule, before the stop.
    expect(s.feed.seen.map((r) => r.path)).toEqual([`/stable/${OS}-${ARCH}.json`]);
  }, 15_000);

  test("with a desktop app attached, a stale or staged platform waits; the explicit apply needs only idle", async () => {
    // The apply the start schedules for the stale pointer waits long enough for the client's hello to land, so the
    // desktop app is attached when it evaluates (at the tests' 50 ms it could stop the daemon first).
    const s = await start({ install: { current: NEXT_PLATFORM, extra: [NEXT_PLATFORM] }, update: "enabled = true\nauto_apply = true\nfirst_check_delay_ms = 300\ncheck_interval_ms = 60000\n", daemon: { applyRetryMs: 1500 } });
    const { d, c } = s;
    await waitFor(() => d.brain?.state === "up");
    await waitFor(() => logged(s.lines, "a desktop app is attached").length >= 1, 5000);
    expect(s.exits).toEqual([]);
    await c!.request("update.apply", { component: "platform" });
    await waitFor(() => s.exits.length === 1);
  }, 15_000);

  test("a checkout takes no platform update and still updates its brain, applied by itself when idle", async () => {
    const s = await start({ installed: false, update: "enabled = false\nauto_apply = true\n" });
    const { d, c } = s;
    await waitFor(() => d.brain?.state === "up");
    expect(d.update.installed).toBe(false);
    expect(logged(s.lines, "platform updates off: not installed")).toHaveLength(1);
    await feedBoth(s, s.scratch);
    await c!.request("update.check");
    await c!.next(isMethod("update.state", (p) => (p as UpdateState).component === "brain" && (p as UpdateState).staged === BRAIN_NEXT));
    await waitFor(() => d.brain?.brainVersion === BRAIN_NEXT, 5000);
    expect(logged(s.lines, '"by":"auto"')).toHaveLength(1);
    const platform = c!.notifications.filter(isMethod("update.state", (p) => (p as UpdateState).component === "platform")).map(stateOf);
    expect(platform.every((u) => u.available === undefined && u.staged === undefined)).toBe(true);
    expect(s.feed.seen.map((r) => r.path)).toEqual([`/stable/${OS}-${ARCH}.json`, `/artifacts/brain-${BRAIN_NEXT}-${OS}-${ARCH}.ts`]);
    expect(await c!.call("update.apply", { component: "platform" })).toMatchObject({ error: { data: { code: "unsupported" } } });
  }, 15_000);

  test("a version the launcher marked .broken is remembered and never staged again, even once its directory is pruned", async () => {
    const s = await start({ install: { broken: [NEXT_PLATFORM] } });
    const { d, c } = s;
    await waitFor(() => d.brain?.state === "up");
    expect(d.store.kv.get("update", "broken")).toEqual([NEXT_PLATFORM]);
    expect(existsSync(join(s.install, "versions", NEXT_PLATFORM))).toBe(false);
    expect(logged(s.lines, "platform versions pruned")[0]).toContain(NEXT_PLATFORM);
    await feedBoth(s, s.scratch);
    await c!.request("update.check");
    await c!.next(isMethod("update.state", (p) => (p as UpdateState).component === "brain" && (p as UpdateState).staged === BRAIN_NEXT));
    const platform = c!.notifications.filter(isMethod("update.state", (p) => (p as UpdateState).component === "platform")).map(stateOf);
    expect(platform.every((u) => u.available === undefined && u.staged === undefined)).toBe(true);
    expect(existsSync(join(s.install, "versions", NEXT_PLATFORM))).toBe(false);
  }, 15_000);

  test("an archive without the shell is not staged and leaves no partial directory", async () => {
    const s = await start();
    const { d, c, feed } = s;
    await waitFor(() => d.brain?.state === "up");
    feed.body = { releases: [await feed.entry("platform", NEXT_PLATFORM, `platform-${NEXT_PLATFORM}-${OS}-${ARCH}.tar.gz`, await platformArchive(s.scratch, NEXT_PLATFORM, { withShell: false }))] };
    await c!.request("update.check");
    await waitFor(() => logged(s.lines, "platform staging failed").length === 1, 5000);
    expect(logged(s.lines, "platform staging failed")[0]).toContain(`archive has no ${SHELL_NAME}`);
    expect(existsSync(join(s.install, "versions", `${NEXT_PLATFORM}.partial`))).toBe(false);
    expect(existsSync(join(s.install, "versions", NEXT_PLATFORM))).toBe(false);
    expect(existsSync(join(s.install, "staged"))).toBe(false);
  }, 15_000);

  test("the scheduler runs one check at a time and a request joins the check in flight", async () => {
    const s = await start({ update: "enabled = true\nauto_apply = false\nfirst_check_delay_ms = 0\ncheck_interval_ms = 20\n" });
    const { d, c, feed } = s;
    feed.delayMs = 60;
    await waitFor(() => d.brain?.state === "up");
    const before = feed.seen.length;
    await Promise.all([c!.request("update.check"), c!.request("update.check"), c!.request("update.check")]);
    await sleep(300);
    expect(feed.maxInFlight).toBe(1);
    expect(feed.seen.length).toBeGreaterThan(before + 1);
    // checks keep running every 20 ms: one may be counted and not yet at the feed when sampled
    await waitFor(() => d.update.checkCount === feed.seen.length);
  }, 15_000);

  test("a bundled brain under <install>/brain is found when nothing is installed under data/, and verified", async () => {
    const s = await start({ brain: "bundled" });
    const { d } = s;
    await waitFor(() => d.brain?.state === "up");
    expect(d.brain!.location?.origin).toBe("bundled");
    expect(d.brain!.brainVersion).toBe(BRAIN_CURRENT);
    expect(logged(s.lines, "brain verified")[0]).toContain('"origin":"bundled"');
    // A release from the feed goes under data/brain and shadows the seed at the next spawn.
    s.feed.body = { releases: [await s.feed.entry("brain", BRAIN_NEXT, `brain-${BRAIN_NEXT}-${OS}-${ARCH}.ts`, brainBytes(BRAIN_NEXT))] };
    await s.c!.request("update.check");
    await s.c!.next(isMethod("update.state", (p) => (p as UpdateState).component === "brain" && (p as UpdateState).staged === BRAIN_NEXT));
    await s.c!.request("update.apply", { component: "brain" });
    await waitFor(() => d.brain?.brainVersion === BRAIN_NEXT, 5000);
    expect(d.brain!.location?.origin).toBe("installed");
    expect(existsSync(join(s.scratch, "data", "brain", "previous"))).toBe(false);
    expect(existsSync(join(s.install, "brain", "brain.ts"))).toBe(true);
    // Tamper with the installed one: the next start refuses it, removes it, and the seed serves again.
    writeFileSync(join(s.scratch, "data", "brain", "current", "brain.ts"), brainBytes(BRAIN_NEXT) + "// tampered\n");
    await d.brain!.restart();
    await waitFor(() => d.brain?.state === "up" && d.brain.brainVersion === BRAIN_CURRENT, 5000);
    expect(d.brain!.location?.origin).toBe("bundled");
    expect(logged(s.lines, "brain release rolled back").pop()).toContain('"now":"bundled"');
  }, 20_000);

  test("a brain the operator points at is verified by nobody and never replaced by a staged release", async () => {
    const scratch = tempHome();
    const script = join(scratch, "brain-script.json");
    writeFileSync(script, JSON.stringify({ on: [] }));
    const s = await start({ brain: "none", update: "enabled = false\nauto_apply = true\n" });
    // The daemon above found no brain at all; rewrite its config to point at the fake and restart the link through a new daemon.
    await stopDaemon(s.d);
    await s.feed.stop();
    current = undefined;
    const feed = new FakeFeed();
    const home = tempHome(`[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\nlaunch = "acp"\n\n[brain]\ncommand = ${tomlString(FAKE_BRAIN)}\nrestart_backoff_ms = 100\n\n[update]\nenabled = false\nauto_apply = true\nfeed = ${tomlString(feed.url)}\n`);
    const lines: string[] = [];
    const { startDaemon } = await import("../src/daemon.ts");
    const d = Object.assign(await startDaemon({ home, port: 0, log: createLogger("info", (l) => lines.push(l)), env: { ...process.env, FAKE_BRAIN_SCRIPT: script, COPHYLA_BRAIN: undefined }, update: { keys: [KEY.pub] } }), { home });
    const c = await TestClient.connect(d.api.url);
    await c.hello(d.token);
    current = { d, c, feed, scratch, install: "", lines, exits: [] };
    await waitFor(() => d.brain?.state === "up");
    expect(d.brain!.location?.origin).toBe("config");
    expect(d.brain!.brainVersion).toBe("fake-0.1");
    feed.body = { releases: [await feed.entry("brain", BRAIN_NEXT, `brain-${BRAIN_NEXT}-${OS}-${ARCH}.ts`, brainBytes(BRAIN_NEXT))] };
    await c.request("update.check");
    await sleep(200);
    expect(logged(lines, "brain updates off: the brain comes from the operator")).toHaveLength(1);
    expect(existsSync(join(home, "data", "brain"))).toBe(false);
    expect(d.brain!.brainVersion).toBe("fake-0.1");
    expect(logged(lines, "brain verified")).toEqual([]);
  }, 15_000);
});

describe("detectInstall", () => {
  test("a root is the launcher's directory (Windows) or one seeded with versions/ and current (macOS, Linux)", () => {
    const scratch = tempHome();
    const windows = join(scratch, "win");
    writeInstall(windows);
    expect(detectInstall({ COPHYLA_INSTALL_DIR: windows, COPHYLA_PLATFORM_DIR: join(windows, "versions", PLATFORM_VERSION) })).toEqual({ dir: windows, versionDir: join(windows, "versions", PLATFORM_VERSION), version: PLATFORM_VERSION });
    const seeded = join(scratch, "seeded");
    writeInstall(seeded, { launcher: false });
    expect(detectInstall({ COPHYLA_INSTALL_DIR: seeded, COPHYLA_PLATFORM_DIR: join(seeded, "versions", PLATFORM_VERSION) })?.dir).toBe(seeded);
    // the daemon's own place under versions/<v>/ in a seeded root, with no environment
    expect(detectInstall({}, join(seeded, "versions", PLATFORM_VERSION, "cophylad", "apps", "cophylad", "src", "update"))).toEqual({ dir: seeded, versionDir: join(seeded, "versions", PLATFORM_VERSION), version: PLATFORM_VERSION });
    // versions/ with no current pointer and no launcher is not a root; neither is a bare directory
    const bare = join(scratch, "bare");
    mkdirSync(join(bare, "versions", PLATFORM_VERSION), { recursive: true });
    expect(detectInstall({ COPHYLA_INSTALL_DIR: bare, COPHYLA_PLATFORM_DIR: join(bare, "versions", PLATFORM_VERSION) })).toBeUndefined();
    expect(detectInstall({}, join(bare, "versions", PLATFORM_VERSION, "cophylad"))).toBeUndefined();
    expect(detectInstall({ COPHYLA_INSTALL_DIR: windows, COPHYLA_PLATFORM_DIR: join(windows, "versions", "not-a-version") })).toBeUndefined();
    expect(detectInstall({}, join(scratch, "checkout", "apps", "cophylad", "src", "update"))).toBeUndefined();
  });
});
