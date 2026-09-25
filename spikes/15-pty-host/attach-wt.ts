// Opens one more window on the running host's session, in Windows Terminal, and records the
// attach client's pid in out/pids.json so `bun stop.ts` ends it with the rest. The token is
// read off the host's own command line.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const BIN = join(HERE, "target", "debug", "ptyhost.exe");
const pidsPath = join(HERE, "out", "pids.json");
const pids = JSON.parse(readFileSync(pidsPath, "utf8")) as { host: number; claude: number; clients: number[] };

const ps = (cmd: string) => spawnSync("powershell.exe", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).stdout.trim();
const token = /--token ([0-9a-f]+)/.exec(ps(`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pids.host}').CommandLine`))?.[1];
if (!token) throw new Error(`no host running as pid ${pids.host}`);
const clients = () => ps(`Get-CimInstance Win32_Process -Filter "Name='ptyhost.exe'" | Where-Object { $_.CommandLine -like '*attach*' } | ForEach-Object { $_.ProcessId }`).split(/\s+/).filter(Boolean).map(Number);
const before = new Set(clients());

// `start` resolves wt.exe, an app execution alias, where a direct spawn cannot.
const line = `/c start "" wt.exe -w new --title "pty-host s1 (Windows Terminal)" "${BIN}" attach --port 4951 --token ${token} --id s1`;
spawn("cmd.exe", [line], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();

const end = Date.now() + 15000;
while (Date.now() < end) {
  const fresh = clients().find((p) => !before.has(p));
  if (fresh) {
    pids.clients.push(fresh);
    writeFileSync(pidsPath, JSON.stringify(pids, null, 2));
    console.log(`attached from Windows Terminal: client pid ${fresh}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 300));
}
console.log("no new attach client within 15 s");
