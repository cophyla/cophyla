// A browser's grant: it has an end, fixed when it is minted. A code or an invite spent from a
// page in a browser makes a browser's grant, thirty days at the most and never longer than the
// one it had; spent from an app's socket it makes what it always did. And the ways round an
// end are closed: what a client whose own grant ends invites, or opens a code for, ends no
// later than it does, on the node it is on and on the primary a secondary relays it to.
// And a browser's key: minted for one pairing with its end, typed however a person types it,
// spent once, found by no phone's invite, and open again for a browser that never heard back.

import { afterEach, describe, expect, test } from "bun:test";
import { FULL, keyFromFragment, parseInvite, parseKey, PROTOCOL_VERSION } from "@cophyla/protocol";
import type { BrowserInvite, Controller, Grant, InviteOffer } from "@cophyla/protocol";
import { runCommand } from "../src/cli.ts";
import { BROWSER_KEY_MS, PhoneInvites } from "../src/grants/phones.ts";
import { silentLogger } from "../src/log.ts";
import type { Daemon } from "../src/daemon.ts";
import { BROWSER_GRANT_MAX_MS, BROWSER_GRANT_MS, Grants } from "../src/grants/store.ts";
import { boundedBy } from "../src/grants/lifetime.ts";
import { Store } from "../src/store/index.ts";
import { stopDaemon, testDaemon, TestClient } from "./helpers.ts";
import { linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started as Node } from "./nodes-helpers.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;

let d: (Daemon & { home: string }) | undefined;
let primary: Primary | undefined;
let secondary: Node | undefined;
const sockets: TestClient[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  if (d) await stopDaemon(d);
  d = undefined;
  await stopAll(secondary, primary?.d);
  primary = undefined;
  secondary = undefined;
});

interface Lan {
  d: Daemon & { home: string };
  ui: TestClient;
  origin: string;
  wss: string;
}

async function start(): Promise<Lan> {
  d = await testDaemon(`[controller]\nenabled = true\nport = 0\n`);
  const ui = await TestClient.connect(d.api.url);
  sockets.push(ui);
  await ui.hello(d.token, { name: "desktop" });
  const origin = `https://127.0.0.1:${d.controller!.port}`;
  return { d, ui, origin, wss: `${origin}/ws/client` };
}

/** A socket to the LAN listener: an app's, or with `origin` a page's in a browser. */
async function socket(wss: string, origin?: string): Promise<TestClient> {
  const c = await TestClient.connect(wss, { insecure: true, ...(origin !== undefined ? { headers: { origin } } : {}) });
  sockets.push(c);
  return c;
}

const hello = (c: TestClient, token: string) => c.request<{ client: { id: string } }>("hello", { token, kind: "controller", audio: { in: false, out: false } });
const invite = (c: TestClient, params: Record<string, unknown> = {}) => c.request<{ grant: Grant; invite: InviteOffer }>("grant.invite", { kind: "controller", name: "Phone", ...params });
const redeem = (c: TestClient, offer: InviteOffer, name = "Phone") => {
  const body = parseInvite(offer.text);
  return c.request<{ token: string; client: Controller }>("invite.redeem", { grant: body.grant, secret: body.secret, name });
};
/** Within a minute of `ms` from now, and never past it. */
const about = (at: number | undefined, ms: number): boolean => at !== undefined && at <= Date.now() + ms && at > Date.now() + ms - 60_000;

