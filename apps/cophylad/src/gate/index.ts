// The gate. Every request from a client, the brain or a peer node passes through `run`:
// policy decides allow, deny or ask; ask opens an Ask and holds the request until someone
// answers; the request, the decision and the result land in the audit table.

import { actionDefinition, RpcError } from "@cophyla/protocol";
import type { AuditEntry, Ask, Principal, RiskClass } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import type { GateConfig } from "../config/schema.ts";
import type { Asks } from "./asks.ts";
import type { Audit } from "./audit.ts";
import type { Policy } from "./policy.ts";
import { redact } from "./audit.ts";

export interface GateRequest {
  principal: Principal;
  /** The client the request came through, when it did. */
  via?: string;
  action: string;
  /** What the action is on: a tool name, a session id. Rules can key on it. */
  target?: string;
  args: unknown;
  /** Overrides the action's static risk, as `tool.run` does with the tool's own. */
  risk?: RiskClass;
  thread?: string;
  task?: string;
  correlation?: string;
  /** Scopes `remember: session` answers. */
  sessionKey?: string;
  /** Words for the ask, when the defaults are not good enough. */
  ask?: { title?: string; detail?: string };
  /** The request is on something the principal started itself; built-in rules may allow it. */
  own?: boolean;
  /** The request lets a session do more unasked than asking before each edit; no built-in rule allows it. */
  loosens?: boolean;
  /** The principal is this node's own primary, let work here unasked at the join: an ask by class default is an allow. */
  trusted?: boolean;
  /** The result as the audit row keeps it, when it carries a secret the generic redaction would miss. */
  redactResult?: (result: unknown) => unknown;
}

export interface GateContext {
  audit: AuditEntry;
}

export interface RunOptions {
  /** Called when the request is held on an ask, so a brain can be told `pending`. */
  onPending?: (ask: Ask, audit: AuditEntry) => void;
  /** Withdraws the request while it is held. */
  signal?: AbortSignal;
}

export interface GateDeps {
  config: GateConfig;
  policy: Policy;
  asks: Asks;
  audit: Audit;
  log: Logger;
  /** The node this gate decides for: a workspace node's gate stamps its asks and audit rows with its own id; the machine's otherwise. */
  node?: string;
}

const DETAIL_CHARS = 2000;

function principalLabel(p: Principal): string {
  switch (p.kind) {
    case "user":
      return "a client";
    case "brain":
      return "the brain";
    case "node":
      return `node ${p.id}`;
    case "harness":
      return `session ${p.session}`;
    case "system":
      return "the daemon";
  }
}

export class Gate {
  private deps: GateDeps;

  constructor(deps: GateDeps) {
    this.deps = deps;
  }

  async run<T>(req: GateRequest, handler: (ctx: GateContext) => Promise<T> | T, opts: RunOptions = {}): Promise<T> {
    const { policy, asks, audit, log, config } = this.deps;
    const def = actionDefinition(req.action);
    const risk = req.risk ?? def?.risk;
    if (risk === undefined) throw new RpcError("unsupported", `unknown action ${req.action}`);

    const query = {
      principal: req.principal.kind,
      action: req.action,
      risk,
      ...(req.target !== undefined ? { target: req.target } : {}),
      ...(def?.control ? { control: true } : {}),
      ...(req.sessionKey !== undefined ? { sessionKey: req.sessionKey } : {}),
      ...(req.own ? { own: true } : {}),
      ...(req.loosens ? { loosens: true } : {}),
      ...(req.trusted ? { trusted: true } : {}),
    };
    const verdict = policy.decide(query);
    const startedAt = Date.now();

    let ask: Ask | undefined;
    if (verdict.decision === "ask") {
      const detail = req.ask?.detail ?? JSON.stringify(redact(req.args), null, 2);
      ask = asks.open({
        type: "permission",
        source: { kind: "gate", action: req.action, principal: req.principal },
        title: req.ask?.title ?? `Allow ${principalLabel(req.principal)} to ${req.action}${req.target ? ` on ${req.target}` : ""}?`,
        detail: detail.length > DETAIL_CHARS ? detail.slice(0, DETAIL_CHARS - 1) + "…" : detail,
        options: [
          { id: "allow", label: "Allow", style: "primary" },
          { id: "deny", label: "Deny", style: "danger" },
        ],
        answerableBy: ["user"],
        ...(config.ask_timeout_ms > 0 ? { expiresAt: startedAt + config.ask_timeout_ms } : {}),
      }, startedAt, this.deps.node);
    }

    const entry = audit.open({
      principal: req.principal,
      action: req.action,
      args: req.args,
      decision: verdict.decision,
      ...(req.via !== undefined ? { via: req.via } : {}),
      ...(req.target !== undefined ? { target: req.target } : {}),
      ...(ask ? { ask: ask.id } : {}),
      ...(req.thread !== undefined ? { thread: req.thread } : {}),
      ...(req.task !== undefined ? { task: req.task } : {}),
      ...(req.correlation !== undefined ? { correlation: req.correlation } : {}),
    }, Date.now(), this.deps.node);
    log.debug("gate", { id: entry.id, action: req.action, principal: req.principal.kind, decision: verdict.decision, source: verdict.source, rule: verdict.rule });

    if (verdict.decision === "deny") {
      const reason = verdict.rule ? `policy rule ${verdict.rule}` : `policy for ${req.principal.kind}/${risk}`;
      audit.complete(entry, "denied", { error: reason, startedAt });
      throw new RpcError("denied", reason);
    }

    if (ask) {
      opts.onPending?.(ask, entry);
      const onAbort = () => asks.cancel(ask!.id);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      let settled: Ask;
      try {
        settled = await asks.wait(ask.id);
      } finally {
        opts.signal?.removeEventListener("abort", onAbort);
      }

      if (settled.status === "answered" && settled.answer) {
        const allowed = settled.answer.option === "allow";
        const remember = settled.remember;
        if (remember === "always" || remember === "session") {
          const key = policy.remember(
            { principal: req.principal.kind, action: req.action, ...(req.target !== undefined ? { target: req.target } : {}), ...(req.sessionKey !== undefined ? { sessionKey: req.sessionKey } : {}) },
            allowed ? "allow" : "deny",
            remember,
            settled.answer.by,
          );
          log.info("remembered", { key, decision: allowed ? "allow" : "deny", scope: remember });
        }
        if (!allowed) {
          const reason = settled.answer.text ?? `denied by ${principalLabel(settled.answer.by)}`;
          audit.complete(entry, "denied", { error: reason, startedAt });
          throw new RpcError("denied", reason);
        }
      } else if (settled.status === "expired") {
        audit.complete(entry, "cancelled", { error: "ask expired", startedAt });
        throw new RpcError("timeout", `ask ${ask.id} expired unanswered`);
      } else {
        audit.complete(entry, "cancelled", { error: "ask cancelled", startedAt });
        throw new RpcError("cancelled", `ask ${ask.id} was cancelled`);
      }
    }

    try {
      const result = await handler({ audit: entry });
      audit.complete(entry, "ok", { result: req.redactResult ? req.redactResult(result) : result, startedAt });
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A handler cut short by its caller (the brain's `cancel`, a client gone) is cancelled, not failed.
      const cancelled = e instanceof RpcError && e.code === "cancelled";
      audit.complete(entry, cancelled ? "cancelled" : "error", { error: message, startedAt });
      throw e;
    }
  }
}
