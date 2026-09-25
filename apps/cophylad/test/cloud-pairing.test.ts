// A phone pairing through the account (12.1): the fake server hands out a grant as its
// sign-in page would, the phone spends it and opens a `pair` tunnel keyed from the public
// constant, and inside it `pair.account` mints a controller with its relay access and the
// LAN listener's pin — then the phone comes back through the relay as any paired phone.
// What the node refuses: another account, the switch off, anything but `pair.account` on
// that tunnel, `pair.account` anywhere else. Neither pairing leaves a secret in the audit.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Controller, PairedLan, RelayAccess } from "@cophyla/protocol";
import { pairingPsk, PeerSession, pskFromHex } from "@cophyla/relay";
import type { PeerSessionOptions } from "@cophyla/relay";
import { paths } from "../src/config/load.ts";
import { spkiHash } from "../src/api/tls.ts";
import type { Daemon } from "../src/daemon.ts";
import { FakeServer } from "./fakes/server.ts";
import { removeHome, TestClient, waitFor } from "./helpers.ts";

const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

interface Started {
  d: Daemon & { home: string };
  fake: FakeServer;
  ui: TestClient;
  wss: string;
}

let current: Started | undefined;
const sessions: PeerSession[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  if (!current) return;
  const s = current;
  current = undefined;
  s.ui.close();
  await s.d.stop();
  await s.fake.stop();
  removeHome(s.d.home);
});

async function start(controller = "enabled = true\nport = 0\n"): Promise<Started> {
  const fake = new FakeServer();
  const { tempHome } = await import("./helpers.ts");
  const home = tempHome(`[controller]\n${controller}\n[nodes]\ndiscovery = false\n\n[cloud]\nenabled = true\nurl = "${fake.url}"\nallow_insecure = true\nreconnect_ms = 20\nreconnect_max_ms = 100\n`);
  const p = paths(home);
  mkdirSync(p.data, { recursive: true });
  writeFileSync(p.accountToken, fake.mintToken("test") + "\n", { mode: 0o600 });
  const { startDaemon } = await import("../src/daemon.ts");
  const { silentLogger } = await import("../src/log.ts");
  const d = Object.assign(await startDaemon({ home, port: 0, log: silentLogger, embedder: null, cloud: { keys: [fake.publicKey], openBrowser: async () => undefined } }), { home });
  const ui = await TestClient.connect(d.api.url);
  await ui.hello(d.token, { name: "desktop" });
  await waitFor(() => d.cloud.hostedAllowed("relay") === undefined, 5000);
  current = { d, fake, ui, wss: d.controller ? `https://127.0.0.1:${d.controller.port}/ws/client` : "" };
  return current;
}

type Frame = { result?: unknown; error?: { data?: { code: string; message: string } } };

/** JSON-RPC inside a tunnel, over the same peer session the app runs. */
class TunnelClient {
  readonly session: PeerSession;
  readonly closed: Promise<{ code: number; reason: string }>;
  private pending = new Map<number, (m: Frame) => void>();
  private n = 0;

  constructor(opts: PeerSessionOptions) {
    let resolveClosed!: (c: { code: number; reason: string }) => void;
    this.closed = new Promise((r) => (resolveClosed = r));
    this.session = new PeerSession(opts, {
      onText: (text) => {
        const m = JSON.parse(text) as Frame & { id?: number; method?: string };
        if (m.method === undefined && typeof m.id === "number") {
          this.pending.get(m.id)?.(m);
          this.pending.delete(m.id);
        }
      },
      onClose: (code, reason) => resolveClosed({ code, reason }),
    });
    sessions.push(this.session);
  }

  static async pairing(fake: FakeServer, grant: string): Promise<TunnelClient> {
    return new TunnelClient({ url: fake.url, grant: { grant, verifier: VERIFIER }, psk: await pairingPsk() });
  }

  static paired(access: RelayAccess): TunnelClient {
    return new TunnelClient({ url: access.url, token: access.token, peer: access.peer, psk: pskFromHex(access.key) });
  }

  connect(): Promise<{ peer: string }> {
    return this.session.connect();
  }

