// The daemon's end of the sign-in door's pipe: newline-delimited JSON-RPC over `node:net`, to
// the door's child behind the shim. The daemon attaches as it starts and holds the pipe for
// as long as it runs; while it does, the door never serves. `attach` hands the door the kit
// and answers once the door has stood down (its streams ended, its link to the primary left),
// with what the door holds for the daemon: a key the primary handed its grant, the grant's
// end, and the viewers that were watching. `kit` sends a newer kit, `forget` switches the
// door off, `status` asks where it stands, `update` has it look at the feed now. The door
// tells its state as it changes (`door.state`). No pipe (ENOENT) is no door: not installed,
// or its service stopped.
//
// A pipe name can be taken by anyone who creates it first, so before the kit, which holds the
// grant's key, goes anywhere, the pipe's server is checked to be the door's service process
// (`verifyDoorPipe`): the process the service manager says CophylaDoor runs as.

import { connect } from "node:net";
import type { Socket } from "node:net";
import { DoorState, RpcError } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import { RpcPeer } from "../rpc/peer.ts";
import { DOOR_PROTOCOL, DOOR_SERVICE } from "./constants.ts";
import type { Kit } from "./kit.ts";

/** What the door answers an attach with. */
export interface DoorAck {
  doorVersion: string;
  state: DoorState;
  /** The key the primary handed the node's grant while the door held its link. */
  rekeyed?: string;
  /** The primary ended the node's grant while the door held its link. */
  revoked?: true;
  /** The viewers whose streams the door ended as it stood down, as the node files them (`<from>:<viewer>`). */
  viewers?: string[];
}

export interface DoorClientDeps {
  pipe: string;
  log: Logger;
  /** Why the pipe's server is not the door's service, or undefined when it is; none for a test or a kit's console door. */
  verify?: (pipe: string) => Promise<string | undefined>;
  /** Opens the pipe; `node:net`'s `connect` without it. */
  open?: (pipe: string) => Socket;
  onState?: (s: DoorState) => void;
  onClose?: (reason: string) => void;
}

/** Lines longer than this from the door are dropped with the connection. */
const MAX_LINE = 1 << 20;

export class DoorClient {
  private deps: DoorClientDeps;
  private sock?: Socket;
  private rpc?: RpcPeer;

  constructor(deps: DoorClientDeps) {
    this.deps = deps;
  }

  get connected(): boolean {
    return this.rpc?.open === true;
  }

  /** Opens the pipe: false when there is none (no door here, or its service is stopped). */
  async connect(timeoutMs = 3000): Promise<boolean> {
    if (this.connected) return true;
    const refused = this.deps.verify ? await this.deps.verify(this.deps.pipe) : undefined;
    if (refused === "absent") return false;
    if (refused) throw new RpcError("denied", refused);
    const sock = (this.deps.open ?? connect)(this.deps.pipe);
    const opened = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new RpcError("timeout", "the sign-in door's pipe did not open"));
      }, timeoutMs);
      sock.once("connect", () => {
        clearTimeout(timer);
        resolve(true);
      });
      sock.once("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (e.code === "ENOENT") resolve(false);
        else reject(new RpcError("unavailable", `the sign-in door's pipe: ${e.message}`));
      });
    });
    if (!opened) return false;
    this.sock = sock;
    const rpc = new RpcPeer({
      write: (text) => {
        if (sock.destroyed) return false;
        sock.write(text + "\n");
        return true;
      },
      log: this.deps.log,
      label: "door",
      onNotification: (method, params) => {
        if (method !== "door.state") return;
        const parsed = DoorState.safeParse(params);
        if (parsed.success) this.deps.onState?.(parsed.data);
      },
    });
    this.rpc = rpc;
    let buffer = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE && !buffer.includes("\n")) {
        sock.destroy();
        return;
      }
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) rpc.onText(line);
      }
    });
    const gone = (reason: string) => {
      if (this.rpc !== rpc) return;
      this.rpc = undefined;
      this.sock = undefined;
      rpc.close(reason);
      this.deps.onClose?.(reason);
    };
    sock.on("error", (e) => gone(e.message));
    sock.on("close", () => gone("closed"));
    return true;
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const rpc = this.rpc;
    if (!rpc?.open) return Promise.reject(new RpcError("unavailable", "the sign-in door is not attached"));
    return rpc.request(method, params, { timeoutMs });
  }

  /** Attaches: the door stands down if it serves, takes the kit (none switches it off) and answers what it held. */
  async attach(kit: Kit | undefined, timeoutMs: number): Promise<DoorAck> {
    const r = (await this.request("door.attach", { protocol: DOOR_PROTOCOL, ...(kit ? { kit } : {}) }, timeoutMs)) as Partial<DoorAck>;
    const state = DoorState.safeParse(r.state);
    if (typeof r.doorVersion !== "string" || !state.success) throw new RpcError("invalid", "the sign-in door answered its attach with something else");
    return {
      doorVersion: r.doorVersion,
      state: state.data,
      ...(typeof r.rekeyed === "string" ? { rekeyed: r.rekeyed } : {}),
      ...(r.revoked === true ? { revoked: true as const } : {}),
      ...(Array.isArray(r.viewers) ? { viewers: r.viewers.filter((v): v is string => typeof v === "string") } : {}),
    };
  }

  async kit(kit: Kit): Promise<void> {
    await this.request("door.kit", { kit }, 10_000);
  }

  async forget(): Promise<void> {
    await this.request("door.forget", {}, 10_000);
  }

  async status(): Promise<DoorState> {
    return DoorState.parse(await this.request("door.status", {}, 5000));
  }

  async update(): Promise<void> {
    await this.request("door.update", {}, 10_000);
  }

  close(): void {
    const sock = this.sock;
    this.sock = undefined;
    this.rpc?.close("closed by the daemon");
    this.rpc = undefined;
    sock?.destroy();
  }
}