describe("a browser's grant", () => {
  test("a code spent from a page in a browser makes a browser's grant that ends in thirty days; from an app, a phone's with no end", async () => {
    const { ui, wss, origin } = await start();
    const first = await ui.request<{ code: string }>("pair.start", {});
    const page = await socket(wss, origin);
    const paired = await page.request<{ token: string; client: Controller }>("pair.claim", { code: first.code, name: "Firefox" });
    expect(paired.client.form).toBe("browser");
    expect(about(paired.client.expiresAt, BROWSER_GRANT_MS)).toBe(true);
    await hello(page, paired.token);

    const second = await ui.request<{ code: string }>("pair.start", {});
    const app = await socket(wss);
    const phone = await app.request<{ token: string; client: Controller }>("pair.claim", { code: second.code, name: "Pixel" });
    expect(phone.client.form).toBeUndefined();
    expect(phone.client.expiresAt).toBeUndefined();

    // listed as what they are, on both lists
    const listed = await ui.request<{ controllers: Controller[] }>("controller.list", {});
    expect(listed.controllers.find((c) => c.id === paired.client.id)).toMatchObject({ form: "browser", connected: true });
    expect(listed.controllers.find((c) => c.id === phone.client.id)?.form).toBeUndefined();
    const grants = await ui.request<{ grants: Grant[] }>("grant.list", {});
    expect(grants.grants.find((g) => g.id === paired.client.id)).toMatchObject({ form: "browser", status: "active" });
  });

  test("a phone's invite spent from a browser becomes a browser's: thirty days at the most, and never longer than it had", async () => {
    const { ui, wss, origin } = await start();
    // no end of its own: thirty days
    const open = await invite(ui);
    expect(open.grant.expiresAt).toBeUndefined();
    const a = await redeem(await socket(wss, origin), open.invite);
    expect(a.client.form).toBe("browser");
    expect(about(a.client.expiresAt, BROWSER_GRANT_MS)).toBe(true);
    // a longer one is cut to thirty days
    const long = await invite(ui, { expiresIn: 60 * DAY });
    const b = await redeem(await socket(wss, origin), long.invite);
    expect(about(b.client.expiresAt, BROWSER_GRANT_MS)).toBe(true);
    // a shorter one is left as it was: a browser only ever shortens
    const short = await invite(ui, { expiresIn: DAY });
    const c = await redeem(await socket(wss, origin), short.invite);
    expect(c.client).toMatchObject({ form: "browser", expiresAt: short.grant.expiresAt });
    // and the same invite spent from an app's socket is the phone's it was minted as
    const plain = await invite(ui, { expiresIn: 60 * DAY });
    const e = await redeem(await socket(wss), plain.invite);
    expect(e.client.form).toBeUndefined();
    expect(e.client.expiresAt).toBe(plain.grant.expiresAt);
  });

  test("an invite a browser spent and never heard the answer of is open again as it was minted", () => {
    const store = new Store(":memory:");
    store.migrate();
    let now = 1_000_000;
    const grants = new Grants({ store, now: () => now });
    const { row, secret } = grants.mint({ kind: "controller", name: "Phone", access: { scopes: ["chat"], messages: "none" }, inviteExpiresAt: now + 900_000 });
    const spent = grants.redeemController(row.id, secret, undefined, { browser: true });
    expect(spent.row).toMatchObject({ form: "browser", expiresAt: now + BROWSER_GRANT_MS });
    expect(grants.stands(row.id)).toBe(true);
    grants.reopen(spent.pending);
    expect(grants.get(row.id)).toEqual(row);
    expect(grants.stands(row.id)).toBe(false);
    expect(grants.authenticate(spent.token)).toBeUndefined();
    // spent again from an app: a phone's, with no end
    now += 1000;
    expect(grants.redeemController(row.id, secret).row.form).toBeUndefined();
    store.close();
  });

  test("a browser's grant is never minted without an end", () => {
    const store = new Store(":memory:");
    store.migrate();
    const grants = new Grants({ store, now: () => 5000 });
    expect(() => grants.mint({ kind: "controller", name: "x", access: { scopes: ["chat"], messages: "none" }, inviteExpiresAt: 6000, form: "browser" })).toThrow(/has an end/);
    expect(grants.createController("x", { form: "browser" }).controller).toMatchObject({ form: "browser", expiresAt: 5000 + BROWSER_GRANT_MS });
    store.close();
  });
});

