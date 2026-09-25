// Spike 14: a desktop Chrome (Playwright, headed) standing in for the phone's browser: opens
// the ticket URL through the TLS proxy, lands on the stream page for the Desktop app, and
// reports whether video frames arrive, over which transport, and what the page logs.
//
//   bun run spikes/14-remote/web.ts serve   # and proxy.ts, in other shells
//   node --experimental-strip-types spikes/14-remote/browser.ts [direct|frame] [--transport websocket|webrtc]
//   (Node, not Bun: Playwright's driver connection hangs under Bun 1.3 here)
//
// `direct` opens /remote/stream.html itself; `frame` opens /frame, which iframes it the way
// the controller page will. Playwright comes from the npx cache the MCP plugin left behind.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PW = "C:/Users/me/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright";
const require = createRequire(import.meta.url);
const { chromium } = require(PW);
const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { transport: { type: "string", default: "auto" }, seconds: { type: "string", default: "12" }, size: { type: "string" }, shots: { type: "boolean", default: false } },
});
const mode = positionals[0] ?? "direct";
const ticket = readFileSync(join(OUT, "ticket.txt"), "utf8").trim();
const origin = new URL(ticket).origin;

const browser = await chromium.launch({ headless: false, executablePath: "C:/Users/me/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe", args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const logs: string[] = [];
const NOISE = /^\[debug\]|Supported |Pipe"|Player"|Renderer"|environmentSupported|^\[info\] \[Stream\]: [,}"]/;
page.on("console", (m: any) => { const t = `[${m.type()}] ${m.text()}`; logs.push(t); if (!NOISE.test(t)) console.log("  page:", t.slice(0, 220)); });
page.on("pageerror", (e: any) => console.log("  pageerror:", String(e).slice(0, 200)));

const t0 = performance.now();
await page.goto(ticket);
console.log(`after the ticket: ${page.url()} (${Math.round(performance.now() - t0)} ms)`);
// The stream settings live in localStorage under the page's origin; set the transport before
// the stream page loads, the way a role default would.
await page.evaluate(({ tr, size }: { tr: string; size?: string }) => {
  const raw = localStorage.getItem("mlSettings");
  const s = raw ? JSON.parse(raw) : {};
  s.dataTransport = tr;
  if (size) { const [w, h] = size.split("x").map(Number); s.videoSize = "custom"; s.videoSizeCustom = { width: w, height: h }; }
  localStorage.setItem("mlSettings", JSON.stringify(s));
  return JSON.stringify(s);
}, { tr: values.transport, size: values.size }).then((s: string) => console.log("mlSettings:", s));

// host and app ids from the API through the proxy (the cookie rides along)
const hosts = await page.evaluate(async () => {
  const r = await fetch("/remote/api/hosts");
  return await r.text();
});
const host = JSON.parse(hosts.split("\n")[0]).hosts?.[0] ?? JSON.parse(hosts.split("\n")[0]);
const hostId = host.host_id ?? host.host?.host_id;
const apps = await page.evaluate(async (id: number) => (await fetch(`/remote/api/apps?host_id=${id}`)).json(), hostId);
const desktop = apps.apps.find((a: any) => a.title === "Desktop");
console.log(`host ${hostId} paired=${host.paired ?? host.host?.paired}; Desktop app ${desktop?.app_id}`);

const streamUrl = mode === "frame"
  ? `${origin}/frame?hostId=${hostId}&appId=${desktop.app_id}`
  : `${origin}/remote/stream.html?hostId=${hostId}&appId=${desktop.app_id}`;
const t1 = performance.now();
await page.goto(streamUrl);
console.log(`stream page opened: ${streamUrl}`);

// Watch the video element inside the page (or the frame) for frames.
const frameOf = () => (mode === "frame" ? page.frames().find((f: any) => f.url().includes("stream.html")) : page.mainFrame());
let firstFrameAt = 0;
const deadline = Number(values.seconds) * 1000;
while (performance.now() - t1 < deadline) {
  await new Promise((r) => setTimeout(r, 250));
  const f = frameOf();
  if (!f) continue;
  const state = await f.evaluate(() => {
    const v = document.querySelector("video") as HTMLVideoElement | null;
    const c = document.querySelector("canvas") as HTMLCanvasElement | null;
    const q = (v as any)?.getVideoPlaybackQuality?.();
    return {
      video: v ? { w: v.videoWidth, h: v.videoHeight, ready: v.readyState, paused: v.paused, t: v.currentTime, frames: q?.totalVideoFrames ?? -1, dropped: q?.droppedVideoFrames ?? -1 } : null,
      canvas: c ? { w: c.width, h: c.height } : null,
      transport: (window as any).app?.getStream?.()?.transport?.constructor?.name ?? (window as any).app?.stream?.transport?.constructor?.name ?? null,
      title: document.title,
      modal: (document.querySelector(".modal, [class*=modal]") as HTMLElement | null)?.innerText?.slice(0, 120) ?? null,
    };
  }).catch(() => null);
  if (!state) continue;
  const frames = state.video?.frames ?? -1;
  if (!firstFrameAt && ((frames > 0) || (state.video && state.video.w > 0 && state.video.t > 0))) {
    firstFrameAt = Math.round(performance.now() - t1);
    console.log(`first video frame after ${firstFrameAt} ms: ${JSON.stringify(state)}`);
  }
  // --shots: a page screenshot every 3 s with the frame counter, for the lock-screen and UAC
  // checks (the browser composites the page itself, so this works while the desktop is locked).
  if (values.shots && Math.floor((performance.now() - t1) / 3000) !== Math.floor((performance.now() - t1 - 250) / 3000)) {
    const sec = Math.round((performance.now() - t1) / 1000);
    await page.screenshot({ path: join(OUT, `watch-${String(sec).padStart(3, "0")}.png`) }).catch(() => {});
    console.log(`  ${new Date().toLocaleTimeString()} t=${sec}s frames=${frames} dropped=${state.video?.dropped} ${state.modal ? "modal=" + JSON.stringify(state.modal.slice(0, 60)) : ""}`);
  }
}
const final = await frameOf()?.evaluate(() => {
  const v = document.querySelector("video") as HTMLVideoElement | null;
  const q = (v as any)?.getVideoPlaybackQuality?.();
  const s = (window as any).app?.getStream?.();
  const stats = s?.getStats?.()?.getCurrentStats?.();
  return { w: v?.videoWidth, h: v?.videoHeight, t: v?.currentTime, frames: q?.totalVideoFrames, dropped: q?.droppedVideoFrames, stats };
}).catch((e: any) => String(e));
console.log("final:", JSON.stringify(final)?.slice(0, 1600));
await page.screenshot({ path: join(OUT, `browser-${mode}-${values.transport}.png`) });
console.log(`screenshot out/browser-${mode}-${values.transport}.png; first frame ${firstFrameAt || "never"} ms`);
const ws = logs.filter((l) => /websocket|webrtc|transport|ice|decoder|codec/i.test(l)).slice(0, 15);
if (ws.length) console.log("transport-related console lines:\n  " + ws.map((l) => l.slice(0, 160)).join("\n  "));
await browser.close();
