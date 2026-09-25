// A paired phone through the server relay: the access minted at pairing, a fake phone
// (`@cophyla/relay`'s peer session, the same code the app runs) saying hello inside the
// tunnel and being served like a LAN socket, what the relay refuses, the revoke, the
// access asked for later when pairing happened signed out, and a voice turn in Opus with
// its played ack. The fake server routes ciphertext it never opens; the daemon is the only
// decryptor.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Controller, RelayAccess } from "@cophyla/protocol";
import { PeerSession, pskFromHex } from "@cophyla/relay";
import { paths } from "../src/config/load.ts";
import type { Daemon } from "../src/daemon.ts";
import { FakeEngines } from "../src/voice/fake.ts";
import { OpusDecoder, OpusEncoder } from "../src/voice/opus.ts";
import { FakeServer } from "./fakes/server.ts";
import { removeHome, sleep, tempHome, TestClient, waitFor } from "./helpers.ts";

interface Started {
  d: Daemon & { home: string };
  fake: FakeServer;
  ui: TestClient;
  wss: string;
}

let current: Started | undefined;
const phones: TestClient[] = [];
const sessions: PeerSession[] = [];

afterEach(async () => {
  for (const p of phones.splice(0)) p.close();
  for (const s of sessions.splice(0)) s.close();
  if (!current) return;
  const s = current;
  current = undefined;
  s.ui.close();
  await s.d.stop();
  await s.fake.stop();
  removeHome(s.d.home);
});

async function start(opts: { signedIn?: boolean; fake?: FakeServer; voice?: FakeEngines } = {}): Promise<Started> {
  const fake = opts.fake ?? new FakeServer();
  const voice = opts.voice ? `\n[voice]\nenabled = true\nwake = "off"\n` : "";
  const home = tempHome(`[controller]\nenabled = true\nport = 0\n\n[nodes]\ndiscovery = false\n\n[cloud]\nenabled = true\nurl = "${fake.url}"\nallow_insecure = true\nreconnect_ms = 20\nreconnect_max_ms = 100\n${voice}`);
  const p = paths(home);
  mkdirSync(p.data, { recursive: true });
  if (opts.signedIn !== false) writeFileSync(p.accountToken, fake.mintToken("test") + "\n", { mode: 0o600 });
  const { startDaemon } = await import("../src/daemon.ts");
  const { silentLogger } = await import("../src/log.ts");
  const d = Object.assign(
    await startDaemon({ home, port: 0, log: silentLogger, embedder: null, cloud: { keys: [fake.publicKey], openBrowser: async () => undefined }, ...(opts.voice ? { voice: { engines: opts.voice, affinity: null } } : {}) }),
    { home },
  );
  if (opts.voice) await d.voice.ready();
  const ui = await TestClient.connect(d.api.url);
  await ui.hello(d.token, { name: "desktop" });
  if (opts.signedIn !== false) await waitFor(() => d.cloud.hostedAllowed("relay") === undefined, 5000);
  current = { d, fake, ui, wss: `https://127.0.0.1:${d.controller!.port}/ws/client` };
  return current;
}

/** A phone on the LAN listener, accepting the self-signed certificate. */
async function lanPhone(wss: string): Promise<TestClient> {
  const c = await TestClient.connect(wss, { insecure: true });
  phones.push(c);
  return c;
}

/** Pairs a phone on the LAN: the token, the controller and the relay access when the node had it. */
async function pair(s: Started, name = "Pixel 8"): Promise<{ token: string; client: Controller; relay?: RelayAccess }> {
  const offer = await s.ui.request<{ code: string }>("pair.start", {});
  const p = await lanPhone(s.wss);
  const claimed = await p.request<{ token: string; client: Controller; relay?: RelayAccess }>("pair.claim", { code: offer.code, name });
  p.close();
  return claimed;
}

