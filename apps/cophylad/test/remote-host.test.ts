// The host's API as spike 14 found it, against the fake host: the welcome flow sets the
// first credentials and refuses afterwards; Apollo takes a login cookie and nothing else,
// Sunshine Basic auth; a config write merges and restarts only when something changed; a
// PIN is posted until a session is pending; the paired client gets a viewer's permissions;
// an invite comes back with the code; unpair drops the client.

import { afterEach, describe, expect, test } from "bun:test";
import { HostApi, HostApiError, PERM_VIEWER } from "../src/remote/host.ts";
import { silentLogger } from "../src/log.ts";
import { startFakeApollo } from "./fakes/apollo.ts";
import type { FakeApollo } from "./fakes/apollo.ts";

let fake: FakeApollo | undefined;

afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

const api = (f: FakeApollo) => new HostApi({ kind: f.kind, port: f.port, log: silentLogger, timeoutMs: 3000 });

describe("remote host api", () => {
  test("welcome sets the first credentials; a second welcome is refused and the known pair logs in", async () => {
    fake = await startFakeApollo();
    const a = api(fake);
    expect(await a.alive()).toBe(true);
    expect(await a.welcome({ username: "cophyla", password: "s3cret" })).toBe(true);
    expect(fake.credentials).toEqual({ username: "cophyla", password: "s3cret" });
    const b = api(fake);
    expect(await b.welcome({ username: "other", password: "x" })).toBe(false);
    b.setCredentials({ username: "cophyla", password: "s3cret" });
    expect(await b.config()).toEqual({});
    expect(fake.logins).toBe(1);
  });

  test("a second login replaces the cookie and the first session recovers by logging in again", async () => {
    fake = await startFakeApollo({ credentials: { username: "u", password: "p" } });
    const a = api(fake);
    a.setCredentials({ username: "u", password: "p" });
    await a.config();
    const b = api(fake);
    b.setCredentials({ username: "u", password: "p" });
    await b.config();
    expect(fake.logins).toBe(2);
    // a's cookie is dead; its next call logs in once more
    await a.apps();
    expect(fake.logins).toBe(3);
    const wrong = api(fake);
    wrong.setCredentials({ username: "u", password: "nope" });
    await expect(wrong.config()).rejects.toBeInstanceOf(HostApiError);
  });

  test("sunshine takes basic auth on every call and mints no invite codes", async () => {
    fake = await startFakeApollo({ kind: "sunshine", credentials: { username: "u", password: "p" } });
    const a = api(fake);
    a.setCredentials({ username: "u", password: "p" });
    expect(await a.apps()).toEqual([
      { name: "Desktop", uuid: "90364DA8-F24F-192C-8C9A-C6970D31FA91" },
      { name: "Steam Big Picture", uuid: "FDAFB9D0" },
    ]);
    expect(fake.logins).toBe(0);
    await expect(a.otp("cophyla-abcd", "phone")).rejects.toThrow(/invite/);
  });

  test("configure merges, writes once and restarts only when something changed", async () => {
    fake = await startFakeApollo({ credentials: { username: "u", password: "p" } });
    fake.config = { min_log_level: "1" };
    const a = api(fake);
    a.setCredentials({ username: "u", password: "p" });
    expect(await a.configure({ sunshine_name: "study", origin_web_ui_allowed: "pc" })).toBe(true);
    expect(fake.config).toEqual({ min_log_level: "1", sunshine_name: "study", origin_web_ui_allowed: "pc" });
    expect(fake.restarts).toBe(1);
    expect(await a.waitAlive(2000)).toBe(true);
    expect((await a.serverInfo()).hostname).toBe("study");
    expect(await a.configure({ sunshine_name: "study" })).toBe(false);
    expect(fake.restarts).toBe(1);
  });

  test("pin posts until a session is pending, the client is listed under its name and gets a viewer's permissions", async () => {
    fake = await startFakeApollo({ credentials: { username: "u", password: "p" } });
    const a = api(fake);
    a.setCredentials({ username: "u", password: "p" });
    // the first client takes everything, as Apollo does; the second is the one that matters
    fake.expectPin("0001");
    await a.pin("0001", "first", { intervalMs: 20 });
    setTimeout(() => fake!.expectPin("4821"), 120);
    await a.pin("4821", "laptop", { intervalMs: 20, timeoutMs: 3000 });
    const tries = fake.pins.filter((p) => p.pin === "4821");
    expect(tries.length).toBeGreaterThan(2);
    expect(tries.at(-1)!.ok).toBe(true);
    const laptop = await a.clientNamed("laptop");
    expect(laptop).toBeDefined();
    expect(laptop!.perm! & PERM_VIEWER).not.toBe(PERM_VIEWER);
    await a.grantViewer(laptop!);
    const after = await a.clientNamed("laptop");
    expect(after!.perm! & PERM_VIEWER).toBe(PERM_VIEWER);
    expect(after!.name).toBe("laptop");
    await expect(a.pin("9999", "nobody", { intervalMs: 20, timeoutMs: 100 })).rejects.toThrow(/no pairing request/);
  });

  test("an invite is the host's code with its address; unpair and disconnect act on the uuid", async () => {
    fake = await startFakeApollo({ credentials: { username: "u", password: "p" } });
    const a = api(fake);
    a.setCredentials({ username: "u", password: "p" });
    const otp = await a.otp("cophyla-7f3a", "phone");
    expect(otp).toEqual({ otp: "1000", ip: "192.168.1.44", name: "FAKE-HOST" });
    expect(fake.otps[0]).toEqual({ passphrase: "cophyla-7f3a", deviceName: "phone", otp: "1000" });
    await expect(a.otp("abc", "phone")).rejects.toThrow(/too short/);
    fake.expectPin("1234");
    await a.pin("1234", "laptop", { intervalMs: 20 });
    const [c] = await a.clients();
    fake.connect(c!.uuid);
    expect((await a.clients())[0]!.connected).toBe(true);
    await a.disconnect(c!.uuid);
    expect((await a.clients())[0]!.connected).toBe(false);
    await a.unpair(c!.uuid);
    expect(await a.clients()).toEqual([]);
    await expect(a.unpair(c!.uuid)).rejects.toThrow(/refused/);
  });
});
