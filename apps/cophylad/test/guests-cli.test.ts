// The workspace node commands: asked on the machine's loopback listener alone, never from a
// phone or through a primary, and the invite kept in no audit row. A `local` hello keeps the
// terminal's client on this machine even while it is a full node of a cluster, where every
// other client is served by the primary. `cophyla node add` checks the folder, says what
// lending it means, reads the invite from a file and lends it; `list` and `remove` follow.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInvite } from "@cophyla/protocol";
import type { Client } from "@cophyla/protocol";
import type { MethodContext } from "../src/api/methods.ts";
import { main } from "../src/cophyla.ts";
import { guestMethods } from "../src/grants/guest-methods.ts";
import { TestClient, waitFor } from "./helpers.ts";
import { client, inviteOn, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

const primaries: Primary[] = [];
const started: Started[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await stopAll(...started, ...primaries.map((p) => p.d));
  started.length = 0;
  primaries.length = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A folder to lend, named as the file system names it: the daemon answers a folder resolved, and macOS's temp folder is a link. */
function folder(name = "friend"): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cophyla-lent-")));
  dirs.push(root);
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const outcome = (x: Promise<unknown>): Promise<string> => x.then(() => "ok", (e: unknown) => (e instanceof Error ? e.message : String(e)));

describe("asked on this machine alone", () => {
  test("from loopback only; the invite is hidden from the audit row", async () => {
    const calls: string[] = [];
    const guests = {
      check: (o: { folder: string }) => (calls.push(`check ${o.folder}`), { folder: o.folder, name: "f" }),
      add: async (o: { folder: string }) => (calls.push(`add ${o.folder}`), { id: "node_x", name: "f", folder: o.folder, state: "seeking" as const }),
      list: () => [],
      join: async () => ({ id: "node_x", name: "f", folder: "/f", state: "seeking" as const }),
      leave: async () => ({ id: "node_x", name: "f", folder: "/f", state: "unlinked" as const }),
      remove: async () => undefined,
    };
    const table = guestMethods({ guests: guests as never }) as Record<string, { handler: (p: unknown, c: MethodContext) => unknown; redact?: (p: unknown) => unknown }>;
    const ctx = (listener: string) => ({ listener, client: { id: "cli_x" } as Client, principal: { kind: "user", client: "cli_x" } }) as unknown as MethodContext;
    for (const listener of ["controller", "relayed", "cloud", "p2p"]) {
      for (const [method, params] of [
        ["guest.add", { folder: "/f", invite: "x" }],
        ["guest.list", {}],
        ["guest.join", { name: "f", invite: "x" }],
        ["guest.leave", { name: "f" }],
        ["guest.remove", { name: "f" }],
      ] as const) {
        expect(await outcome(Promise.resolve().then(() => table[method]!.handler(params, ctx(listener))))).toMatch(/on this machine alone/);
      }
    }
    expect(calls).toEqual([]);
    expect(await outcome(Promise.resolve(table["guest.add"]!.handler({ folder: "/f" }, ctx("loopback"))))).toBe("ok");
    expect(await outcome(Promise.resolve(table["guest.add"]!.handler({ folder: "/f", invite: "x" }, ctx("loopback"))))).toBe("ok");
    expect(calls).toEqual(["check /f", "add /f"]);
    expect(table["guest.add"]!.redact!({ folder: "/f", invite: "secret" })).toEqual({ folder: "/f", invite: "[redacted]" });
    expect(table["guest.join"]!.redact!({ name: "f", invite: "secret" })).toEqual({ name: "f", invite: "[redacted]" });
  });

  test("end to end: checked and added on loopback, refused on the LAN listener, and the invite in no row", async () => {
    const m = await startPrimary({ heartbeatMs: 1000 });
    primaries.push(m);
    const p2 = await startPrimary({ heartbeatMs: 1000 });
    primaries.push(p2);
    const c = await client(m.d);
    clients.push(c);
    const lent = folder();
    expect(await c.request<unknown>("guest.add", { folder: lent })).toEqual({ folder: lent, name: "friend" });
    expect(m.d.guests.list()).toEqual([]);
    const invite = await inviteOn(p2, { role: "hands" });
    const added = await c.request<{ guest: { id: string; name: string } }>("guest.add", { folder: lent, invite });
    expect(added.guest.name).toBe("friend");
    expect((await c.request<{ guests: { id: string }[] }>("guest.list")).guests.map((g) => g.id)).toEqual([added.guest.id]);
    // no row of the store keeps the invite or its secret
    const secret = parseInvite(invite).secret;
    const everything = m.d.store.tables().map((t) => JSON.stringify(m.d.store.db.query(`SELECT * FROM "${t}"`).all())).join("\n");
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(invite.trim());
    const row = m.d.store.audit.list({ limit: 50 }).find((e) => e.action === "guest.add" && (e.args as { invite?: string }).invite !== undefined);
    expect((row!.args as { invite: string }).invite).toBe("[redacted]");
    // a phone with every access, on the LAN listener: refused
    const { token } = m.d.grants.createController("phone", {});
    const phone = await TestClient.connect(`wss://127.0.0.1:${m.d.controller!.port}/ws/client`, { insecure: true });
    clients.push(phone);
    await phone.request("hello", { token, kind: "controller", audio: { in: false, out: false } });
    const r = await phone.call("guest.list", {});
    expect("error" in r && r.error.message).toMatch(/on this machine alone/);
  }, 60_000);
});

describe("a terminal's client on a node of a cluster", () => {
  test("a local hello is served here; any other is the primary's, and there the commands are refused", async () => {
    const p1 = await startPrimary({ heartbeatMs: 1000 });
    primaries.push(p1);
    const s = await startSecondary(p1, { heartbeatMs: 1000 });
    started.push(s);
    await linked(s);
    const relayed = await TestClient.connect(s.api.url);
    clients.push(relayed);
    const r1 = (await relayed.request<{ node: string }>("hello", { token: s.token, kind: "ui", name: "app", audio: { in: false, out: false } })).node;
    expect(r1).toBe(p1.d.identity.id);
    const refused = await relayed.call("guest.list", {});
    expect("error" in refused && refused.error.message).toMatch(/on this machine alone/);
    const local = await TestClient.connect(s.api.url);
    clients.push(local);
    const r2 = (await local.request<{ node: string }>("hello", { token: s.token, kind: "ui", name: "cophyla", audio: { in: false, out: false }, local: true })).node;
    expect(r2).toBe(s.identity.id);
    expect(await local.request<unknown>("guest.list", {})).toEqual({ guests: [] });
  }, 60_000);
});

describe("cophyla node", () => {
  test("add checks, says what it means, reads the invite from a file and lends the folder; list and remove follow", async () => {
    const m = await startPrimary({ heartbeatMs: 1000 });
    primaries.push(m);
    const p2 = await startPrimary({ heartbeatMs: 1000 });
    primaries.push(p2);
    const lent = folder("the friend");
    const file = join(dirs[0]!, "invite.txt");
    writeFileSync(file, (await inviteOn(p2, { role: "hands" })) + "\n");
    const where = ["--home", m.d.home, "--port", String(m.d.api.port)];
    const out: string[] = [];
    const err: string[] = [];
    const run = async (argv: string[]): Promise<number> => {
      const o = process.stdout.write.bind(process.stdout);
      const e = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((t: string) => (out.push(String(t)), true)) as typeof process.stdout.write;
      process.stderr.write = ((t: string) => (err.push(String(t)), true)) as typeof process.stderr.write;
      try {
        return await main(argv);
      } finally {
        process.stdout.write = o;
        process.stderr.write = e;
      }
    };
    expect(await run(["node", "add", lent, "--name", "friend", "--file", file, ...where])).toBe(0);
    expect(err.join("")).toContain("This is not a sandbox");
    expect(err.join("").replace(/\s+/g, " ")).toContain("your own sessions included");
    expect(out.join("")).toContain(`Lent ${lent}`);
    const g = m.d.guests.list()[0]!;
    expect(g.name).toBe("friend");
    await waitFor(() => m.d.guests.member(g.id).linked(), 10_000);
    out.length = 0;
    expect(await run(["node", "list", ...where])).toBe(0);
    expect(out.join("")).toMatch(/^friend\tlinked\t.*cluster\t/);
    // a folder in the lent one is refused before any invite is read
    err.length = 0;
    expect(await run(["node", "add", join(lent, "sub"), "--file", file, ...where])).toBe(1);
    expect(err.join("")).toMatch(/no folder|overlaps/);
    expect(await run(["node", "remove", "friend", ...where])).toBe(0);
    expect(m.d.guests.list()).toEqual([]);
    expect(await run(["node", "nothing", ...where])).toBe(2);
  }, 60_000);
});
