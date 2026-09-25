// Stands in for cophylad's client protocol over loopback: the only channel a view is
// supposed to have. Both the host page and the view page POST their findings here.
import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";

const OUT = new URL("./out/", import.meta.url);
mkdirSync(OUT, { recursive: true });
const FILE = new URL("./web.jsonl", OUT);

const server = createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.url === "/ping") return res.writeHead(200).end("pong");

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const line = JSON.stringify({ at: new Date().toISOString(), body: safe(body) });
    appendFileSync(FILE, line + "\n");
    console.log(line);
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
});

function safe(s) {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
}

server.listen(8777, "127.0.0.1", () => console.log("collector on 127.0.0.1:8777"));
