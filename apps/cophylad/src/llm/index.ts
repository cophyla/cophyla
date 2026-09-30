// `llm.complete` routing. The brain asks for a tier or a `vendor/model`; config maps a tier
// to a vendor and model with its thinking level, which a request's own `thinking` overrides,
// and `[providers].llm` lists the routes in order: `server` (the account's hosted model, the
// request sent as is for the server to resolve), `byok:<vendor>` with the user's own key,
// `local:<engine>` in a later milestone.
// A route that cannot serve — `unavailable` (no key, not signed in, the link down, the vendor
// throttled) or `quota_exceeded` — passes the call to the next; any other failure is the
// answer. When every route refused, a `quota_exceeded` among the refusals is raised over a
// later `unavailable` (it says why and until when; a missing key behind it says nothing the
// user can act on now), else the last one, each with every route's reason in its data.
// Providers stream deltas and return the whole completion; a route that fails after it had
// streamed some tells the caller through `onRetry` before the next one starts.

import { RpcError } from "@cophyla/protocol";
import type { ErrorCode, LlmComplete, LlmDelta, LlmResult, ModelRef } from "@cophyla/protocol";
import type { ProvidersConfig, TierConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";
import { GeminiProvider } from "./gemini.ts";

export interface CompleteOptions {
  onDelta?: (delta: LlmDelta) => void;
  /** A later route takes over after an earlier one had sent deltas: what they said is void. */
  onRetry?: () => void;
  signal?: AbortSignal;
}

export interface ProviderRequest {
  /** The vendor's own model name; for the server route, the tier or model the brain named. */
  model: string;
  thinking?: TierConfig["thinking"];
  params: LlmComplete;
  onDelta?: (delta: LlmDelta) => void;
  signal?: AbortSignal;
}

export interface Provider {
  /** The vendor behind a `byok:<vendor>` route, or `server`. */
  readonly vendor: string;
  complete(req: ProviderRequest): Promise<LlmResult>;
}

/** A completion and the route that served it. */
export interface RoutedResult extends LlmResult {
  route: string;
}

/** One route's refusal, carried in the data of the error raised when every route refused. */
export interface RouteFailure {
  route: string;
  code: ErrorCode;
  message: string;
}

export interface LlmDeps {
  config: ProvidersConfig;
  log: Logger;
  env?: Record<string, string | undefined>;
  /** The Gemini key at each call, typed in the app over config.toml's and the environment's; those two when absent. */
  geminiKey?: () => string | undefined;
  /** Replaces the vendor providers, for tests. */
  providers?: Provider[];
}

export interface Resolved {
  vendor: string;
  model: string;
  thinking?: TierConfig["thinking"];
}

/** The codes that hand a call to the next route. */
const PASS_ON = new Set<ErrorCode>(["unavailable", "quota_exceeded"]);

export class Llm {
  private deps: LlmDeps;
  private providers = new Map<string, Provider>();

  constructor(deps: LlmDeps) {
    this.deps = deps;
    const env = deps.env ?? process.env;
    const list = deps.providers ?? [
      new GeminiProvider({
        apiKey: deps.geminiKey ?? (() => deps.config.gemini.api_key ?? env["GEMINI_API_KEY"]),
        baseUrl: deps.config.gemini.base_url,
        timeoutMs: deps.config.timeout_ms,
        log: deps.log.child("gemini"),
      }),
    ];
    for (const p of list) this.providers.set(p.vendor, p);
  }

  /** The routes in order, as configured. */
  get routes(): string[] {
    return this.deps.config.llm;
  }

  /** The vendor and model a reference names. */
  resolve(ref: ModelRef): Resolved {
    if ("model" in ref) {
      const slash = ref.model.indexOf("/");
      return { vendor: ref.model.slice(0, slash), model: ref.model.slice(slash + 1) };
    }
    const tier = this.deps.config.tiers[ref.tier];
    if (!tier) throw new RpcError("unavailable", `no model configured for the ${ref.tier} tier`, { provider: ref.tier });
    const slash = tier.model.indexOf("/");
    const out: Resolved = { vendor: tier.model.slice(0, slash), model: tier.model.slice(slash + 1) };
    if (tier.thinking) out.thinking = tier.thinking;
    return out;
  }

  private serve(route: string, params: LlmComplete, opts: CompleteOptions): Promise<LlmResult> {
    const req: ProviderRequest = { model: "", params };
    if (opts.onDelta) req.onDelta = opts.onDelta;
    if (opts.signal) req.signal = opts.signal;
    if (route === "server") {
      // The server has no local tier: a request for one passes on to the routes that might.
      if ("tier" in params.model && params.model.tier === "local") throw new RpcError("unavailable", "the server route has no local tier", { provider: "server" });
      const provider = this.providers.get("server");
      if (!provider) throw new RpcError("unavailable", "the server route has no provider on this node", { provider: "server" });
      req.model = "tier" in params.model ? params.model.tier : params.model.model;
      return provider.complete(req);
    }
    if (route.startsWith("local:")) throw new RpcError("unavailable", `the ${route} route is not available yet`, { provider: route });
    const vendor = route.slice("byok:".length);
    const resolved = this.resolve(params.model);
    if (vendor !== resolved.vendor) throw new RpcError("unavailable", `${resolved.vendor}/${resolved.model} is not served by the ${route} route`, { provider: route });
    const provider = this.providers.get(vendor);
    if (!provider) throw new RpcError("unavailable", `no provider for ${vendor}`, { provider: route });
    req.model = resolved.model;
    // The request's own level over the tier's.
    const thinking = params.thinking ?? resolved.thinking;
    if (thinking) req.thinking = thinking;
    return provider.complete(req);
  }

  async complete(params: LlmComplete, opts: CompleteOptions = {}): Promise<RoutedResult> {
    const failures: RouteFailure[] = [];
    let last: RpcError | undefined;
    let quota: RpcError | undefined;
    let sent = false;
    const onDelta = opts.onDelta;
    const served: CompleteOptions = onDelta
      ? {
          ...opts,
          onDelta: (delta) => {
            sent = true;
            onDelta(delta);
          },
        }
      : opts;
    for (const route of this.routes) {
      if (opts.signal?.aborted) throw new RpcError("cancelled", "cancelled");
      if (sent) {
        sent = false;
        opts.onRetry?.();
      }
      try {
        const r = await this.serve(route, params, served);
        return { ...r, route };
      } catch (e) {
        const err = e instanceof RpcError ? e : new RpcError("unavailable", e instanceof Error ? e.message : String(e), { provider: route });
        if (!PASS_ON.has(err.code)) throw err;
        failures.push({ route, code: err.code, message: err.message });
        last = err;
        if (err.code === "quota_exceeded" && !quota) quota = err;
        this.deps.log.info("route passed the call on", { route, code: err.code, message: err.message });
      }
    }
    if (!last) throw new RpcError("unavailable", "no llm route is configured", { routes: failures });
    const raised = quota ?? last;
    const data = raised.error.data !== null && typeof raised.error.data === "object" ? (raised.error.data as Record<string, unknown>) : {};
    throw new RpcError(raised.code, raised.message, { ...data, routes: failures });
  }
}
