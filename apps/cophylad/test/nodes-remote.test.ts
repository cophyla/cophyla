// Remote desktop across the node link. A desktop client on the secondary, named by the node it
// sits on, opens the primary's desktop: `remote.open` is answered on the secondary, its
// moonlight pairs, the PIN goes up the link as `remote.pair`, the primary's gate asks the user
// in the host's words and the host accepts it once allowed; both nodes keep a row. A
// controller on the primary opens the secondary's desktop: the stream page is on the
// primary's controller origin, the sidecar's pairing is forwarded to the secondary and
// audited there as the primary node; a secondary with no LAN listener is found at the address
// it linked from. The secondary's `remote.state` reaches the primary's clients as it changes
// and in `welcome`.

import { afterEach, describe, expect, test } from "bun:test";
import type { Ask, AuditEntry, RemoteState } from "@cophyla/protocol";
import { silentLogger } from "../src/log.ts";
import { HostApi } from "../src/remote/host.ts";
import { startFakeApollo } from "./fakes/apollo.ts";
import type { FakeApollo } from "./fakes/apollo.ts";
import { FAKE_WEB, remoteSeams } from "./fakes/remote.ts";
import type { RemoteSeams } from "./fakes/remote.ts";
import { isMethod, TestClient, waitFor } from "./helpers.ts";
import { client, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

let primary: Primary | undefined;
let secondary: Started | undefined;
const fakes: FakeApollo[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await stopAll(secondary, primary?.d);
  for (const f of fakes.splice(0)) await f.stop();
  primary = undefined;
  secondary = undefined;
});

/** The remote seams of one daemon: its moonlight and capture fakes, its host on `fake` when it has one. */
function seamsFor(seams: RemoteSeams, fake?: FakeApollo) {
  return {
    os: "windows" as const,
    exec: seams.exec,
    moonlight: { spawn: seams.spawn, command: seams.moonlight },
    screenshot: seams.screenshot,
    display: seams.display,
    web: { command: [process.execPath, FAKE_WEB] },
    ...(fake ? { hostApi: (kind: "apollo" | "sunshine") => new HostApi({ kind, port: fake.port, log: silentLogger, timeoutMs: 3000 }) } : {}),
  };
}

const remoteToml = (enabled: boolean, seams: RemoteSeams) =>
  `[remote]\nenabled = ${enabled}\nhost_command = "C:\\\\fake\\\\Apollo\\\\sunshine.exe"\nmoonlight = ${JSON.stringify(seams.moonlight)}\npoll_ms = 100\n\n`;

const rows = (d: { store: { audit: { list(o: { limit: number }): AuditEntry[] } } }, action: string) => d.store.audit.list({ limit: 200 }).filter((e) => e.action === action);

