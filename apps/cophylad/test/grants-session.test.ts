// A shared computer's session: a grant kept in the daemon's memory alone. It is one from its
// mint when the minter asks, or from its pairing when the browser says it is a shared
// computer; it ends a little after its last socket closes, half a day after it was paired at
// the latest, and with the daemon; and it mints nothing.

import { afterEach, describe, expect, test } from "bun:test";
import { FULL, parseInvite } from "@cophyla/protocol";
import type { BrowserInvite, Controller, Grant, InviteOffer } from "@cophyla/protocol";
import { startDaemon } from "../src/daemon.ts";
import type { Daemon } from "../src/daemon.ts";
import { GRANTS_NS, LOCAL_GRANTS_NS } from "../src/grants/namespaces.ts";
import { BROWSER_GRANT_MS, Grants, SESSION_GRANT_MAX_MS } from "../src/grants/store.ts";
import { silentLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";
import { removeHome, sleep, testDaemon, TestClient, waitFor } from "./helpers.ts";

let d: (Daemon & { home: string }) | undefined;
const sockets: TestClient[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  if (d) {
    await d.stop();
    removeHome(d.home);
  }
  d = undefined;
});

const CONFIG = `[controller]\nenabled = true\nport = 0\n`;
/** Short, so a test sees a session end; long enough that a hello on a fresh socket is never late. */
const LINGER = 400;

interface Lan {
  d: Daemon & { home: string };
  ui: TestClient;
  origin: string;
  wss: string;
}

async function start(lingerMs = LINGER): Promise<Lan> {
  d = await testDaemon(CONFIG, { lan: { sessionLingerMs: lingerMs } });
  const ui = await TestClient.connect(d.api.url);
  sockets.push(ui);
  await ui.hello(d.token, { name: "desktop" });
  const origin = `https://127.0.0.1:${d.controller!.port}`;
  return { d, ui, origin, wss: `${origin}/ws/client` };
}

async function page(l: Pick<Lan, "wss" | "origin">): Promise<TestClient> {
  const c = await TestClient.connect(l.wss, { insecure: true, headers: { origin: l.origin } });
  sockets.push(c);
  return c;
}

const hello = (c: TestClient, token: string) => c.call("hello", { token, kind: "controller", audio: { in: false, out: false } });
const addBrowser = (c: TestClient, params: Record<string, unknown> = {}) => c.request<{ grant: Grant; invite: BrowserInvite }>("browser.invite", { name: "Library computer", ...params });
const pairKey = (c: TestClient, key: string, extra: Record<string, unknown> = {}) => c.request<{ token: string; client: Controller }>("browser.pair", { key, name: "Firefox", ...extra });
const kept = (dm: Daemon, id: string): boolean => dm.store.kv.get(GRANTS_NS, id) !== undefined || dm.store.kv.get(LOCAL_GRANTS_NS, id) !== undefined;
const half = (at: number | undefined): boolean => at !== undefined && at <= Date.now() + SESSION_GRANT_MAX_MS && at > Date.now() + SESSION_GRANT_MAX_MS - 60_000;

/** A session paired from a key the desktop minted for one, with one socket said hello. */
async function session(l: Lan): Promise<{ id: string; token: string; sock: TestClient }> {
  const added = await addBrowser(l.ui, { session: true });
  const sock = await page(l);
  const paired = await pairKey(sock, added.invite.key);
  expect("result" in (await hello(sock, paired.token))).toBe(true);
  return { id: paired.client.id, token: paired.token, sock };
}

