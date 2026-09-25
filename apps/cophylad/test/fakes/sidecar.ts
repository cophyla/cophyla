// A stand-in for a sidecar: an HTTP server on the port it was given, answering `/health`
// once it is warm. The environment drives what it does, so one script covers every case the
// supervisor has to handle.
//
//   FAKE_SIDECAR_WARM_MS   milliseconds before /health starts answering (default 0)
//   FAKE_SIDECAR_EXIT_MS   exit this long after starting, with FAKE_SIDECAR_EXIT_CODE (default: never)
//   FAKE_SIDECAR_SICK_MS   stop answering /health this long after becoming warm
//   FAKE_SIDECAR_DEAF      never answer /health at all
//   FAKE_SIDECAR_LOG       a line to write to stdout at start, so the log file can be checked
//   FAKE_SIDECAR_IGNORE_TERM  keep running when killed politely, so the hard kill is exercised

const arg = (name: string): string | undefined => {
  const i = Bun.argv.indexOf(name);
  return i >= 0 ? Bun.argv[i + 1] : undefined;
};

const port = Number(arg("--port") ?? 0);
const host = arg("--host") ?? "127.0.0.1";
const num = (name: string): number | undefined => {
  const v = process.env[name];
  return v === undefined ? undefined : Number(v);
};

const warmMs = num("FAKE_SIDECAR_WARM_MS") ?? 0;
const exitMs = num("FAKE_SIDECAR_EXIT_MS");
const sickMs = num("FAKE_SIDECAR_SICK_MS");
const deaf = process.env["FAKE_SIDECAR_DEAF"] === "1";
const started = Date.now();

if (process.env["FAKE_SIDECAR_LOG"]) console.log(process.env["FAKE_SIDECAR_LOG"]);
console.log(`fake sidecar on ${host}:${port}`);

if (process.env["FAKE_SIDECAR_IGNORE_TERM"] === "1") {
  process.on("SIGTERM", () => console.log("ignoring SIGTERM"));
  process.on("SIGINT", () => console.log("ignoring SIGINT"));
}

const server = Bun.serve({
  hostname: host,
  port,
  fetch(req) {
    const url = new URL(req.url);
    const age = Date.now() - started;
    if (url.pathname === "/health") {
      if (deaf || age < warmMs) return new Response("warming", { status: 503 });
      if (sickMs !== undefined && age > warmMs + sickMs) return new Response("sick", { status: 500 });
      return Response.json({ ok: true, port });
    }
    if (url.pathname === "/v1/audio/speech") {
      // 100 ms of a ramp at 24 kHz, as the speech sidecar would stream it.
      const pcm = new Int16Array(2400);
      for (let i = 0; i < pcm.length; i++) pcm[i] = ((i * 7) % 2000) - 1000;
      return new Response(pcm, { headers: { "content-type": "audio/pcm", "x-sample-rate": "24000" } });
    }
    return new Response("not found", { status: 404 });
  },
});
void server;

if (exitMs !== undefined) {
  setTimeout(() => {
    console.log("exiting on purpose");
    process.exit(num("FAKE_SIDECAR_EXIT_CODE") ?? 7);
  }, exitMs);
}
