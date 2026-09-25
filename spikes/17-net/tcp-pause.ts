// Can cophylad hold back a loopback TCP connection's reads while the far end of a pipe has no
// credit, and does the writer then see backpressure? A server streams 64 MB; the client
// pauses after the first megabyte, counts what still arrives in half a second, resumes, and
// takes the rest. The server's `write` return and `drain` show its side.
//   bun tcp-pause.ts

const TOTAL = 64 * 1024 * 1024;
const CHUNK = new Uint8Array(64 * 1024).fill(7);
let serverWritten = 0;
let serverShortWrites = 0;
let serverDrains = 0;

const server = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open(s) {
      const pump = () => {
        while (serverWritten < TOTAL) {
          const n = s.write(CHUNK);
          serverWritten += n;
          if (n < CHUNK.length) {
            serverShortWrites++;
            return;
          }
        }
        s.end();
      };
      (s as unknown as { pump: () => void }).pump = pump;
      pump();
    },
    drain(s) {
      serverDrains++;
      (s as unknown as { pump: () => void }).pump();
    },
    data() {},
  },
});

let got = 0;
let whilePaused = 0;
let paused = false;
const done = Promise.withResolvers<void>();
const t0 = performance.now();
const client = await Bun.connect({
  hostname: "127.0.0.1",
  port: server.port,
  socket: {
    data(s, d) {
      got += d.length;
      if (paused) whilePaused += d.length;
      if (!paused && got >= 1024 * 1024 && whilePaused === 0 && got < 2 * 1024 * 1024) {
        paused = true;
        (s as unknown as { pause(): void }).pause();
        setTimeout(() => {
          console.log(JSON.stringify({ at: "paused 500 ms", got, arrivedWhilePaused: whilePaused, serverWritten, serverShortWrites }));
          paused = false;
          (s as unknown as { resume(): void }).resume();
        }, 500);
      }
    },
    close() {
      done.resolve();
    },
    end() {
      done.resolve();
    },
  },
});
void client;
await done.promise;
console.log(JSON.stringify({ got, total: TOTAL, ms: Math.round(performance.now() - t0), serverShortWrites, serverDrains, pauseResume: typeof (client as unknown as { pause?: unknown }).pause === "function" }));
server.stop(true);
