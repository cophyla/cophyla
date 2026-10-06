// A browser's grant: it has an end, fixed when it is minted. A code or an invite spent from a
// page in a browser makes a browser's grant, thirty days at the most and never longer than the
// one it had; spent from an app's socket it makes what it always did. And the ways round an
// end are closed: what a client whose own grant ends invites, or opens a code for, ends no
// later than it does, on the node it is on and on the primary a secondary relays it to.

import { afterEach, describe, expect, test } from "bun:test";
import { parseInvite, PROTOCOL_VERSION } from "@cophyla/protocol";
import type { Controller, Grant, InviteOffer } from "@cophyla/protocol";
import type { Daemon } from "../src/daemon.ts";
import { BROWSER_GRANT_MS, Grants } from "../src/grants/store.ts";
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
