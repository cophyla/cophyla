// Voice models as a release component: a model is wanted only while a stage that needs it is
// on, it carries a name instead of an OS, and it is unpacked under `data/models/<name>/` and
// checked against the hashes in its own manifest before anything loads it. A first install
// promotes itself, since nothing holds the old copy open; a later version waits for
// `update.apply {component: "model", name}` or for a quiet moment.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientNotificationParams, Release } from "@cophyla/protocol";
import { Bus } from "../src/bus.ts";
import { silentLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";
import { Update } from "../src/update/index.ts";
import { ModelStore, verifyModelDir } from "../src/update/models.ts";
import { defaultTar } from "../src/update/platform.ts";
import { signRelease } from "../src/update/verify.ts";
import { readVoiceManifest, verifyVoiceDir } from "../src/voice/manifest.ts";
import { FakeFeed, KEY } from "./fakes/feed.ts";
import { removeHome, tempHome, waitFor } from "./helpers.ts";

type UpdateState = ClientNotificationParams<"update.state">;

const TAR = defaultTar();
const MODEL = "tts-kokoro-en";

interface Started {
  update: Update;
  feed: FakeFeed;
  store: Store;
  home: string;
  states: UpdateState[];
  models: string[];
}

let current: Started | undefined;

afterEach(async () => {
  if (!current) return;
  current.update.dispose();
  current.store.close();
  await current.feed.stop();
  removeHome(current.home);
  current = undefined;
});

/** A model directory as the feed ships it: files, a manifest that hashes them, tarred up. */
async function modelArchive(scratch: string, name: string, version: string, opts: { body?: string; tamper?: boolean } = {}): Promise<Uint8Array> {
  const dir = join(scratch, `${name}-${version}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const body = opts.body ?? `model bytes ${version}`;
  writeFileSync(join(dir, "model.onnx"), body);
  writeFileSync(join(dir, "tokens.txt"), "a b c\n");
  const hash = (f: string) => createHash("sha256").update(readFileSync(join(dir, f))).digest("hex");
  const manifest = {
    name,
    kind: "tts",
    version,
    params: { model: "model.onnx", tokens: "tokens.txt", sampleRate: 24000 },
    files: { "model.onnx": hash("model.onnx"), "tokens.txt": hash("tokens.txt") },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  // A tampered archive keeps the manifest but changes a file after it was hashed.
  if (opts.tamper) writeFileSync(join(dir, "model.onnx"), body + " changed");
  const out = join(scratch, `${name}-${version}.tar.gz`);
  const proc = Bun.spawn([TAR, "-czf", out, "-C", dir, "."], { stdout: "ignore", stderr: "pipe", windowsHide: true });
  if ((await proc.exited) !== 0) throw new Error(`tar failed: ${await new Response(proc.stderr).text()}`);
  return new Uint8Array(readFileSync(out));
}

function start(): Started {
  const home = tempHome();
  const feed = new FakeFeed();
  const store = new Store(":memory:");
  store.migrate();
  const bus = new Bus();
  const states: UpdateState[] = [];
  const models: string[] = [];
  bus.on("update.state", (s) => states.push(s));
  const update = new Update({
    config: { enabled: false, channel: "stable", feed: feed.url, check_interval_ms: 60000, first_check_delay_ms: 0, auto_apply: true, allow_insecure_feed: false },
    dataDir: join(home, "data"),
    nodeId: "node_test",
    platformVersion: "0.2.0",
    keys: [KEY.pub],
    brain: () => undefined,
    locate: () => undefined,
    busy: () => [],
    uiConnected: () => false,
    exit: () => {},
    store,
    bus,
    log: silentLogger,
    onModel: (name) => models.push(name),
    voiceIdle: () => true,
  });
  update.start();
  current = { update, feed, store, home, states, models };
  return current;
}

const rows = (states: UpdateState[], name = MODEL) => states.filter((s) => s.component === "model" && s.name === name);

describe("model releases", () => {
  test("a wanted model is fetched, checked, unpacked and made current on a first install", async () => {
    const s = start();
    s.feed.body = { releases: [await s.feed.entry("model", "1.0.0", MODEL, await modelArchive(s.home, MODEL, "1.0.0"))] };

    const dir = await s.update.ensureModel(MODEL);
    expect(dir).toBeDefined();
    expect(existsSync(join(dir!, "model.onnx"))).toBe(true);
    expect(readVoiceManifest(dir!)!.version).toBe("1.0.0");
    // The signed entry lands beside the files and checks out.
    expect(verifyModelDir(dir!, [KEY.pub]).ok).toBe(true);
    expect(verifyVoiceDir(dir!).ok).toBe(true);
    expect(s.models).toEqual([MODEL]);
    // It is listed in the snapshot with its name and version, and the progress was published.
    expect(s.update.snapshot().find((r) => r.component === "model" && r.name === MODEL)).toMatchObject({ current: "1.0.0" });
    expect(rows(s.states).some((r) => r.progress !== undefined)).toBe(true);
    expect(s.update.wantedModels).toEqual([MODEL]);
    // A second ask is answered from disk without another request.
    const before = s.feed.seen.length;
    expect(await s.update.ensureModel(MODEL)).toBe(dir!);
    expect(s.feed.seen.length).toBe(before);
  }, 20_000);

  test("a newer version is staged and waits, and apply promotes it and says so", async () => {
    const s = start();
    s.feed.body = { releases: [await s.feed.entry("model", "1.0.0", MODEL, await modelArchive(s.home, MODEL, "1.0.0"))] };
    const first = await s.update.ensureModel(MODEL);
    s.models.length = 0;

    s.feed.body = { releases: [await s.feed.entry("model", "1.1.0", MODEL, await modelArchive(s.home, MODEL, "1.1.0"))] };
    // A busy conversation holds the promotion back; the check still stages it.
    let idle = false;
    (s.update as unknown as { deps: { voiceIdle: () => boolean } }).deps.voiceIdle = () => idle;
    await s.update.trigger("test").done;
    expect(rows(s.states).at(-1)).toMatchObject({ current: "1.0.0", available: "1.1.0", staged: "1.1.0" });
    expect(s.update.modelDir(MODEL)).toBe(first!);
    expect(s.models).toEqual([]);
    await expect(s.update.apply("model", MODEL)).rejects.toThrow(/voice conversation/);

    idle = true;
    await s.update.apply("model", MODEL);
    expect(readVoiceManifest(s.update.modelDir(MODEL)!)!.version).toBe("1.1.0");
    expect(s.models).toEqual([MODEL]);
    expect(rows(s.states).at(-1)).toMatchObject({ current: "1.1.0" });
    expect(rows(s.states).at(-1)!.staged).toBeUndefined();
    // The old version is gone: one copy per model is kept.
    expect(existsSync(first!)).toBe(false);
  }, 20_000);

  test("an archive whose bytes changed after signing is refused, and nothing is left behind", async () => {
    const s = start();
    const bytes = await modelArchive(s.home, MODEL, "1.0.0", { tamper: true });
    s.feed.body = { releases: [await s.feed.entry("model", "1.0.0", MODEL, bytes)] };
    expect(await s.update.ensureModel(MODEL)).toBeUndefined();
    expect(s.update.modelDir(MODEL)).toBeUndefined();
    expect(existsSync(join(s.home, "data", "models", MODEL, "1.0.0"))).toBe(false);
    expect(existsSync(join(s.home, "data", "models", MODEL, "1.0.0.partial"))).toBe(false);
    expect(s.models).toEqual([]);
  }, 20_000);

  test("an entry signed by another key is dropped before anything is downloaded", async () => {
    const s = start();
    const other = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const good = await s.feed.entry("model", "1.0.0", MODEL, await modelArchive(s.home, MODEL, "1.0.0"));
    s.feed.body = { releases: [signRelease({ ...good, signature: undefined } as unknown as Record<string, unknown>, other) as unknown as Release] };
    expect(await s.update.ensureModel(MODEL)).toBeUndefined();
    expect(s.feed.seen.some((r) => r.path.startsWith("/artifacts/"))).toBe(false);
  }, 20_000);

  test("a model nobody asked for is never fetched", async () => {
    const s = start();
    s.feed.body = { releases: [await s.feed.entry("model", "1.0.0", MODEL, await modelArchive(s.home, MODEL, "1.0.0"))] };
    await s.update.trigger("test").done;
    expect(s.feed.seen.some((r) => r.path.startsWith("/artifacts/"))).toBe(false);
    expect(s.update.snapshot().some((r) => r.component === "model")).toBe(false);
  }, 20_000);

  test("apply without a name is invalid, and with no staged version is not found", async () => {
    const s = start();
    await expect(s.update.apply("model")).rejects.toThrow(/needs its name/);
    await expect(s.update.apply("model", MODEL)).rejects.toThrow(/no tts-kokoro-en release is staged/);
  });
});

describe("the model store", () => {
  test("keeps one current version behind a pointer and reports what is staged", async () => {
    const home = tempHome();
    try {
      const store = new ModelStore(join(home, "data"));
      const bytes = await modelArchive(home, MODEL, "1.0.0");
      const archive = join(home, "one.tar.gz");
      writeFileSync(archive, bytes);
      const release = { component: "model", name: MODEL, version: "1.0.0", channel: "stable", url: "x", size: bytes.byteLength, sha256: "0".repeat(64), signature: "ed25519:x", publishedAt: 1 } as Release;
      const dir = await store.stage(archive, release);
      expect(store.currentVersion(MODEL)).toBeUndefined();
      expect(store.stagedVersion(MODEL)).toBe("1.0.0");
      expect(store.known()).toEqual([MODEL]);
      store.promote(MODEL, "1.0.0");
      expect(store.currentVersion(MODEL)).toBe("1.0.0");
      expect(store.currentDir(MODEL)).toBe(dir);
      expect(store.stagedVersion(MODEL)).toBeUndefined();
      // A directory whose files no longer match its manifest is not complete, so it is not current.
      writeFileSync(join(dir, "model.onnx"), "tampered on disk");
      expect(store.isComplete(MODEL, "1.0.0")).toBe(false);
      expect(store.currentVersion(MODEL)).toBeUndefined();
    } finally {
      removeHome(home);
    }
  }, 20_000);

  test("an archive holding another model is refused", async () => {
    const home = tempHome();
    try {
      const store = new ModelStore(join(home, "data"));
      const bytes = await modelArchive(home, "wake-openwakeword", "1.0.0");
      const archive = join(home, "wrong.tar.gz");
      writeFileSync(archive, bytes);
      const release = { component: "model", name: MODEL, version: "1.0.0", channel: "stable", url: "x", size: 1, sha256: "0".repeat(64), signature: "ed25519:x", publishedAt: 1 } as Release;
      await expect(store.stage(archive, release)).rejects.toThrow(/holds wake-openwakeword/);
      expect(store.versions(MODEL)).toEqual([]);
    } finally {
      removeHome(home);
    }
  }, 20_000);
});

describe("the daemon's model wiring", () => {
  test("a staged model is picked up at start and reported", async () => {
    const s = start();
    // A version already on disk from an earlier run, with nothing current.
    const bytes = await modelArchive(s.home, MODEL, "2.0.0");
    const archive = join(s.home, "staged.tar.gz");
    writeFileSync(archive, bytes);
    const store = new ModelStore(join(s.home, "data"));
    const release = { component: "model", name: MODEL, version: "2.0.0", channel: "stable", url: "x", size: bytes.byteLength, sha256: "0".repeat(64), signature: "ed25519:x", publishedAt: 1 } as Release;
    await store.stage(archive, release);
    // `ensureModel` promotes it without going near the feed: a first install holds nothing open.
    const before = s.feed.seen.length;
    const dir = await s.update.ensureModel(MODEL);
    expect(readVoiceManifest(dir!)!.version).toBe("2.0.0");
    expect(s.feed.seen.length).toBe(before);
    await waitFor(() => s.models.includes(MODEL));
  }, 20_000);
});
