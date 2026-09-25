// A release feed on loopback: one signed file per channel and target, the artifacts beside
// it, and a record of every request, so a test can check that the daemon asked for exactly
// `<channel>/<os>-<arch>.json` and nothing else. The key is made once per process and is the
// one the daemon is told to trust.

import { createHash, generateKeyPairSync } from "node:crypto";
import { releaseFileName } from "@cophyla/protocol";
import type { Release } from "@cophyla/protocol";
import { hostTarget } from "../../src/update/feed.ts";
import { signRelease } from "../../src/update/verify.ts";

export const { os: OS, arch: ARCH } = hostTarget();

export function keyPair(): { pem: string; pub: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }) as string, pub: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

/** The release key the tests sign with; the daemon is started with its public half. */
export const KEY: { pem: string; pub: string } = keyPair();

export interface Seen {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FakeFeed {
  readonly seen: Seen[] = [];
  body: unknown = { releases: [] };
  artifacts = new Map<string, Uint8Array>();
  delayMs = 0;
  inFlight = 0;
  maxInFlight = 0;
  private server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
        this.seen.push({ method: req.method, path: url.pathname, search: url.search, headers });
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        try {
          if (this.delayMs > 0) await sleep(this.delayMs);
          if (url.pathname === `/stable/${OS}-${ARCH}.json`) return Response.json(this.body);
          const m = /^\/artifacts\/(.+)$/.exec(url.pathname);
          if (m) {
            const bytes = this.artifacts.get(decodeURIComponent(m[1]!));
            if (bytes) return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
          }
          return new Response("not found", { status: 404 });
        } finally {
          this.inFlight--;
        }
      },
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /**
   * A signed entry for `bytes`. `name` is the entry's own: a file name for a platform or a
   * brain, the model's name for a model, whose file name the protocol derives from it. A
   * model carries no OS or architecture; everything else carries this host's.
   */
  async entry(component: Release["component"], version: string, name: string, bytes: Uint8Array, over: Partial<Release> = {}): Promise<Release> {
    const file = releaseFileName({ component, version, name, os: OS as Release["os"], arch: ARCH });
    this.artifacts.set(file, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const target = component === "model" ? {} : { os: OS, arch: ARCH, protocol: { min: 1, max: 1 } };
    return signRelease(
      {
        component,
        name,
        version,
        channel: "stable",
        ...target,
        url: `${this.url}/artifacts/${file}`,
        size: bytes.byteLength,
        sha256,
        publishedAt: 1758196800000,
        ...over,
      } as Omit<Release, "signature">,
      KEY.pem,
    );
  }

  async stop(): Promise<void> {
    await this.server.stop(true);
  }
}
