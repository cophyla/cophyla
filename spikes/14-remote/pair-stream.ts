// Spike 14: headless pairing and streaming with moonlight-qt against Apollo on this machine.
//
//   bun run spikes/14-remote/pair-stream.ts pair     # moonlight pair + POST /api/pin
//   bun run spikes/14-remote/pair-stream.ts list     # is `list` the "already paired" check?
//   bun run spikes/14-remote/pair-stream.ts stream   # windowed Desktop stream, time to BUSY, cost, quit
//   bun run spikes/14-remote/pair-stream.ts quit
//   bun run spikes/14-remote/pair-stream.ts unpair   # drop the spike's client from the host
//
// moonlight-qt is a GUI-subsystem executable: `--help` opens a dialog and blocks, and its
// stdout is empty; stderr carries its SDL log lines.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { api, HOST_LAN, loadCreds, log, sleep } from "./_shared";

const MOONLIGHT = process.env.MOONLIGHT ?? "C:\\Program Files\\Moonlight Game Streaming\\Moonlight.exe";
const INI = join(process.env.APPDATA ?? "", "Moonlight Game Streaming Project", "Moonlight.ini");
const creds = loadCreds();
if (!creds) throw new Error("run host-api.ts first (credentials in out/)");

const step = process.argv[2] ?? "pair";

function spawnMoonlight(args: string[], detached = false) {
  console.log(`> moonlight ${args.join(" ")}`);
  const child = Bun.spawn([MOONLIGHT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(detached ? { windowsHide: false } : {}),
  });
  const out: string[] = [];
  const pump = async (s: ReadableStream<Uint8Array> | null, tag: string) => {
    if (!s) return;
    for await (const chunk of s) {
      for (const line of new TextDecoder().decode(chunk).split(/\r?\n/)) {
        if (line.trim()) { out.push(`${tag} ${line}`); console.log(`  [${tag}] ${line}`); }
      }
    }
  };
  void pump(child.stdout as any, "out");
  void pump(child.stderr as any, "err");
  return { child, out };
}

async function serverState(): Promise<string> {
  const t = await fetch(`http://127.0.0.1:47989/serverinfo`).then((r) => r.text());
  return /<state>([^<]*)<\/state>/.exec(t)?.[1] ?? "?";
}

function iniHosts(): string {
  if (!existsSync(INI)) return "(no Moonlight.ini yet)";
  const text = readFileSync(INI, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => /^\[|hosts|uuid|manualaddress|localaddress|name=|serverCert|srvcert/i.test(l));
  return lines.slice(0, 30).join("\n");
}

if (step === "pair") {
  console.log("--- before:", iniHosts());
  const t0 = performance.now();
  const { child } = spawnMoonlight(["pair", HOST_LAN, "--pin", "1234"]);
  // Apollo has no GET /api/pin, so post until the host accepts: status false = nothing pending.
  let accepted = false;
  let tries = 0;
  while (performance.now() - t0 < 30_000) {
    await sleep(500);
    tries++;
    const r = await api("/api/pin", { creds, body: { pin: "1234", name: "spike-desktop" } });
    if (r.json?.status === true) {
      accepted = true;
      console.log(`POST /api/pin accepted after ${tries} tries, ${Math.round(performance.now() - t0)} ms`);
      break;
    }
    console.log(`  try ${tries} at ${Math.round(performance.now() - t0)} ms: ${r.status} ${r.text}`);
    if ((await api("/api/clients/list", { creds })).json?.named_certs?.length) {
      console.log("  a client is paired now (the POST answered false)");
      accepted = true;
      break;
    }
  }
  const exit = await Promise.race([child.exited, sleep(60_000).then(() => "timeout" as const)]);
  console.log(`moonlight pair exited: ${exit} at ${Math.round(performance.now() - t0)} ms; accepted=${accepted}`);
  if (exit === "timeout") child.kill();
  log("GET /api/clients/list", await api("/api/clients/list", { creds }));
  console.log("--- after:", iniHosts());
}

if (step === "list") {
  const t0 = performance.now();
  const { child, out } = spawnMoonlight(["list", HOST_LAN]);
  const exit = await Promise.race([child.exited, sleep(20_000).then(() => "timeout" as const)]);
  if (exit === "timeout") child.kill();
  console.log(`moonlight list exited: ${exit} in ${Math.round(performance.now() - t0)} ms; ${out.length} lines`);
}

if (step === "stream") {
  // Apollo answers SUNSHINE_SERVER_FREE on the unpaired :47989 /serverinfo even while a
  // client streams (Permission 0 hides it); `connected` in /api/clients/list is the signal.
  const connected = async () => ((await api("/api/clients/list", { creds })).json?.named_certs ?? []).some((c: any) => c.connected);
  console.log("state before:", await serverState(), "connected:", await connected());
  const t0 = performance.now();
  // Detached so the window outlives this script (a Bun.spawn child dies with its pipes).
  const { spawn } = await import("node:child_process");
  const args = ["stream", HOST_LAN, "Desktop", "--display-mode", "windowed", "--absolute-mouse", "--quit-after"];
  console.log(`> moonlight ${args.join(" ")} (detached)`);
  const child = spawn(MOONLIGHT, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  let connectedAt = 0;
  while (performance.now() - t0 < 30_000) {
    await sleep(100);
    if (await connected()) { connectedAt = Math.round(performance.now() - t0); break; }
  }
  console.log(`client connected after ${connectedAt} ms (spawn → host lists it connected; first frame follows within the second)`);
  await sleep(3000);
  const sample = Bun.spawnSync(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dir, "cost.ps1"), "-Seconds", "10"]);
  console.log("--- 10 s while streaming:\n" + sample.stdout.toString().trim());
  console.log("state:", await serverState(), "connected:", await connected());
  console.log("leaving the window open; run `quit` next (or lock the screen / raise a UAC prompt first and look)");
  process.exit(0);
}

if (step === "quit") {
  const t0 = performance.now();
  const { child } = spawnMoonlight(["quit", HOST_LAN]);
  const exit = await Promise.race([child.exited, sleep(20_000).then(() => "timeout" as const)]);
  if (exit === "timeout") child.kill();
  console.log(`moonlight quit exited: ${exit} in ${Math.round(performance.now() - t0)} ms`);
  await sleep(1000);
  console.log("state:", await serverState());
  const ps = Bun.spawnSync(["powershell", "-NoProfile", "-Command", "(Get-Process Moonlight -ErrorAction SilentlyContinue | Measure-Object).Count"]);
  console.log("Moonlight processes left:", ps.stdout.toString().trim());
}

if (step === "unpair") {
  const cl = await api("/api/clients/list", { creds });
  for (const c of cl.json?.named_certs ?? []) {
    if (/spike/.test(c.name)) log(`POST /api/clients/unpair ${c.name}`, await api("/api/clients/unpair", { creds, body: { uuid: c.uuid } }));
  }
  log("GET /api/clients/list", await api("/api/clients/list", { creds }));
}
