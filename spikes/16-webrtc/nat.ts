// What kind of NAT this node sits behind, the half of the hole-punching question that can be
// answered from here: mapping (does one socket keep its public port whatever it talks to),
// filtering (does a reply from an address it never sent to get in), port allocation across
// sockets, IPv6, whether the router takes port mappings (UPnP IGD, NAT-PMP, PCP; asked, never
// set), whether the router's WAN address is the public one (a carrier NAT above it if not),
// and the round trip to the relay server for comparison. Read-only toward the router.
//   bun nat.ts [--gateway 192.168.1.1] [--out out/nat-home.json]

import { createSocket } from "node:dgram";
import { writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { connect } from "node:net";
import { parseArgs } from "node:util";
import { StunSocket } from "./stun.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { gateway: { type: "string", default: "192.168.1.1" }, out: { type: "string", default: "out/nat-home.json" } },
});
const gateway = values.gateway!;
const report: Record<string, unknown> = { at: new Date().toISOString() };

// --- mapping: one socket, several servers -------------------------------------------------
const SERVERS = ["stun.l.google.com:19302", "stun.cloudflare.com:3478", "global.stun.twilio.com:3478", "stun.nextcloud.com:443", "stun.sipgate.net:3478", "stun.ekiga.net:3478"];
{
  const s = new StunSocket();
  const local = await s.ready;
  const rows = [];
  for (const server of SERVERS) rows.push(await s.bind(server));
  s.close();
  const ports = new Set(rows.filter((r) => r.mapped).map((r) => r.mapped));
  report.mapping = { localPort: local, rows, distinctMapped: [...ports], verdict: ports.size === 1 ? "endpoint-independent" : ports.size > 1 ? "endpoint-dependent (symmetric)" : "no answer" };
  console.log("mapping", JSON.stringify(report.mapping, null, 1));
}

// --- RFC 5780 against servers that have a second address ----------------------------------
// Filtering, on fresh sockets so no earlier send opened anything toward the other address.
// Several servers, since one of them may answer a change request from the wrong place.
const RFC5780 = ["stun.ekiga.net:3478", "stun.voipgate.com:3478", "stun.nfon.net:3478", "stun.solnet.ch:3478", "stun.fitauto.ru:3478"];
{
  const rows = [];
  for (const server of RFC5780) {
    const s = new StunSocket();
    await s.ready;
    const base = await s.bind(server);
    const row: Record<string, unknown> = { server, base: base.mapped ?? base.error, other: base.other };
    if (base.other) {
      const [otherIp, otherPort] = base.other.split(":");
      // mapping toward the server's other IP (same port) and other IP and port
      row.otherIpSamePort = (await s.bind(`${otherIp}:${server.split(":")[1]}`)).mapped ?? "no answer";
      row.otherIpOtherPort = (await s.bind(`${otherIp}:${otherPort}`)).mapped ?? "no answer";
    }
    s.close();
    const f1 = new StunSocket();
    await f1.bind(server);
    const both = await f1.bind(server, 0x06, 3000);
    f1.close();
    const f2 = new StunSocket();
    await f2.bind(server);
    const port = await f2.bind(server, 0x02, 3000);
    f2.close();
    row.changeIpAndPort = both.mapped ? `answered from ${both.origin}` : "no answer";
    row.changePortOnly = port.mapped ? `answered from ${port.origin}` : "no answer";
    row.filtering = both.mapped ? "endpoint-independent (full cone)" : port.mapped ? "address-dependent" : "address-and-port-dependent";
    rows.push(row);
  }
  report.rfc5780 = rows;
  console.log("rfc5780", JSON.stringify(rows, null, 1));
}

// --- port allocation across fresh sockets --------------------------------------------------
{
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const s = new StunSocket();
    const local = await s.ready;
    const r = await s.bind("stun.l.google.com:19302");
    rows.push({ local, mapped: r.mapped });
    s.close();
  }
  report.allocation = rows;
  console.log("allocation", JSON.stringify(rows));
}

// --- IPv6 ------------------------------------------------------------------------------------
{
  const v6 = Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).filter((a) => a.family === "IPv6" && !a.internal && !a.address.startsWith("fe80") && !a.address.startsWith("fd") && !a.address.startsWith("fc")).map((a) => `${name} ${a.address}`),
  );
  report.ipv6Global = v6;
  console.log("ipv6 global", v6);
}

