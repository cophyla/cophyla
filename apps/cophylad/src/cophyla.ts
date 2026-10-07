// `cophyla`: the Cophyla commands in a terminal. A client of the running daemon on its
// loopback listener, asking to be served on this machine even while it is a node of a
// cluster; it never starts a daemon itself. The installed platform puts a launcher for it on
// the PATH beside `tether` (`<root>/bin/cophyla`, `cophyla.cmd` on Windows).
//
//   cophyla node add <folder> [--name N] [--profile P] [--file F|-]
//       lends a folder to another person's cluster as a workspace node of it: checks the
//       folder, says what lending it means, then reads the invite that person's primary
//       minted (`cophylad invite --role hands`) from F or stdin, never the command line
//   cophyla node list
//   cophyla node join <name> [--file F|-]     a workspace node joins a cluster again
//   cophyla node leave <name>                 it leaves its cluster; what it holds stays
//   cophyla node remove <name>                it leaves, and what it held here goes
//   cophyla invite | join | leave             as `cophylad invite | join | leave`
//   cophyla agents uninstall                  takes the agents' MCP server out of every
//                                             profile, with no daemon running (the
//                                             uninstaller runs it)
//
// Each takes --home and --port as the daemon does.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ClientResult } from "@cophyla/protocol";
import { call, COMMANDS, readInvite, runCommand } from "./cli.ts";
import type { Command } from "./cli.ts";
import { uninstallAgents } from "./agentmsg/uninstall.ts";

/** `cophyla agents uninstall [--home H]`. */
async function agentsCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { home: { type: "string" } }, strict: true });
  if (positionals[0] !== "uninstall" || positionals.length !== 1) {
    process.stderr.write("usage: cophyla agents uninstall [--home <dir>]\n");
    return 2;
  }
  const r = await uninstallAgents(values.home);
  for (const line of r.lines) process.stdout.write(line + "\n");
  return r.ok ? 0 : 1;
}

const HELP = `cophyla: the Cophyla commands, for the daemon running on this machine

  cophyla node add <folder> [--name N] [--profile P] [--file F|-]
                 lend a folder to another person's cluster, with the invite their primary
                 minted (cophylad invite --role hands) read from F or stdin
  cophyla node list
                 the folders lent, the cluster each is in, and whether it is linked
  cophyla node join <name> [--file F|-]
                 a workspace node that left its cluster, or was let go, joins one again
  cophyla node leave <name>
                 it leaves its cluster; what it holds here stays until it joins another
  cophyla node remove <name>
                 it leaves, and its sessions' records, asks and audit go with it

  cophyla invite | join | leave
                 as cophylad invite | join | leave
  cophyla agents uninstall
                 take the agents' MCP server (cophyla-agents) out of every Claude and Codex
                 profile; run with the daemon stopped, as the uninstaller does

  --home <dir>   the Cophyla home (default: $COPHYLA_HOME or ~/.cophyla)
  --port <n>     the daemon's loopback port, when config.toml does not say it
`;

/** What lending a folder means, said before the invite is asked for. */
export function caveats(folder: string, name: string): string {
  return [
    `Lending ${folder} to another person's cluster, as the workspace node "${name}".`,
    "",
    "  - Anything started in this folder belongs to that cluster from now on, your own",
    "    sessions included: your apps will not show them.",
    "  - Its sessions run as this computer's user, on your own harness logins and plan.",
    "  - This is not a sandbox. The other cluster's agents can do in this folder what",
    "    you can, and an agent can reach past it as any program you run can.",
    "",
  ].join("\n");
}

function guestLine(g: ClientResult<"guest.list">["guests"][number]): string {
  const where = g.primary ? `${g.primary.name}'s cluster` : "no cluster";
  const how = g.state === "linked" ? `linked${g.via === "relay" ? " through the relay" : ""}` : g.state;
  return `${g.name}\t${how}\t${where}\t${g.folder}`;
}

export async function main(argv: string[]): Promise<number> {
  const [group, ...rest] = argv;
  if (group === undefined || group === "help" || group === "--help" || group === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if ((COMMANDS as readonly string[]).includes(group)) return runCommand(group as Command, rest, { local: true, prog: "cophyla" });
  if (group === "agents") return agentsCommand(rest);
  if (group !== "node") {
    process.stderr.write(`cophyla: no command ${group}\n\n${HELP}`);
    return 2;
  }
  let verb = "";
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        home: { type: "string" },
        port: { type: "string" },
        name: { type: "string" },
        profile: { type: "string" },
        file: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
      strict: true,
    });
    verb = positionals[0] ?? "";
    const arg = positionals[1];
    if (values.help || verb === "") {
      process.stdout.write(HELP);
      return 0;
    }
    const where = { ...(values.home !== undefined ? { home: values.home } : {}), ...(values.port !== undefined ? { port: values.port } : {}) };
    const how = { local: true, name: "cophyla" };
    const need = (what: string): string => {
      if (arg === undefined) throw new Error(`give the ${what}: cophyla node ${verb} <${what}>`);
      return arg;
    };
    switch (verb) {
      case "add": {
        const folder = resolve(need("folder"));
        const ask = { folder, ...(values.name !== undefined ? { name: values.name } : {}), ...(values.profile !== undefined ? { profile: values.profile } : {}) };
        const checked = await call(where, "guest.add", ask, how);
        process.stderr.write(caveats(checked.folder, checked.name));
        const invite = await readInvite(values.file);
        const r = await call(where, "guest.add", { ...ask, invite: invite.trim() }, how);
        const g = r.guest!;
        process.stdout.write(`Lent ${g.folder} to ${g.primary?.name ?? "the other"}'s cluster as ${g.name}.\n`);
        return 0;
      }
      case "list": {
        const r = await call(where, "guest.list", {}, how);
        if (r.guests.length === 0) process.stdout.write("No folder of this machine is lent to another cluster.\n");
        else process.stdout.write(r.guests.map(guestLine).join("\n") + "\n");
        return 0;
      }
      case "join": {
        const name = need("name");
        const invite = await readInvite(values.file);
        const r = await call(where, "guest.join", { name, invite: invite.trim() }, how);
        process.stdout.write(`${r.guest.name} joined ${r.guest.primary?.name ?? "the other"}'s cluster.\n`);
        return 0;
      }
      case "leave": {
        const r = await call(where, "guest.leave", { name: need("name") }, how);
        process.stdout.write(`${r.guest.name} left its cluster; what it holds here stays until it joins another or is removed.\n`);
        return 0;
      }
      case "remove": {
        const name = need("name");
        await call(where, "guest.remove", { name }, how);
        process.stdout.write(`${name} is removed: its folder is this machine's again.\n`);
        return 0;
      }
      default:
        process.stderr.write(`cophyla node: no command ${verb}\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    process.stderr.write(`cophyla node${verb ? ` ${verb}` : ""}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