describe("a browser's key", () => {
  const addBrowser = (c: TestClient, params: Record<string, unknown> = {}) => c.request<{ grant: Grant; invite: BrowserInvite }>("browser.invite", { name: "Laptop", ...params });
  const pairKey = (c: TestClient, key: string, extra: Record<string, unknown> = {}) => c.call("browser.pair", { key, name: "Firefox on Linux", ...extra });

  test("a key pairs one browser, typed any way a person types it, with the access and the end it was minted with", async () => {
    const { d, ui, wss, origin } = await start();
    const added = await addBrowser(ui);
    expect(added.grant).toMatchObject({ kind: "controller", name: "Laptop", status: "pending", form: "browser", access: FULL });
    expect(about(added.grant.expiresAt, BROWSER_GRANT_MS)).toBe(true);
    expect(about(added.invite.expiresAt, BROWSER_KEY_MS)).toBe(true);
    expect(added.invite.key).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    // the address is this listener's own, and the link carries the key in its fragment, which no server is sent
    expect(added.invite.address).toMatch(new RegExp(`^https://[0-9.]+:${d.controller!.port}$`));
    expect(added.invite.link).toBe(`${added.invite.address}/#k=${added.invite.key}`);
    expect(keyFromFragment(new URL(added.invite.link).hash)).toBe(parseKey(added.invite.key)!);

    const page = await socket(wss, origin);
    const typed = added.invite.key.toLowerCase().replace(/-/g, " ");
    const paired = (await pairKey(page, typed)) as { result: { token: string; client: Controller } };
    expect(paired.result.client).toMatchObject({ id: added.grant.id, name: "Laptop", form: "browser", expiresAt: added.grant.expiresAt, access: FULL });
    expect(Object.keys(paired.result).sort()).toEqual(["client", "token"]);
    await hello(page, paired.result.token);

    // spent: the same key opens nothing again, on this socket or another
    expect(await pairKey(await socket(wss, origin), added.invite.key)).toMatchObject({ error: { data: { code: "denied" } } });
    // neither the key nor the link is in the audit, by either row
    const rows = JSON.stringify(d.store.audit.list({ limit: 50 }).filter((e) => e.action === "browser.invite" || e.action === "browser.pair"));
    expect(rows).toContain("Firefox on Linux");
    expect(rows).not.toContain(added.invite.key);
    expect(rows).not.toContain(parseKey(added.invite.key)!);
    expect(rows).not.toContain(typed);
  });

  test("a mistyped key, a phone's invite and a spent or cancelled key open nothing; a phone's redemption takes no key", async () => {
    const { ui, wss, origin } = await start();
    const added = await addBrowser(ui);
    const wrong = added.invite.key.replace(/.$/, (c) => (c === "7" ? "8" : "7"));
    const page = await socket(wss, origin);
    expect(await pairKey(page, wrong)).toMatchObject({ error: { data: { code: "denied" } } });
    expect(await pairKey(page, "not a key")).toMatchObject({ error: { data: { code: "denied" } } });
    // a phone's invite is not found by a key, whatever is typed
    const phone = await invite(ui);
    const body = parseInvite(phone.invite.text);
    expect(await pairKey(page, body.secret)).toMatchObject({ error: { data: { code: "denied" } } });
    // three wrong tries close the socket, as a pairing code's do
    expect((await page.closed).code).toBe(4401);
    // and a key is no invite's secret: the phone's request does not take one
    const other = await socket(wss);
    expect(await other.call("invite.redeem", { grant: added.grant.id, secret: parseKey(added.invite.key)!, name: "x" })).toMatchObject({ error: { data: { code: "invalid" } } });
    // the key is still open after all that, until it is cancelled
    await ui.request("controller.revoke", { id: added.grant.id });
    expect(await pairKey(await socket(wss, origin), added.invite.key)).toMatchObject({ error: { data: { code: "denied" } } });
  });

  test("browser.pair comes before hello, on the LAN listener alone", async () => {
    const { ui, wss, origin } = await start();
    const added = await addBrowser(ui);
    expect(await pairKey(ui, added.invite.key)).toMatchObject({ error: { data: { code: "conflict" } } });
    const loop = await TestClient.connect(d!.api.url);
    sockets.push(loop);
    expect(await pairKey(loop, added.invite.key)).toMatchObject({ error: { data: { code: "unsupported" } } });
    const page = await socket(wss, origin);
    const paired = (await pairKey(page, added.invite.key)) as { result: { token: string } };
    expect(await pairKey(page, added.invite.key)).toMatchObject({ error: { data: { code: "conflict" } } });
    await hello(page, paired.result.token);
    expect(await pairKey(page, added.invite.key)).toMatchObject({ error: { data: { code: "conflict" } } });
  });

  test("how long: thirty days unless less is asked, ninety at the most, and never past the minter's own end", async () => {
    const { d, ui, wss } = await start();
    expect(about((await addBrowser(ui, { expiresIn: DAY })).grant.expiresAt, DAY)).toBe(true);
    expect(about((await addBrowser(ui, { expiresIn: BROWSER_GRANT_MAX_MS })).grant.expiresAt, BROWSER_GRANT_MAX_MS)).toBe(true);
    expect(await ui.call("browser.invite", { name: "x", expiresIn: BROWSER_GRANT_MAX_MS + 1 })).toMatchObject({ error: { data: { code: "invalid" } } });
    expect(await ui.call("browser.invite", { name: "x", expiresIn: 60_000 })).toMatchObject({ error: { data: { code: "invalid" } } });
    // limited access is what the minter names, no wider than its own
    const view = await addBrowser(ui, { access: { scopes: ["sessions:read", "views"], messages: "none" } });
    expect(view.grant.access.scopes).toEqual(["sessions:read", "views"]);
    // a browser whose own grant ends in an hour adds one that ends with it
    const ends = Date.now() + HOUR;
    const minter = d.grants.createController("Firefox", { form: "browser", expiresAt: ends });
    const page = await socket(wss);
    await hello(page, minter.token);
    expect((await addBrowser(page)).grant.expiresAt).toBe(ends);
    expect((await addBrowser(page, { expiresIn: 30 * 60_000 })).grant.expiresAt).toBeLessThan(ends);
    // and one that may not name wider access than it holds
    const narrow = d.grants.createController("Kiosk", { access: { scopes: ["sessions:read", "views", "controllers"], messages: "none" } });
    const kiosk = await socket(wss);
    await hello(kiosk, narrow.token);
    expect(await kiosk.call("browser.invite", { name: "x", access: FULL })).toMatchObject({ error: { data: { code: "invalid" } } });
  });

  test("a key runs out after fifteen minutes, and one a browser spent without hearing back is open again", async () => {
    const store = new Store(":memory:");
    store.migrate();
    let now = 1_000_000;
    const grants = new Grants({ store, now: () => now });
    const phones = new PhoneInvites({
      grants,
      identity: { id: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "desk" },
      lan: () => undefined,
      lanPin: () => undefined,
      browserAddress: () => "https://192.168.1.44:4818",
      relayAccess: async () => {
        throw new Error("a browser gets no relay access");
      },
      revokeRelay: () => undefined,
      log: silentLogger,
      now: () => now,
    });
    const added = phones.browser({ name: "Laptop", access: FULL }, FULL);
    expect(added.invite.expiresAt).toBe(now + BROWSER_KEY_MS);
    expect(added.grant.expiresAt).toBe(now + BROWSER_GRANT_MS);
    // spent, the answer never heard: open again, the row as it was minted
    const before = grants.get(added.grant.id);
    const spent = await phones.redeemKey({ key: added.invite.key }, { browser: true });
    expect(spent.answer.relay).toBeUndefined();
    expect(spent.answer.client).toMatchObject({ form: "browser", expiresAt: added.grant.expiresAt });
    await expect(phones.redeemKey({ key: added.invite.key })).rejects.toThrow(/not open/);
    spent.abandon();
    expect(grants.get(added.grant.id)).toEqual(before!);
    expect(grants.authenticate(spent.answer.token)).toBeUndefined();
    // just inside its fifteen minutes it still opens; a second one, past them, does not
    now += BROWSER_KEY_MS - 1;
    const second = phones.browser({ name: "Other", access: FULL }, FULL);
    expect((await phones.redeemKey({ key: added.invite.key })).answer.client.id).toBe(added.grant.id);
    now += BROWSER_KEY_MS;
    await expect(phones.redeemKey({ key: second.invite.key })).rejects.toThrow(/not open/);
    // with no listener serving browsers there is nowhere to type a key
    const none = new PhoneInvites({ grants, identity: { id: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "desk" }, lan: () => undefined, lanPin: () => undefined, relayAccess: async () => undefined, revokeRelay: () => undefined, log: silentLogger, now: () => now });
    expect(() => none.browser({ name: "x", access: FULL }, FULL)).toThrow(/serves no browser/);
    store.close();
  });

  test("cophylad invite --browser prints the address and the key, and the link alone on stdout", async () => {
    const { d, wss, origin } = await start();
    const out: string[] = [];
    const err: string[] = [];
    const write = { out: process.stdout.write, err: process.stderr.write };
    process.stdout.write = ((s: string) => (out.push(String(s)), true)) as never;
    process.stderr.write = ((s: string) => (err.push(String(s)), true)) as never;
    let code: number;
    try {
      code = await runCommand("invite", ["--browser", "--name", "Laptop", "--access", "view", "--expires", "7d", "--home", d.home, "--port", String(d.api.port)]);
    } finally {
      process.stdout.write = write.out;
      process.stderr.write = write.err;
    }
    expect(err.join("")).toContain("A key for the browser Laptop (view)");
    expect(code).toBe(0);
    const link = out.join("").trim();
    expect(link).toMatch(new RegExp(`^https://[0-9.]+:${d.controller!.port}/#k=`));
    const key = keyFromFragment(new URL(link).hash)!;
    expect(err.join("")).toContain(new URL(link).origin);
    expect(err.join("").replace(/-/g, "")).toContain(key);
    const page = await socket(wss, origin);
    const paired = (await pairKey(page, key)) as { result: { client: Controller } };
    expect(paired.result.client).toMatchObject({ name: "Laptop", form: "browser" });
    expect(paired.result.client.access?.scopes).toEqual(["sessions:read", "views", "metrics:read"]);
    expect(about(paired.result.client.expiresAt, 7 * DAY)).toBe(true);
  });
});

