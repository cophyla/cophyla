// Serves the staged feed and artifacts on the LAN, for a clean machine (the Windows
// Sandbox) that cannot reach the public feed yet: `/<channel>/<os>-<arch>.json` from
// `stage/feed` with every `url` rewritten to this server's `/artifacts/<name>`, which serves
// the file from `stage/out`. Logs every request, so the acceptance run can read what the
// daemon asked for. `--only` limits the served entries, to stage the feed's growth.
//   bun run apps/installer/scripts/serve-feed.ts [--dir stage/feed] [--artifacts stage/out] [--host 0.0.0.0] [--port 8790] [--only platform@0.1.0,model/tts-kokoro-en@1.0.0]

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { releaseFileName, ReleaseFeed } from "@cophyla/protocol";
import { releaseKey } from "./feed.ts";
import { fail, FEED_DIR, log, OUT } from "./lib.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    dir: { type: "string" },
    artifacts: { type: "string" },
    host: { type: "string", default: "0.0.0.0" },
    port: { type: "string", default: "8790" },
    only: { type: "string" },
  },
  strict: true,
});
const root = values.dir ?? FEED_DIR;
const artifacts = values.artifacts ?? OUT;
if (!existsSync(root)) fail(`no feed at ${root}; run feed.ts --add first`);
const only = values.only ? new Set(values.only.split(",").map((s) => s.trim())) : undefined;

const server = Bun.serve({
  hostname: values.host,
  port: Number(values.port),
  fetch(req) {
    const url = new URL(req.url);
    const stamp = new Date().toISOString();
    const extra = [...req.headers.keys()].filter((h) => !["host", "accept", "accept-encoding", "user-agent", "connection", "accept-language"].includes(h));
    log(`${stamp} ${req.method} ${url.pathname}${url.search}${extra.length ? `  headers: ${extra.join(", ")}` : ""}`);
    const feed = /^\/([a-z]+)\/([a-z]+-[a-z0-9]+)\.json$/.exec(url.pathname);
    if (feed) {
      const path = join(root, feed[1]!, `${feed[2]}.json`);
      if (!existsSync(path)) return new Response("no such feed", { status: 404 });
      const parsed = ReleaseFeed.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (!parsed.success) return new Response("feed invalid", { status: 500 });
      const base = `http://${req.headers.get("host") ?? `${values.host}:${values.port}`}/artifacts`;
      const releases = parsed.data.releases
        // `name` is the artifact for a platform or a brain and the model's own for a model,
        // so the served URL is always what the feed calls the file.
        .filter((r) => !only || only.has(releaseKey(r)))
        .map((r) => ({ ...r, url: `${base}/${encodeURIComponent(releaseFileName(r))}` }));
      return Response.json({ ...parsed.data, releases });
    }
    const artifact = /^\/artifacts\/([^/]+)$/.exec(url.pathname);
    if (artifact) {
      const file = Bun.file(join(artifacts, decodeURIComponent(artifact[1]!)));
      return file.size > 0 ? new Response(file) : new Response("no such artifact", { status: 404 });
    }
    return new Response("cophyla feed: /<channel>/<os>-<arch>.json, /artifacts/<name>", { status: 404 });
  },
});
log(`feed ${root} on http://${server.hostname}:${server.port}  (artifacts from ${artifacts}${only ? `; only ${[...only].join(", ")}` : ""})`);