// --- the router: UPnP IGD, NAT-PMP, PCP (queries only) --------------------------------------
async function ssdp(): Promise<{ location: string; server?: string; st?: string }[]> {
  const sock = createSocket({ type: "udp4", reuseAddr: true });
  const found: { location: string; server?: string; st?: string }[] = [];
  sock.on("message", (msg) => {
    const text = msg.toString();
    const header = (h: string) => new RegExp(`^${h}:\\s*(.+)$`, "im").exec(text)?.[1]?.trim();
    const location = header("location");
    if (location && !found.some((f) => f.location === location)) found.push({ location, server: header("server"), st: header("st") });
  });
  await new Promise<void>((r) => sock.bind(0, () => r()));
  for (const st of ["urn:schemas-upnp-org:device:InternetGatewayDevice:1", "urn:schemas-upnp-org:device:InternetGatewayDevice:2", "urn:schemas-upnp-org:service:WANIPConnection:1"]) {
    const m = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
    sock.send(m, 1900, "239.255.255.250");
  }
  await Bun.sleep(3000);
  sock.close();
  return found;
}

const upnp: Record<string, unknown> = {};
try {
  const found = await ssdp();
  upnp.devices = found;
  for (const dev of found) {
    const xml = await (await fetch(dev.location, { signal: AbortSignal.timeout(3000) })).text();
    const services = [...xml.matchAll(/<serviceType>([^<]+)<\/serviceType>[\s\S]*?<controlURL>([^<]+)<\/controlURL>/g)].map((m) => ({ type: m[1]!, control: m[2]! }));
    upnp[dev.location] = { friendlyName: /<friendlyName>([^<]+)</.exec(xml)?.[1], modelName: /<modelName>([^<]+)</.exec(xml)?.[1], services: services.map((s) => s.type) };
    const wan = services.find((s) => /WAN(IP|PPP)Connection/.test(s.type));
    if (wan) {
      // GetExternalIPAddress: a read-only action
      const url = new URL(wan.control, dev.location).href;
      const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetExternalIPAddress xmlns:u="${wan.type}"/></s:Body></s:Envelope>`;
      const res = await fetch(url, { method: "POST", body, headers: { "content-type": 'text/xml; charset="utf-8"', soapaction: `"${wan.type}#GetExternalIPAddress"` }, signal: AbortSignal.timeout(3000) });
      const text = await res.text();
      upnp.externalIp = { status: res.status, ip: /<NewExternalIPAddress>([^<]*)</.exec(text)?.[1] };
    }
  }
} catch (e) {
  upnp.error = (e as Error).message;
}
report.upnp = upnp;
console.log("upnp", JSON.stringify(upnp, null, 1));

async function udpAsk(buf: Buffer, host: string, port: number, ms = 2000): Promise<Buffer | undefined> {
  const sock = createSocket("udp4");
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      sock.close();
      resolve(undefined);
    }, ms);
    sock.on("message", (msg) => {
      clearTimeout(t);
      sock.close();
      resolve(msg);
    });
    sock.send(buf, port, host);
  });
}

{
  // NAT-PMP external address request: version 0, opcode 0
  const pmp = await udpAsk(Buffer.from([0, 0]), gateway, 5351);
  report.natPmp = pmp ? { bytes: pmp.toString("hex"), result: pmp.length >= 4 ? pmp.readUInt16BE(2) : undefined, ip: pmp.length >= 12 ? [...pmp.subarray(8, 12)].join(".") : undefined } : "no answer";
  // PCP ANNOUNCE: version 2, opcode 0, lifetime 0, our address as IPv4-mapped IPv6
  const pcp = Buffer.alloc(24);
  pcp[0] = 2;
  pcp[1] = 0;
  pcp.writeUInt16BE(0xffff, 18);
  const ours = Object.values(networkInterfaces()).flat().find((a) => a?.family === "IPv4" && a.address.startsWith(gateway.split(".").slice(0, 3).join(".")));
  if (ours) Buffer.from(ours.address.split(".").map(Number)).copy(pcp, 20);
  const pcpAns = await udpAsk(pcp, gateway, 5351);
  report.pcp = pcpAns ? { bytes: pcpAns.toString("hex"), version: pcpAns[0], result: pcpAns[3] } : "no answer";
  console.log("nat-pmp", report.natPmp, "pcp", report.pcp);
}

// --- the relay server's round trip, for comparison -----------------------------------------
async function tcpRtt(host: string, port: number): Promise<number> {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const s = connect({ host, port }, () => {
      const ms = performance.now() - t0;
      s.destroy();
      resolve(Math.round(ms * 10) / 10);
    });
    s.on("error", reject);
    s.setTimeout(3000, () => {
      s.destroy();
      reject(new Error("timeout"));
    });
  });
}
{
  const rtts: number[] = [];
  for (let i = 0; i < 6; i++) rtts.push(await tcpRtt("api.getcophyla.com", 443).catch(() => -1));
  report.relayServerTcpConnectMs = rtts;
  console.log("api.getcophyla.com tcp connect ms", rtts);
}

writeFileSync(values.out!, JSON.stringify(report, null, 2));
console.log(`wrote ${values.out}`);
process.exit(0);
