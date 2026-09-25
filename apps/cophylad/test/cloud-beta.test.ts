// The beta brain channel behind the account: the feed and the artifact are read from the
// server with the bearer, the stable feed never sees one, and a node that is signed out
// (or on a plan without the channel) reads stable with a warning and no bearer anywhere.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientNotificationParams, Release } from "@cophyla/protocol";
import { paths } from "../src/config/load.ts";
import type { Daemon } from "../src/daemon.ts";
import { createLogger } from "../src/log.ts";
import { sha256File, signRelease } from "../src/update/verify.ts";
import { ARCH, FakeFeed, KEY, OS } from "./fakes/feed.ts";
import { FakeServer } from "./fakes/server.ts";
import { isMethod, removeHome, tempHome, TestClient, tomlString, waitFor } from "./helpers.ts";


type UpdateState = ClientNotificationParams<"update.state">;

const FAKE_BRAIN = join(import.meta.dir, "fakes", "brain.ts");
const BRAIN_CURRENT = "0.1.1";
const BRAIN_BETA = "0.1.9-beta.1";

interface Started {
  d: Daemon & { home: string };
  c: TestClient;
  fake: FakeServer;
  feed: FakeFeed;
  lines: string[];
}

let current: Started | undefined;
afterEach(async () => {
  if (!current) return;
  const s = current;
  current = undefined;
  s.c.close();
  await s.d.stop();
  await s.fake.stop();
  await s.feed.stop();
  removeHome(s.d.home);
});

const brainBytes = (tag: string): Uint8Array => Buffer.from(readFileSync(FAKE_BRAIN, "utf8") + `\n// release ${tag}\n`, "utf8");

/** The installed brain under `data/brain/current`: the fake brain with a signed entry beside it, so the update module may replace it. */
async function writeBrainDir(dir: string, version: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "brain.ts");
  writeFileSync(file, brainBytes(version));
  const release = signRelease(
    { component: "brain", name: `brain-${version}-${OS}-${ARCH}.ts`, version, channel: "stable", os: OS, arch: ARCH, protocol: { min: 1, max: 1 }, url: "https://example.invalid/brain.ts", size: 0, sha256: await sha256File(file), publishedAt: 1 } as Omit<Release, "signature">,
    KEY.pem,
  );
  writeFileSync(join(dir, "release.json"), JSON.stringify(release, null, 2));
}

/** A signed beta brain entry whose URL names the artifact by its file name; the server rewrites the origin. */
function betaEntry(bytes: Uint8Array): Release {
  const name = `brain-${BRAIN_BETA}-${OS}-${ARCH}.ts`;
  return signRelease(
    { component: "brain", name, version: BRAIN_BETA, channel: "beta", os: OS, arch: ARCH, protocol: { min: 1, max: 1 }, url: `https://stage.invalid/out/${name}`, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), publishedAt: 1758196800000 } as Omit<Release, "signature">,
    KEY.pem,
  );
}

