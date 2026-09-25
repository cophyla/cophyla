// The node's side of the bench: an HTTP server for the page and a WebSocket for signalling,
// and per connection one answering peer over the chosen library. The page opens a data
// channel and drives the bench over it; this side echoes, sends bulk and message bursts,
// counts what comes up, and adds its own CPU and memory to each phase. Candidates can be
// cut to one type both ways (`only`) to force a path: `srflx` makes the pair go through the
// router's public address even on one LAN. A page loaded on a phone can run `nat` alone.
//   bun node.ts --lib ndc|werift [--port 4961] [--stun] [--only any|host|srflx] [--host 0.0.0.0]

import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { candType, keep, makePeer, STUN, stripSdpCandidates } from "./peer.ts";
import type { Chan, Lib, Only, Peer } from "./peer.ts";
import { publicAddress } from "./stun.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    lib: { type: "string", default: "ndc" },
    port: { type: "string", default: "4961" },
    host: { type: "string", default: "127.0.0.1" },
    stun: { type: "boolean", default: false },
    only: { type: "string", default: "any" },
    log: { type: "string", default: "out/results.jsonl" },
    "ndc-log": { type: "string" },
    predict: { type: "string", default: "0" },
  },
});
const LIB = values.lib as Lib;
const ONLY = values.only as Only;
const LOG = values.log!;
const publicIp = values.stun || ONLY === "srflx" ? (await publicAddress(STUN))?.split(":")[0] : undefined;
const page = readFileSync(new URL("./page.html", import.meta.url), "utf8");
if (values["ndc-log"] && LIB === "ndc") {
  // libdatachannel's own log, for a path that fails: which checks went out and which came back
  const ndc = await import("node-datachannel");
  ndc.initLogger(values["ndc-log"] as "Debug", (level, message) => appendFileSync("out/ndc.log", `${new Date().toISOString()} ${level} ${message}
`));
}

/** CPU of this process over a phase, as % of one core, with RSS at its end. */
function meter() {
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  return () => {
    const c = process.cpuUsage(c0);
    const ms = performance.now() - t0;
    return { ms: Math.round(ms), cpuPct: Math.round(((c.user + c.system) / 1000 / ms) * 1000) / 10, rssMb: Math.round(process.memoryUsage().rss / 1e6) };
  };
}

function bench(ch: Chan, peer: Peer) {
  let upExpect = 0;
  let upGot = 0;
  let upDone: (() => void) | undefined;
  let upMeter: (() => ReturnType<ReturnType<typeof meter>>) | undefined;
  const reply = (o: unknown) => ch.send(JSON.stringify(o));

  /** Sends `n` items made by `make`, keeping the buffer under 1 MB: on the low event, and a 10 ms check besides. */
  let onLow: () => void = () => {};
  ch.onLow(1 << 18, () => onLow());
  let closed = false;
  ch.onClose(() => (closed = true));
  function pump(n: number, make: (i: number) => string | Uint8Array, done: () => void) {
    let i = 0;
    const HIGH = 1 << 20;
    let lowEvents = 0;
    let timerWakes = 0;
    let finished = false;
    const timer = setInterval(() => {
      timerWakes++;
      go();
    }, 10);
    const go = () => {
      if (closed) {
        clearInterval(timer);
        return;
      }
      while (i < n && ch.buffered() < HIGH) ch.send(make(i++));
      if (i >= n && !finished) {
        finished = true;
        clearInterval(timer);
        onLow = () => {};
        done();
      }
    };
    onLow = () => {
      lowEvents++;
      go();
    };
    go();
    return () => ({ lowEvents, timerWakes });
  }

  ch.onMessage((d) => {
    if (typeof d !== "string") {
      upGot += d.byteLength;
      if (upGot >= upExpect && upDone) {
        const f = upDone;
        upDone = undefined;
        f();
      }
      return;
    }
    const m = JSON.parse(d);
    if (m.op === "ping") return ch.send(d);
    if (m.op === "down") {
      const stop = meter();
      const chunk = new Uint8Array(m.chunk);
      pump(Math.ceil(m.bytes / m.chunk), () => chunk, () => reply({ op: "down-sent", node: stop() }));
    } else if (m.op === "msgs") {
      // session-stream-like text frames: a JSON-RPC notification with a delta of `size` bytes
      const stop = meter();
      const pad = "x".repeat(m.size);
      pump(m.count, (i) => `{"jsonrpc":"2.0","method":"session.delta","params":{"i":${i},"text":"${pad}"}}`, () => reply({ op: "msgs-sent", node: stop() }));
    } else if (m.op === "up") {
      upExpect = m.bytes;
      upGot = 0;
      upMeter = meter();
      upDone = () => reply({ op: "up-done", got: upGot, node: upMeter!() });
      reply({ op: "up-ready" });
    } else if (m.op === "rate") {
      // a steady stream at `bytesPerSec` for `seconds`, in 20 ms ticks: what a video-sized or chat-sized flow costs
      const stop = meter();
      const perTick = Math.max(1, Math.round((m.bytesPerSec * 20) / 1000));
      const msg = m.text ? `{"jsonrpc":"2.0","method":"session.delta","params":{"text":"${"x".repeat(Math.max(0, perTick - 60))}"}}` : new Uint8Array(perTick);
      let ticks = 0;
      const t = setInterval(() => {
        if (closed) return clearInterval(t);
        ch.send(msg);
        if (++ticks >= (m.seconds * 1000) / 20) {
          clearInterval(t);
          reply({ op: "rate-done", node: stop() });
        }
      }, 20);
    } else if (m.op === "hold") {
      // nothing sent: what an open, idle connection costs (ICE consent checks, SCTP heartbeats)
      const stop = meter();
      setTimeout(() => reply({ op: "hold-done", node: stop() }), m.seconds * 1000);
    } else if (m.op === "info") {
      reply({ op: "info", lib: LIB, selected: peer.selected(), rssMb: Math.round(process.memoryUsage().rss / 1e6) });
    }
  });
}

