// What listens on a machine, as each system's tool prints it: Windows' two netstat tables
// (read by the far address, the state's word being the system language's), macOS' lsof
// fields, Linux's ss and its /proc tables; loopback and every-address listeners kept, one on a
// network address alone left out, the rows merged a port, named, and Cophyla's own (the daemon, its
// helpers and what they start, by pid) left out; a page a terminal of the daemon's serves stays.

import { describe, expect, test } from "bun:test";
import { descendants, listPorts, mergeListeners, parseLsof, parseNetstat, parseProcNet, parsePs, parseSs, systemProgram } from "../src/remote/listening.ts";
import type { Exec } from "../src/sidecars/tts-py.ts";

const NETSTAT_V4 = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2164
  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       5120
  TCP    127.0.0.1:4817         0.0.0.0:0              LISTENING       900
  TCP    192.168.1.20:139       0.0.0.0:0              LISTENING       4
  TCP    127.0.0.1:3000         127.0.0.1:52011        ESTABLISHED     5120
  TCP    127.0.0.1:52011        127.0.0.1:3000         ESTABLISHED     7000
`;

// a German Windows: the state says ABHÖREN, which nothing reads
const NETSTAT_V6 = `
Aktive Verbindungen

  Proto  Lokale Adresse         Remoteadresse          Status           PID
  TCP    [::]:135               [::]:0                 ABHÖREN          2164
  TCP    [::1]:5173             [::]:0                 ABHÖREN          6200
  TCP    [fe80::1%12]:8080      [::]:0                 ABHÖREN          6300
  TCP    [::1]:5173             [::1]:52020            HERGESTELLT      6200
`;

const LSOF = ["p412", "cnode", "f23", "tIPv6", "n[::1]:5173", "f24", "tIPv4", "n127.0.0.1:5173", "p77", "cpostgres", "f5", "tIPv4", "n*:5432", "f6", "tIPv6", "n*:5432", "p91", "cControlCe", "f9", "tIPv4", "n192.168.1.4:7000", "f10", "tIPv4", "n127.0.0.1:60000->127.0.0.1:5432"].join("\n");

const SS = `LISTEN 0      511        127.0.0.1:3000      0.0.0.0:*    users:(("node",pid=1234,fd=20))
LISTEN 0      4096           [::1]:5173         [::]:*    users:(("node",pid=99,fd=3))
LISTEN 0      128          0.0.0.0:22         0.0.0.0:*
LISTEN 0      4096               *:8080             *:*    users:(("java",pid=55,fd=7))
LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*
LISTEN 0      511     10.0.0.7:9000        0.0.0.0:*    users:(("nginx",pid=8,fd=6))`;

const PROC_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000000000000000 100 0 0 10 0
   2: 0700000A:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12347 1 0000000000000000 100 0 0 10 0
   3: 0100007F:0BB8 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 12348 1 0000000000000000 100 0 0 10 0`;

