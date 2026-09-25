// Phone invites: the desktop mints one (`grant.invite {kind: "controller"}`) with the access
// the phone gets, no wider than the minter's own, and the phone redeems it before `hello`
// on the LAN listener or through the relay on the invite's throwaway peer, keyed from the
// invite's secret. One redemption, a token and a relay key minted fresh for the real id, the
// throwaway peer let go after, and no secret in the audit. A phone that left before its
// answer finds its invite open again.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { FULL, parseInvite } from "@cophyla/protocol";
import type { Access, Controller, Grant, InviteBody, InviteOffer, PairedLan, RelayAccess } from "@cophyla/protocol";
import { PeerSession, pskFromHex, pskFromSecret } from "@cophyla/relay";
import type { PeerSessionOptions } from "@cophyla/relay";
import { paths } from "../src/config/load.ts";
import type { Daemon } from "../src/daemon.ts";
import { FakeServer } from "./fakes/server.ts";
import { removeHome, stopDaemon, testDaemon, TestClient, waitFor } from "./helpers.ts";

type Home = Daemon & { home: string };

interface Started {
  d: Home;
  ui: TestClient;
  wss: string;
  fake?: FakeServer;
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
  if (s.fake) {
    await s.d.stop();
    await s.fake.stop();
    removeHome(s.d.home);
  } else {
    await stopDaemon(s.d);
  }
});

async function start(): Promise<Started> {
  const d = await testDaemon(`[controller]\nenabled = true\nport = 0\n`);
  const ui = await TestClient.connect(d.api.url);
  await ui.hello(d.token, { name: "desktop" });
  current = { d, ui, wss: `https://127.0.0.1:${d.controller!.port}/ws/client` };
  return current;
}

/** A daemon signed in to a fake server, so an invite carries the relay. */
async function startSignedIn(): Promise<Started & { fake: FakeServer }> {
  const fake = new FakeServer();
  const { tempHome } = await import("./helpers.ts");
  const home = tempHome(`[controller]\nenabled = true\nport = 0\n\n[nodes]\ndiscovery = false\n\n[cloud]\nenabled = true\nurl = "${fake.url}"\nallow_insecure = true\nreconnect_ms = 20\nreconnect_max_ms = 100\n`);
  const p = paths(home);
  mkdirSync(p.data, { recursive: true });
  writeFileSync(p.accountToken, fake.mintToken("test") + "\n", { mode: 0o600 });
  const { startDaemon } = await import("../src/daemon.ts");
  const { silentLogger } = await import("../src/log.ts");
  const d = Object.assign(await startDaemon({ home, port: 0, log: silentLogger, embedder: null, cloud: { keys: [fake.publicKey], openBrowser: async () => undefined } }), { home });
  const ui = await TestClient.connect(d.api.url);
  await ui.hello(d.token, { name: "desktop" });
  await waitFor(() => d.cloud.hostedAllowed("relay") === undefined, 5000);
  const s = { d, ui, wss: `https://127.0.0.1:${d.controller!.port}/ws/client`, fake };
  current = s;
  return s;
}

async function phone(wss: string): Promise<TestClient> {
  const c = await TestClient.connect(wss, { insecure: true });
  phones.push(c);
  return c;
}

type Invited = { grant: Grant; invite: InviteOffer };
type Redeemed = { token: string; client: Controller; relay?: RelayAccess; lan?: PairedLan };

const LIMITED = (node: string): Access => ({ scopes: ["sessions:read", "views"], nodes: [node], messages: "none" });

async function invitePhone(by: TestClient, params: Record<string, unknown>): Promise<{ invited: Invited; body: InviteBody }> {
  const invited = await by.request<Invited>("grant.invite", { kind: "controller", name: "Work phone", ...params });
  return { invited, body: parseInvite(invited.invite.text) };
}

const codeOf = (r: object) => ((r as { error?: { data?: unknown } }).error?.data as { code?: string } | undefined)?.code;

