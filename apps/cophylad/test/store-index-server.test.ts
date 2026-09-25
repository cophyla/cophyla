// The recall index on the `server` embedding route, through the daemon against the fake
// server: the probe names the hosted model and its width, the queue fills `chunk_vectors`
// under that model, recall uses the vector leg, a link that is down leaves recall on full
// text (still answering) and the queue resumes at the next link-up, a plan without compute
// and a signed-out daemon settle to full-text only (and the daemon still stops), a vector
// of the wrong width is refused before the queue writes it, and a `quota_exceeded` holds
// the queue until its reset.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config/load.ts";
import type { Daemon } from "../src/daemon.ts";
import { FAKE_EMBED_DIM, FAKE_EMBED_MODEL, FakeServer } from "./fakes/server.ts";
import { removeHome, sleep, tempHome, TestClient, waitFor } from "./helpers.ts";

interface Started {
  d: Daemon & { home: string };
  c: TestClient;
  fake: FakeServer;
}

const running: Started[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) {
    s.c.close();
    await s.d.stop();
    await s.fake.stop();
    removeHome(s.d.home);
  }
});

async function start(opts: { signedIn?: boolean; plan?: string; now?: () => number } = {}): Promise<Started> {
  const fake = new FakeServer(opts.now ? { now: opts.now } : {});
  if (opts.plan) fake.plan = opts.plan;
  const home = tempHome();
  const toml = `[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\n\n[update]\nenabled = false\n\n[store]\nembedding = "server"\nembed_batch = 4\n\n[cloud]\nenabled = true\nurl = "${fake.url}"\nallow_insecure = true\nrefresh_interval_ms = 60000\nreconnect_ms = 20\nreconnect_max_ms = 100\n`;
  writeFileSync(join(home, "config.toml"), toml);
  const p = paths(home);
  mkdirSync(p.data, { recursive: true });
  if (opts.signedIn ?? true) writeFileSync(p.accountToken, fake.mintToken("test") + "\n", { mode: 0o600 });
  const { startDaemon } = await import("../src/daemon.ts");
  const { silentLogger } = await import("../src/log.ts");
  const d = Object.assign(
    await startDaemon({
      home,
      port: 0,
      log: silentLogger,
      brain: false,
      voice: { affinity: null },
      cloud: { keys: [fake.publicKey], ...(opts.now ? { now: opts.now } : {}) },
      env: { ...process.env, GEMINI_API_KEY: undefined },
    }),
    { home },
  );
  const c = await TestClient.connect(d.api.url);
  await c.hello(d.token, { name: "desktop" });
  const s = { d, c, fake };
  running.push(s);
  if (opts.signedIn ?? true) await waitFor(() => d.cloud.linkState === "up", 5000);
  return s;
}

const vectors = (d: Daemon) => (d.store.db.query("SELECT COUNT(*) AS n FROM chunk_vectors WHERE model = $model").get({ model: `server:${FAKE_EMBED_MODEL}` }) as { n: number }).n;

