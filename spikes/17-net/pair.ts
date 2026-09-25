// Two cophyla-net helpers linked to each other the way two nodes will be: one offers, the
// other answers, and this script carries the SDP and the candidates between them, keeping
// only the reflexive ones when asked, so the path goes out through the router and back in.
// Then an echo, and megabytes each way.
//   node --experimental-strip-types pair.ts [--helper wsl:<path>] [--only-srflx] [--mb 4]

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    helper: { type: "string", default: "wsl:/home/me/cophyla/apps/net/target/release/cophyla-net" },
    "only-srflx": { type: "boolean", default: false },
    stun: { type: "string", default: "stun:stun.cloudflare.com:3478" },
    mb: { type: "string", default: "4" },
  },
});
type Json = Record<string, unknown>;
const FRAME = 16 * 1024;

class Helper {
  private child: ChildProcessWithoutNullStreams;
  private next = 1;
  private pending = new Map<number, (v: Json) => void>();
  handlers: ((method: string, params: Json) => void)[] = [];
  constructor(command: string[]) {
    this.child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const m = JSON.parse(line) as Json;
      if (typeof m.id === "number") {
        this.pending.get(m.id)?.((m.result ?? { error: m.error }) as Json);
        this.pending.delete(m.id);
      } else for (const h of this.handlers) h(m.method as string, m.params as Json);
    });
    this.child.stderr.resume();
  }
  request(method: string, params: Json): Promise<Json> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method: string, params: Json): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  stop(): void {
    this.child.stdin.end();
  }
}

const cmd = values.helper!.startsWith("wsl:") ? ["wsl", "-e", values.helper!.slice(4)] : [values.helper!];
const a = new Helper(cmd);
const b = new Helper(cmd);
for (const h of [a, b]) {
  await h.request("hello", { protocol: 1 });
  await h.request("net.configure", { stun: [values.stun], map: false, ipv6: false });
}
const typ = (c: string) => / typ (\w+)/.exec(c)?.[1];
const got = { a: 0, b: 0 };
const opened = { a: false, b: false };
const paths: Json = {};
const wire = (from: Helper, to: Helper, fromName: "a" | "b", toPeer: string) => {
  from.handlers.push((m, p) => {
    if (m === "peer.candidate") {
      const c = p.candidate as { candidate: string } | null;
      if (!c || (values["only-srflx"] && typ(c.candidate) !== "srflx")) return;
      void to.request("peer.candidate", { peer: toPeer, candidate: c });
    } else if (m === "peer.open") opened[fromName] = true;
    else if (m === "peer.data") {
      const d = p.data as string;
      if (d.startsWith("ping:")) from.notify("peer.send", { peer: p.peer as string, data: d.replace("ping", "pong") });
      else got[fromName] += d.length;
    } else if (m === "peer.path") paths[fromName] = p;
  });
};
wire(a, b, "a", "from-a");
wire(b, a, "b", "to-b");
const t0 = performance.now();
const offer = await a.request("peer.offer", { peer: "to-b", ice: { disconnectedMs: 2500, failedMs: 6000 } });
const answer = await b.request("peer.answer", { peer: "from-a", sdp: offer.sdp as string, ice: { disconnectedMs: 2500, failedMs: 6000 } });
await a.request("peer.accept", { peer: "to-b", sdp: answer.sdp as string });
while (!(opened.a && opened.b) && performance.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 10));
const openMs = Math.round(performance.now() - t0);
if (!(opened.a && opened.b)) {
  console.log(JSON.stringify({ ok: false, openMs }));
  process.exit(1);
}
// echo: a → b → a
const rtts: number[] = [];
for (let i = 0; i < 20; i++) {
  const t = performance.now();
  await new Promise<void>((resolve) => {
    const h = (m: string, p: Json) => {
      if (m === "peer.data" && (p.data as string) === `pong:${i}`) {
        a.handlers.splice(a.handlers.indexOf(h), 1);
        resolve();
      }
    };
    a.handlers.push(h);
    a.notify("peer.send", { peer: "to-b", data: `ping:${i}` });
  });
  rtts.push(performance.now() - t);
}
rtts.sort((x, y) => x - y);
const bytes = Number(values.mb) * 1024 * 1024;
const frame = "x".repeat(FRAME);
const measure = async (from: Helper, peer: string, into: "a" | "b") => {
  const t = performance.now();
  for (let s = 0; s < bytes; s += FRAME) from.notify("peer.send", { peer, data: frame });
  while (got[into] < bytes && performance.now() - t < 60_000) await new Promise((r) => setTimeout(r, 10));
  return Math.round((bytes / 1e6 / ((performance.now() - t) / 1000)) * 10) / 10;
};
const abMBs = await measure(a, "to-b", "b");
const baMBs = await measure(b, "from-a", "a");
await new Promise((r) => setTimeout(r, 2500));
console.log(JSON.stringify({ ok: got.a >= bytes && got.b >= bytes, openMs, rttP50: Math.round(rtts[10]! * 10) / 10, abMBs, baMBs, pathA: paths.a, pathB: paths.b }).replace(/81\.26\.\d+\.\d+/g, "<public>"));
a.stop();
b.stop();