  call(method: string, params: unknown = {}): Promise<Frame> {
    const id = ++this.n;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.session.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
}

type Paired = { token: string; client: Controller; relay: RelayAccess; lan?: PairedLan };

describe("pairing through the account", () => {
  test("a grant's pair tunnel answers pair.account alone: a controller with its relay access and the LAN pin; the phone then comes back as any paired phone", async () => {
    const s = await start();
    const { d, fake } = s;
    const pairing = await TunnelClient.pairing(fake, fake.pairGrant({ login: "octocat" }));
    expect((await pairing.connect()).peer).toBe(d.identity.id);
    expect(pairing.session.account).toEqual({ subject: fake.subject, login: "octocat" });
    expect(d.cloud.tunnelPeers).toEqual([{ peer: pairing.session.peer!, kind: "pair" }]);
    // nothing but pair.account on this tunnel
    expect((await pairing.call("hello", { token: "x", kind: "controller", audio: { in: true, out: true } })).error?.data?.code).toBe("unsupported");
    expect((await pairing.call("pair.claim", { code: "123456", name: "x" })).error?.data?.code).toBe("unsupported");
    expect((await pairing.call("session.list", {})).error?.data?.code).toBe("unsupported");
    const answer = await pairing.call("pair.account", { name: "Pixel 8" });
    const paired = answer.result as Paired;
    expect(paired.client).toMatchObject({ name: "Pixel 8", relay: true, account: "octocat", connected: false });
    expect(paired.relay).toMatchObject({ url: fake.url, peer: paired.client.id });
    expect(paired.relay.key).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.relayTokens.get(paired.client.id)?.token).toBe(paired.relay.token);
    // the LAN pin, when this machine has a LAN address: the listener's port and the key its certificate carries
    if (paired.lan) {
      expect(paired.lan.port).toBe(d.controller!.port);
      expect(paired.lan.spki).toBe(spkiHash(readFileSync(join(paths(d.home).tls, "cert.pem"), "utf8")));
    }
    // once is enough
    expect((await pairing.call("pair.account", { name: "Pixel 8" })).error?.data?.code).toBe("conflict");
    // the audit row names the login and holds neither the token nor the relay secret
    const rows = d.store.audit.list({ limit: 50 });
    const row = rows.find((e) => e.action === "pair.account");
    expect(row).toMatchObject({ outcome: "ok", args: { name: "Pixel 8", account: "octocat" } });
    const audit = JSON.stringify(rows);
    expect(audit).not.toContain(paired.token);
    expect(audit).not.toContain(paired.relay.key);
    expect(audit).not.toContain(paired.relay.token);
    // the desktop's list says how it paired
    const listed = await s.ui.request<{ controllers: Controller[] }>("controller.list", {});
    expect(listed.controllers.find((c) => c.id === paired.client.id)).toMatchObject({ account: "octocat", relay: true });
    pairing.session.close();
    await waitFor(() => d.cloud.tunnelPeers.length === 0);

    // back through the relay with the new token, as any paired phone
    const phone = TunnelClient.paired(paired.relay);
    await phone.connect();
    const hello = await phone.call("hello", { token: paired.token, kind: "controller", name: "Pixel 8", audio: { in: true, out: true } });
    expect(hello.result).toMatchObject({ client: { kind: "controller", controller: paired.client.id, via: "relay" } });
    expect((await phone.call("session.list", {})).result).toEqual({ sessions: [] });
    // and on the LAN, with the key it was handed
    const lan = await TestClient.connect(s.wss, { insecure: true });
    expect((await lan.request<{ client: { controller: string } }>("hello", { token: paired.token, kind: "controller", audio: { in: true, out: true } })).client.controller).toBe(paired.client.id);
    lan.close();
    // revoked like any phone: the grant goes with it
    await s.ui.request("controller.revoke", { id: paired.client.id });
    await waitFor(() => fake.relayTokens.get(paired.client.id)?.revoked === true);
  });

  test("the node refuses a pairing for another account, and any pairing with the switch off", async () => {
    const s = await start();
    const stranger = await TunnelClient.pairing(s.fake, s.fake.pairGrant({ subject: "usr_someone_else" }));
    await expect(stranger.connect()).rejects.toMatchObject({ code: "denied", message: expect.stringContaining("another account") });
    expect(s.d.grants.controllers()).toEqual([]);
  });

  test("[controller] account_pairing = false: the open is refused and nothing is minted", async () => {
    const s = await start("enabled = true\nport = 0\naccount_pairing = false\n");
    const refused = await TunnelClient.pairing(s.fake, s.fake.pairGrant());
    await expect(refused.connect()).rejects.toMatchObject({ code: "denied", message: expect.stringContaining("does not pair through the account") });
    expect(s.d.grants.controllers()).toEqual([]);
  });

  test("with the LAN listener off, the phone still pairs and comes back through the relay, with no LAN pin", async () => {
    const s = await start("enabled = false\n");
    expect(s.d.controller).toBeUndefined();
    const pairing = await TunnelClient.pairing(s.fake, s.fake.pairGrant());
    await pairing.connect();
    const paired = (await pairing.call("pair.account", { name: "Pixel 8" })).result as Paired;
    expect(paired.lan).toBeUndefined();
    const phone = TunnelClient.paired(paired.relay);
    await phone.connect();
    expect((await phone.call("hello", { token: paired.token, kind: "controller", audio: { in: true, out: true } })).result).toMatchObject({ client: { via: "relay" } });
  });

  test("the relay access cannot be granted: the pairing fails and leaves no row", async () => {
    const s = await start();
    const pairing = await TunnelClient.pairing(s.fake, s.fake.pairGrant());
    await pairing.connect();
    // the plan drops under the open tunnel: the node's grant request is refused
    s.fake.plan = "free";
    const failed = await pairing.call("pair.account", { name: "Pixel 8" });
    expect(failed.error?.data?.code).toBeDefined();
    expect(s.d.grants.controllers()).toEqual([]);
  });

  test("a phone that leaves before the answer holds no token: the controller and its relay access are dropped", async () => {
    const s = await start();
    const pairing = await TunnelClient.pairing(s.fake, s.fake.pairGrant());
    await pairing.connect();
    s.fake.grantDelayMs = 300;
    void pairing.call("pair.account", { name: "Pixel 8" });
    await waitFor(() => s.d.grants.controllers().length === 1, 5000);
    // the app paused, the network dropped: the tunnel goes while the node is still asking for the grant
    pairing.session.close();
    await waitFor(() => s.d.grants.controllers().length === 0, 5000);
    const peer = [...s.fake.relayTokens.entries()].find(([, v]) => v.kind === "controller")![0];
    await waitFor(() => s.fake.relayTokens.get(peer)?.revoked === true, 5000);
  });

  test("pair.account on the LAN, or on a paired phone's tunnel, is not answered", async () => {
    const s = await start();
    const lan = await TestClient.connect(s.wss, { insecure: true });
    expect(await lan.call("pair.account", { name: "x" })).toMatchObject({ error: { data: { code: "unsupported" } } });
    lan.close();
    expect(await s.ui.call("pair.account", { name: "x" })).toMatchObject({ error: { data: { code: "unsupported" } } });
  });
});

describe("pairing with a code", () => {
  test("the claim's relay secret and token stay out of the audit", async () => {
    const s = await start();
    const offer = await s.ui.request<{ code: string }>("pair.start", {});
    const p = await TestClient.connect(s.wss, { insecure: true });
    const claimed = await p.request<{ token: string; client: Controller; relay?: RelayAccess }>("pair.claim", { code: offer.code, name: "Pixel 8" });
    p.close();
    expect(claimed.relay).toBeDefined();
    const rows = s.d.store.audit.list({ limit: 50 });
    expect(rows.find((e) => e.action === "pair.claim")).toMatchObject({ outcome: "ok" });
    const audit = JSON.stringify(rows);
    expect(audit).not.toContain(claimed.token);
    expect(audit).not.toContain(claimed.relay!.key);
    expect(audit).not.toContain(claimed.relay!.token);
  });
});
