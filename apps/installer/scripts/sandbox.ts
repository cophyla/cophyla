// Writes `stage/cophyla.wsb`, a Windows Sandbox configuration for the clean-machine run:
// `stage/out` mapped read-only, networking on, and a logon script that writes the sandbox
// user's `~\.cophyla\config.toml` pointing `[update]` at this host's LAN feed (serve-feed.ts on
// 0.0.0.0:8790), with `allow_insecure_feed` for the http URL and a one-minute check. The
// user's model key is never written here: it is pasted into the sandbox's config by hand.
// `--print-config` prints that config.toml instead, for the clean Linux VM or the second
// macOS account, whose `~/.cophyla/config.toml` is written by hand.
//   bun run apps/installer/scripts/sandbox.ts [--host <ip>] [--port 8790] [--print-config]
// Then: `WindowsSandbox.exe apps\installer\stage\cophyla.wsb` (or double-click the file).

import { writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ensureDir, fail, log, OUT, STAGE } from "./lib.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { host: { type: "string" }, port: { type: "string", default: "8790" }, "print-config": { type: "boolean" } },
  strict: true,
});

/** The acceptance `config.toml`: the LAN feed, insecure http allowed, a one-minute check, the key left to paste. */
export function acceptanceConfig(feed: string): string {
  return [
    "# Cophyla on the clean machine: the update feed is the host's LAN server.",
    "[update]",
    `feed = "${feed}"`,
    "allow_insecure_feed = true",
    "check_interval_ms = 60000",
    "first_check_delay_ms = 5000",
    "",
    "[providers.gemini]",
    '# api_key = "paste the key here, on the clean machine only"',
    "",
  ].join("\n");
}

/** The host's address the sandbox reaches: a vEthernet adapter's IPv4, else the first non-loopback one. */
function hostIp(): string {
  const all = Object.entries(networkInterfaces()).flatMap(([name, addrs]) => (addrs ?? []).map((a) => ({ name, ...a })));
  const v4 = all.filter((a) => a.family === "IPv4" && !a.internal);
  const preferred = v4.find((a) => /vEthernet \(Default Switch\)/i.test(a.name)) ?? v4.find((a) => /vEthernet/i.test(a.name)) ?? v4[0];
  if (!preferred) fail("no IPv4 address; pass --host");
  return preferred.address;
}

const host = values.host ?? hostIp();
const feed = `http://${host}:${values.port}`;
if (values["print-config"]) {
  process.stdout.write(acceptanceConfig(feed));
  process.exit(0);
}
ensureDir(OUT);
const script = [
  "@echo off",
  'set HOME=%USERPROFILE%\\.cophyla',
  'if not exist "%HOME%" mkdir "%HOME%"',
  'if exist "%HOME%\\config.toml" goto done',
  // No BOM: cmd's echo writes plain bytes.
  '(',
  "echo # Cophyla in the sandbox: the update feed is the host's LAN server.",
  "echo [update]",
  `echo feed = "${feed}"`,
  "echo allow_insecure_feed = true",
  "echo check_interval_ms = 60000",
  "echo first_check_delay_ms = 5000",
  "echo.",
  "echo [providers.gemini]",
  'echo # api_key = "paste the key here, in the sandbox only"',
  ') > "%HOME%\\config.toml"',
  ":done",
  'echo Cophyla: config at %HOME%\\config.toml, feed %FEED%; run the installer from the mapped folder on the desktop.',
  "",
].join("\r\n").replace("%FEED%", feed);
writeFileSync(join(OUT, "sandbox-logon.cmd"), script);

const wsb = `<Configuration>
  <Networking>Enable</Networking>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>${OUT}</HostFolder>
      <SandboxFolder>C:\\Users\\WDAGUtilityAccount\\Desktop\\out</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>cmd.exe /c C:\\Users\\WDAGUtilityAccount\\Desktop\\out\\sandbox-logon.cmd</Command>
  </LogonCommand>
  <MemoryInMB>6144</MemoryInMB>
</Configuration>
`;
const path = join(STAGE, "cophyla.wsb");
writeFileSync(path, wsb);
log(`wrote ${path} (feed ${feed}, out ${OUT}) and ${join(OUT, "sandbox-logon.cmd")}`);
log(`host side: bun run apps/installer/scripts/serve-feed.ts --host 0.0.0.0 --port ${values.port}  (allow TCP ${values.port} in the firewall)`);
