// The `server` route of `llm.complete`: the request sent to the server unchanged (the tier is
// the server's to resolve), `llm.delta` frames streamed back as the provider's own deltas, an
// abort turned into `cancel {id}` over the link, the usage counted locally. A `quota_exceeded`
// from the server passes through with its `{metric, resetsAt}`, so the route walk can move on
// and the brain can tell the user when the allowance returns.

import { LlmResult, RpcError } from "@cophyla/protocol";
import type { LlmDelta } from "@cophyla/protocol";
import type { Provider, ProviderRequest } from "../llm/index.ts";
import type { HostedDeps } from "./hosted.ts";

export class ServerProvider implements Provider {
  readonly vendor = "server";
  private deps: HostedDeps;

  constructor(deps: HostedDeps) {
    this.deps = deps;
  }

  async complete(req: ProviderRequest): Promise<LlmResult> {
    const refused = this.deps.allowed("llm");
    if (refused) throw refused;
    if (req.signal?.aborted) throw new RpcError("cancelled", "cancelled");
    const raw = await this.deps.link.requestCancellable("llm.complete", req.params, {
      ...(req.signal ? { signal: req.signal } : {}),
      onNotice: (method, params) => {
        if (method !== "llm.delta") return;
        const delta = (params as { delta?: LlmDelta }).delta;
        if (delta) req.onDelta?.(delta);
      },
    });
    const parsed = LlmResult.safeParse(raw);
    if (!parsed.success) throw new RpcError("unavailable", "the server's answer was not a completion", { provider: "server" });
    this.deps.usage.add("llm_tokens_in", parsed.data.usage.in);
    this.deps.usage.add("llm_tokens_out", parsed.data.usage.out);
    return parsed.data;
  }
}
