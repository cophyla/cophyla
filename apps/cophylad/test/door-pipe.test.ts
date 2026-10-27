// The daemon's end of the sign-in door and the door itself over a pipe, with no nodes: the
// switch on hands the door the kit on the attach and the door readies itself, a changed kit
// follows a moment later, the switch off has the door forget the machine; what the door holds
// for the node (a key the primary handed its grant, the grant's end) is taken by the daemon at
// its attach, before anything else; and the door tells the shim what the power rule needs.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Config } from "../src/config/schema.ts";
import { startDoor } from "../src/door/index.ts";
import type { Kit } from "../src/door/kit.ts";
import { DoorManager } from "../src/door/manager.ts";
import { silentLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";
import { FakeShim } from "./fakes/door-shim.ts";
import { removeHome, tempHome, waitFor } from "./helpers.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const PRIMARY = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const KEY = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

function kitNamed(name: string): Kit {
  const config = Config.parse({});
  return {
    v: 1,
    node: { id: NODE, name },
    link: { v: 1, grant: "grt_01ARZ3NDEKTSV4RRFFQ69G5FD1", key: KEY, cluster: "9f86d081884c7d65", role: "full", via: "join", primary: { id: PRIMARY, name: "desk" } },
    registry: [],
    epoch: 3,
    host: { kind: "apollo", username: "cophyla", password: "pw" },
    remote: config.remote,
    direct: { enabled: true, config: config.direct },
    nodes: config.nodes,
    update: config.update,
    machines: [PRIMARY],
    sharing: true,
    hands: false,
    confined: false,
    primary: false,
    platform: { version: "0.22.0", protocol: 1 },
    attachedAt: Date.now(),
  };
}

interface Rig {
  shim: FakeShim;
  doorHome: string;
  manager: DoorManager;
  meta: Map<string, string>;
  adopted: string[];
  revoked: number;
  kit: { now: Kit };
}

/** A door on a fake shim's pipe, and a daemon's end of it with an in-memory switch. */
async function rig(opts: { held?: { rekeyed?: string; revoked?: true } } = {}): Promise<Rig> {
  const doorHome = tempHome();
  const shim = new FakeShim({ console: "active" });
  if (opts.held) {
    mkdirSync(join(doorHome, "data"), { recursive: true });
    const store = new Store(join(doorHome, "data", "door.sqlite"));
    store.migrate();
    store.meta.set("door_held", JSON.stringify(opts.held));
    store.close();
  }
  const door = startDoor({ home: doorHome, program: join(doorHome, "program"), io: shim.io, log: silentLogger, door: { prepare: async () => undefined, exit: () => undefined, timing: { goneMs: 50 } } });
  await shim.start();
  const meta = new Map<string, string>();
  const r: Rig = { shim, doorHome, meta, adopted: [], revoked: 0, kit: { now: kitNamed("laptop") }, manager: undefined as never };
  r.manager = new DoorManager({
    os: "windows",
    meta: { get: (k) => meta.get(k), set: (k, v) => void meta.set(k, v) },
    log: silentLogger,
    kit: () => r.kit.now,
    nodes: { adoptKey: (key) => void r.adopted.push(key), revokedAway: () => void r.revoked++ },
    refusal: () => undefined,
    install: () => undefined,
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    tmpDir: join(doorHome, "tmp"),
    pipe: shim.pipe,
    client: { verify: async () => undefined },
    elevate: async () => {
      throw new Error("no elevation in this test: the door is there");
    },
    onChange: () => undefined,
  });
  closers.push(async () => {
    r.manager.stop();
    await door.stop();
    await shim.stop();
    removeHome(doorHome);
  });
  return r;
}

const kitOnDisk = (home: string): Kit | undefined => {
  const f = join(home, "data", "kit.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Kit) : undefined;
};

describe("the door over its pipe", () => {
  test("switched on, the door gets the kit and readies itself; a changed kit follows; off, it forgets the machine", async () => {
    const r = await rig();
    expect(r.manager.state()).toEqual({ state: "off" });
    await r.manager.set(true);
    expect(r.manager.attached).toBe(true);
    expect(kitOnDisk(r.doorHome)?.node.name).toBe("laptop");
    await waitFor(() => r.manager.state()?.state === "ready", 5000);
    expect(r.manager.state()).toMatchObject({ state: "ready", version: expect.any(String) });
    // ready while someone works: nothing held awake; at the sign-in screen on mains power it is
    await waitFor(() => r.shim.powers.some((p) => p.ready && !p.streaming), 5000);

    r.kit.now = kitNamed("laptop 2");
    r.manager.kitChanged();
    await waitFor(() => kitOnDisk(r.doorHome)?.node.name === "laptop 2", 5000);
    // the same kit again goes nowhere
    r.manager.kitChanged();

    await r.manager.set(false);
    expect(kitOnDisk(r.doorHome)).toBeUndefined();
    expect(r.manager.state()).toMatchObject({ state: "off" });
    expect(r.meta.get("door_enabled")).toBe("0");
  }, 30_000);

  test("what the door held for the node is the daemon's at its attach: a new key, then the grant's end", async () => {
    const key = "b".repeat(64);
    const a = await rig({ held: { rekeyed: key } });
    a.meta.set("door_enabled", "1");
    await a.manager.start();
    expect(a.adopted).toEqual([key]);
    expect(a.revoked).toBe(0);

    const b = await rig({ held: { revoked: true } });
    b.meta.set("door_enabled", "1");
    await b.manager.start();
    expect(b.revoked).toBe(1);
  }, 30_000);

  test("a pipe that is not there is no door: the switch then installs it, and says why it could not", async () => {
    const meta = new Map<string, string>();
    const elevated: string[][] = [];
    const m = new DoorManager({
      os: "windows",
      meta: { get: (k) => meta.get(k), set: (k, v) => void meta.set(k, v) },
      log: silentLogger,
      kit: () => kitNamed("laptop"),
      nodes: { adoptKey: () => undefined, revokedAway: () => undefined },
      refusal: () => undefined,
      install: () => ({ versionDir: "C:\\Users\\me\\AppData\\Local\\Cophyla\\versions\\0.22.0", version: "0.22.0" }),
      exec: async () => ({ code: 0, stdout: '"desk\\me","S-1-5-21-1-2-3-1001"\r\n', stderr: "" }),
      tmpDir: join(tempHome(), "tmp"),
      pipe: new FakeShim().pipe,
      client: { verify: async () => undefined },
      elevate: async (exe, args) => {
        elevated.push([exe, ...args]);
        return { code: 1223 };
      },
      onChange: () => undefined,
    });
    closers.push(() => m.stop());
    await m.start();
    expect(m.state()).toEqual({ state: "off" });
    await expect(m.set(true)).rejects.toThrow("the administrator prompt was declined");
    expect(elevated[0]![0]).toBe("C:\\Users\\me\\AppData\\Local\\Cophyla\\versions\\0.22.0\\bin\\cophyla-door.exe");
    expect(elevated[0]!.slice(1, 6)).toEqual(["install", "--from", "C:\\Users\\me\\AppData\\Local\\Cophyla\\versions\\0.22.0", "--user-sid", "S-1-5-21-1-2-3-1001"]);
    expect(m.state()).toMatchObject({ state: "unavailable", reason: "the administrator prompt was declined" });
  }, 30_000);
});
