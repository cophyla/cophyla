// A minimal STUN client (RFC 5389 binding, RFC 5780 CHANGE-REQUEST) over node:dgram: what
// address does the NAT map a socket to, per server, and does a reply from another address
// or port get back in.

import { createSocket } from "node:dgram";
import type { Socket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";

const COOKIE = 0x2112a442;

export interface Mapped {
  server: string;
  mapped?: string;
  /** Where the reply came from, and the server's other address when it has one (RFC 5780). */
  origin?: string;
  other?: string;
  rttMs?: number;
  error?: string;
}

function request(change: number): { buf: Buffer; tid: Buffer } {
  const tid = randomBytes(12);
  const attrs = change ? Buffer.from([0x00, 0x03, 0x00, 0x04, 0, 0, 0, change]) : Buffer.alloc(0);
  const head = Buffer.alloc(20);
  head.writeUInt16BE(0x0001, 0);
  head.writeUInt16BE(attrs.length, 2);
  head.writeUInt32BE(COOKIE, 4);
  tid.copy(head, 8);
  return { buf: Buffer.concat([head, attrs]), tid };
}

function addr(v: Buffer, xor: boolean): string {
  const family = v[1];
  let port = v.readUInt16BE(2);
  if (xor) port ^= COOKIE >>> 16;
  if (family === 0x01) {
    const ip = Buffer.from(v.subarray(4, 8));
    if (xor) ip.writeUInt32BE((ip.readUInt32BE(0) ^ COOKIE) >>> 0, 0);
    return `${[...ip].join(".")}:${port}`;
  }
  return `ipv6:${port}`;
}

function parse(msg: Buffer): { tid: Buffer; mapped?: string; origin?: string; other?: string } {
  const tid = msg.subarray(8, 20);
  const out: { tid: Buffer; mapped?: string; origin?: string; other?: string } = { tid };
  let off = 20;
  while (off + 4 <= msg.length) {
    const type = msg.readUInt16BE(off);
    const len = msg.readUInt16BE(off + 2);
    const v = msg.subarray(off + 4, off + 4 + len);
    if (type === 0x0020) out.mapped = addr(v, true);
    else if (type === 0x0001 && !out.mapped) out.mapped = addr(v, false);
    else if (type === 0x802b || type === 0x0004) out.origin = addr(v, false);
    else if (type === 0x802c || type === 0x0005) out.other = addr(v, false);
    off += 4 + len + ((4 - (len % 4)) % 4);
  }
  return out;
}

/** A socket that answers several binding requests, matched by transaction id. */
export class StunSocket {
  readonly sock: Socket;
  private waiting = new Map<string, (r: { mapped?: string; origin?: string; other?: string; from: string }) => void>();
  readonly ready: Promise<number>;

  constructor(port = 0) {
    this.sock = createSocket("udp4");
    this.sock.on("message", (msg, rinfo) => {
      if (msg.length < 20 || msg.readUInt32BE(4) !== COOKIE) return;
      const r = parse(msg);
      const key = r.tid.toString("hex");
      this.waiting.get(key)?.({ ...r, from: `${rinfo.address}:${rinfo.port}` });
      this.waiting.delete(key);
    });
    this.ready = new Promise((resolve) => this.sock.bind(port, () => resolve(this.sock.address().port)));
  }

  /** One binding request to `host:port`, retried until `timeoutMs`; `change` is RFC 5780's flags (4 = IP, 2 = port). */
  async bind(server: string, change = 0, timeoutMs = 2500): Promise<Mapped> {
    await this.ready;
    const [host, portText] = server.split(/:(?=\d+$)/);
    let ip: string;
    try {
      ip = (await lookup(host!, { family: 4 })).address;
    } catch (e) {
      return { server, error: `dns: ${(e as Error).message}` };
    }
    const { buf, tid } = request(change);
    const t0 = performance.now();
    return new Promise((resolve) => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      const finish = (m: Mapped) => {
        timers.forEach(clearTimeout);
        this.waiting.delete(tid.toString("hex"));
        resolve(m);
      };
      this.waiting.set(tid.toString("hex"), (r) =>
        finish({ server: `${server} (${ip})`, mapped: r.mapped, origin: r.from, other: r.other, rttMs: Math.round(performance.now() - t0) }),
      );
      for (const at of [0, 250, 750, 1500]) timers.push(setTimeout(() => this.sock.send(buf, Number(portText), ip), at));
      timers.push(setTimeout(() => finish({ server: `${server} (${ip})`, error: "timeout" }), timeoutMs));
    });
  }

  close(): void {
    this.sock.close();
  }
}

/** The public address a fresh socket maps to through the first server that answers. */
export async function publicAddress(servers: string[]): Promise<string | undefined> {
  const s = new StunSocket();
  try {
    for (const server of servers) {
      const r = await s.bind(server);
      if (r.mapped) return r.mapped;
    }
  } finally {
    s.close();
  }
  return undefined;
}