describe("a shared computer's session", () => {
  test("a key minted for one session is never in the store, pending or paired, and ends half a day after it is paired", async () => {
    const l = await start();
    const added = await addBrowser(l.ui, { session: true });
    expect(added.grant).toMatchObject({ status: "pending", form: "browser", session: true, local: true });
    expect(kept(l.d, added.grant.id)).toBe(false);
    expect(l.d.grants.get(added.grant.id)?.session).toBe(true);
    const sock = await page(l);
    const paired = await pairKey(sock, added.invite.key);
    expect(paired.client).toMatchObject({ form: "browser", session: true });
    expect(half(paired.client.expiresAt)).toBe(true);
    expect(kept(l.d, added.grant.id)).toBe(false);
    await sock.request("hello", { token: paired.token, kind: "controller", audio: { in: false, out: false } });
    const listed = await l.ui.request<{ controllers: Controller[] }>("controller.list", {});
    expect(listed.controllers.find((c) => c.id === paired.client.id)).toMatchObject({ session: true, connected: true });
    // nothing of it is in the store's file either: no snapshot, replica or backup could carry it
    const all = [...l.d.store.kv.list(GRANTS_NS), ...l.d.store.kv.list(LOCAL_GRANTS_NS)];
    expect(all).not.toContain(paired.client.id);
  });

  test("a browser that says it is a shared computer makes a kept key, a code and an invite a session's, and the row leaves the store", async () => {
    const l = await start();
    // a key
    const added = await addBrowser(l.ui);
    expect(added.grant.session).toBeUndefined();
    expect(kept(l.d, added.grant.id)).toBe(true);
    const byKey = await pairKey(await page(l), added.invite.key, { keep: false });
    expect(byKey.client).toMatchObject({ form: "browser", session: true });
    expect(half(byKey.client.expiresAt)).toBe(true);
    expect(kept(l.d, added.grant.id)).toBe(false);
    // a code
    const offer = await l.ui.request<{ code: string }>("pair.start", {});
    const byCode = await (await page(l)).request<{ token: string; client: Controller }>("pair.claim", { code: offer.code, name: "Firefox", keep: false });
    expect(byCode.client).toMatchObject({ form: "browser", session: true });
    expect(half(byCode.client.expiresAt)).toBe(true);
    expect(kept(l.d, byCode.client.id)).toBe(false);
    // an invite
    const invited = await l.ui.request<{ grant: Grant; invite: InviteOffer }>("grant.invite", { kind: "controller", name: "Phone", expiresIn: 30 * 86_400_000 });
    const body = parseInvite(invited.invite.text);
    const byInvite = await (await page(l)).request<{ client: Controller }>("invite.redeem", { grant: body.grant, secret: body.secret, name: "Firefox", keep: false });
    expect(byInvite.client).toMatchObject({ form: "browser", session: true });
    expect(half(byInvite.client.expiresAt)).toBe(true);
    expect(kept(l.d, body.grant)).toBe(false);
    // `keep: true`, or nothing said, keeps it as it was minted
    const again = await addBrowser(l.ui);
    const stays = await pairKey(await page(l), again.invite.key, { keep: true });
    expect(stays.client.session).toBeUndefined();
    expect(stays.client.expiresAt).toBe(again.grant.expiresAt);
    expect(kept(l.d, again.grant.id)).toBe(true);
  });

  test("it ends a little after its last socket closes, and not while one of two is open", async () => {
    const l = await start();
    const s = await session(l);
    const second = await page(l);
    expect("result" in (await hello(second, s.token))).toBe(true);
    s.sock.close();
    await sleep(LINGER * 2);
    // one socket still open: the session stands
    expect(l.d.grants.stands(s.id)).toBe(true);
    second.close();
    await waitFor(() => l.d.grants.get(s.id) === undefined, LINGER * 10);
    const late = await page(l);
    expect(await hello(late, s.token)).toMatchObject({ error: { data: { code: "denied" } } });
    const listed = await l.ui.request<{ controllers: Controller[] }>("controller.list", {});
    expect(listed.controllers.find((c) => c.id === s.id)).toBeUndefined();
  });

  test("a socket that comes back inside the linger keeps it, and one paired that never says hello loses it", async () => {
    const l = await start(600);
    const s = await session(l);
    s.sock.close();
    await sleep(150);
    const back = await page(l);
    expect("result" in (await hello(back, s.token))).toBe(true);
    await sleep(900);
    expect(l.d.grants.stands(s.id)).toBe(true);
    // paired, and then nothing
    const added = await addBrowser(l.ui, { session: true });
    const silent = await pairKey(await page(l), added.invite.key);
    expect(l.d.grants.stands(silent.client.id)).toBe(true);
    await waitFor(() => l.d.grants.get(silent.client.id) === undefined, 6000);
  });

  test("it mints nothing: no invite, no key, no pairing code", async () => {
    const l = await start(5000);
    const s = await session(l);
    for (const [method, params] of [
      ["grant.invite", { kind: "controller", name: "Phone" }],
      ["grant.invite", { kind: "node", name: "laptop", role: "hands" }],
      ["browser.invite", { name: "Other" }],
      ["pair.start", {}],
    ] as const) {
      const r = await s.sock.call(method, params);
      expect(r).toMatchObject({ error: { data: { code: "denied" } } });
      expect((r as { error: { message: string } }).error.message).toContain("a session on a shared computer");
    }
    // what it holds otherwise is its access: it lists, it revokes
    expect("result" in (await s.sock.call("grant.list", {}))).toBe(true);
  });

  test("the daemon stopping ends it: the next one knows no such token, and a kept browser beside it is still there", async () => {
    const l = await start(5000);
    const s = await session(l);
    const keeper = l.d.grants.createController("Firefox on the laptop", { form: "browser" });
    const home = l.d.home;
    for (const sock of sockets.splice(0)) sock.close();
    await l.d.stop();
    d = Object.assign(await startDaemon({ home, port: 0, log: silentLogger, brain: false, embedder: null }), { home });
    expect(d.grants.get(s.id)).toBeUndefined();
    expect(d.grants.stands(keeper.controller.id)).toBe(true);
    const wss = `wss://127.0.0.1:${d.controller!.port}/ws/client`;
    const late = await TestClient.connect(wss, { insecure: true });
    sockets.push(late);
    expect(await hello(late, s.token)).toMatchObject({ error: { data: { code: "denied" } } });
    const kept = await TestClient.connect(wss, { insecure: true });
    sockets.push(kept);
    expect("result" in (await hello(kept, keeper.token))).toBe(true);
  });
});

