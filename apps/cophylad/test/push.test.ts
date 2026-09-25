// Push from the daemon's side: which asks go to which phones, trimmed how, the dismiss
// that follows an answer, and what is not pushed (a phone with the app open, push off,
// the link down). The fake server records what the link carried.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Ask, PushAsk } from "@cophyla/protocol";
import { paths } from "../src/config/load.ts";
import type { Daemon } from "../src/daemon.ts";
import { MAX_PUSH_BUTTONS, trimAsk } from "../src/push/index.ts";
import { FakeServer } from "./fakes/server.ts";
import { removeHome, sleep, tempHome, TestClient, waitFor } from "./helpers.ts";

interface Started {
  d: Daemon & { home: string };
  fake: FakeServer;
  ui: TestClient;
}

let current: Started | undefined;
const phones: TestClient[] = [];
afterEach(async () => {
  for (const p of phones.splice(0)) p.close();
  if (!current) return;
  const s = current;
  current = undefined;
  s.ui.close();
  await s.d.stop();
  await s.fake.stop();
  removeHome(s.d.home);
});

async function start(opts: { signedIn?: boolean; pushOff?: boolean } = {}): Promise<Started> {
  const fake = new FakeServer();
  const home = tempHome(`[controller]\nenabled = true\nport = 0\n\n[nodes]\ndiscovery = false\n\n${opts.pushOff ? "[push]\nenabled = false\n\n" : ""}[cloud]\nenabled = true\nurl = "${fake.url}"\nallow_insecure = true\nreconnect_ms = 20\nreconnect_max_ms = 100\n`);
  const p = paths(home);
  mkdirSync(p.data, { recursive: true });
  if (opts.signedIn !== false) writeFileSync(p.accountToken, fake.mintToken("test") + "\n", { mode: 0o600 });
  const { startDaemon } = await import("../src/daemon.ts");
  const { silentLogger } = await import("../src/log.ts");
  const d = Object.assign(await startDaemon({ home, port: 0, log: silentLogger, embedder: null, cloud: { keys: [fake.publicKey] } }), { home });
  const ui = await TestClient.connect(d.api.url);
  await ui.hello(d.token, { name: "desktop" });
  if (opts.signedIn !== false) await waitFor(() => d.cloud.hostedAllowed("push") === undefined, 5000);
  current = { d, fake, ui };
  return current;
}

/** A paired phone that registered a push device, through the LAN listener as the app does. */
async function registered(s: Started, name = "Pixel"): Promise<{ id: string; token: string; socket: TestClient }> {
  const { controller, token } = s.d.grants.createController(name);
  const socket = await TestClient.connect(`https://127.0.0.1:${s.d.controller!.port}/ws/client`, { insecure: true });
  phones.push(socket);
  await socket.request("hello", { token, kind: "controller", audio: { in: true, out: true } });
  await socket.request("push.register", { platform: "android", token: `fcm-${name}` });
  await waitFor(() => s.d.grants.pushOf(controller.id)?.pending === undefined);
  return { id: controller.id, token, socket };
}

const openAsk = (d: Daemon, extra: Partial<Parameters<Daemon["asks"]["open"]>[0]> = {}) =>
  d.asks.open({
    type: "permission",
    source: { kind: "gate", action: "tool.run", principal: { kind: "brain" } },
    title: "Allow  the agent to\nrun  git push?",
    detail: "The agent in ws-1 wants to run `git push origin main`. ".repeat(6),
    options: [
      { id: "allow", label: "Allow once" },
      { id: "always", label: "Always allow this, for every session from now on and forever" },
      { id: "deny", label: "Deny" },
      { id: "text", label: "Say why" },
    ],
    allowsText: true,
    answerableBy: ["user"],
    expiresAt: Date.now() + 120_000,
    ...extra,
  });

const sends = (fake: FakeServer, kind: string) => fake.pushes.filter((p) => p.method === "push.send" && p.params["kind"] === kind);

