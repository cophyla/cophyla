// cophylad entry point: `bun run apps/cophylad/src/main.ts [--home <dir>] [--port <n>]`, or one of
// the commands that talk to the running daemon (`invite`, `join`, `leave`; see cli.ts).

import { parseArgs } from "node:util";
import { COMMANDS, runCommand } from "./cli.ts";
import type { Command } from "./cli.ts";
import { ConfigError } from "./config/load.ts";
import { startDaemon } from "./daemon.ts";
import { RESTART_ENV, waitForExit } from "./restart.ts";

const command = Bun.argv[2];
if (command !== undefined && (COMMANDS as readonly string[]).includes(command)) {
  process.exit(await runCommand(command as Command, Bun.argv.slice(3)));
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    home: { type: "string" },
    port: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log(`cophylad: the Cophyla daemon

  --home <dir>   user data directory (default: $COPHYLA_HOME or ~/.cophyla)
  --port <n>     override [api].port from config.toml

  cophylad invite [--name N] [--role hands|full] [--expires 1d] [--invite-expires 1h]
                 an invite for a new node, from the running primary
  cophylad invite --phone [--name N] [--access full|sessions|view] [--expires 1d]
                 an invite for a phone, with its QR code on a terminal
  cophylad join [--file F|-] [--workspace P]... [--answer-here]
                 this machine joins the primary whose invite is read from F or stdin
  cophylad leave    this machine leaves the primary it joined
`);
  process.exit(0);
}

// A successor started by `node.restart` opens the home once its predecessor is gone; the
// variable is its own, so nothing this daemon starts inherits it.
const predecessor = process.env[RESTART_ENV];
delete process.env[RESTART_ENV];
if (predecessor !== undefined && !(await waitForExit(Number(predecessor)))) {
  console.error(`cophylad: the daemon being restarted (pid ${predecessor}) is still running; not starting`);
  process.exit(3);
}

try {
  const daemon = await startDaemon({
    ...(values.home !== undefined ? { home: values.home } : {}),
    ...(values.port !== undefined ? { port: Number(values.port) } : {}),
  });
  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(2);
  }
  throw e;
}