describe("remote desktop across nodes", () => {
  test("a desktop client on the secondary opens the primary's desktop: pairing goes up the link, the primary asks, both audit", async () => {
    const hostA = await startFakeApollo();
    fakes.push(hostA);
    const seamsP = remoteSeams();
    const seamsS = remoteSeams();
    seamsS.onPair = (_host, pin) => hostA.expectPin(pin);
    primary = await startPrimary({ toml: `[node]\nname = "study"\n\n${remoteToml(true, seamsP)}`, daemon: { remote: seamsFor(seamsP, hostA) } });
    await primary.d.remote.ready();
    secondary = await startSecondary(primary, { toml: remoteToml(false, seamsS), daemon: { remote: seamsFor(seamsS) } });
    await linked(secondary);

    const onPrimary = await client(primary.d, "desk-a");
    clients.push(onPrimary);
    const onSecondary = await client(secondary, "desk-b");
    clients.push(onSecondary);
    // the desktop app on the secondary is named by the node it sits on, on the primary too
    await waitFor(() => primary!.d.clients.list().some((c) => c.name === "desk-b"));
    expect(primary.d.clients.list().find((c) => c.name === "desk-b")!.node).toBe(secondary.identity.id);

    const opened = onSecondary.request<object>("remote.open", { node: primary.d.identity.id });
    const ask = (await onPrimary.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && (p as Ask).source.kind === "gate"), 10_000)).params as Ask;
    expect(ask.title).toBe(`Let ${secondary.identity.name} view and control this desktop?`);
    expect(ask.node).toBe(primary.d.identity.id);
    await onPrimary.request("ask.answer", { id: ask.id, option: "allow" });
    expect(await opened).toEqual({});

    // the viewer ran on the secondary: checked, paired with the primary's address, confirmed, streamed
    const moon = seamsS.commands.filter((x) => x.startsWith(seamsS.moonlight)).map((x) => x.slice(seamsS.moonlight.length + 1).split(" ").slice(0, 2).join(" "));
    const address = moon[0]!.split(" ")[1]!;
    expect(moon).toEqual([`list ${address}`, `pair ${address}`, `list ${address}`, `stream ${address}`]);
    expect(secondary.nodes.registry.endpointsOf(primary.d.identity.id)[0]!.startsWith(address)).toBe(true);
    expect(seamsP.commands.some((x) => x.startsWith(seamsP.moonlight))).toBe(false);
    expect(hostA.clients.map((c) => c.name)).toEqual([secondary.identity.name]);

    // audited on the host as the secondary node, and on the viewer as the user who opened it
    const pairRow = rows(primary.d, "remote.pair")[0]!;
    expect(pairRow.principal).toEqual({ kind: "node", id: secondary.identity.id });
    expect(pairRow.target).toBe(secondary.identity.name);
    expect(pairRow.outcome).toBe("ok");
    expect((pairRow.args as { pin: string }).pin).toBe("[redacted]");
    const openRow = rows(secondary, "remote.open")[0]!;
    expect(openRow.principal.kind).toBe("user");
    expect(openRow.target).toBe(primary.d.identity.id);
    expect(rows(primary.d, "remote.open")).toEqual([]);

    // the host seeing the viewer connect is the primary's desktop watched, heard by the secondary's client too
    hostA.connect(hostA.clients[0]!.uuid);
    await onSecondary.next(isMethod("remote.state", (p) => (p as RemoteState).node === primary!.d.identity.id && (p as RemoteState).streaming), 10_000);
    expect(secondary.remote.state().streaming).toBe(false);
  }, 60_000);

  test("a controller on the primary opens the secondary's desktop: the page is on the primary, the pairing is audited on the secondary; state reaches the primary", async () => {
    const hostB = await startFakeApollo();
    hostB.acceptAny = true;
    fakes.push(hostB);
    const seamsP = remoteSeams();
    const seamsS = remoteSeams();
    primary = await startPrimary({ toml: `[node]\nname = "study"\n\n${remoteToml(false, seamsP)}`, daemon: { remote: seamsFor(seamsP) } });
    secondary = await startSecondary(primary, { gateRules: { "node:remote.pair": "allow", "node:remote.invite": "allow" }, toml: remoteToml(true, seamsS), daemon: { remote: seamsFor(seamsS, hostB) } });
    await secondary.remote.ready();
    await linked(secondary);
    // with no LAN listener the secondary names no endpoint: its machine is where it linked from
    expect(primary.d.nodes.registry.endpointsOf(secondary.identity.id)).toEqual([]);
    expect(primary.d.nodes.addressOf(secondary.identity.id)).toBe("127.0.0.1");

    // the secondary's host state is on the primary's bus and in a new client's welcome
    await waitFor(() => primary!.d.remote.states().some((s) => s.node === secondary!.identity.id && s.host.status === "ready"), 10_000);
    const desk = await client(primary.d, "desk-a");
    clients.push(desk);
    const welcomed = (await desk.next(isMethod("remote.state", (p) => (p as RemoteState).node === secondary!.identity.id))).params as RemoteState;
    expect(welcomed.host).toEqual({ kind: "apollo", status: "ready" });

    const { token } = primary.d.grants.createController("Pixel");
    const phone = await TestClient.connect(`wss://127.0.0.1:${primary.d.controller!.port}/ws/client`, { insecure: true });
    clients.push(phone);
    await phone.call("hello", { token, kind: "controller", audio: { in: false, out: false } });
    const { url } = await phone.request<{ url: string }>("remote.open", { node: secondary.identity.id });
    expect(url.startsWith(`https://127.0.0.1:${primary.d.controller!.port}/remote/?t=`)).toBe(true);
    expect(hostB.clients.map((c) => c.name)).toEqual(["study web"]);
    const pairRow = rows(secondary, "remote.pair")[0]!;
    expect(pairRow.principal).toEqual({ kind: "node", id: primary.d.identity.id });
    expect(pairRow.target).toBe("study web");

    // the page opens through the primary's proxy
    const claim = await fetch(url, { tls: { rejectUnauthorized: false } } as RequestInit);
    expect(claim.status).toBe(200);

    // the new viewer on the secondary's host reaches the primary's desktop client
    await desk.next(isMethod("remote.state", (p) => (p as RemoteState).node === secondary!.identity.id && (p as RemoteState).viewers.some((v) => v.name === "study web")), 10_000);

    // an invite from the secondary's host, asked on the primary and served there
    const invite = await desk.request<{ otp: string; link: string }>("remote.invite", { node: secondary.identity.id });
    expect(invite.link).toMatch(/^art:\/\/192\.168\.1\.44:47989\?pin=1000&passphrase=cophyla-[0-9a-f]{6}&name=/);
    const inviteRow = rows(secondary, "remote.invite")[0]!;
    expect(inviteRow.principal).toEqual({ kind: "node", id: primary.d.identity.id });
    expect((inviteRow.result!.body as { otp: string }).otp).toBe("[redacted]");

    // a node that leaves drops out of what a new client is told
    const gone = secondary.identity.id;
    await stopAll(secondary);
    secondary = undefined;
    await waitFor(() => !primary!.d.remote.states().some((s) => s.node === gone), 10_000);
  }, 60_000);

  test("the desktop app on the primary shares the secondary's desktop, asked there, and shows it beside its view on a loopback page seeded for low latency", async () => {
    const hostB = await startFakeApollo();
    hostB.acceptAny = true;
    fakes.push(hostB);
    const seamsP = remoteSeams();
    const seamsS = remoteSeams();
    seamsS.screen = { width: 2560, height: 1440 };
    primary = await startPrimary({ toml: `[node]\nname = "study"\n\n${remoteToml(false, seamsP)}`, daemon: { remote: seamsFor(seamsP) } });
    secondary = await startSecondary(primary, { gateRules: { "node:remote.pair": "allow" }, toml: remoteToml(false, seamsS), daemon: { remote: seamsFor(seamsS, hostB) } });
    await linked(secondary);
    const desk = await client(primary.d, "desk-a");
    clients.push(desk);
    await waitFor(() => primary!.d.remote.states().some((s) => s.node === secondary!.identity.id && s.host.status === "off"), 10_000);

    // Share: served on the secondary, whose gate asks in its own words; answered from the primary
    const sharing = desk.request("remote.enable", { node: secondary.identity.id });
    const ask = (await desk.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && (p as Ask).source.kind === "gate"), 10_000)).params as Ask;
    expect(ask.title).toBe("Share this desktop?");
    expect(ask.node).toBe(secondary.identity.id);
    await desk.request("ask.answer", { id: ask.id, option: "allow" });
    expect(await sharing).toEqual({});
    await desk.next(isMethod("remote.state", (p) => (p as RemoteState).node === secondary!.identity.id && (p as RemoteState).host.status === "ready"), 10_000);
    const row = rows(secondary, "remote.enable")[0]!;
    expect(row.principal).toEqual({ kind: "node", id: primary.d.identity.id });
    expect(rows(primary.d, "remote.enable")[0]!.principal.kind).toBe("user");

    // Beside: the primary's own web viewer, paired with the secondary's host, on this machine's loopback
    const { url, stream, video } = await desk.request<{ url: string; stream: string; video?: { width: number; height: number } }>("remote.open", { node: secondary.identity.id, embed: true });
    // sized to the secondary's screen, as its remote.state says it
    expect(video).toEqual({ width: 2560, height: 1440 });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/remote\/\?t=[0-9a-f]{32}$/);
    expect(stream).toMatch(/^stream_[0-9a-f]{16}$/);
    expect(hostB.clients.map((c) => c.name)).toEqual(["study web"]);
    expect(seamsP.commands.some((x) => x.startsWith(seamsP.moonlight))).toBe(false);
    const claim = await fetch(url);
    expect(claim.status).toBe(200);
    expect(claim.headers.get("set-cookie")).not.toContain("Secure");
    const page = await claim.text();
    expect(page).toContain(`s.dataTransport="websocket";s.canvasRenderer=true;`);
    expect(page).toContain(`s.videoSize="custom";s.videoSizeCustom={"width":2560,"height":1440};s.fps=60;s.bitrate=55296;`);
    // the stream page hides the pointer over the picture, which shows the desktop's own cursor
    const cookie = claim.headers.get("set-cookie")!.split(";")[0]!;
    const streamPage = await fetch(new URL(/"(\/remote\/stream\.html[^"]*)"/.exec(page)![1]!, url), { headers: { cookie } });
    expect(streamPage.headers.get("cache-control")).toBe("no-store");
    expect(streamPage.headers.get("etag")).toBeNull();
    expect(await streamPage.text()).toContain("<title>Stream: Desktop</title><style>.video-stream{cursor:none}</style></head>");
    await waitFor(() => primary!.d.remote.state().viewers.some((v) => v.kind === "web" && v.name === "desk-a"));
    await desk.request("remote.close", { stream });
    await waitFor(() => !primary!.d.remote.state().viewers.some((v) => v.kind === "web"));

    // Stop sharing, also served and asked there
    const stopping = desk.request("remote.disable", { node: secondary.identity.id });
    const stopAsk = (await desk.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && (p as Ask).id !== ask.id), 10_000)).params as Ask;
    expect(stopAsk.title).toBe("Stop sharing this desktop?");
    await desk.request("ask.answer", { id: stopAsk.id, option: "allow" });
    expect(await stopping).toEqual({});
    await waitFor(() => primary!.d.remote.states().some((s) => s.node === secondary!.identity.id && s.host.status === "off"), 10_000);
    expect(secondary.store.meta.get("remote_enabled")).toBe("0");

    // off, the host still lists who it paired, and a pairing is taken back there, asked by its name
    const off = primary.d.remote.states().find((s) => s.node === secondary!.identity.id)!;
    const web = off.viewers.find((v) => v.name === "study web")!;
    expect(web.kind).toBe("native");
    const revoking = desk.request("remote.revoke", { node: secondary.identity.id, viewer: web.id });
    const revokeAsk = (await desk.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && (p as Ask).title.startsWith("Revoke")), 10_000)).params as Ask;
    expect(revokeAsk.title).toBe("Revoke study web?");
    await desk.request("ask.answer", { id: revokeAsk.id, option: "allow" });
    expect(await revoking).toEqual({});
    expect(hostB.clients.map((c) => c.name)).toEqual([]);
  }, 60_000);

  test("a hands node's desktop is not switched from the primary", async () => {
    const seamsP = remoteSeams();
    const seamsS = remoteSeams();
    primary = await startPrimary({ toml: remoteToml(false, seamsP), daemon: { remote: seamsFor(seamsP) } });
    secondary = await startSecondary(primary, { hands: true, gateRules: { "node:remote.enable": "allow" }, toml: remoteToml(false, seamsS), daemon: { remote: seamsFor(seamsS) } });
    await linked(secondary);
    const desk = await client(primary.d, "desk-a");
    clients.push(desk);
    const r = await desk.call("remote.enable", { node: secondary.identity.id });
    expect("error" in r && r.error.message).toMatch(/joined as hands/);
    expect(secondary.store.meta.get("remote_enabled")).toBeUndefined();
  }, 60_000);
});