describe("a session's row", () => {
  test("lives in memory, moves out of the store when a kept one becomes a session, and back when its invite is opened again", () => {
    const store = new Store(":memory:");
    store.migrate();
    let now = 1_000_000;
    const grants = new Grants({ store, now: () => now });
    const changes: number[] = [];
    grants.onChange(() => void changes.push(now));
    const inStore = (id: string) => store.kv.get(GRANTS_NS, id) !== undefined;

    // minted for a session: memory from the start, listed with the rest, local to this node
    const minted = grants.mint({ kind: "controller", name: "Library", access: FULL, expiresAt: now + BROWSER_GRANT_MS, inviteExpiresAt: now + 900_000, form: "browser", session: true, secret: "0123456789ABCDEF" });
    expect(inStore(minted.row.id)).toBe(false);
    expect(grants.rows().map((r) => r.id)).toContain(minted.row.id);
    expect(grants.isLocal(minted.row.id)).toBe(true);
    expect(grants.browserInvite("0123456789ABCDEF")?.id).toBe(minted.row.id);
    const paired = grants.redeemController(minted.row.id, "0123456789ABCDEF");
    expect(paired.row.expiresAt).toBe(now + SESSION_GRANT_MAX_MS);
    expect(grants.authenticate(paired.token)).toMatchObject({ id: minted.row.id, session: true });
    expect(inStore(minted.row.id)).toBe(false);

    // kept, then spent on a shared computer: out of the store; opened again: back in it, as it was
    const keptRow = grants.mint({ kind: "controller", name: "Laptop", access: FULL, expiresAt: now + BROWSER_GRANT_MS, inviteExpiresAt: now + 900_000, form: "browser", secret: "FEDCBA9876543210" });
    expect(inStore(keptRow.row.id)).toBe(true);
    const spent = grants.redeemController(keptRow.row.id, "FEDCBA9876543210", undefined, { browser: true, session: true });
    expect(spent.row).toMatchObject({ session: true, expiresAt: now + SESSION_GRANT_MAX_MS });
    expect(inStore(keptRow.row.id)).toBe(false);
    grants.reopen(spent.pending);
    expect(inStore(keptRow.row.id)).toBe(true);
    expect(grants.get(keptRow.row.id)).toEqual(keptRow.row);

    // its own end is the clock's to act on, and a revoke forgets it
    expect(grants.nextEnd()).toBe(now + 900_000);
    now += SESSION_GRANT_MAX_MS;
    expect(grants.authenticate(paired.token)).toBeUndefined();
    expect(grants.ended(grants.get(minted.row.id)!)).toBe("expired");
    const before = changes.length;
    expect(grants.revoke(minted.row.id)?.id).toBe(minted.row.id);
    expect(grants.get(minted.row.id)).toBeUndefined();
    expect(changes.length).toBe(before + 1);
    // a session row is a controller's alone: a node's grant is never one
    const node = grants.mint({ kind: "node", name: "laptop", access: FULL, role: "hands", inviteExpiresAt: now + 1000, session: true });
    expect(node.row.session).toBeUndefined();
    expect(inStore(node.row.id)).toBe(true);
    store.close();
  });
});