async function start(opts: { signedIn: boolean; channel: "beta" | "stable" }): Promise<Started> {
  const fake = new FakeServer();
  const feed = new FakeFeed();
  const scratch = tempHome();
  const bytes = brainBytes(BRAIN_BETA);
  const entry = betaEntry(bytes);
  fake.betaFeed = { releases: [entry] };
  fake.artifacts.set(`brain-${BRAIN_BETA}-${OS}-${ARCH}.ts`, bytes);
  feed.body = { generatedAt: 1, releases: [] };
  await writeBrainDir(join(scratch, "data", "brain", "current"), BRAIN_CURRENT);
  const toml =
    `[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\n\n[brain]\nrestart_backoff_ms = 100\nhello_timeout_ms = 5000\n\n` +
    `[update]\nenabled = true\nchannel = "${opts.channel}"\nfeed = ${tomlString(feed.url)}\nallow_insecure_feed = true\nfirst_check_delay_ms = 60000\nauto_apply = false\n\n` +
    `[cloud]\nenabled = true\nurl = "${fake.url}"\nallow_insecure = true\n`;
  writeFileSync(join(scratch, "config.toml"), toml);
  const p = paths(scratch);
  mkdirSync(p.data, { recursive: true });
  if (opts.signedIn) writeFileSync(p.accountToken, fake.mintToken() + "\n", { mode: 0o600 });
  const lines: string[] = [];
  const { startDaemon } = await import("../src/daemon.ts");
  const d = Object.assign(
    await startDaemon({
      home: scratch,
      port: 0,
      log: createLogger("info", (l) => lines.push(l)),
      embedder: null,
      cloud: { keys: [fake.publicKey] },
      update: { keys: [KEY.pub] },
      env: { ...process.env, FAKE_BRAIN_SCRIPT: join(scratch, "brain-script.json"), COPHYLA_BRAIN: undefined, GEMINI_API_KEY: undefined },
    }),
    { home: scratch },
  );
  writeFileSync(join(scratch, "brain-script.json"), JSON.stringify({ on: [] }));
  const c = await TestClient.connect(d.api.url);
  await c.hello(d.token, { name: "test" });
  current = { d, c, fake, feed, lines };
  return current;
}

describe("beta channel", () => {
  test("signed in on a beta plan: the feed and the artifact come from the server with the bearer; stable sees none", async () => {
    const { d, c, fake, feed } = await start({ signedIn: true, channel: "beta" });
    await waitFor(() => d.brain?.state === "up");
    await waitFor(() => d.cloud.state().plan === "pro");
    const token = readFileSync(d.paths.accountToken, "utf8").trim();
    await c.request("update.check");
    await c.next(isMethod("update.state", (p) => (p as UpdateState).component === "brain" && (p as UpdateState).staged === BRAIN_BETA), 10_000);
    const beta = fake.http.filter((h) => h.path.startsWith("/releases/"));
    expect(beta.map((h) => h.path)).toEqual([`/releases/beta/${OS}-${ARCH}.json`, `/releases/artifacts/brain-${BRAIN_BETA}-${OS}-${ARCH}.ts`]);
    for (const h of beta) expect(h.headers["authorization"]).toBe(`Bearer ${token}`);
    expect(feed.seen).toEqual([]);
    // after a logout: the warning, the stable feed, and no bearer anywhere
    await c.request("account.logout");
    await c.request("update.check");
    expect(feed.seen.map((r) => r.path)).toEqual([`/stable/${OS}-${ARCH}.json`]);
    expect(feed.seen[0]!.headers["authorization"]).toBeUndefined();
    expect(current!.lines.some((l) => l.includes("the beta channel needs an account"))).toBe(true);
    expect(fake.http.filter((h) => h.path.startsWith("/releases/")).length).toBe(2);
  });

  test("signed out on the beta channel: the warning and the stable feed, no bearer", async () => {
    const { d, c, fake, feed } = await start({ signedIn: false, channel: "beta" });
    await waitFor(() => d.brain?.state === "up");
    await c.request("update.check");
    expect(feed.seen.map((r) => r.path)).toEqual([`/stable/${OS}-${ARCH}.json`]);
    expect(Object.keys(feed.seen[0]!.headers)).not.toContain("authorization");
    expect(fake.http.filter((h) => h.path.startsWith("/releases/"))).toEqual([]);
    expect(current!.lines.filter((l) => l.includes("the beta channel needs an account")).length).toBe(1);
  });

  test("the stable channel signed in: the account's server is never asked for releases", async () => {
    const { d, c, fake, feed } = await start({ signedIn: true, channel: "stable" });
    await waitFor(() => d.cloud.state().plan === "pro");
    await c.request("update.check");
    expect(feed.seen.map((r) => r.path)).toEqual([`/stable/${OS}-${ARCH}.json`]);
    expect(feed.seen[0]!.headers["authorization"]).toBeUndefined();
    expect(fake.http.filter((h) => h.path.startsWith("/releases/"))).toEqual([]);
  });
});
