// A daemon that dies leaving a helper holding its port, as on 2026-10-07: listens on the port,
// starts `exe` detached (outside its job, as a native sidecar's stream worker is) without the
// spawn guard, so the helper inherits the listening socket, then exits.
// `bun run orphan-holder.ts <port> <exe>`; prints `helper <pid>`.
import { spawn } from "node:child_process";

const port = Number(Bun.argv[2]);
const exe = Bun.argv[3]!;
Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
const child = spawn(exe, ["-n", "60", "127.0.0.1"], { stdio: "ignore", detached: true, windowsHide: true });
child.unref();
console.log(`helper ${child.pid}`);
await Bun.sleep(300);
process.exit(0);
