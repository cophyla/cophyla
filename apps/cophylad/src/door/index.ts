// The sign-in door's process: `main.ts door --home <dir> --program <dir>`, which the shim
// (apps/door) runs under the CophylaDoor service as `NT SERVICE\CophylaDoor`, and a kit's
// console shim runs as the user. It is composed like a workspace node (`nodes/guest.ts`): a
// store of its own (`data/door.sqlite`, for its registry, what it holds for the node and its
// readiness), a bus, and for each period it serves a gate that stamps its audit rows with the
// machine's id and lets in only what the door decided (`GateRequest.decided`): every other
// request of another machine's is denied. It logs to `data/door.log`. Nothing of the
// daemon's own is started: no sessions, no brain, no listeners, no discovery.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { Bus } from "../bus.ts";
import { GateConfig } from "../config/schema.ts";
import { Asks } from "../gate/asks.ts";
import { Audit } from "../gate/audit.ts";
import { Gate } from "../gate/index.ts";
import { Policy } from "../gate/policy.ts";
import { createLogger } from "../log.ts";
import type { Logger } from "../log.ts";
import { Store } from "../store/index.ts";
import { doorFolders } from "./constants.ts";
import { Door } from "./door.ts";
import type { DoorDeps } from "./door.ts";
import { DoorProgram } from "./program.ts";
import { Shim, stdioShim } from "./shim.ts";
import type { ShimIo } from "./shim.ts";

/** The door's gate: what the door decided passes, with its audit row; everything else another machine asks is denied. */
export function doorGate(store: Store, bus: Bus, node: string, log: Logger): Gate {
  const config = GateConfig.parse({ policy: { node: { read: "deny", write: "deny", exec: "deny", network: "deny" } }, rules: {} });
  const policy = new Policy(config, store);
  const asks = new Asks(store, node, bus);
  const audit = new Audit(store, node, config.audit_result_cap, bus);
  return new Gate({ config, policy, asks, audit, log, node });
}

const LOG_CAP = 5 * 1024 * 1024;

/** A log sink to `file`, kept under LOG_CAP with one older file beside it. */
function fileSink(file: string): (line: string) => void {
  return (line) => {
    try {
      if (existsSync(file) && statSync(file).size > LOG_CAP) renameSync(file, file + ".1");
      appendFileSync(file, line + "\n");
    } catch {
      // a log that cannot be written is not a reason to stop
    }
  };
}

export interface DoorOptions {
  home: string;
  program: string;
  io?: ShimIo;
  log?: Logger;
  /** The seams the tests replace. */
  door?: Partial<Pick<DoorDeps, "serving" | "prepare" | "update" | "exit" | "timing" | "now">>;
}

/** Starts the door: its store, its shim, and the door itself. */
export function startDoor(opts: DoorOptions): { door: Door; store: Store; bus: Bus; stop: () => Promise<void> } {
  const home = resolve(opts.home);
  for (const dir of [home, join(home, "data"), join(home, "tmp")]) mkdirSync(dir, { recursive: true });
  const log = opts.log ?? createLogger("info", fileSink(join(home, "data", "door.log")), "door");
  const store = new Store(join(home, "data", "door.sqlite"));
  store.migrate();
  const bus = new Bus();
  const shim = new Shim(opts.io ?? stdioShim(), log.child("shim"));
  const program = new DoorProgram({ program: opts.program, tmp: join(home, "tmp"), log: log.child("program") });
  const platformVersion: string = pkg.version;
  const door = new Door({
    home,
    program: opts.program,
    shim,
    store,
    bus,
    gateFor: (node) => doorGate(store, bus, node, log.child("gate")),
    log,
    platformVersion,
    update: (want, kit) => program.update(platformVersion, want, kit.update),
    ...(opts.door ?? {}),
  });
  door.start();
  return {
    door,
    store,
    bus,
    stop: async () => {
      await door.stop();
      store.close();
    },
  };
}

/** `main.ts door`: runs until the shim stops it. */
export async function runDoor(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { home: { type: "string" }, program: { type: "string" } }, strict: true });
  const folders = doorFolders();
  const { stop } = startDoor({ home: values.home ?? folders.home, program: values.program ?? folders.program });
  const end = () => void stop().then(() => process.exit(0));
  process.on("SIGINT", end);
  process.on("SIGTERM", end);
  await new Promise<never>(() => undefined);
}