interface Conn {
  peer?: Peer;
  t0: number;
  marks: Record<string, number>;
  pending: { c: string; mid: string }[];
  /** Per public IP of the page's srflx candidates, the highest port predicted so far. */
  seen?: Map<string, number>;
}

const server = Bun.serve<Conn>({
  hostname: values.host,
  port: Number(values.port),
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") return srv.upgrade(req, { data: { t0: performance.now(), marks: {}, pending: [] } }) ? undefined : new Response("upgrade failed", { status: 400 });
    if (url.pathname === "/report" && req.method === "POST") {
      return req.text().then((t) => {
        appendFileSync(LOG, t.trim() + "\n");
        console.log("report", t.slice(0, 300));
        return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
      });
    }
    if (url.pathname === "/rss") {
      Bun.gc(true);
      return Response.json({ rssMb: Math.round(process.memoryUsage().rss / 1e6), heapMb: Math.round(process.memoryUsage().heapUsed / 1e6) });
    }
    if (url.pathname === "/config") return Response.json({ lib: LIB, only: ONLY, stun: values.stun, publicIp, stunServers: STUN });
    if (url.pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    return new Response("not found", { status: 404 });
  },
  websocket: {
    async message(ws, raw) {
      const m = JSON.parse(String(raw));
      const conn = ws.data;
      const mark = (k: string) => (conn.marks[k] = Math.round(performance.now() - conn.t0));
      if (m.t === "offer") {
        mark("offer");
        const created = performance.now();
        const peer = await makePeer(LIB, { stun: values.stun || ONLY === "srflx" });
        conn.peer = peer;
        conn.marks.peerCreateMs = Math.round(performance.now() - created);
        const sent: string[] = [];
        peer.onCandidate((c, mid) => {
          if (!keep(ONLY, c)) return;
          sent.push(candType(c));
          ws.send(JSON.stringify({ t: "cand", c, mid }));
        });
        peer.onState((s) => {
          mark(`state:${s}`);
          console.log(`${new Date().toISOString()} ${ws.remoteAddress} ${s} at ${conn.marks[`state:${s}`]! - conn.marks.offer!} ms${s === "connected" ? ` pair ${JSON.stringify(peer.selected())}` : ""}`);
          ws.send(JSON.stringify({ t: "state", s }));
          if (s === "connected") console.log(`connected (${LIB}, only ${ONLY}) in ${conn.marks[`state:${s}`]! - conn.marks.offer!} ms since offer; ours ${sent.join(",")}`);
        });
        peer.onChannel((ch) => {
          mark("channel");
          bench(ch, peer);
        });
        const answer = await peer.answer(m.sdp);
        mark("answer");
        ws.send(JSON.stringify({ t: "answer", sdp: stripSdpCandidates(answer), publicIp }));
        for (const p of conn.pending.splice(0)) peer.addCandidate(p.c, p.mid);
      } else if (m.t === "cand") {
        const add = (c: string) => (conn.peer ? conn.peer.addCandidate(c, m.mid) : conn.pending.push({ c, mid: m.mid }));
        add(m.c);
        // `--predict n`: a NAT that hands out ports in sequence will use one just above those
        // STUN saw for the socket's next destination, this node; offer ICE those ports as
        // remote candidates too, so this side's checks open its router for them
        const n = Number(values.predict);
        if (n > 0 && candType(m.c) === "srflx") {
          const f = m.c.split(" ");
          const ip = f[4]!;
          const port = Number(f[5]);
          conn.seen ??= new Map();
          const top = Math.max(port, conn.seen.get(ip) ?? 0);
          const from = (conn.seen.get(ip) ?? port) + 1;
          conn.seen.set(ip, top + n);
          for (let q = Math.max(from, port + 1); q <= top + n; q++) add(`candidate:9${q} 1 udp ${1677729535 - (q - port)} ${ip} ${q} typ srflx raddr 0.0.0.0 rport 0`);
          console.log(`${new Date().toISOString()} predicted ${ip}:${Math.max(from, port + 1)}-${top + n}`);
        }
      } else if (m.t === "marks") {
        ws.send(JSON.stringify({ t: "marks", node: conn.marks }));
      }
    },
    close(ws) {
      ws.data.peer?.close();
    },
  },
});

console.log(`node (${LIB}, stun ${values.stun}, only ${ONLY}, public ${publicIp ?? "-"}) on http://${server.hostname}:${server.port}/`);
