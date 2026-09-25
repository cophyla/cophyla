# Spike 13: sampling the machine without a shell, and finding a node on the network

Date: 2026-09-20. Windows 11, Bun 1.3.14, NVIDIA driver with `nvml.dll` in System32, an RTX
4080 in WDDM mode; WSL2 Ubuntu on the same machine for the Linux half. 24 logical cores,
~780 processes running (a working desktop with a dozen harness sessions open).

Question: can cophylad read every process's CPU time, memory and parent, and the machine's
totals and the GPU, through `bun:ffi` and `/proc` alone, fast enough to do it every second
for less than a harness session costs? And can a secondary on one network find the primary
by a UDP broadcast, two homes on one machine included?

**Answer: yes to both, with two numbers to carry.** One `NtQuerySystemInformation
(SystemProcessInformation)` call returns every process; on this machine that call is
**~12 ms of kernel time** because the class carries every thread too (1.6 MB for 780
processes), and there is no cheaper class that has CPU time and parent in it. `/proc` in WSL
walks its 45 processes in 0.2 ms. NVML answers in under a millisecond but **hides
per-process VRAM on WDDM** (every entry is `NVML_VALUE_NOT_AVAILABLE`; the pid list itself
is right). Two sockets on 4819 with `reuseAddr` both hear a broadcast, and a query from WSL
reaches the host's listener over the vEthernet adapter.

## What runs

- `win.ts` — `ntdll` `NtQuerySystemInformation(5)` into a buffer that doubles on
  `0xC0000004` (settles at 2 MB here and is kept), `kernel32` `GetSystemTimes` and
  `GlobalMemoryStatusEx`. The x64 offsets in the header comment were checked against this
  process's own row: pid, parent (`bash.exe`), name (`bun.exe`), CPU time within 2 ms of
  `process.cpuUsage()`, working set within 2 MB of `process.memoryUsage().rss`. Names are
  UTF-16LE inside the same buffer (`ImageName.Buffer` minus the buffer's base address), so
  nothing outside it is ever read.
- `linux.ts` — `/proc/stat` (busy = total − idle − iowait), `/proc/meminfo` (MemTotal −
  MemAvailable), `/proc/<pid>/stat` parsed after the last `)` (ppid field 4, utime 14,
  stime 15, rss 24 × 4096). Its own row checked the same way.
- `nvml.ts` — `nvmlInit_v2`, count, handle, name, `nvmlDeviceGetUtilizationRates`,
  `nvmlDeviceGetMemoryInfo`, `nvmlDeviceGetComputeRunningProcesses_v3` and the graphics
  twin with the 24-byte `nvmlProcessInfo_t`, grown on `NVML_ERROR_INSUFFICIENT_SIZE`.
- `_shared.ts` — the tree walk: sessions, then sidecars, the brain, the platform claim their
  subtrees, a claimed subtree never re-entered; per-process percent of all cores.
- `cost.ts` — one sample a second for 60 s (or any interval): wall ms per walk, JSON bytes of
  a trimmed sample, this process's own CPU share by `process.cpuUsage` (allowed here, never
  in the module), the idlest harness session beside it.
- `udp.ts` — `node:dgram` with `reuseAddr` and `setBroadcast(true)`: a listener on 4819
  answering queries, an ephemeral-port query to every interface's subnet broadcast plus
  `255.255.255.255`, and two listeners on one port in one process.

## Results

| Measure | Windows (780 processes) | WSL Ubuntu (45 processes) | Target |
|---|---|---|---|
| process walk | 11.8 ms median, 18.9 max (the kernel call; parsing is 0.3 ms) | 0.20 ms median | < 5 ms / < 15 ms |
| NVML sample | 0.9 ms median, 2–3 ms mean with occasional 20 ms | — | < 2 ms |
| trimmed sample (owned + top 10 others) | 1.24 KB | — | < 8 KB |
| own CPU at 1 s, whole process | 1.6 % median, 1.9 % mean of one core | — | < 1 % |
| own CPU at 15 s, whole process | 0.15–0.21 % (Bun's idle loop is most of it) | — | < 0.1 % |
| idle harness sessions, subtree over 5 s | Claude Code 0.6–0.9 % each, Codex 0.0 % | — | sampler below them |

The Windows walk misses the 5 ms target and the 1 s budget with it: the cost is the kernel
copying every thread's record, and it scales with the machine's thread count, not with what
cophylad does with the data. At the default view's 2 s subscription the sampler is ~0.8 % of
one core, level with one idle Claude Code session and under a working one by an order of
magnitude; at the 15 s idle rate it is noise. The module keeps the one-second floor from the
design and documents the cost.

Per-process VRAM: NVML lists 40 pids on the GPU here and reports `usedGpuMemory` as not
available for all of them, which is the documented WDDM behaviour; the bytes come through on
Linux and in TCC mode. The module records `vram` when a driver gives it and leaves it off
otherwise.

Discovery: two sockets bound to 4819 with `reuseAddr` in one process both received a query
broadcast to the subnet and a beacon to `255.255.255.255`, so two homes on one machine can
share the port. A query from WSL reached the Windows listener by broadcast through the WSL
vEthernet adapter (the host saw it from `172.17.140.137`, answered from `172.17.128.1`) and by
unicast to the host's LAN address (NAT'd, answered from `192.168.1.44`); a unicast to the
other Hyper-V adapter went nowhere. `Bun.udpSocket` was not used: it has broadcast but no
reuse option, and reuse is what lets two homes share the port.

## Not verified

macOS (`libproc`, `host_statistics64`): the engine is written from the headers and waits for
the Mac. Per-process VRAM on Linux with a real NVIDIA driver (WSL has none). A machine with
several GPUs. AMD and Intel GPUs have no NVML and are left out.
