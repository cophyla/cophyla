// The cloud module through the daemon against the fake server: the device-code login and
// the logout, the route list over the hosted model and a BYOK fallback, forged and expired
// entitlements, hosted speech through the voice pipeline, the beta feed behind the bearer,
// the audit's redaction, the exact set of methods the server ever sees, a server restart,
// and a pushed entitlement reaching the row, the clients and the brain.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FREE_ENTITLEMENT, RpcError } from "@cophyla/protocol";
import type { ClientNotificationParams } from "@cophyla/protocol";
import type { Daemon } from "../src/daemon.ts";
import { paths } from "../src/config/load.ts";
import type { EntitlementKey } from "../src/cloud/keys.ts";
import { Store } from "../src/store/index.ts";
import { FakeEngines, b64, silenceChunk, speechChunk, wakeChunk } from "../src/voice/fake.ts";
import { finish, startGeminiFake, text as geminiText } from "./fakes/gemini.ts";
import { FakeServer, serverKey } from "./fakes/server.ts";
import { removeHome, sleep, tempHome, TestClient, tomlString, waitFor } from "./helpers.ts";

type AccountState = ClientNotificationParams<"account.state">;

const FAKE_BRAIN = join(import.meta.dir, "fakes", "brain.ts");

interface StartOptions {
  /** Pre-write the account token file, as a completed login leaves it. */
  signedIn?: boolean;
  /** Pre-store this entitlement token in the row (a forged or stale one). */
  row?: string;
  /** The route list; the default is the config's default. */
  llm?: string[];
  /** A Gemini fake for the byok route. */
  gemini?: boolean;
  brain?: boolean;
  voice?: boolean;
  /** `[voice] stt` with voice on: `server`, the live engine's old name, unless given. */
  stt?: string;
  keys?: EntitlementKey[];
  refreshMs?: number;
  update?: string;
  fake?: FakeServer;
}

interface Started {
  d: Daemon & { home: string };
  fake: FakeServer;
  c: TestClient;
  engines: FakeEngines;
  opened: string[];
  brainLog: string;
  gemini?: ReturnType<typeof startGeminiFake>;
  scriptPath: string;
}

let current: Started | undefined;
afterEach(async () => {
  if (!current) return;
  const s = current;
  current = undefined;
  try {
    s.c.close();
  } catch {
    // already closed
  }
  await s.d.stop();
  await s.fake.stop();
  s.gemini?.stop();
  removeHome(s.d.home);
});

async function start(opts: StartOptions = {}): Promise<Started> {
  const fake = opts.fake ?? new FakeServer();
  const scratch = tempHome();
  const brainLog = join(scratch, "brain.log");
  const scriptPath = join(scratch, "brain-script.json");
  writeFileSync(scriptPath, JSON.stringify({ on: [] }));
  const gemini = opts.gemini ? startGeminiFake({ scripts: { default: [geminiText("From your own key."), finish("STOP")] } }) : undefined;
  const brain = opts.brain ? `[brain]\ncommand = ${tomlString(FAKE_BRAIN)}\nrestart_backoff_ms = 100\nhello_timeout_ms = 5000\n\n[gate.rules]\n"brain:voice.speak" = "allow"\n"brain:ui.say" = "allow"\n\n` : "";
  const voice = opts.voice ? `[voice]\nenabled = true\nstt = "${opts.stt ?? "server"}"\ntts = "server"\n\n` : "";
  const providers = `[providers]\n${opts.llm ? `llm = [${opts.llm.map((r) => JSON.stringify(r)).join(", ")}]\n` : ""}${gemini ? `[providers.gemini]\napi_key = "k"\nbase_url = "${gemini.url}"\n` : ""}\n`;
  const toml = `[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\n\n${opts.update ?? "[update]\nenabled = false\n"}\n${brain}${voice}${providers}[cloud]\nenabled = true\nurl = "${fake.url}"\nallow_insecure = true\nrefresh_interval_ms = ${opts.refreshMs ?? 60000}\nreconnect_ms = 20\nreconnect_max_ms = 100\n`;
  writeFileSync(join(scratch, "config.toml"), toml);
  const p = paths(scratch);
  mkdirSync(p.data, { recursive: true });
  if (opts.signedIn) writeFileSync(p.accountToken, fake.mintToken("test") + "\n", { mode: 0o600 });
  if (opts.row) {
    const store = new Store(p.db);
    store.migrate();
    store.entitlement.put(opts.row, {}, Date.now());
    store.close();
  }
  const engines = new FakeEngines({ transcript: "ignored by the hosted recogniser" });
  const opened: string[] = [];
  const { startDaemon } = await import("../src/daemon.ts");
  const { silentLogger } = await import("../src/log.ts");
  const d = Object.assign(
    await startDaemon({
      home: scratch,
      port: 0,
      log: silentLogger,
      brain: Boolean(opts.brain),
      embedder: null,
      voice: { engines, affinity: null },
      cloud: { keys: opts.keys ?? [fake.publicKey], openBrowser: async (url) => void opened.push(url) },
      env: { ...process.env, FAKE_BRAIN_SCRIPT: scriptPath, FAKE_BRAIN_LOG: brainLog, GEMINI_API_KEY: undefined },
    }),
    { home: scratch },
  );
  const c = await TestClient.connect(d.api.url);
  await c.hello(d.token, { name: "desktop" });
  current = { d, fake, c, engines, opened, brainLog, scriptPath, ...(gemini ? { gemini } : {}) };
  return current;
}

