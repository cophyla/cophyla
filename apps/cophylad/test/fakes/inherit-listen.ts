// A process that listens, starts a child through `node:child_process` (which goes through
// `Bun.spawn`), stops listening while the child runs, and says whether its port still takes a
// connection: `held` when the child kept the socket it inherited, `free` when it is refused.
// `bun run inherit-listen.ts <guard: 0|1>`; prints one JSON line.
import { spawn } from "node:child_process";
import { guardSpawns } from "../../src/inherit.ts";

const guard = Bun.argv[2] === "1";
if (guard) guardSpawns();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
const port = server.port;
const child = spawn("ping", ["-n", "30", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
await Bun.sleep(300);
server.stop(true);
await Bun.sleep(300);
const verdict = await new Promise<"held" | "free">((ok) => {
  const timer = setTimeout(() => ok("held"), 2000);
  Bun.connect({
    hostname: "127.0.0.1",
    port: port!,
    socket: {
      open(s) {
        clearTimeout(timer);
        s.end();
        ok("held");
      },
      data() {},
      connectError() {
        clearTimeout(timer);
        ok("free");
      },
    },
  }).catch(() => {
    clearTimeout(timer);
    ok("free");
  });
});
child.kill();
console.log(JSON.stringify({ guard, port, verdict }));
process.exit(0);