/**
 * Whether the pipe's server is the door's service process: `absent` when there is no pipe,
 * a reason when another process holds the name, undefined when it is the service's.
 */
export async function verifyDoorPipe(pipe: string): Promise<string | undefined> {
  const c = loadPipeCalls();
  if (!c) return "the sign-in door needs Windows";
  const server = c.serverPid(pipe);
  if (server === "absent") return "absent";
  if (server === undefined) return "the sign-in door's pipe could not be checked";
  const service = c.servicePid(DOOR_SERVICE);
  if (service === undefined || service === 0) return `the pipe is held by process ${server}, and the door's service is not running`;
  if (service !== server) return `the pipe is held by process ${server}, not the door's service (${service}): not trusted with this machine's membership`;
  return undefined;
}

interface PipeCalls {
  serverPid(pipe: string): number | "absent" | undefined;
  servicePid(name: string): number | undefined;
}

let pipeCalls: PipeCalls | null | undefined;

function wide(s: string): Uint16Array {
  const out = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function loadPipeCalls(): PipeCalls | null {
  if (pipeCalls !== undefined) return pipeCalls;
  if (process.platform !== "win32") return (pipeCalls = null);
  try {
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { FFIType } = ffi;
    const k = ffi.dlopen("kernel32.dll", {
      CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
      GetNamedPipeServerProcessId: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
      GetLastError: { args: [], returns: FFIType.u32 },
    }).symbols as unknown as {
      CreateFileW: (name: unknown, access: number, share: number, sa: unknown, disposition: number, flags: number, template: bigint) => bigint;
      GetNamedPipeServerProcessId: (h: bigint, out: unknown) => number;
      CloseHandle: (h: bigint) => number;
      GetLastError: () => number;
    };
    const a = ffi.dlopen("advapi32.dll", {
      OpenSCManagerW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u64 },
      OpenServiceW: { args: [FFIType.u64, FFIType.ptr, FFIType.u32], returns: FFIType.u64 },
      QueryServiceStatusEx: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      CloseServiceHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    }).symbols as unknown as {
      OpenSCManagerW: (machine: unknown, db: unknown, access: number) => bigint;
      OpenServiceW: (scm: bigint, name: unknown, access: number) => bigint;
      QueryServiceStatusEx: (svc: bigint, level: number, buf: unknown, size: number, needed: unknown) => number;
      CloseServiceHandle: (h: bigint) => number;
    };
    const ptr = ffi.ptr as unknown as (view: ArrayBufferView) => number;
    const INVALID = 0xffffffffffffffffn;
    const GENERIC_READ = 0x80000000;
    const OPEN_EXISTING = 3;
    const ERROR_FILE_NOT_FOUND = 2;
    pipeCalls = {
      serverPid: (pipe) => {
        const h = k.CreateFileW(ptr(wide(pipe)), GENERIC_READ, 0, null, OPEN_EXISTING, 0, 0n);
        if (h === INVALID || h === 0n) {
          // no pipe at all is no door; every instance taken, or anything else, cannot be checked now
          return k.GetLastError() === ERROR_FILE_NOT_FOUND ? "absent" : undefined;
        }
        try {
          const out = new Uint32Array(1);
          return k.GetNamedPipeServerProcessId(h, ptr(out)) ? out[0]! : undefined;
        } finally {
          k.CloseHandle(h);
        }
      },
      servicePid: (name) => {
        const scm = a.OpenSCManagerW(null, null, 0x0001);
        if (scm === 0n) return undefined;
        try {
          const svc = a.OpenServiceW(scm, ptr(wide(name)), 0x0004);
          if (svc === 0n) return undefined;
          try {
            // SERVICE_STATUS_PROCESS: nine DWORDs, the process id the eighth
            const buf = new Uint32Array(9);
            const needed = new Uint32Array(1);
            if (!a.QueryServiceStatusEx(svc, 0, ptr(buf), 36, ptr(needed))) return undefined;
            return buf[7]!;
          } finally {
            a.CloseServiceHandle(svc);
          }
        } finally {
          a.CloseServiceHandle(scm);
        }
      },
    };
  } catch {
    pipeCalls = null;
  }
  return pipeCalls;
}