/** JSON-RPC inside a tunnel: the phone's side of the client protocol over the peer session. */
class TunnelClient {
  readonly session: PeerSession;
  readonly notifications: { method: string; params: unknown }[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private pending = new Map<number, (m: { result?: unknown; error?: { data?: { code: string; message: string } } }) => void>();
  private waiters: { test: (n: { method: string; params: unknown }) => boolean; resolve: (n: { method: string; params: unknown }) => void }[] = [];
  private n = 0;

  constructor(access: RelayAccess, keyHex = access.key) {
    let resolveClosed!: (c: { code: number; reason: string }) => void;
    this.closed = new Promise((r) => (resolveClosed = r));
    this.session = new PeerSession(
      { url: access.url, token: access.token, peer: access.peer, psk: pskFromHex(keyHex) },
      {
        onText: (text) => {
          const m = JSON.parse(text) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { data?: { code: string; message: string } } };
          if (m.method !== undefined) {
            const n = { method: m.method, params: m.params };
            this.notifications.push(n);
            for (const w of [...this.waiters]) if (w.test(n)) (this.waiters.splice(this.waiters.indexOf(w), 1), w.resolve(n));
            return;
          }
          if (typeof m.id === "number") {
            this.pending.get(m.id)?.(m);
            this.pending.delete(m.id);
          }
        },
        onClose: (code, reason) => resolveClosed({ code, reason }),
      },
    );
    sessions.push(this.session);
  }

  connect(): Promise<{ peer: string }> {
    return this.session.connect();
  }

  call(method: string, params: unknown = {}): Promise<{ result?: unknown; error?: { data?: { code: string; message: string } } }> {
    const id = ++this.n;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.session.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** A notification with no id: what the phone's microphone frames and its played ack are. */
  signal(method: string, params: unknown): void {
    this.session.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  next(test: (n: { method: string; params: unknown }) => boolean, ms = 5000): Promise<{ method: string; params: unknown }> {
    const have = this.notifications.find(test);
    if (have) return Promise.resolve(have);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no notification")), ms);
      this.waiters.push({ test, resolve: (n) => (clearTimeout(t), resolve(n)) });
    });
  }
}