const PROC_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 23 1 0000000000000000 100 0 0 10 0`;

describe("listening ports", () => {
  test("Windows: the listeners by their far address of zeros, loopback and every address only, with their pids", () => {
    expect(parseNetstat(NETSTAT_V4, 4)).toEqual([
      { port: 135, family: 4, pid: 2164 },
      { port: 3000, family: 4, pid: 5120 },
      { port: 4817, family: 4, pid: 900 },
    ]);
    expect(parseNetstat(NETSTAT_V6, 6)).toEqual([
      { port: 135, family: 6, pid: 2164 },
      { port: 5173, family: 6, pid: 6200 },
    ]);
  });

  test("macOS: lsof's processes and their sockets, by family; a connection and a network address left out", () => {
    expect(parseLsof(LSOF)).toEqual([
      { port: 5173, family: 6, pid: 412, process: "node" },
      { port: 5173, family: 4, pid: 412, process: "node" },
      { port: 5432, family: 4, pid: 77, process: "postgres" },
      { port: 5432, family: 6, pid: 77, process: "postgres" },
    ]);
  });

  test("Linux: ss with the user's own programs named, `*` on both families; /proc without names", () => {
    expect(parseSs(SS)).toEqual([
      { port: 3000, family: 4, pid: 1234, process: "node" },
      { port: 5173, family: 6, pid: 99, process: "node" },
      { port: 22, family: 4 },
      { port: 8080, family: 4, pid: 55, process: "java" },
      { port: 8080, family: 6, pid: 55, process: "java" },
      { port: 53, family: 4 },
    ]);
    expect(parseProcNet(PROC_TCP, 4)).toEqual([
      { port: 3000, family: 4 },
      { port: 22, family: 4 },
    ]);
    expect(parseProcNet(PROC_TCP6, 6)).toEqual([
      { port: 5173, family: 6 },
      { port: 8080, family: 6 },
    ]);
  });

  test("the rows merged a port, named from the process list, a helper's and its children's left out", () => {
    const rows = parsePs("  1     0 /sbin/init\n900     1 /usr/bin/bun\n950   900 moonlight-web\n951   950 streamer\n5120    1 /usr/bin/node\n");
    expect(rows.find((r) => r.pid === 950)).toEqual({ pid: 950, ppid: 900, name: "moonlight-web" });
    const own = descendants(rows, [900]);
    expect([...own].sort((a, b) => a - b)).toEqual([900, 950, 951]);
    const merged = mergeListeners(
      [
        { port: 3000, family: 4, pid: 5120 },
        { port: 3000, family: 6, pid: 5120 },
        { port: 4817, family: 4, pid: 900 },
        { port: 4817, family: 6 },
        { port: 47990, family: 4, pid: 951 },
        { port: 22, family: 4 },
      ],
      new Map(rows.map((r) => [r.pid, r.name])),
      own,
    );
    expect(merged).toEqual([{ port: 3000, v4: true, v6: true, process: "node" }]);
  });

  test("the system's ports are left out: under 1024, and what its own services hold", () => {
    const names = new Map<number, string>([
      [4, "System"],
      [1100, "svchost.exe"],
      [1200, "lsass.exe"],
      [5000, "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter"],
      [6000, "node.exe"],
      [6100, "python.exe"],
      [6200, "Code.exe"],
    ]);
    const merged = mergeListeners(
      [
        { port: 135, family: 4, pid: 1100 },
        { port: 445, family: 4, pid: 4 },
        { port: 49664, family: 4, pid: 1200 },
        { port: 49665, family: 6, pid: 1100 },
        { port: 7000, family: 4, pid: 5000 },
        { port: 80, family: 4, pid: 6000 },
        { port: 5173, family: 6, pid: 6000 },
        { port: 8000, family: 4, pid: 6100 },
        { port: 52101, family: 4, pid: 6200 },
        { port: 9229, family: 4 },
      ],
      names,
      new Set(),
    );
    expect(merged.map((r) => r.port)).toEqual([5173, 8000, 9229, 52101]);
    expect(systemProgram("SVCHOST.EXE")).toBe(true);
    expect(systemProgram(String.raw`C:\Windows\System32\lsass.exe`)).toBe(true);
    expect(systemProgram("node")).toBe(false);
    expect(systemProgram(undefined)).toBe(false);
  });

  test("listPorts runs each system's tool, and Linux falls back to /proc without ss", async () => {
    const ran: string[][] = [];
    const exec = (outputs: Record<string, string | undefined>): Exec =>
      async (command) => {
        ran.push(command);
        const out = outputs[command[0]!];
        return out === undefined ? { code: 1, stdout: "", stderr: "not found" } : { code: 0, stdout: out, stderr: "" };
      };
    const win = await listPorts({
      os: "windows",
      exec: async (command) => ({ code: 0, stdout: command.includes("TCPv6") ? NETSTAT_V6 : NETSTAT_V4, stderr: "" }),
      own: () => [900],
      helpers: () => [2164],
      // a page a terminal of the daemon's serves is the user's; a helper's and its children's are Cophyla's
      processes: () => [
        { pid: 5120, ppid: 900, name: "node.exe" },
        { pid: 6200, ppid: 5120, name: "vite.exe" },
        { pid: 2164, ppid: 900, name: "moonlight-web.exe" },
      ],
    });
    expect(win).toEqual([
      { port: 3000, v4: true, v6: false, process: "node.exe" },
      { port: 5173, v4: false, v6: true, process: "vite.exe" },
    ]);
    const mac = await listPorts({ os: "macos", exec: exec({ lsof: LSOF, ps: "412 1 /usr/local/bin/node\n77 1 postgres\n" }), own: () => [77] });
    expect(mac).toEqual([{ port: 5173, v4: true, v6: true, process: "node" }]);
    ran.length = 0;
    const linux = await listPorts({ os: "linux", exec: exec({ ps: "" }), own: () => [], readFile: async (p) => (p.endsWith("tcp6") ? PROC_TCP6 : PROC_TCP) });
    expect(ran.map((c) => c[0])).toEqual(["ps", "ss"]);
    expect(linux).toEqual([
      { port: 3000, v4: true, v6: false },
      { port: 5173, v4: false, v6: true },
      { port: 8080, v4: false, v6: true },
    ]);
  });
});
