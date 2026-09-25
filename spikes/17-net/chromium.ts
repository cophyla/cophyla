// cophyla-net against headless Chromium, the engine of the Android web view the phone app
// runs in. This script plays cophylad: it runs the helper on its stdio, passes the page's offer
// and candidates in and the answer and the helper's candidates out, and then drives an echo
// round trip, a megabyte each way, and reads the path from both ends.
//   node --experimental-strip-types chromium.ts [--helper wsl|<path>] [--runs 1] [--peers 1]
//        [--only-srflx] [--predict-shift 3] [--stun stun:stun.cloudflare.com:3478]

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    helper: { type: "string", default: "wsl" },
    runs: { type: "string", default: "1" },
    peers: { type: "string", default: "1" },
    "only-srflx": { type: "boolean", default: false },
    "predict-shift": { type: "string", default: "0" },
    stun: { type: "string", default: "stun:stun.cloudflare.com:3478" },
    mb: { type: "string", default: "1" },
    pings: { type: "string", default: "50" },
  },
});
const require = createRequire(join(homedir(), "AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/"));
const { chromium } = require("playwright");
const SHELL = join(homedir(), "AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe");
const FRAME = 16 * 1024;

type Json = Record<string, unknown>;

/** cophyla-net on its stdio, spoken to as cophylad does. */
class Helper {
  private child: ChildProcessWithoutNullStreams;
  private next = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private handlers: ((method: string, params: Json) => void)[] = [];
  readonly log: string[] = [];

  constructor(command: string[]) {
    this.child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let m: Json;
      try {
        m = JSON.parse(line) as Json;
      } catch {
        return;
      }
      if (typeof m.id === "number") {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new Error(JSON.stringify(m.error)));
        else p?.resolve(m.result as Json);
      } else if (typeof m.method === "string") for (const h of this.handlers) h(m.method, m.params as Json);
    });
    createInterface({ input: this.child.stderr }).on("line", (line) => this.log.push(line));
  }

  request(method: string, params: Json): Promise<Json> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params: Json): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  on(fn: (method: string, params: Json) => void): void {
    this.handlers.push(fn);
  }

  stop(): void {
    this.child.stdin.end();
    setTimeout(() => this.child.kill(), 1000).unref();
  }
}

const helperCommand = values.helper === "wsl" || values.helper === "wsl-release" ? ["wsl", "-e", `/home/me/cophyla/apps/net/target/${values.helper === "wsl" ? "debug" : "release"}/cophyla-net`] : values.helper!.startsWith("wsl:") ? ["wsl", "-e", values.helper!.slice(4)] : [values.helper!];
const helper = new Helper(helperCommand);
const hello = await helper.request("hello", { protocol: 1 });
const configured = await helper.request("net.configure", { stun: [values.stun], map: true, ipv6: true });
console.log("helper", JSON.stringify(hello), JSON.stringify(configured));
const netStates: Json[] = [];
helper.on((m, p) => {
  if (m === "net.state") netStates.push(p);
});

const typ = (c: string) => / typ (\w+)/.exec(c)?.[1];

const browser = await chromium.launch({ headless: true, executablePath: SHELL });

