// Ports across the links, with the gate, the registry and the carrying played by fakes. On the
// host a share is gated as the node on the link, the primary trusted where it was at the join,
// with the machine it is for as the primary vouches: on the primary the node on the link, on a
// secondary what the primary said. The primary carries a share, its end and its pipes on to the
// machine whose port it is, setting the viewer over what a secondary said, and refuses a hands
// node, a machine that lends folders, one at its sign-in door, one with an older Cophyla, and
// any link that rides the relay. An older primary refuses the names outright.

import { describe, expect, test } from "bun:test";
import { RpcError } from "@cophyla/protocol";
import type { NodeRecord } from "@cophyla/protocol";
import type { Gate, GateRequest } from "../src/gate/index.ts";
import { silentLogger } from "../src/log.ts";
import { PortLinks } from "../src/nodes/ports.ts";
import type { PipeHub, PipeTarget } from "../src/remote/pipes.ts";
import type { Ports } from "../src/remote/ports.ts";

const PRIMARY = "node_01ARZ3NDEKTSV4RRFFQ69G5FPR";
const LAPTOP = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const SHARE = "prt_01ARZ3NDEKTSV4RRFFQ69G5FP1";

function row(id: string, name: string, patch: Partial<NodeRecord> = {}): NodeRecord {
  return { id, name, role: "secondary", status: "online", via: "direct", platform: "windows", scope: { kind: "machine" }, capabilities: { harnesses: [], voice: { wake: false, stt: false, tts: false }, remote: false, brain: false, ports: true }, versions: { platform: "0.30.0", protocol: 1 }, lastSeen: 0, endpoints: [], ...patch } as NodeRecord;
}

function links(opts: { self: string; primary: boolean; rows?: NodeRecord[]; straight?: (n: string) => boolean; trusted?: boolean }) {
  const gated: GateRequest[] = [];
  const carried: { node: string; method: string; params: Record<string, unknown> }[] = [];
  const opened: { from: string; params: unknown; target: PipeTarget }[] = [];
  const shared: unknown[] = [];
  const unshared: unknown[] = [];
  const rows = new Map((opts.rows ?? []).map((r) => [r.id, r]));
  const gate = {
    run: async (req: GateRequest, handler: () => unknown) => {
      gated.push(req);
      return handler();
    },
  } as unknown as Gate;
  const ports = {
    share: async (p: unknown) => {
      shared.push(p);
      return { share: SHARE, expiresAt: 1 };
    },
    unshare: (share: string, viewer: string) => {
      unshared.push({ share, viewer });
      return { connections: 3, bytes: 99 };
    },
    linkGone: () => undefined,
  } as unknown as Ports;
  const pipes = {
    openForLink: async (from: string, params: unknown, target: PipeTarget) => {
      opened.push({ from, params, target });
      return { window: 262144 };
    },
  } as unknown as PipeHub;
  const l = new PortLinks({
    selfId: () => opts.self,
    primary: () => opts.primary,
    gate,
    ports: () => ports,
    pipes: () => pipes,
    carry: async (node, method, params) => {
      carried.push({ node, method, params: params as Record<string, unknown> });
      return method === "port.share" ? { share: SHARE, expiresAt: 1 } : {};
    },
    row: (n) => rows.get(n),
    straight: opts.straight ?? (() => true),
    trusted: () => opts.trusted === true,
    log: silentLogger,
  });
  return { l, gated, carried, opened, shared, unshared };
}