/** JSON-RPC inside a relay tunnel, over the same peer session the app runs. */
class TunnelClient {
  readonly session: PeerSession;
  readonly closed: Promise<{ code: number; reason: string }>;
  private pending = new Map<number, (m: { result?: unknown; error?: { data?: unknown } }) => void>();
  private n = 0;

  constructor(opts: PeerSessionOptions) {
    let resolveClosed!: (c: { code: number; reason: string }) => void;
    this.closed = new Promise((r) => (resolveClosed = r));
    this.session = new PeerSession(opts, {
      onText: (text) => {
        const m = JSON.parse(text) as { id?: number; method?: string; result?: unknown; error?: { data?: unknown } };
        if (m.method === undefined && typeof m.id === "number") {
          this.pending.get(m.id)?.(m);
          this.pending.delete(m.id);
        }
      },
      onClose: (code, reason) => resolveClosed({ code, reason }),
    });
    sessions.push(this.session);
  }

  /** The invite's own tunnel: its throwaway peer's token, keyed from its secret. */
  static async invite(body: InviteBody): Promise<TunnelClient> {
    return new TunnelClient({ url: body.relay!.url, token: body.relay!.token, peer: body.relay!.peer, psk: await pskFromSecret(body.secret), kind: "enroll" });
  }

  static paired(access: RelayAccess): TunnelClient {
    return new TunnelClient({ url: access.url, token: access.token, peer: access.peer, psk: pskFromHex(access.key) });
  }

  connect(): Promise<{ peer: string }> {
    return this.session.connect();
  }