describe("push", () => {
  test("trimAsk: three buttons at most, labels and lines cut, the flags kept", () => {
    const ask: Ask = { id: "ask_1", node: "node_1", type: "choice", source: { kind: "brain" }, title: " a ".repeat(60), detail: "line one\nline two\n" + "x".repeat(300), options: Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, label: `option ${i} `.repeat(10) })), multiple: true, answerableBy: ["user"], status: "open", createdAt: 1, expiresAt: 99 };
    const t = trimAsk(ask);
    expect(t.options.length).toBe(MAX_PUSH_BUTTONS);
    for (const o of t.options) expect(o.label.length).toBeLessThanOrEqual(40);
    expect(t.title.length).toBeLessThanOrEqual(80);
    expect(t.detail!.length).toBeLessThanOrEqual(200);
    expect(t.detail).not.toContain("\n");
    expect(t).toMatchObject({ id: "ask_1", node: "node_1", multiple: true, expiresAt: 99 });
  });

  test("an ask with no phone connected is pushed once per registered phone, trimmed; the answer dismisses it", async () => {
    const s = await start();
    const { id, socket } = await registered(s);
    expect(s.fake.pushes.map((p) => p.method)).toEqual(["push.register"]);
    expect(s.fake.pushes[0]!.params).toEqual({ peer: id, platform: "android", token: "fcm-Pixel" });
    expect(s.d.grants.pushOf(id)?.pending).toBeUndefined();
    // the phone has the app open: the ask reaches its socket, no push
    const seen = openAsk(s.d);
    await socket.next((n) => n.method === "ask.state" && (n.params as Ask).id === seen.id);
    await sleep(100);
    expect(sends(s.fake, "ask")).toEqual([]);
    s.d.asks.answer(seen.id, { option: "deny" }, { kind: "user", client: "cli_test" });
    // the app closes: the next ask is pushed
    socket.close();
    await waitFor(() => s.d.clients.byController(id).length === 0);
    const ask = openAsk(s.d);
    await waitFor(() => sends(s.fake, "ask").length === 1);
    const sent = sends(s.fake, "ask")[0]!.params;
    expect(sent).toMatchObject({ peer: id, kind: "ask", title: "Allow the agent to run git push?" });
    const pushed = sent["ask"] as PushAsk;
    expect(pushed.id).toBe(ask.id);
    expect(pushed.node).toBe(s.d.identity.id);
    expect(pushed.options).toEqual([
      { id: "allow", label: "Allow once" },
      { id: "always", label: "Always allow this, for every session fr…" },
      { id: "deny", label: "Deny" },
    ]);
    expect(pushed.detail!.length).toBeLessThanOrEqual(200);
    expect(sent["body"]).toBe(pushed.detail);
    expect(s.d.push.pushedTo(ask.id)).toEqual([id]);
    // a second broadcast of the same open ask (a state re-send) does not push again
    s.d.bus.emit("ask.state", s.d.asks.get(ask.id)!);
    await sleep(100);
    expect(sends(s.fake, "ask").length).toBe(1);
    // answered on the desktop: one dismiss to the phone it went to
    s.d.asks.answer(ask.id, { option: "allow" }, { kind: "user", client: "cli_test" });
    await waitFor(() => sends(s.fake, "dismiss").length === 1);
    expect(sends(s.fake, "dismiss")[0]!.params).toMatchObject({ peer: id, kind: "dismiss", ask: { id: ask.id } });
    expect(s.fake.used["push_count"]).toBe(2);
    expect(s.d.push.pushedTo(ask.id)).toEqual([]);
    // an ask only the brain may answer is never pushed
    const brainOnly = openAsk(s.d, { answerableBy: ["brain"] });
    await sleep(100);
    expect(sends(s.fake, "ask").length).toBe(1);
    s.d.asks.answer(brainOnly.id, { option: "deny" }, { kind: "brain" });
  });

  test("an ask answered while its push is still out is dismissed once the push is through", async () => {
    const s = await start();
    const { id, socket } = await registered(s);
    socket.close();
    await waitFor(() => s.d.clients.byController(id).length === 0);
    s.fake.pushDelayMs = 300;
    const ask = openAsk(s.d);
    await waitFor(() => sends(s.fake, "ask").length === 1);
    // answered before the server has said the push went
    s.d.asks.answer(ask.id, { option: "deny" }, { kind: "user", client: "cli_test" });
    await waitFor(() => sends(s.fake, "dismiss").length === 1);
    expect(sends(s.fake, "dismiss")[0]!.params).toMatchObject({ peer: id, kind: "dismiss", ask: { id: ask.id } });
  });

  test("two phones: the connected one hears the ask on its socket, the other gets the push; a mirrored ask carries the other node", async () => {
    const s = await start();
    const a = await registered(s, "A");
    const b = await registered(s, "B");
    b.socket.close();
    await waitFor(() => s.d.clients.byController(b.id).length === 0);
    const ask = openAsk(s.d);
    await waitFor(() => sends(s.fake, "ask").length === 1);
    expect(sends(s.fake, "ask")[0]!.params["peer"]).toBe(b.id);
    await a.socket.next((n) => n.method === "ask.state" && (n.params as Ask).id === ask.id);
    s.d.asks.answer(ask.id, { option: "deny" }, { kind: "user", client: "cli_test" });
    await waitFor(() => sends(s.fake, "dismiss").length === 1);
    // an ask mirrored from a secondary rides the bus with that node's id, and is pushed with it
    const mirrored: Ask = { id: "ask_01ARZ3NDEKTSV4RRFFQ69G5FB9", node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAW", type: "choice", source: { kind: "brain" }, title: "From the laptop", options: [{ id: "y", label: "Yes" }], answerableBy: ["user"], status: "open", createdAt: Date.now() };
    s.d.bus.emit("ask.state", mirrored);
    await waitFor(() => sends(s.fake, "ask").length === 2);
    expect((sends(s.fake, "ask")[1]!.params["ask"] as PushAsk).node).toBe("node_01ARZ3NDEKTSV4RRFFQ69G5FAW");
    s.d.bus.emit("ask.state", { ...mirrored, status: "answered" });
    await waitFor(() => sends(s.fake, "dismiss").length === 2);
  });

  test("push.unregister and controller.revoke forget the device on both sides; a device the platform lost is dropped", async () => {
    const s = await start();
    const a = await registered(s, "A");
    await a.socket.request("push.unregister", {});
    await waitFor(() => !s.fake.pushDevices.has(a.id));
    expect(s.d.grants.pushOf(a.id)).toBeUndefined();
    const b = await registered(s, "B");
    await s.ui.request("controller.revoke", { id: b.id });
    await waitFor(() => !s.fake.pushDevices.has(b.id));
    expect(s.fake.pushes.filter((p) => p.method === "push.unregister").map((p) => p.params["peer"])).toEqual([a.id, b.id]);
    // the server says the device is gone: the row goes
    const c = await registered(s, "C");
    c.socket.close();
    await waitFor(() => s.d.clients.byController(c.id).length === 0);
    s.fake.pushDevices.delete(c.id);
    const ask = openAsk(s.d);
    await waitFor(() => s.d.grants.pushOf(c.id) === undefined, 5000);
    expect(sends(s.fake, "ask").length).toBe(1);
    s.d.asks.answer(ask.id, { option: "deny" }, { kind: "user", client: "cli_test" });
    await sleep(50);
    expect(sends(s.fake, "dismiss").length).toBe(0);
  });

  test("push off in config: nothing is forwarded, the row is still kept locally", async () => {
    const s = await start({ pushOff: true });
    const { controller, token } = s.d.grants.createController("Pixel");
    const socket = await TestClient.connect(`https://127.0.0.1:${s.d.controller!.port}/ws/client`, { insecure: true });
    phones.push(socket);
    await socket.request("hello", { token, kind: "controller", audio: { in: true, out: true } });
    await socket.request("push.register", { platform: "android", token: "fcm-x" });
    socket.close();
    await waitFor(() => s.d.clients.byController(controller.id).length === 0);
    const ask = openAsk(s.d);
    await sleep(150);
    expect(s.fake.pushes).toEqual([]);
    expect(s.d.grants.pushOf(controller.id)?.pending).toBe(true);
    s.d.asks.answer(ask.id, { option: "deny" }, { kind: "user", client: "cli_test" });
  });

  test("signed out or with the link down nothing is queued; a pending registration is replayed at link-up", async () => {
    const s = await start({ signedIn: false });
    const { controller, token } = s.d.grants.createController("Pixel");
    const socket = await TestClient.connect(`https://127.0.0.1:${s.d.controller!.port}/ws/client`, { insecure: true });
    phones.push(socket);
    await socket.request("hello", { token, kind: "controller", audio: { in: true, out: true } });
    await socket.request("push.register", { platform: "android", token: "fcm-late" });
    expect(s.d.grants.pushOf(controller.id)?.pending).toBe(true);
    socket.close();
    await waitFor(() => s.d.clients.byController(controller.id).length === 0);
    const ask = openAsk(s.d);
    await sleep(150);
    expect(s.fake.pushes).toEqual([]);
    s.d.asks.answer(ask.id, { option: "deny" }, { kind: "user", client: "cli_test" });
    // the user signs in: the registration goes up, and the next ask is pushed
    await s.ui.request("account.login", {});
    s.fake.approve();
    await waitFor(() => s.d.grants.pushOf(controller.id)?.pending === undefined, 5000);
    expect(s.fake.pushDevices.has(controller.id)).toBe(true);
    const later = openAsk(s.d);
    await waitFor(() => sends(s.fake, "ask").length === 1);
    expect(sends(s.fake, "ask")[0]!.params["peer"]).toBe(controller.id);
    s.d.asks.answer(later.id, { option: "deny" }, { kind: "user", client: "cli_test" });
    await waitFor(() => sends(s.fake, "dismiss").length === 1);
    // the link drops: an ask opened then is not pushed and not queued
    s.fake.restart(1000);
    await waitFor(() => s.d.cloud.hostedAllowed("push") !== undefined);
    const during = openAsk(s.d);
    await sleep(100);
    expect(sends(s.fake, "ask").length).toBe(1);
    await waitFor(() => s.d.cloud.hostedAllowed("push") === undefined, 5000);
    await sleep(100);
    expect(sends(s.fake, "ask").length).toBe(1);
    s.d.asks.answer(during.id, { option: "deny" }, { kind: "user", client: "cli_test" });
    await sleep(100);
    expect(sends(s.fake, "dismiss").length).toBe(1);
  });
});