describe("ports across the links", () => {
  test("on the host, a share is gated as the node on the link, for the machine the primary vouches for", async () => {
    // a secondary host: the request came from its primary, which says whose it is
    const h = links({ self: DESK, primary: false, trusted: true, rows: [row(PRIMARY, "Hub"), row(LAPTOP, "Laptop")] });
    expect(await h.l.request({ id: PRIMARY, sessionKey: "link-1" }, "port.share", { node: DESK, port: 3000, viewer: LAPTOP, name: "Laptop" })).toEqual({ share: SHARE, expiresAt: 1 });
    expect(h.gated[0]).toMatchObject({ principal: { kind: "node", id: PRIMARY }, action: "port.share", target: "3000", args: { port: 3000, viewer: LAPTOP, name: "Laptop" }, sessionKey: "link-1", trusted: true });
    expect(h.shared[0]).toEqual({ port: 3000, viewer: LAPTOP, name: "Laptop", link: PRIMARY });
    // the primary as the host: the viewer is the node on the link, whatever it said
    const p = links({ self: PRIMARY, primary: true, rows: [row(LAPTOP, "Laptop")] });
    await p.l.request({ id: LAPTOP, sessionKey: "link-2" }, "port.share", { node: PRIMARY, port: 3000, viewer: DESK });
    expect(p.shared[0]).toEqual({ port: 3000, viewer: LAPTOP, link: LAPTOP });
    expect(p.gated[0]).not.toHaveProperty("trusted");
    // its end, the same way
    expect(await h.l.request({ id: PRIMARY, sessionKey: "link-1" }, "port.unshare", { node: DESK, share: SHARE, viewer: LAPTOP })).toEqual({ connections: 3, bytes: 99 });
    expect(h.unshared[0]).toEqual({ share: SHARE, viewer: LAPTOP });
    expect(h.gated[1]).toMatchObject({ action: "port.unshare", target: SHARE, args: { share: SHARE, viewer: LAPTOP } });
  });

  test("the primary carries a share, its end and its pipes on, the viewer set to the node on the link", async () => {
    const p = links({ self: PRIMARY, primary: true, rows: [row(LAPTOP, "Laptop"), row(DESK, "Desk")] });
    await p.l.request({ id: LAPTOP, sessionKey: "link-2" }, "port.share", { node: DESK, port: 5173, viewer: PRIMARY, name: "Laptop" });
    expect(p.carried[0]).toEqual({ node: DESK, method: "port.share", params: { node: DESK, port: 5173, viewer: LAPTOP, name: "Laptop" } });
    expect(p.gated).toEqual([]);
    await p.l.request({ id: LAPTOP, sessionKey: "link-2" }, "port.unshare", { node: DESK, share: SHARE });
    expect(p.carried[1]).toEqual({ node: DESK, method: "port.unshare", params: { node: DESK, share: SHARE, viewer: LAPTOP } });
    await p.l.request({ id: LAPTOP, sessionKey: "link-2" }, "port.pipe.open", { node: DESK, pipe: "n4", share: SHARE, viewer: PRIMARY });
    expect(p.opened[0]).toEqual({ from: LAPTOP, params: { node: DESK, pipe: "n4", share: SHARE, viewer: PRIMARY }, target: { kind: "port", share: SHARE, viewer: LAPTOP } });
    // on the host, a pipe for the machine its primary names
    const h = links({ self: DESK, primary: false, rows: [row(PRIMARY, "Hub")] });
    await h.l.request({ id: PRIMARY, sessionKey: "link-1" }, "port.pipe.open", { node: DESK, pipe: "n5", share: SHARE, viewer: LAPTOP });
    expect(h.opened[0]!.target).toEqual({ kind: "port", share: SHARE, viewer: LAPTOP });
  });

  test("a hands node, a lent machine, a sign-in door and an older Cophyla are refused", async () => {
    const p = links({
      self: PRIMARY,
      primary: true,
      rows: [row(LAPTOP, "Laptop"), row(DESK, "Desk", { hands: true }), row("node_01ARZ3NDEKTSV4RRFFQ69G5FN1", "Lent", { scope: { kind: "workspaces", workspaces: [] } as never }), row("node_01ARZ3NDEKTSV4RRFFQ69G5FD1", "Door", { door: "signin" }), row("node_01ARZ3NDEKTSV4RRFFQ69G5FQ1", "Old", { capabilities: { harnesses: [], voice: { wake: false, stt: false, tts: false }, remote: false, brain: false } })],
    });
    const from = { id: LAPTOP, sessionKey: "link-2" };
    await expect(p.l.request({ ...from, hands: true }, "port.share", { node: PRIMARY, port: 3000, viewer: LAPTOP })).rejects.toThrow("a hands node opens no port");
    await expect(p.l.request(from, "port.share", { node: DESK, port: 3000, viewer: LAPTOP })).rejects.toThrow("Desk is lent as hands");
    await expect(p.l.request(from, "port.share", { node: "node_01ARZ3NDEKTSV4RRFFQ69G5FN1", port: 3000, viewer: LAPTOP })).rejects.toThrow("Lent shares some folders alone");
    await expect(p.l.request(from, "port.share", { node: "node_01ARZ3NDEKTSV4RRFFQ69G5FD1", port: 3000, viewer: LAPTOP })).rejects.toThrow("Door is at its sign-in screen");
    await expect(p.l.request(from, "port.share", { node: "node_01ARZ3NDEKTSV4RRFFQ69G5FQ1", port: 3000, viewer: LAPTOP })).rejects.toThrow("Update Cophyla on Old");
    await expect(p.l.request(from, "port.pipe.open", { node: DESK, pipe: "n1", share: SHARE })).rejects.toThrow("Desk is lent as hands");
    expect(p.carried).toEqual([]);
    await expect(p.l.request(from, "port.share", { node: DESK, port: 0, viewer: LAPTOP })).rejects.toThrow(RpcError);
  });

  test("a link on the relay refuses a share, on either side of the primary", async () => {
    const rows = [row(LAPTOP, "Laptop"), row(DESK, "Desk")];
    const viewerOnRelay = links({ self: PRIMARY, primary: true, rows, straight: (n) => n !== LAPTOP });
    await expect(viewerOnRelay.l.request({ id: LAPTOP, sessionKey: "l" }, "port.share", { node: DESK, port: 3000, viewer: LAPTOP })).rejects.toThrow("Opening Desk's localhost needs a direct connection; Laptop reaches Desk only through the relay right now");
    const hostOnRelay = links({ self: PRIMARY, primary: true, rows, straight: (n) => n !== DESK });
    await expect(hostOnRelay.l.request({ id: LAPTOP, sessionKey: "l" }, "port.share", { node: DESK, port: 3000, viewer: LAPTOP })).rejects.toThrow("only through the relay");
    // the host's own link to its primary rides the relay
    const host = links({ self: DESK, primary: false, rows: [row(PRIMARY, "Hub")], straight: () => false });
    await expect(host.l.request({ id: PRIMARY, sessionKey: "l" }, "port.share", { node: DESK, port: 3000, viewer: LAPTOP })).rejects.toThrow("only through the relay");
    expect([...viewerOnRelay.carried, ...hostOnRelay.carried, ...host.shared]).toEqual([]);
  });
});
