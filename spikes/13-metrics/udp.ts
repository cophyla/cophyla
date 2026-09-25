// Discovery on one network: a UDP listener on 4819 that answers queries, a query from an
// ephemeral port to every broadcast address, and two listeners on one port in one process
// (two homes on one machine), through node:dgram with reuseAddr and broadcast on.
//
//   bun run udp.ts listen [port]     answer queries; prints what arrives
//   bun run udp.ts query [port] [host]   broadcast a query (or unicast to host); print answers for 3 s
//   bun run udp.ts pair              two sockets on 4819 in-process, one broadcast, both hear it

import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";

const PORT = Number(process.argv[3] ?? 4819);
const mode = process.argv[2] ?? "pair";

function broadcasts(): string[] {
  const out = new Set<string>(["255.255.255.255"]);
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      const ip = i.address.split(".").map(Number);
      const mask = i.netmask.split(".").map(Number);
      out.add(ip.map((b, k) => (b & mask[k]!) | (~mask[k]! & 255)).join("."));
    }
  }
  return [...out];
}

function open(port: number, label: string, onMessage: (msg: Record<string, unknown>, rinfo: { address: string; port: number }) => void): Promise<import("node:dgram").Socket> {
  return new Promise((resolve, reject) => {
    const sock = createSocket({ type: "udp4", reuseAddr: true });
    sock.on("error", (e) => {
      console.log(`${label}: error ${e.message}`);
      reject(e);
    });
    sock.on("message", (buf, rinfo) => {
      try {
        onMessage(JSON.parse(buf.toString("utf8")), rinfo);
      } catch {
        console.log(`${label}: non-JSON from ${rinfo.address}:${rinfo.port}`);
      }
    });
    sock.bind(port, "0.0.0.0", () => {
      sock.setBroadcast(true);
      console.log(`${label}: bound ${JSON.stringify(sock.address())}`);
      resolve(sock);
    });
  });
}

const send = (sock: import("node:dgram").Socket, msg: unknown, port: number, host: string) => sock.send(JSON.stringify(msg), port, host);

if (mode === "listen") {
  const sock = await open(PORT, "listener", (msg, rinfo) => {
    console.log("listener got", msg, "from", rinfo.address, rinfo.port);
    if (msg["t"] === "q") send(sock, { cophyla: 1, t: "a", cluster: msg["cluster"], nonce: msg["nonce"], nodeId: "node_listener", name: "listener", port: 4888, epoch: 1, role: "primary" }, rinfo.port, rinfo.address);
  });
  console.log("broadcast addresses here:", broadcasts());
} else if (mode === "query") {
  const host = process.argv[4];
  const sock = await open(0, "query", (msg, rinfo) => console.log("query got", msg, "from", rinfo.address, rinfo.port));
  const q = { cophyla: 1, t: "q", cluster: "0123456789abcdef", nonce: "n1", nodeId: "node_query", name: "query", port: 0, epoch: 0, role: "secondary" };
  for (const to of host ? [host] : broadcasts()) {
    send(sock, q, PORT, to);
    console.log("query sent to", to, PORT);
  }
  await Bun.sleep(3000);
  sock.close();
} else {
  const a = await open(PORT, "A", (msg, rinfo) => console.log("A got", msg["t"], "from", rinfo.address, rinfo.port));
  const b = await open(PORT, "B", (msg, rinfo) => console.log("B got", msg["t"], "from", rinfo.address, rinfo.port));
  const c = await open(0, "C", (msg, rinfo) => console.log("C got", msg["t"], "from", rinfo.address, rinfo.port));
  for (const to of broadcasts()) send(c, { cophyla: 1, t: "q", cluster: "x", nodeId: "node_c" }, PORT, to);
  await Bun.sleep(1000);
  send(a, { cophyla: 1, t: "b", cluster: "x", nodeId: "node_a" }, PORT, "255.255.255.255");
  await Bun.sleep(1000);
  a.close();
  b.close();
  c.close();
}
