// Spike 14: Apollo's API from Bun over loopback — the welcome credential flow, basic auth,
// config, apps, pending PINs, clients, OTP and the unauthenticated /serverinfo.
//
//   bun run spikes/14-remote/host-api.ts            # everything
//   bun run spikes/14-remote/host-api.ts probe      # just the unauthenticated probes
import { api, HOST_LAN, loadCreds, log, saveCreds, type Creds } from "./_shared";

const step = process.argv[2] ?? "all";

async function probe() {
  console.log("--- unauthenticated ---");
  log("GET /", await api("/", { raw: true }), 200);
  log("GET /api/config (no auth)", await api("/api/config"));
  log("GET /welcome", await api("/welcome", { raw: true }), 200);
  const info = await fetch(`http://127.0.0.1:47989/serverinfo`).then(async (r) => ({ status: r.status, text: await r.text() }));
  console.log(`GET :47989/serverinfo: ${info.status} ${info.text.replace(/\s+/g, " ").slice(0, 700)}`);
  const infoLan = await fetch(`http://${HOST_LAN}:47989/serverinfo`).then(async (r) => ({ status: r.status, text: await r.text() }));
  const m = /<state>([^<]*)<\/state>/.exec(infoLan.text);
  const paired = /<PairStatus>([^<]*)<\/PairStatus>/.exec(infoLan.text);
  const name = /<hostname>([^<]*)<\/hostname>/.exec(infoLan.text);
  console.log(`GET ${HOST_LAN}:47989/serverinfo: ${infoLan.status} state=${m?.[1]} PairStatus=${paired?.[1]} hostname=${name?.[1]}`);
}

async function credentials(): Promise<Creds> {
  let creds = loadCreds();
  if (creds) {
    const r = await api("/api/config", { creds });
    if (r.status === 200) { console.log(`credentials from out/ accepted (${r.ms} ms)`); return creds; }
    console.log(`saved credentials rejected: ${r.status}; trying the welcome flow`);
  }
  creds = { username: "cophyla", password: crypto.randomUUID().replace(/-/g, "").slice(0, 24) };
  console.log("--- welcome flow: POST /api/password with no credentials set ---");
  const r = await api("/api/password", {
    body: { newUsername: creds.username, newPassword: creds.password, confirmNewPassword: creds.password },
  });
  log("POST /api/password", r);
  if (r.status !== 200 || r.json?.status === false || r.json?.status === "false") {
    throw new Error("welcome flow failed: " + r.text);
  }
  saveCreds(creds);
  const check = await api("/api/config", { creds });
  log("GET /api/config (basic auth)", check, 300);
  return creds;
}

async function authenticated(creds: Creds) {
  console.log("--- authenticated ---");
  const bad = await api("/api/config", { creds: { username: creds.username, password: "wrong" } });
  console.log(`wrong password: ${bad.status}`);

  const cfg = await api("/api/config", { creds });
  console.log(`GET /api/config: ${cfg.status} keys=${Object.keys(cfg.json ?? {}).length}`);
  console.log("  platform/version/status:", cfg.json?.platform, cfg.json?.version, cfg.json?.status);
  for (const k of ["sunshine_name", "origin_web_ui_allowed", "port", "output_name", "min_log_level", "encoder", "capture", "address_family"]) {
    if (k in (cfg.json ?? {})) console.log(`  ${k} = ${JSON.stringify(cfg.json[k])}`);
  }

  console.log("--- POST /api/config: origin_web_ui_allowed=pc, sunshine_name ---");
  const set = await api("/api/config", { creds, body: { origin_web_ui_allowed: "pc", sunshine_name: "cophyla-spike" } });
  log("POST /api/config", set);
  const cfg2 = await api("/api/config", { creds });
  console.log("  after:", cfg2.json?.origin_web_ui_allowed, cfg2.json?.sunshine_name);

  const apps = await api("/api/apps", { creds });
  console.log(`GET /api/apps: ${apps.status} ${apps.json?.apps?.map((a: any) => `${a.name}(${a.uuid ?? a.index ?? "?"})`).join(", ")}`);
  const desktop = apps.json?.apps?.find((a: any) => a.name === "Desktop");
  console.log("  Desktop:", JSON.stringify(desktop));

  log("GET /api/pin (pending)", await api("/api/pin", { creds }));
  log("GET /api/clients/list", await api("/api/clients/list", { creds }));
  log("GET /api/apps/status", await api("/api/apps/status", { creds }));
  log("GET /api/logs (tail)", { ...(await api("/api/logs", { creds, raw: true })), json: undefined, text: "" }, 0);

  console.log("--- POST /api/otp ---");
  const otp = await api("/api/otp", { creds, body: { passphrase: "cophylaspike", deviceName: "spike-phone" } });
  log("POST /api/otp", otp);
  if (otp.json?.otp) {
    const name = cfg2.json?.sunshine_name || "host";
    console.log(`  art://${otp.json.ip ?? HOST_LAN}:47989?pin=${otp.json.otp}&passphrase=cophylaspike&name=${encodeURIComponent(name)}`);
  }
  const otpShort = await api("/api/otp", { creds, body: { passphrase: "abc", deviceName: "x" } });
  log("POST /api/otp (3-char passphrase)", otpShort);
  const otpNoName = await api("/api/otp", { creds, body: { passphrase: "cophylaspike" } });
  log("POST /api/otp (no deviceName)", otpNoName);

  console.log("--- POST /api/pin with nothing pending ---");
  log("POST /api/pin", await api("/api/pin", { creds, body: { pin: "1234", name: "nobody" } }));

  console.log("--- endpoints Apollo answers (POST with an empty body) ---");
  for (const p of ["/api/clients/disconnect", "/api/clients/unpair", "/api/clients/update", "/api/apps/close", "/api/apps/status"]) {
    const r = await api(p, { creds, body: {} });
    console.log(`  POST ${p}: ${r.status} ${r.text.replace(/\s+/g, " ").slice(0, 160)}`);
  }
}

if (step === "probe" || step === "all") await probe();
if (step === "all" || step === "auth") {
  const creds = await credentials();
  await authenticated(creds);
}
