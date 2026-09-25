// A host started after the daemon, as a terminal the user opens starts one when none runs: the
// daemon, which found no host at its start, adopts it at a later look at the tether folder and
// knows its terminals, and forgets them when the host goes.

import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { silentLogger } from "../src/log.ts";
import { Tether } from "../src/sessions/tether/index.ts";
import type { TerminalChange } from "../src/sessions/tether/index.ts";
import { FakeTether } from "./fakes/tether.ts";
import { tempHome, waitFor } from "./helpers.ts";

const scratch = tempHome();
const dir = join(scratch, "tether");
let fake: FakeTether | undefined;
const tether = new Tether({
  config: { idle_exit_s: 600, window: "auto", window_on_start: false, profiles: false, on_path: false, dir },
  env: {},
  dataDir: join(scratch, "data"),
  nodeId: "node_test",
  log: silentLogger,
  exe: "C:/fake/tether.exe",
  run: async () => ({ code: 0, out: "tether 0.1.0\n", err: "" }),
  scanMs: 20,
});

afterAll(async () => {
  await tether.stop();
  await fake?.stop();
});

test("a host started after the daemon is adopted with its terminals, and forgotten when it goes", async () => {
  const changes: TerminalChange[] = [];
  tether.onChange((c) => changes.push(c));
  await tether.start();
  expect(tether.list()).toEqual([]);

  fake = await new FakeTether(dir).start();
  const shell = fake.add({ argv: ["powershell.exe"] });
  await waitFor(() => tether.list().length === 1);
  const entry = tether.list()[0]!;
  expect(entry.ref).toEqual({ host: fake.host.host, id: shell.id });
  expect(entry.info.pid).toBe(shell.pid);
  expect(changes.some((c) => !c.gone && c.entry.ref.id === shell.id)).toBe(true);

  await fake.stop();
  fake = undefined;
  await waitFor(() => tether.list().length === 0);
  expect(changes.some((c) => c.gone && c.entry.ref.id === shell.id)).toBe(true);
});
