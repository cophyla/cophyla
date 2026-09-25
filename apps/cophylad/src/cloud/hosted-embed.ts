// The `server` route of the recall index's embedder: `compute.embed` over the link, the
// vectors normalised here and checked against the width the probe reported before the queue
// writes any of them. The model is named `server:<vendor model>`, so a node that moves
// between the local model and the hosted one re-embeds into a new space rather than mixing
// two. A `quota_exceeded` is remembered until its reset: the queue stops on the throw and
// nothing is asked of the server until the allowance is back. A link that is down throws
// `unavailable`, which stops the queue until the next write or link-up kicks it; recall
// itself stays on the full-text leg for that query.

import { RpcError } from "@cophyla/protocol";
import type { Embedder } from "../store/index/embed.ts";
import { normalise } from "../store/index/embed.ts";
import type { HostedDeps } from "./hosted.ts";

export const EMBED_TIMEOUT_MS = 60_000;
/** The text the probe sends when the server names no width. */
const PROBE_TEXT = "cophyla";

export class ServerEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  private deps: HostedDeps;
  private now: () => number;
  /** Until when a `quota_exceeded` holds every call back. */
  private holdUntil = 0;

  constructor(deps: HostedDeps, model: string, dim: number, now: () => number = Date.now) {
    this.deps = deps;
    this.model = `server:${model}`;
    this.dim = dim;
    this.now = now;
  }

  /** When the hosted allowance returns, while a `quota_exceeded` holds. */
  get heldUntil(): number | undefined {
    return this.now() < this.holdUntil ? this.holdUntil : undefined;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (this.now() < this.holdUntil) throw new RpcError("quota_exceeded", `the plan's embed_tokens allowance is used up until ${new Date(this.holdUntil).toISOString()}`, { metric: "embed_tokens", resetsAt: this.holdUntil });
    const refused = this.deps.allowed("compute");
    if (refused) throw refused;
    let raw: unknown;
    try {
      raw = await this.deps.link.request("compute.embed", { texts }, { timeoutMs: EMBED_TIMEOUT_MS });
    } catch (e) {
      if (e instanceof RpcError && e.code === "quota_exceeded") {
        const resetsAt = (e.error.data as { resetsAt?: unknown } | undefined)?.resetsAt;
        if (typeof resetsAt === "number" && resetsAt > this.now()) this.holdUntil = resetsAt;
        this.deps.log.warn("hosted embeddings held: the allowance is used up", { resetsAt: this.holdUntil || null });
      }
      throw e;
    }
    const r = raw as { vectors?: unknown } | undefined;
    const vectors = r?.vectors;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new RpcError("unavailable", `the server answered ${Array.isArray(vectors) ? vectors.length : 0} vectors for ${texts.length} texts`, { provider: "server" });
    const out: Float32Array[] = [];
    for (const v of vectors) {
      if (!Array.isArray(v) || v.length !== this.dim) throw new RpcError("unavailable", `the server answered a vector of ${Array.isArray(v) ? v.length : "no"} dims for a ${this.dim}-dim index`, { provider: "server" });
      out.push(normalise(Float32Array.from(v as number[])));
    }
    this.deps.usage.add("embed_tokens", Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4));
    return out;
  }

  async close(): Promise<void> {
    // nothing held open: the link is the cloud module's
  }
}

/** Asks the server which model it embeds with and how wide: one `compute.embed` with no texts, or one word when the answer names no width. */
export async function probeServerEmbedder(deps: HostedDeps, now: () => number = Date.now): Promise<ServerEmbedder> {
  const refused = deps.allowed("compute");
  if (refused) throw refused;
  const r = (await deps.link.request("compute.embed", { texts: [] }, { timeoutMs: EMBED_TIMEOUT_MS })) as { model?: unknown; dim?: unknown } | undefined;
  if (typeof r?.model !== "string" || !r.model) throw new RpcError("unavailable", "the server named no embedding model", { provider: "server" });
  let dim = typeof r.dim === "number" && r.dim > 0 ? r.dim : undefined;
  if (dim === undefined) {
    const one = (await deps.link.request("compute.embed", { texts: [PROBE_TEXT] }, { timeoutMs: EMBED_TIMEOUT_MS })) as { vectors?: unknown[][] } | undefined;
    const v = one?.vectors?.[0];
    if (!Array.isArray(v) || v.length === 0) throw new RpcError("unavailable", "the server's probe answered no vector", { provider: "server" });
    dim = v.length;
  }
  return new ServerEmbedder(deps, r.model, dim, now);
}