  call(method: string, params: unknown = {}): Promise<{ result?: unknown; error?: { data?: unknown } }> {
    const id = ++this.n;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.session.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
}

describe("phone invites on the LAN", () => {
  test("an invite redeems once for a token of the phone's own, with the access the desktop gave it", async () => {
    const { d, ui, wss } = await start();
    const { invited, body } = await invitePhone(ui, { access: LIMITED(d.identity.id) });
    expect(invited.grant).toMatchObject({ kind: "controller", name: "Work phone", status: "pending", access: LIMITED(d.identity.id) });
    expect(body).toMatchObject({ kind: "controller", grant: invited.grant.id, node: { id: d.identity.id } });
    expect(body.lan?.port).toBe(d.controller!.port);
    expect(body.relay).toBeUndefined();

    const p = await phone(wss);
    // the wrong secret is refused like a spent invite
    expect(codeOf(await p.call("invite.redeem", { grant: body.grant, secret: "0".repeat(64), name: "Pixel" }))).toBe("denied");
    const redeemed = await p.request<Redeemed>("invite.redeem", { grant: body.grant, secret: body.secret, name: "Pixel" });
    expect(redeemed.token).toMatch(/^[0-9a-f]{64}$/);
    expect(redeemed.client).toMatchObject({ id: invited.grant.id, name: "Work phone", access: LIMITED(d.identity.id) });
    expect(redeemed.relay).toBeUndefined();
    const hello = await p.request<{ client: { controller?: string; scopes: string[]; access?: Access } }>("hello", { token: redeemed.token, kind: "controller", audio: { in: true, out: true } });
    expect(hello.client.controller).toBe(invited.grant.id);
    expect(hello.client.scopes).toEqual(["sessions:read", "views"]);
    // a limited phone cannot mint anything: `grant.invite` needs a global scope
    expect(codeOf(await p.call("grant.invite", { kind: "controller", name: "x" }))).toBe("denied");

    // once: the same invite again, from anyone, is refused
    const again = await phone(wss);
    expect(codeOf(await again.call("invite.redeem", { grant: body.grant, secret: body.secret, name: "Pixel" }))).toBe("denied");
    const listed = await ui.request<{ grants: Grant[] }>("grant.list", {});
    expect(listed.grants.find((g) => g.id === invited.grant.id)).toMatchObject({ status: "active", connected: true });

    // no secret in the audit
    const audit = JSON.stringify(d.store.audit.list({ limit: 100 }));
    expect(audit).not.toContain(body.secret);
    expect(audit).not.toContain(redeemed.token);
    expect(audit).not.toContain(invited.invite.text.slice(20));
    expect(d.store.audit.list({ limit: 100 }).find((e) => e.action === "invite.redeem" && e.outcome === "ok")).toMatchObject({ args: { grant: body.grant, name: "Pixel" } });
  });

  test("what a phone mints is no wider than its own access", async () => {
    const { d, ui, wss } = await start();
    const narrower: Access = { scopes: FULL.scopes.filter((s) => s !== "voice"), messages: "reply" };
    const { body } = await invitePhone(ui, { access: narrower });
    const p = await phone(wss);
    const redeemed = await p.request<Redeemed>("invite.redeem", { grant: body.grant, secret: body.secret, name: "Pixel" });
    await p.request("hello", { token: redeemed.token, kind: "controller", audio: { in: true, out: true } });
    const wider = await p.call("grant.invite", { kind: "controller", name: "x", access: FULL });
    expect(codeOf(wider)).toBe("invalid");
    const louder = await p.call("grant.invite", { kind: "controller", name: "x", access: { ...narrower, messages: "send" } });
    expect(codeOf(louder)).toBe("invalid");
    // within its own: a view-only phone limited to this node
    const ok = await p.request<Invited>("grant.invite", { kind: "controller", name: "Tablet", access: LIMITED(d.identity.id) });
    expect(ok.grant.status).toBe("pending");
    // the invite's `access` defaults to the minter's when it names none
    const same = await p.request<Invited>("grant.invite", { kind: "controller", name: "Other" });
    expect(same.grant.access).toEqual(narrower);
  });

  test("an invite that ran out, or was cancelled, redeems nothing", async () => {
    const { d, ui, wss } = await start();
    const { invited, body } = await invitePhone(ui, { inviteExpiresIn: 150 });
    // the clock of ends takes the pending grant away
    await waitFor(() => d.grants.get(invited.grant.id) === undefined, 3000);
    const p = await phone(wss);
    expect(codeOf(await p.call("invite.redeem", { grant: body.grant, secret: body.secret, name: "Pixel" }))).toBe("denied");

    const second = await invitePhone(ui, {});
    await ui.request("grant.revoke", { id: second.invited.grant.id });
    expect(codeOf(await p.call("invite.redeem", { grant: second.body.grant, secret: second.body.secret, name: "Pixel" }))).toBe("denied");
    // a grant that would end before its invite is refused
    expect(codeOf(await ui.call("grant.invite", { kind: "controller", name: "x", expiresIn: 1000, inviteExpiresIn: 60_000 }))).toBe("invalid");
  });

  test("invite.redeem comes before hello, on the LAN listener or the invite's tunnel alone", async () => {
    const { d, ui, wss } = await start();
    const { body } = await invitePhone(ui, {});
    // the desktop's loopback listener redeems nothing
    const desk = await TestClient.connect(d.api.url);
    phones.push(desk);
    expect(codeOf(await desk.call("invite.redeem", { grant: body.grant, secret: body.secret, name: "Pixel" }))).toBe("unsupported");
    // after hello it is a conflict
    expect(codeOf(await ui.call("invite.redeem", { grant: body.grant, secret: body.secret, name: "Pixel" }))).toBe("conflict");
    // still open for the phone
    const p = await phone(wss);
    await p.request("invite.redeem", { grant: body.grant, secret: body.secret, name: "Pixel" });
  });
});

describe("phone invites through the relay", () => {
  test("the invite's own tunnel answers invite.redeem alone; the phone comes back on a relay key of its own and the throwaway peer goes", async () => {
    const { d, ui, fake } = await startSignedIn();
    const { invited, body } = await invitePhone(ui, { access: LIMITED(d.identity.id) });
    expect(body.relay).toMatchObject({ url: fake.url });
    expect(body.relay!.peer).toMatch(/^ctl_/);
    expect(body.relay!.peer).not.toBe(invited.grant.id);
    expect(fake.relayTokens.get(body.relay!.peer)).toMatchObject({ kind: "controller", revoked: false });

    const t = await TunnelClient.invite(body);
    expect((await t.connect()).peer).toBe(d.identity.id);
    // nothing but invite.redeem, and for this invite's grant alone
    expect(codeOf(await t.call("hello", { token: "x", kind: "controller", audio: { in: true, out: true } }))).toBe("unsupported");
    expect(codeOf(await t.call("pair.claim", { code: "123456", name: "x" }))).toBe("unsupported");
    const answer = await t.call("invite.redeem", { grant: body.grant, secret: body.secret, name: "Pixel" });
    const redeemed = answer.result as Redeemed;
    expect(redeemed.client).toMatchObject({ id: invited.grant.id, relay: true });
    expect(redeemed.relay).toMatchObject({ url: fake.url, peer: invited.grant.id });
    expect(redeemed.relay!.key).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.relayTokens.get(invited.grant.id)?.token).toBe(redeemed.relay!.token);
    expect(codeOf(await t.call("invite.redeem", { grant: body.grant, secret: body.secret, name: "Pixel" }))).toBe("conflict");

    // the phone closes the invite's tunnel: its peer is let go
    t.session.close();
    await waitFor(() => fake.relayTokens.get(body.relay!.peer)?.revoked === true, 3000);

    // and comes back as any paired phone, with the access it was given
    const back = TunnelClient.paired(redeemed.relay!);
    await back.connect();
    const hello = await back.call("hello", { token: redeemed.token, kind: "controller", audio: { in: true, out: true } });
    expect((hello.result as { client: { controller: string; scopes: string[] } }).client).toMatchObject({ controller: invited.grant.id, scopes: ["sessions:read", "views"] });

    const audit = JSON.stringify(d.store.audit.list({ limit: 100 }));
    expect(audit).not.toContain(body.secret);
    expect(audit).not.toContain(redeemed.token);
    expect(audit).not.toContain(redeemed.relay!.key);
  });

  test("a tunnel keyed from the wrong secret opens nothing", async () => {
    const { ui } = await startSignedIn();
    const { body } = await invitePhone(ui, {});
    const t = await TunnelClient.invite({ ...body, secret: "1".repeat(64) });
    await t.connect().catch(() => undefined);
    const r = await Promise.race([t.call("invite.redeem", { grant: body.grant, secret: body.secret, name: "Pixel" }), t.closed.then(() => "closed" as const)]);
    expect(r).toBe("closed");
  });

  test("a phone that left before its answer finds the invite open again", async () => {
    const { d, ui, fake } = await startSignedIn();
    const { invited, body } = await invitePhone(ui, {});
    fake.grantDelayMs = 400;
    const t = await TunnelClient.invite(body);
    await t.connect();
    void t.call("invite.redeem", { grant: body.grant, secret: body.secret, name: "Pixel" });
    await waitFor(() => d.grants.get(invited.grant.id)?.tokenHash !== undefined, 3000);
    t.session.close();
    await waitFor(() => d.grants.status(d.grants.get(invited.grant.id)!) === "pending", 3000);
    await waitFor(() => fake.relayTokens.get(invited.grant.id)?.revoked === true, 3000);
    fake.grantDelayMs = 0;
    const again = await TunnelClient.invite(body);
    await again.connect();
    const answer = await again.call("invite.redeem", { grant: body.grant, secret: body.secret, name: "Pixel" });
    expect((answer.result as Redeemed).client.id).toBe(invited.grant.id);
  });
});