async function onePeer(run: number, n: number): Promise<Json> {
  const peer = `phone-${run}-${n}`;
  const page = await browser.newPage();
  page.on("console", (m: { text(): string }) => console.log(`page ${peer}:`, m.text()));
  await page.goto("about:blank");
  const got = { frames: 0, bytes: 0 };
  const events: Json[] = [];
  let path: Json | undefined;
  let openAt = 0;
  const pong = (data: string) => helper.notify("peer.send", { peer, data: data.replace("ping:", "pong:") });
  helper.on((m, p) => {
    if (p.peer !== peer) return;
    if (m === "peer.candidate") {
      const c = p.candidate as { candidate: string; sdpMid?: string; sdpMLineIndex?: number } | null;
      if (!c) return;
      if (values["only-srflx"] && typ(c.candidate) !== "srflx") return;
      void page.evaluate((cand: unknown) => (window as any).__addCand(cand), c);
    } else if (m === "peer.data") {
      const data = p.data as string;
      if (data.startsWith("ping:")) pong(data);
      else {
        got.frames++;
        got.bytes += data.length;
      }
    } else if (m === "peer.path") path = p;
    else if (m === "peer.open") openAt = performance.now();
    else if (m === "peer.state") events.push(p);
  });
  const shift = Number(values["predict-shift"]);
  const sent: string[] = [];
  await page.exposeFunction("__cand", (c: { candidate: string; sdpMid?: string; sdpMLineIndex?: number } | null) => {
    if (!c || !c.candidate) return;
    const t = typ(c.candidate);
    if (values["only-srflx"] && t !== "srflx") return;
    let candidate = c.candidate;
    if (shift > 0 && t === "srflx") {
      // the port STUN saw, told lower: the helper has to predict the real one
      const f = candidate.split(" ");
      f[5] = String(Number(f[5]) - shift);
      candidate = f.join(" ");
    } else if (shift > 0) return;
    sent.push(candidate);
    void helper.request("peer.candidate", { peer, candidate: { ...c, candidate } }).catch(() => undefined);
  });
  const t0 = performance.now();
  const offer = (await page.evaluate(async (stun: string) => {
    const w = window as any;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: stun }] });
    const dc = pc.createDataChannel("cophyla", { ordered: true });
    w.__pc = pc;
    w.__dc = dc;
    w.__early = [];
    w.__down = { frames: 0, bytes: 0 };
    w.__pongs = new Map();
    pc.onicecandidate = (e: RTCPeerConnectionIceEvent) => w.__cand(e.candidate ? e.candidate.toJSON() : null);
    w.__addCand = (c: RTCIceCandidateInit) => (pc.remoteDescription ? pc.addIceCandidate(c) : w.__early.push(c));
    dc.onmessage = (e: MessageEvent) => {
      const d = e.data as string;
      if (d.startsWith("pong:")) w.__pongs.get(d)?.();
      else {
        w.__down.frames++;
        w.__down.bytes += d.length;
      }
    };
    w.__open = new Promise<void>((r) => (dc.onopen = () => r()));
    await pc.setLocalDescription(await pc.createOffer());
    return pc.localDescription!.sdp;
  }, values.stun)) as string;
  const answer = await helper.request("peer.answer", { peer, sdp: offer });
  await page.evaluate(async (sdp: string) => {
    const w = window as any;
    await w.__pc.setRemoteDescription({ type: "answer", sdp });
    for (const c of w.__early) await w.__pc.addIceCandidate(c);
  }, answer.sdp as string);
  const opened = await Promise.race([page.evaluate(() => (window as any).__open.then(() => true)), new Promise((r) => setTimeout(() => r(false), 20_000))]);
  const openMs = Math.round(performance.now() - t0);
  if (!opened) {
    await page.close();
    return { peer, ok: false, openMs, events, sent, helperLog: helper.log.slice(-20) };
  }
  // round trips: page → helper → driver → helper → page
  const rtts = (await page.evaluate(async (n: number) => {
    const w = window as any;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const key = `ping:${i}:${Math.random()}`;
      const t = performance.now();
      await new Promise<void>((r) => {
        w.__pongs.set(key.replace("ping:", "pong:"), r);
        w.__dc.send(key);
      });
      out.push(performance.now() - t);
    }
    return out;
  }, Number(values.pings))) as number[];
  rtts.sort((a, b) => a - b);
  const bytes = Number(values.mb) * 1024 * 1024;
  // up: the page sends a megabyte in frames of 16 KiB, respecting its buffer
  const upT0 = performance.now();
  await page.evaluate(async (bytes: number) => {
    const w = window as any;
    const frame = "u".repeat(16 * 1024);
    w.__dc.bufferedAmountLowThreshold = 1 << 20;
    for (let sent = 0; sent < bytes; sent += frame.length) {
      if (w.__dc.bufferedAmount > 4 << 20) await new Promise<void>((r) => (w.__dc.onbufferedamountlow = () => r()));
      w.__dc.send(frame);
    }
  }, bytes);
  while (got.bytes < bytes && performance.now() - upT0 < 30_000) await new Promise((r) => setTimeout(r, 20));
  const upMs = performance.now() - upT0;
  // down: the helper sends a megabyte
  const downT0 = performance.now();
  const frame = "d".repeat(FRAME);
  for (let s = 0; s < bytes; s += FRAME) helper.notify("peer.send", { peer, data: frame });
  let down = { frames: 0, bytes: 0 };
  while (down.bytes < bytes && performance.now() - downT0 < 30_000) {
    await new Promise((r) => setTimeout(r, 20));
    down = (await page.evaluate(() => (window as any).__down)) as typeof down;
  }
  const downMs = performance.now() - downT0;
  const chosen = await page.evaluate(async () => {
    const w = window as any;
    const st: Map<string, any> = await w.__pc.getStats();
    let pair: any;
    for (const r of st.values()) if (r.type === "transport" && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId);
    if (!pair) for (const r of st.values()) if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pair = r;
    const l = pair && st.get(pair.localCandidateId);
    const rm = pair && st.get(pair.remoteCandidateId);
    return pair ? { local: `${l.candidateType} ${l.address}:${l.port}`, remote: `${rm.candidateType} ${rm.address}:${rm.port}`, rttMs: pair.currentRoundTripTime * 1000 } : null;
  });
  await new Promise((r) => setTimeout(r, 2500));
  await helper.request("peer.close", { peer });
  await page.close();
  return {
    peer,
    ok: got.bytes >= bytes && down.bytes >= bytes,
    openMs,
    helperOpenMs: openAt ? Math.round(openAt - t0) : undefined,
    rttP50: Math.round(rtts[Math.floor(rtts.length / 2)]! * 10) / 10,
    rttP95: Math.round(rtts[Math.floor(rtts.length * 0.95)]! * 10) / 10,
    upMBs: Math.round((bytes / 1e6 / (upMs / 1000)) * 10) / 10,
    downMBs: Math.round((bytes / 1e6 / (downMs / 1000)) * 10) / 10,
    upFrames: got.frames,
    downFrames: down.frames,
    pageSelected: chosen,
    helperPath: path,
    sentTypes: sent.map(typ),
  };
}

try {
  for (let run = 0; run < Number(values.runs); run++) {
    const results = await Promise.all(Array.from({ length: Number(values.peers) }, (_, n) => onePeer(run, n)));
    for (const r of results) console.log(JSON.stringify(r));
  }
  console.log("net.state", JSON.stringify(netStates.at(-1)));
} finally {
  await browser.close();
  helper.stop();
}