describe("the server embedding route", () => {
  test("the probe names the model and width; the queue fills the vectors; recall uses the vector leg; the link down leaves full text, and the queue resumes at link-up", async () => {
    const s = await start();
    const { d, c, fake } = s;
    await c.request("chat.send", { text: "the quick brown fox jumps over the lazy dog" });
    await c.request("chat.send", { text: "pack my box with five dozen liquor jugs" });
    await waitFor(() => d.store.index.model === `server:${FAKE_EMBED_MODEL}`, 5000);
    await d.store.index.settled();
    await waitFor(() => vectors(d) === 2, 5000);
    expect(d.store.index.vectorCount).toBe(2);
    expect((d.store.db.query("SELECT DISTINCT dim FROM chunk_vectors").all() as { dim: number }[]).map((r) => r.dim)).toEqual([FAKE_EMBED_DIM]);
    // the probe was one empty batch; the texts went in batches of the configured size
    expect(fake.seen.filter((m) => m === "compute.embed").length).toBeGreaterThanOrEqual(2);
    expect(fake.embeds.flat()).toContain("the quick brown fox jumps over the lazy dog");
    expect(fake.embeds.every((b) => b.length <= 4)).toBe(true);
    // a query with no word in common still finds a neighbour through the vector leg
    const byVector = await d.store.index.recall({ query: "zzzz qqqq xxxx" });
    expect(byVector.length).toBeGreaterThan(0);
    // and the local counter moved
    expect(d.cloud.state().usage?.metrics["embed_tokens"]?.used).toBeGreaterThan(0);
    // the link down: recall answers from full text, the vector leg silent; a new message waits
    fake.acceptTokens = false;
    fake.restart();
    await waitFor(() => d.cloud.linkState !== "up");
    expect(await d.store.index.recall({ query: "zzzz qqqq xxxx" })).toEqual([]);
    const byText = await d.store.index.recall({ query: "liquor jugs" });
    expect(byText.length).toBe(1);
    await c.request("chat.send", { text: "sphinx of black quartz, judge my vow" });
    await sleep(200);
    expect(vectors(d)).toBe(2);
    // the link up again: the queue is kicked and the vector lands
    fake.acceptTokens = true;
    await waitFor(() => d.cloud.linkState === "up", 5000);
    await waitFor(() => vectors(d) === 3, 5000);
    expect(d.store.index.vectorCount).toBe(3);
  }, 30_000);

  test("a plan without compute and a signed-out daemon are full-text only, and the daemon stops", async () => {
    const free = await start({ plan: "free" });
    await free.c.request("chat.send", { text: "on the free plan" });
    await free.d.store.index.settled();
    expect(free.d.store.index.model).toBeUndefined();
    expect(free.fake.seen.filter((m) => m === "compute.embed").length).toBe(0);
    expect((await free.d.store.index.recall({ query: "free plan" })).length).toBe(1);
    const out = await start({ signedIn: false });
    await out.c.request("chat.send", { text: "signed out" });
    expect(out.d.store.index.model).toBeUndefined();
    expect((await out.d.store.index.recall({ query: "signed out" })).length).toBe(1);
    // `stop` must not wait on an embedder that never comes
    const t0 = Date.now();
    for (const s of running.splice(0)) {
      s.c.close();
      await s.d.stop();
      await s.fake.stop();
      removeHome(s.d.home);
    }
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 20_000);

  test("a vector of the wrong width is refused before the queue writes it", async () => {
    const s = await start();
    const { d, c, fake } = s;
    await c.request("chat.send", { text: "first, at the right width" });
    await waitFor(() => d.store.index.model !== undefined, 5000);
    await waitFor(() => vectors(d) === 1, 5000);
    fake.embedDim = FAKE_EMBED_DIM + 1;
    await c.request("chat.send", { text: "second, at the wrong width" });
    await sleep(300);
    await d.store.index.settled();
    expect(vectors(d)).toBe(1);
    expect(d.store.index.vectorCount).toBe(1);
    fake.embedDim = FAKE_EMBED_DIM;
    d.store.index.kick();
    await waitFor(() => vectors(d) === 2, 5000);
  }, 20_000);

  test("quota_exceeded holds the queue until the reset, then it drains", async () => {
    const clock = { now: Date.UTC(2026, 8, 22, 12) };
    const s = await start({ now: () => clock.now });
    const { d, c, fake } = s;
    await c.request("chat.send", { text: "before the quota" });
    await waitFor(() => d.store.index.model !== undefined, 5000);
    await waitFor(() => vectors(d) === 1, 5000);
    const resetsAt = clock.now + 60_000;
    fake.embedQuota = { resetsAt };
    await c.request("chat.send", { text: "past the quota" });
    await sleep(200);
    await d.store.index.settled();
    expect(vectors(d)).toBe(1);
    const calls = fake.seen.filter((m) => m === "compute.embed").length;
    // the allowance is back on the server, but the node remembers the reset: nothing is asked until then
    fake.embedQuota = undefined;
    d.store.index.kick();
    await sleep(200);
    await d.store.index.settled();
    expect(vectors(d)).toBe(1);
    expect(fake.seen.filter((m) => m === "compute.embed").length).toBe(calls);
    clock.now = resetsAt + 1;
    d.store.index.kick();
    await waitFor(() => vectors(d) === 2, 5000);
  }, 20_000);
});