const accountStates = (c: TestClient): AccountState[] => c.notifications.filter((n) => n.method === "account.state").map((n) => n.params as AccountState);
const lastAccount = (c: TestClient): AccountState | undefined => accountStates(c).at(-1);
const brainFrames = (log: string): { dir: string; frame: Record<string, unknown> }[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const entitlementsToBrain = (log: string): string[] => brainFrames(log).filter((f) => f.dir === "in" && f.frame["method"] === "entitlement.updated").map((f) => (f.frame["params"] as { token: string }).token);
const decode = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
const ask = (text: string) => ({ model: { tier: "fast" as const }, messages: [{ role: "user" as const, content: [{ type: "text" as const, text }] }] });

describe("cloud", () => {
  test("login: the code is answered at once, the token lands 0600, the link auths and refreshes, clients hear the plan", async () => {
    const { d, fake, c, opened } = await start();
    expect(lastAccount(c)).toBeUndefined();
    // the welcome carried the signed-out state (the notification precedes the hello result in the stream, so look at the whole list)
    const initial = await c.next((n) => n.method === "account.state");
    expect(initial.params).toEqual({ plan: "free", limits: { ...FREE_ENTITLEMENT.limits, hosted: FREE_ENTITLEMENT.hosted, brainChannel: "stable" }, backup: { enabled: false, state: "idle" } });
    const r = await c.request<{ verificationUrl: string; userCode: string; expiresAt: number }>("account.login");
    expect(r.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(r.verificationUrl).toContain(r.userCode);
    expect(opened).toEqual([r.verificationUrl]);
    expect(existsSync(d.paths.accountToken)).toBe(false);
    expect(await c.call("account.login")).toMatchObject({ error: { data: { code: "conflict" } } });
    fake.approve(r.userCode);
    await waitFor(() => existsSync(d.paths.accountToken));
    const token = readFileSync(d.paths.accountToken, "utf8").trim();
    expect(fake.tokens.get(token)).toBeDefined();
    if (process.platform !== "win32") expect(statSync(d.paths.accountToken).mode & 0o777).toBe(0o600);
    await waitFor(() => fake.seen.includes("entitlement.refresh"));
    expect(fake.seen.slice(0, 2)).toEqual(["auth", "entitlement.refresh"]);
    // a signed-in primary registers with the registry once the plan is known
    await waitFor(() => fake.seen.includes("registry.register"));
    await waitFor(() => d.store.entitlement.get() !== undefined);
    expect(decode(d.store.entitlement.get()!.token).plan).toBe("pro");
    await waitFor(() => lastAccount(c)?.plan === "pro");
    const state = lastAccount(c)!;
    expect(state).toMatchObject({ plan: "pro", subject: fake.subject, connected: true, limits: { sessions: 8, nodes: 5, memoryTier: "full" } });
    expect(state.usage).toMatchObject({ period: "2026-09", metrics: { llm_tokens_in: { used: 0, cap: 2_000_000 } } });
    // a later client's welcome carries it
    const later = await TestClient.connect(d.api.url);
    await later.hello(d.token, { name: "later" });
    const welcome = await later.next((n) => n.method === "account.state");
    expect((welcome.params as AccountState).plan).toBe("pro");
    expect((welcome.params as AccountState).subject).toBe(fake.subject);
    later.close();
    expect(d.cloud.hostedAllowed("llm")).toBeUndefined();
  });

  test("logout revokes over HTTP, deletes the file, clears the row and tells everyone the free plan", async () => {
    const { d, fake, c } = await start({ signedIn: true });
    await waitFor(() => lastAccount(c)?.plan === "pro");
    const token = readFileSync(d.paths.accountToken, "utf8").trim();
    await c.request("account.logout");
    expect(fake.http.some((h) => h.path === "/auth/revoke" && h.headers["authorization"] === `Bearer ${token}`)).toBe(true);
    expect(fake.tokens.get(token)?.revoked).toBe(true);
    expect(existsSync(d.paths.accountToken)).toBe(false);
    expect(d.store.entitlement.get()).toBeUndefined();
    const state = lastAccount(c)!;
    expect(state.plan).toBe("free");
    expect(state.subject).toBeUndefined();
    expect(state.connected).toBeUndefined();
    expect(d.cloud.hostedAllowed("llm")?.message).toContain("not signed in");
    await waitFor(() => fake.links === 0);
    // the logout works with the link down too: nothing to revoke against is not an error
    await c.request("account.logout");
  });

  test("the route list: the server serves when entitled, byok on quota_exceeded, the last refusal when neither can, and the data stays whole alone", async () => {
    const { d, fake, gemini } = await start({ signedIn: true, gemini: true, llm: ["server", "byok:gemini"] });
    await waitFor(() => d.cloud.hostedAllowed("llm") === undefined);
    const deltas: string[] = [];
    const served = await d.llm.complete(ask("what is open"), { onDelta: (x) => x.type === "text" && deltas.push(x.text) });
    expect(served.route).toBe("server");
    expect(served.content).toEqual([{ type: "text", text: "Nothing is open." }]);
    expect(deltas).toEqual(["Nothing ", "is open."]);
    expect(gemini!.requests).toHaveLength(0);
    expect(d.cloud.state().usage?.metrics["llm_tokens_in"]?.used).toBe(42);

    fake.quota = { metric: "llm_tokens_out", resetsAt: Date.UTC(2026, 9, 1) };
    const fell = await d.llm.complete(ask("again"));
    expect(fell.route).toBe("byok:gemini");
    expect(fell.content[0]).toEqual({ type: "text", text: "From your own key." });
    expect(gemini!.requests).toHaveLength(1);

    gemini!.setFail({ status: 503, body: "down" });
    let err: RpcError | undefined;
    try {
      await d.llm.complete(ask("both down"));
    } catch (e) {
      err = e as RpcError;
    }
    // the allowance is the refusal the user can act on: it is raised over the vendor's 503 behind it
    expect(err?.code).toBe("quota_exceeded");
    expect(err?.error.data).toMatchObject({ metric: "llm_tokens_out", resetsAt: Date.UTC(2026, 9, 1) });
    const routes = (err?.error.data as { routes: { route: string; code: string }[] }).routes;
    expect(routes.map((r) => `${r.route}:${r.code}`)).toEqual(["server:quota_exceeded", "byok:gemini:unavailable"]);
    // any other code from a route is the answer at once
    gemini!.setFail(undefined);
    fake.quota = undefined;
    gemini!.setFail({ status: 401, body: "bad key" });
    fake.unavailable = true;
    await expect(d.llm.complete(ask("denied"))).rejects.toMatchObject({ code: "denied" });
    fake.unavailable = false;
    gemini!.setFail(undefined);
  });

  test("[\"server\"] alone raises quota_exceeded with its data whole; signed out it is unavailable", async () => {
    const { d, fake } = await start({ signedIn: true, llm: ["server"] });
    await waitFor(() => d.cloud.hostedAllowed("llm") === undefined);
    fake.quota = { metric: "llm_tokens_in", resetsAt: 1790812800000 };
    let err: RpcError | undefined;
    try {
      await d.llm.complete(ask("x"));
    } catch (e) {
      err = e as RpcError;
    }
    expect(err?.code).toBe("quota_exceeded");
    expect(err?.error.retryable).toBe(true);
    expect(err?.error.data).toMatchObject({ metric: "llm_tokens_in", resetsAt: 1790812800000, routes: [{ route: "server", code: "quota_exceeded" }] });
    fake.quota = undefined;
    await d.cloud.logout();
    await expect(d.llm.complete(ask("x"))).rejects.toMatchObject({ code: "unavailable" });
    expect(fake.llm).toHaveLength(0);
  });

  test("a forged token and one past its grace show as free, while the brain still gets the raw token after hello and after a refresh", async () => {
    const forger = serverKey();
    const fake = new FakeServer();
    fake.signWith(forger.key);
    const forged = fake.entitlement();
    fake.signWith(undefined);
    // the refresh is held back until the brain has heard the stored row
    fake.refuseRefresh = true;
    const { d, c, brainLog } = await start({ fake, signedIn: true, row: forged, brain: true, refreshMs: 200 });
    // at start: the row is forged → free, although it says pro
    const first = accountStates(c)[0] ?? (await c.next((n) => n.method === "account.state")).params;
    expect((first as AccountState).plan).toBe("free");
    expect(decode(forged).plan).toBe("pro");
    await waitFor(() => d.brain?.state === "up");
    await waitFor(() => entitlementsToBrain(brainLog).length >= 1, 5000);
    expect(entitlementsToBrain(brainLog)[0]).toBe(forged);
    expect(lastAccount(c)?.plan).toBe("free");
    // the refresh brings a real one: pro, and the brain hears it too
    fake.refuseRefresh = false;
    await waitFor(() => lastAccount(c)?.plan === "pro", 5000);
    await waitFor(() => entitlementsToBrain(brainLog).length >= 2, 5000);
    const real = entitlementsToBrain(brainLog)[1]!;
    expect(real).not.toBe(forged);
    expect(decode(real).plan).toBe("pro");
    // a token past its grace is free too, whoever signed it
    const stale = fake.entitlement({ issuedAt: Date.now() - 10 * 86400_000, expiresAt: Date.now() - 9 * 86400_000, graceSeconds: 604800 });
    d.store.entitlement.put(stale, {}, Date.now());
    const { verifyEntitlement } = await import("../src/cloud/entitlement.ts");
    expect(verifyEntitlement(stale, [fake.publicKey], Date.now())).toMatchObject({ status: "expired", claims: FREE_ENTITLEMENT });
  });

  test("hosted speech: the utterance streams to the server as it is said, its words come back on the way, the reply comes back as its chunks, no local model is wanted", async () => {
    const { d, fake, c, engines } = await start({
      signedIn: true,
      brain: true,
      voice: true,
    });
    writeFileSync(current!.scriptPath, JSON.stringify({ on: [{ event: "user.message", requests: [{ method: "voice.speak", params: { blocks: [{ type: "text", text: "Nothing is open." }], interrupt: true } }] }] }));
    await d.voice.ready();
    expect(d.voice.stageStates()).toMatchObject({ wake: { status: "ready" }, stt: { status: "ready", engine: "gemini-live" }, tts: { status: "ready", engine: "kokoro-online" } });
    expect(d.update.snapshot().map((u) => (u.component === "model" ? `model:${u.name}` : u.component))).not.toContain("model:stt-nemotron-3.5-streaming-int8");
    expect(d.update.snapshot().map((u) => (u.component === "model" ? `model:${u.name}` : u.component))).not.toContain("model:tts-piper-en");
    expect(engines.models()).toEqual([]);
    await waitFor(() => d.brain?.state === "up");
    await waitFor(() => d.cloud.hostedAllowed("voice") === undefined);
    const phone = await TestClient.connect(d.api.url);
    await phone.hello(d.token, { kind: "controller", name: "Pixel", audio: { in: true, out: true } });
    phone.signal("voice.audio", { chunk: b64(wakeChunk()) });
    await sleep(30);
    const frames = 8;
    for (let i = 0; i < frames; i++) phone.signal("voice.audio", { chunk: b64(speechChunk()) });
    for (let i = 0; i < 20; i++) phone.signal("voice.audio", { chunk: b64(silenceChunk()) });
    await waitFor(() => fake.sttStreams[0]?.ended === "end", 5000);
    // the speech frames and the closing silence are what the VAD handed over, none sent twice
    expect(fake.sttStreams[0]!.samples).toBeGreaterThanOrEqual(frames * 640);
    expect(fake.sttStreams[0]!.samples % 640).toBe(0);
    expect(fake.stt).toEqual([]);
    const msg = await c.next((n) => n.method === "chat.message" && (n.params as { message: { role: string } }).message.role === "user", 5000);
    const message = (msg.params as { message: { id: string; content: { text: string }[] } }).message;
    expect(message.content[0]!.text).toBe(fake.transcript);
    // the phone saw the words grow, and the last it was told named the message they became
    await waitFor(() => phone.notifications.some((n) => n.method === "voice.partial" && (n.params as { message?: string }).message === message.id));
    expect(phone.notifications.filter((n) => n.method === "voice.partial").length).toBeGreaterThanOrEqual(2);
    await waitFor(() => fake.tts.length === 1, 10_000);
    expect(fake.tts[0]).toBe("Nothing is open.");
    await waitFor(() => phone.notifications.filter((n) => n.method === "voice.audio").length >= 1, 5000);
    await sleep(100);
    const heard = Buffer.concat(phone.notifications.filter((n) => n.method === "voice.audio").map((n) => Buffer.from((n.params as { chunk: string }).chunk, "base64")));
    const ramp = fake.ramp();
    expect(heard.length).toBe(ramp.byteLength);
    expect([...new Int16Array(heard.buffer, heard.byteOffset, heard.length / 2)]).toEqual([...ramp]);
    const states = phone.notifications.filter((n) => n.method === "voice.state").map((n) => (n.params as { state: string }).state);
    expect(states.slice(0, 4)).toEqual(["listening", "transcribing", "thinking", "speaking"]);
    expect(d.cloud.state().usage?.metrics["stt_seconds"]?.used).toBeGreaterThanOrEqual(1);
    expect(d.cloud.state().usage?.metrics["tts_chars"]?.used).toBe("Nothing is open.".length);
    phone.close();
  });

  test("the cheaper engine sends each utterance whole once it ends", async () => {
    const { d, fake } = await start({ signedIn: true, voice: true, stt: "gemini" });
    await d.voice.ready();
    expect(d.voice.stageStates().stt).toMatchObject({ status: "ready", engine: "gemini" });
    await waitFor(() => d.cloud.hostedAllowed("voice") === undefined);
    const phone = await TestClient.connect(d.api.url);
    await phone.hello(d.token, { kind: "controller", name: "Pixel", audio: { in: true, out: true } });
    phone.signal("voice.audio", { chunk: b64(wakeChunk()) });
    await sleep(30);
    for (let i = 0; i < 8; i++) phone.signal("voice.audio", { chunk: b64(speechChunk()) });
    for (let i = 0; i < 20; i++) phone.signal("voice.audio", { chunk: b64(silenceChunk()) });
    await waitFor(() => fake.stt.length === 1, 5000);
    expect(fake.stt[0]!.samples).toBeGreaterThanOrEqual(8 * 640);
    expect(fake.sttStreams).toEqual([]);
    phone.close();
  });

  test("the allowance running out mid-utterance ends it there, with the words heard and the reason told", async () => {
    const { d, fake, c } = await start({ signedIn: true, voice: true });
    fake.liveMaxSeconds = 1;
    await d.voice.ready();
    await waitFor(() => d.cloud.hostedAllowed("voice") === undefined);
    const phone = await TestClient.connect(d.api.url);
    await phone.hello(d.token, { kind: "controller", name: "Pixel", audio: { in: true, out: true } });
    await phone.request("voice.ptt", { active: true });
    for (let i = 0; i < 60; i++) {
      phone.signal("voice.audio", { chunk: b64(speechChunk()) });
      if (i % 10 === 9) await sleep(20);
    }
    const transcribing = await phone.next((n) => n.method === "voice.state" && (n.params as { state: string }).state === "transcribing", 5000);
    expect(transcribing.params).toMatchObject({ stopped: "quota" });
    const msg = await c.next((n) => n.method === "chat.message" && (n.params as { message: { role: string } }).message.role === "user", 5000);
    const text = (msg.params as { message: { content: { text: string }[] } }).message.content[0]!.text;
    expect(fake.transcript.startsWith(text) && text.length > 0).toBe(true);
    expect(fake.sttStreams[0]!.ended).toBe("quota");
    await phone.request("voice.ptt", { active: false });
    phone.close();
  });

  test("the audit never holds either token, and the login's code is redacted", async () => {
    const { d, fake, c } = await start();
    const r = await c.request<{ userCode: string }>("account.login");
    fake.approve(r.userCode);
    await waitFor(() => existsSync(d.paths.accountToken));
    await waitFor(() => d.store.entitlement.get() !== undefined);
    const token = readFileSync(d.paths.accountToken, "utf8").trim();
    const jwt = d.store.entitlement.get()!.token;
    await c.request("account.logout");
    const rows = d.store.audit.list({ limit: 200 });
    const login = rows.find((e) => e.action === "account.login")!;
    expect(login).toBeDefined();
    expect(login.result?.summary ?? "").toContain("[redacted]");
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(jwt);
    expect(JSON.stringify(rows)).not.toContain(r.userCode);
    expect(rows.some((e) => e.action === "account.logout")).toBe(true);
  });

  test("the server only ever sees the allowed methods, whatever else happens on the node", async () => {
    const { d, fake, c } = await start({ signedIn: true, brain: true });
    await waitFor(() => d.brain?.state === "up");
    await waitFor(() => d.cloud.hostedAllowed("llm") === undefined);
    await c.request("metrics.subscribe", { intervalMs: 1000 });
    await c.request("chat.send", { text: "hello there" });
    await d.llm.complete(ask("x"));
    d.bus.emit("session.state", { id: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1", node: d.identity.id, harness: "claude", profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", native: { id: "x", transport: "pipe" }, origin: "user", cwd: ".", tags: [], status: "idle", startedAt: 1, lastActivity: 1 } as never);
    await sleep(200);
    // the hosted capabilities, the entitlement, since milestone 12 the registry, the relay and push, since 13 the backup: never a session, a metric or a chat
    const allowed = new Set(["auth", "entitlement.refresh", "llm.complete", "stt.transcribe", "stt.stream", "stt.audio", "stt.end", "tts.speak", "cancel", "registry.register", "registry.heartbeat", "registry.claim", "relay.grant", "relay.revoke", "relay.open", "relay", "relay.close", "push.register", "push.unregister", "push.send", "backup.status"]);
    expect([...new Set(fake.seen)].filter((m) => !allowed.has(m))).toEqual([]);
    // a signed-in primary registered itself and was granted the role
    expect(fake.seen).toContain("registry.register");
    expect(fake.primaryOf()?.primary).toBe(d.identity.id);
    expect(fake.http.map((h) => h.path).every((p) => p.startsWith("/auth/") || p === "/ws/link" || p.startsWith("/releases/"))).toBe(true);
  });

  test("a server restart: a second auth, connected false then true", async () => {
    const { d, fake, c } = await start({ signedIn: true });
    await waitFor(() => lastAccount(c)?.connected === true);
    fake.restart();
    await waitFor(() => accountStates(c).some((s) => s.connected === false));
    await waitFor(() => fake.seen.filter((m) => m === "auth").length === 2, 5000);
    await waitFor(() => lastAccount(c)?.connected === true, 5000);
    expect(d.cloud.hostedAllowed("llm")).toBeUndefined();
  });

  test("a pushed entitlement reaches the row, the clients and the brain", async () => {
    const { d, fake, c, brainLog } = await start({ signedIn: true, brain: true });
    await waitFor(() => d.brain?.state === "up");
    await waitFor(() => lastAccount(c)?.plan === "pro");
    await waitFor(() => entitlementsToBrain(brainLog).length >= 1, 5000);
    const before = entitlementsToBrain(brainLog).length;
    expect(fake.setPlan("free")).toBe(1);
    await waitFor(() => lastAccount(c)?.plan === "free");
    expect(decode(d.store.entitlement.get()!.token).plan).toBe("free");
    await waitFor(() => entitlementsToBrain(brainLog).length > before, 5000);
    expect(decode(entitlementsToBrain(brainLog).at(-1)!).plan).toBe("free");
    expect(d.cloud.hostedAllowed("llm")?.message).toContain("the plan has no hosted llm");
    fake.setPlan("pro");
    await waitFor(() => lastAccount(c)?.plan === "pro");
  });
});