describe("cloud relay", () => {
  test("pairing hands the phone its relay access; the phone says hello through the tunnel and is served like a LAN client", async () => {
    const s = await start();
    const { d, fake } = s;
    const claimed = await pair(s);
    expect(claimed.relay).toBeDefined();
    const access = claimed.relay!;
    expect(access).toMatchObject({ url: fake.url, peer: claimed.client.id });
    expect(access.key).toMatch(/^[0-9a-f]{64}$/);
    expect(access.token.startsWith("rly_")).toBe(true);
    expect(claimed.client.relay).toBe(true);
    expect(fake.seen).toContain("relay.grant");
    // the desktop's list shows the grant
    const listed = await s.ui.request<{ controllers: Controller[] }>("controller.list", {});
    expect(listed.controllers[0]).toMatchObject({ id: claimed.client.id, relay: true });

    const phone = new TunnelClient(access);
    const { peer } = await phone.connect();
    expect(peer).toBe(d.identity.id);
    expect(fake.tunnelCount).toBe(1);
    const hello = await phone.call("hello", { token: claimed.token, kind: "controller", name: "Pixel 8", audio: { in: true, out: true } });
    expect(hello.result).toMatchObject({ node: d.identity.id, client: { kind: "controller", controller: claimed.client.id, via: "relay" } });
    const listedAgain = await s.ui.request<{ controllers: Controller[] }>("controller.list", {});
    expect(listedAgain.controllers[0]!.connected).toBe(true);
    expect(d.clients.list().find((c) => c.controller === claimed.client.id)?.via).toBe("relay");

    // a request through the gate, audited under the phone's principal
    const sessions = await phone.call("session.list", {});
    expect(sessions.result).toEqual({ sessions: [] });
    const rows = d.store.audit.list({ limit: 50 });
    const helloRow = rows.find((e) => e.action === "hello" && e.result?.summary !== undefined);
    expect(helloRow).toBeDefined();
    expect(rows.some((e) => e.action === "session.list")).toBe(true);
    // an ask reaches the phone as a notification inside the tunnel
    const ask = d.asks.open({ type: "choice", source: { kind: "brain" }, title: "Through the relay?", options: [{ id: "y", label: "Yes" }], answerableBy: ["user"] });
    const heard = await phone.next((n) => n.method === "ask.state" && (n.params as { id: string }).id === ask.id);
    expect((heard.params as { title: string }).title).toBe("Through the relay?");
    const answered = await phone.call("ask.answer", { id: ask.id, option: "y" });
    expect(answered.result).toEqual({});
    expect(d.asks.get(ask.id)?.status).toBe("answered");
    // the two requests that answer a URL are not served over the relay; pairing is not either
    expect((await phone.call("view.stage", { id: "default" })).error?.data?.code).toBe("unsupported");
    expect((await phone.call("remote.open", { node: d.identity.id })).error?.data?.code).toBe("unsupported");
    expect((await phone.call("pair.claim", { code: "123456", name: "x" })).error?.data?.code).toBe("unsupported");
    // the server saw ciphertext only: no frame it routed parses as JSON, and the meter grew
    expect(fake.used["relay_messages"]).toBeGreaterThan(4);
    expect(fake.seen.filter((m) => m === "relay").length).toBeGreaterThan(4);
    expect(d.cloud.tunnelPeers).toEqual([{ peer: claimed.client.id, kind: "controller" }]);
    // the phone leaves: the tunnel is gone on both sides and the client is disconnected
    phone.session.close();
    await waitFor(() => fake.tunnelCount === 0);
    await waitFor(() => d.clients.byController(claimed.client.id).length === 0);
    expect(d.cloud.tunnelPeers).toEqual([]);
  });

  test("a phone with the wrong secret gets its tunnel closed on the first record", async () => {
    const s = await start();
    const claimed = await pair(s);
    const phone = new TunnelClient(claimed.relay!, "00".repeat(32));
    await phone.connect();
    void phone.call("hello", { token: claimed.token, kind: "controller", audio: { in: true, out: true } });
    const closed = await phone.closed;
    expect(closed.code).toBe(4409);
    expect(closed.reason).toBe("unauthorized");
    await waitFor(() => s.fake.tunnelCount === 0);
    // nothing was served: no client, no audit row for a hello
    expect(s.d.clients.byController(claimed.client.id)).toEqual([]);
    expect(s.d.store.audit.list({ limit: 50 }).some((e) => e.action === "hello" && e.principal.kind === "user" && e.principal.client !== s.ui.notifications.length.toString())).toBe(true);
  });

  test("a bad controller token inside the tunnel is refused like on the LAN; a stranger's peer id is denied by the node", async () => {
    const s = await start();
    const claimed = await pair(s);
    const phone = new TunnelClient(claimed.relay!);
    await phone.connect();
    const refused = await phone.call("hello", { token: "deadbeef", kind: "controller", audio: { in: true, out: true } });
    expect(refused.error?.data?.code).toBe("denied");
    const closed = await phone.closed;
    expect(closed.code).toBe(4409);
    // a relay token the server holds for a peer this node never paired: the node refuses the open
    const other = { ...claimed.relay!, peer: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC9" };
    s.fake.relayTokens.set(other.peer, { token: "rly_fake_stranger", node: s.d.identity.id, kind: "controller", revoked: false });
    const stranger = new TunnelClient({ ...other, token: "rly_fake_stranger" });
    await expect(stranger.connect()).rejects.toMatchObject({ code: "denied" });
  });

  test("controller.revoke closes the tunnel, revokes the grant, and the token no longer authenticates at the relay", async () => {
    const s = await start();
    const claimed = await pair(s);
    const phone = new TunnelClient(claimed.relay!);
    await phone.connect();
    await phone.call("hello", { token: claimed.token, kind: "controller", audio: { in: true, out: true } });
    await s.ui.request("controller.revoke", { id: claimed.client.id });
    // the node closes the client (4409 through the tunnel) and revokes the grant (4401 from the server): whichever lands first
    const closed = await phone.closed;
    expect([4401, 4409]).toContain(closed.code);
    await waitFor(() => s.fake.relayTokens.get(claimed.client.id)?.revoked === true);
    expect(s.fake.seen).toContain("relay.revoke");
    const again = new TunnelClient(claimed.relay!);
    await expect(again.connect()).rejects.toMatchObject({ code: "denied" });
  });

  test("paired signed out: no access in the claim; relay.info answers it once signed in, and is a phone's request alone", async () => {
    const s = await start({ signedIn: false });
    const claimed = await pair(s);
    expect(claimed.relay).toBeUndefined();
    expect(claimed.client.relay).toBeUndefined();
    const lan = await lanPhone(s.wss);
    await lan.request("hello", { token: claimed.token, kind: "controller", audio: { in: true, out: true } });
    const early = await lan.call("relay.info", {});
    expect(early).toMatchObject({ error: { data: { code: "unavailable" } } });
    // the desktop cannot ask for a phone's access
    expect(await s.ui.call("relay.info", {})).toMatchObject({ error: { data: { code: "denied" } } });
    // sign in through the device flow
    await s.ui.request("account.login", {});
    s.fake.approve();
    await waitFor(() => s.d.cloud.hostedAllowed("relay") === undefined, 5000);
    const access = await lan.request<RelayAccess>("relay.info", {});
    expect(access).toMatchObject({ url: s.fake.url, peer: claimed.client.id });
    expect((await s.ui.request<{ controllers: Controller[] }>("controller.list", {})).controllers[0]!.relay).toBe(true);
    const phone = new TunnelClient(access);
    await phone.connect();
    const hello = await phone.call("hello", { token: claimed.token, kind: "controller", audio: { in: true, out: true } });
    expect(hello.result).toMatchObject({ client: { via: "relay" } });
    // a fresh grant replaces the token a tunnel holds, so the access is a LAN request alone
    expect((await phone.call("relay.info", {})).error?.data?.code).toBe("unsupported");
    const again = await lan.request<RelayAccess>("relay.info", {});
    expect(again.peer).toBe(claimed.client.id);
    expect(again.key).toBe(access.key);
    expect(again.token).not.toBe(access.token);
  });

  test("the server link dropping closes every tunnel; the phone reconnects once it is back", async () => {
    const s = await start();
    const claimed = await pair(s);
    const phone = new TunnelClient(claimed.relay!);
    await phone.connect();
    await phone.call("hello", { token: claimed.token, kind: "controller", audio: { in: true, out: true } });
    s.fake.restart();
    const closed = await phone.closed;
    expect(closed.code).toBe(4409);
    await waitFor(() => s.d.clients.byController(claimed.client.id).length === 0);
    await waitFor(() => s.d.cloud.hostedAllowed("relay") === undefined, 5000);
    await sleep(50);
    const again = new TunnelClient(claimed.relay!);
    await again.connect();
    expect((await again.call("hello", { token: claimed.token, kind: "controller", audio: { in: true, out: true } })).result).toBeDefined();
  });

  test("a voice turn through the tunnel: Opus up and down, numbered, and speaking ends on the phone's voice.played", async () => {
    const engines = new FakeEngines({ transcript: "what is open", msPerSentence: 200 });
    const s = await start({ voice: engines });
    const claimed = await pair(s);
    const phone = new TunnelClient(claimed.relay!);
    await phone.connect();
    const hello = await phone.call("hello", { token: claimed.token, kind: "controller", audio: { in: true, out: true, codecs: ["opus", "pcm"], played: true } });
    expect((hello.result as { audio?: unknown }).audio).toEqual({ codecs: ["opus", "pcm"] });
    const state = (want: string) => phone.next((n) => n.method === "voice.state" && (n.params as { state: string }).state === want);

    // the button, and 240 ms of a tone as Opus, each frame numbered
    expect((await phone.call("voice.ptt", { active: true })).error).toBeUndefined();
    const enc = new OpusEncoder(16000, 24_000);
    for (let f = 0; f < 6; f++) {
      const pcm = new Int16Array(640);
      for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(3000 * Math.sin((2 * Math.PI * 300 * (f * 640 + i)) / 16000));
      phone.signal("voice.audio", { chunk: Buffer.from(enc.encode(pcm)).toString("base64"), codec: "opus", seq: f });
    }
    enc.close();
    await sleep(100);
    await phone.call("voice.ptt", { active: false });
    // heard: the recogniser turned the decoded tone into the utterance
    await state("thinking");
    expect(engines.finals).toBe(1);

    s.d.voice.speak([{ type: "text", text: "Nothing is open." }], {});
    const end = await phone.next((n) => n.method === "voice.audio" && (n.params as { end?: boolean }).end === true);
    const frames = phone.notifications.filter((n) => n.method === "voice.audio").map((n) => n.params as { chunk: string; codec: string; rate: number; seq: number; reply: number });
    expect(frames.every((f) => f.codec === "opus" && f.rate === 24000 && f.reply === 1)).toBe(true);
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i));
    const dec = new OpusDecoder(24000);
    expect(frames.reduce((n, f) => n + dec.decode(Buffer.from(f.chunk, "base64")).length, 0)).toBe(4800);
    dec.close();
    expect((end.params as { reply: number }).reply).toBe(1);
    phone.signal("voice.played", { reply: 1, stats: { underruns: 0, maxLateMs: 0, targetMs: 300, frames: frames.length } });
    await state("idle");
  });
});