describe("the ways round an end", () => {
  test("what is left of the minter's grant bounds what it mints; a session mints nothing", () => {
    expect(boundedBy({}, undefined, 1000, "invites nobody")).toBeUndefined();
    expect(boundedBy({}, 1500, 1000, "invites nobody")).toBe(1500);
    expect(boundedBy({ ends: 5000 }, undefined, 1000, "invites nobody")).toBe(5000);
    expect(boundedBy({ ends: 5000 }, 9000, 1000, "invites nobody")).toBe(5000);
    expect(boundedBy({ ends: 5000 }, 1100, 1000, "invites nobody")).toBe(1100);
    expect(() => boundedBy({ ends: 5000 }, 5100, 5000, "invites nobody")).toThrow(/ended/);
    expect(() => boundedBy({ session: true }, 1100, 1000, "invites nobody")).toThrow(/a session on a shared computer invites nobody/);
  });

  test("a phone's invite, a node's invite and a pairing code from a client whose grant ends all end no later than it does", async () => {
    const { d, wss } = await start();
    const ends = Date.now() + HOUR;
    const minter = d.grants.createController("Firefox", { form: "browser", expiresAt: ends });
    const page = await socket(wss);
    await hello(page, minter.token);

    // a phone's invite: with no end asked, with a longer one, with a shorter one
    const open = await invite(page);
    expect(open.grant.expiresAt).toBe(ends);
    const long = await invite(page, { expiresIn: 30 * DAY });
    expect(long.grant.expiresAt).toBe(ends);
    const short = await invite(page, { expiresIn: 20 * 60_000, inviteExpiresIn: 60_000 });
    expect(about(short.grant.expiresAt, 20 * 60_000)).toBe(true);
    // redeemed, the phone holds no more than that
    const phone = await redeem(await socket(wss), long.invite);
    expect(phone.client.expiresAt).toBe(ends);

    // a node's invite (this node is a primary of its own cluster)
    const node = await page.request<{ grant: Grant }>("grant.invite", { kind: "node", name: "laptop", role: "hands" });
    expect(node.grant.expiresAt).toBe(ends);
    const longNode = await page.request<{ grant: Grant }>("grant.invite", { kind: "node", name: "laptop", role: "hands", expiresIn: 365 * DAY });
    expect(longNode.grant.expiresAt).toBe(ends);
    const shortNode = await page.request<{ grant: Grant }>("grant.invite", { kind: "node", name: "laptop", role: "hands", expiresIn: 20 * 60_000, inviteExpiresIn: 60_000 });
    expect(about(shortNode.grant.expiresAt, 20 * 60_000)).toBe(true);

    // a pairing window: the code makes a phone that ends with the client that opened it
    const offer = await page.request<{ code: string }>("pair.start", {});
    const claimed = await (await socket(wss)).request<{ client: Controller }>("pair.claim", { code: offer.code, name: "Pixel" });
    expect(claimed.client.expiresAt).toBe(ends);
    expect(claimed.client.form).toBeUndefined();
  });

  test("a relayed client's grant ends on the primary as it does on its own node", async () => {
    primary = await startPrimary();
    secondary = await startSecondary(primary, { controller: true });
    await linked(secondary);
    const ends = Date.now() + HOUR;
    // paired on the secondary: the row is that node's own, and the primary never holds it
    const minter = secondary.grants.createController("Firefox", { form: "browser", expiresAt: ends });
    expect(primary.d.grants.get(minter.controller.id)).toBeUndefined();
    const page = await socket(`wss://127.0.0.1:${secondary.controller!.port}/ws/client`);
    const said = (await page.hello(minter.token, { kind: "controller", audio: { in: false, out: false } })) as { result: { node: string; protocolVersion: number } };
    expect(said.result.node).toBe(primary.d.identity.id);
    expect(said.result.protocolVersion).toBe(PROTOCOL_VERSION);
    // `grant.invite` is the primary's to answer: it bounds the invite by the end the secondary told it
    const node = await page.request<{ grant: Grant }>("grant.invite", { kind: "node", name: "laptop", role: "hands", expiresIn: 365 * DAY });
    expect(node.grant.expiresAt).toBe(ends);
    // `pair.start` is this node's own: its code is bounded here
    const offer = await page.request<{ code: string }>("pair.start", {});
    const claimed = await (await socket(`wss://127.0.0.1:${secondary.controller!.port}/ws/client`)).request<{ client: Controller }>("pair.claim", { code: offer.code, name: "Pixel" });
    expect(claimed.client.expiresAt).toBe(ends);
  }, 30_000);
});
