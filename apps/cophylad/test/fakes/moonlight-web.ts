// A stand-in for the moonlight-web sidecar, run by the daemon's own runtime as
// `bun moonlight-web.ts --bind-address 127.0.0.1:<port> --path-prefix /remote
// --forwarded-header x-cophyla-user … run`; like the real binary it refuses an option after the
// subcommand, exiting 2. It serves what the proxy tests need: the page under
// the prefix, `/api/*` refusing a request without the login header, `POST /api/host`,
// `GET /api/host`, `POST /api/pair` streaming a PIN line then the paired host, `GET /api/apps`,
// `DELETE /api/host`, and the stream WebSocket at `/api/host/stream/web_socket` echoing
// every frame back with the user header's value prefixed to text frames; for the tests,
// `/api/argv` answers its arguments and `/api/blob?bytes=n` a body of n patterned bytes. Its
// state is in memory; `print-config` prints a default config like the real binary.

export {};

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] === "print-config") {
  console.log(JSON.stringify({ web_server: { bind_address: "0.0.0.0:8080", url_path_prefix: "" }, webrtc: { port_range: null } }, null, 2));
  process.exit(0);
}

// The real binary's options belong to the program, so one after `run` is an error.
const runAt = args.indexOf("run");
if (runAt >= 0 && runAt < args.length - 1) {
  console.error(`error: unexpected argument '${args[runAt + 1]}' found`);
  process.exit(2);
}

const bind = opt("--bind-address") ?? "127.0.0.1:0";
const [host, portText] = bind.split(":");
const prefix = opt("--path-prefix") ?? "";
const header = (opt("--forwarded-header") ?? "x-forwarded-user").toLowerCase();

interface Host {
  host_id: number;
  address: string;
  http_port: number;
  paired: "Paired" | "NotPaired";
  name: string;
}
const hosts = new Map<number, Host>();
let nextId = 364422421;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Bun.serve<{ user: string }>({
  hostname: host,
  port: Number(portText),
  async fetch(req, server) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(prefix + "/") && url.pathname !== prefix + "/") return new Response("not found", { status: 404 });
    const path = url.pathname.slice(prefix.length);
    if (path === "/" || path === "/index.html") return new Response("<!doctype html><title>Moonlight Web</title><h1>hosts</h1>", { headers: { "content-type": "text/html; charset=utf-8" } });
    if (path === "/stream.html") return new Response(`<!doctype html><title>Stream: Desktop</title><video></video><script>/* stream ${url.search} */</script>`, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (!path.startsWith("/api/")) return new Response("not found", { status: 404 });
    const user = req.headers.get(header);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (path === "/api/host/stream/web_socket") {
      if (server.upgrade(req, { data: { user } })) return undefined;
      return new Response("expected a websocket", { status: 426 });
    }
    if (path === "/api/authenticate") return new Response("", { status: 200 });
    if (path === "/api/user") return json({ id: 1, name: user, role: "User" });
    // the fake's own, for the tests: how it was started, and a body of a given size
    if (path === "/api/argv") return json(args);
    if (path === "/api/blob") {
      const n = Number(url.searchParams.get("bytes") ?? "0");
      const body = new Uint8Array(n);
      for (let i = 0; i < n; i++) body[i] = (i * 31 + 7) & 0xff;
      return new Response(body, { headers: { "content-type": "application/octet-stream" } });
    }
    if (path === "/api/host" && req.method === "POST") {
      const body = (await req.json()) as { address: string; http_port?: number };
      const h: Host = { host_id: nextId++, address: body.address, http_port: body.http_port ?? 47989, paired: "NotPaired", name: "FAKE-HOST" };
      hosts.set(h.host_id, h);
      return json({ host: h });
    }
    if (path === "/api/host" && req.method === "GET") {
      const h = hosts.get(Number(url.searchParams.get("host_id")));
      return h ? json({ host: h }) : json({ error: "no host" }, 404);
    }
    if (path === "/api/host" && req.method === "DELETE") {
      hosts.delete(Number(url.searchParams.get("host_id")));
      return new Response("", { status: 200 });
    }
    if (path === "/api/hosts") return new Response(JSON.stringify({ hosts: [...hosts.values()] }) + "\n", { headers: { "content-type": "application/json" } });
    if (path === "/api/pair" && req.method === "POST") {
      const body = (await req.json()) as { host_id: number };
      const h = hosts.get(body.host_id);
      if (!h) return json({ error: "no host" }, 404);
      const pin = String(1000 + Math.floor(Math.random() * 9000));
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ Pin: pin }) + "\n"));
          // The real sidecar answers once the host accepted the PIN; the daemon posts it there while this waits.
          await Bun.sleep(300);
          h.paired = "Paired";
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ Paired: h }) + "\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "application/json" } });
    }
    if (path === "/api/apps") {
      const h = hosts.get(Number(url.searchParams.get("host_id")));
      if (!h) return json({ error: "no host" }, 404);
      return json({ apps: [{ app_id: 881448767, title: "Desktop", is_hdr_supported: true }, { app_id: 1093255277, title: "Steam Big Picture", is_hdr_supported: true }] });
    }
    return json({ error: "not found" }, 404);
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ hello: ws.data.user }));
    },
    message(ws, msg) {
      if (typeof msg === "string") ws.send(`${ws.data.user}:${msg}`);
      else ws.send(msg);
    },
  },
});
