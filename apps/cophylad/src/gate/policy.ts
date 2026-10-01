// Policy is the config plus the answers the user chose to remember. The decision for a
// request is the most specific rule that matches it, in this order: a control action is
// always allowed; an answer remembered for this session; an answer remembered always; a
// config rule; a built-in rule (what the brain may do without asking: speak, keep its own
// books, call the model the user configured, start a session of its own and message the
// ones it started); the config default for the principal kind and risk class.

import type { Decision, Principal, PrincipalKind, RiskClass } from "@cophyla/protocol";
import type { GateConfig } from "../config/schema.ts";
import { RULE_KEY } from "../config/schema.ts";
import type { PolicyRule, Store } from "../store/index.ts";

export interface PolicyQuery {
  principal: PrincipalKind;
  action: string;
  risk: RiskClass;
  target?: string;
  control?: boolean;
  /** Scopes `remember: session` answers: a client id, a brain instance, a node link. */
  sessionKey?: string;
  /** The request is on something the principal started itself: a message to a session the brain started. */
  own?: boolean;
}

export type PolicySource = "control" | "system" | "session" | "remembered" | "config.rule" | "builtin.rule" | "config.class";

/**
 * The brain's own conversation and bookkeeping, allowed without a prompt: a brain that had
 * to ask before every reply could not converse. So is starting a session: the user asked for
 * it, and the session runs under their own account in their own terminal, where they watch it.
 * Anything else that reaches a session, a machine or the network stays under the class
 * default (`ask`) unless config says otherwise; `"brain:session.spawn" = "ask"` in
 * `[gate.rules]` puts the ask back.
 */
export const BUILTIN_RULES: Readonly<Record<string, Decision>> = {
  "brain:ui.say": "allow",
  "brain:ui.ask": "allow",
  "brain:voice.speak": "allow",
  "brain:llm.complete": "allow",
  "brain:thread.start": "allow",
  "brain:task.create": "allow",
  "brain:task.update": "allow",
  "brain:annotate": "allow",
  "brain:store.put": "allow",
  "brain:store.delete": "allow",
  "brain:listener.add": "allow",
  "brain:listener.remove": "allow",
  "brain:memory.write": "allow",
  "brain:prompt.write": "allow",
  "brain:session.spawn": "allow",
};

/**
 * Allowed only on what the principal started: the brain messaging or stopping a session it
 * started. A message to any other session, the user's own, and a stop of one, stay under the
 * rules above.
 */
export const BUILTIN_OWN_RULES: Readonly<Record<string, Decision>> = {
  "brain:session.send": "allow",
  "brain:session.stop": "allow",
};

export interface PolicyDecision {
  decision: Decision;
  source: PolicySource;
  rule?: string;
}

export function ruleKey(principal: PrincipalKind | "*", action: string, target?: string): string {
  return target === undefined ? `${principal}:${action}` : `${principal}:${action}@${target}`;
}

export function parseRuleKey(key: string): { principal: PrincipalKind | "*"; action: string; target?: string } {
  const m = RULE_KEY.exec(key);
  if (!m) throw new Error(`bad rule key: ${key}`);
  const out: { principal: PrincipalKind | "*"; action: string; target?: string } = {
    principal: m[1] as PrincipalKind | "*",
    action: m[2]!,
  };
  if (m[3] !== undefined) out.target = m[3];
  return out;
}

/** The keys that could match a query, most specific first. */
function candidateKeys(q: { principal: PrincipalKind; action: string; target?: string }): string[] {
  const keys: string[] = [];
  if (q.target !== undefined) {
    keys.push(ruleKey(q.principal, q.action, q.target), ruleKey("*", q.action, q.target));
  }
  keys.push(ruleKey(q.principal, q.action), ruleKey("*", q.action));
  return keys;
}

export class Policy {
  private remembered = new Map<string, Decision>();
  private sessions = new Map<string, Map<string, Decision>>();
  private config: GateConfig;
  private store: Store;

  constructor(config: GateConfig, store: Store) {
    this.config = config;
    this.store = store;
    for (const rule of store.policy.list()) this.remembered.set(rule.key, rule.decision);
  }

  decide(q: PolicyQuery): PolicyDecision {
    if (q.principal === "system") return { decision: "allow", source: "system" };
    if (q.control) return { decision: "allow", source: "control" };

    const keys = candidateKeys(q);

    if (q.sessionKey !== undefined) {
      const session = this.sessions.get(q.sessionKey);
      if (session) {
        for (const key of keys) {
          const d = session.get(key);
          if (d) return { decision: d, source: "session", rule: key };
        }
      }
    }
    for (const key of keys) {
      const d = this.remembered.get(key);
      if (d) return { decision: d, source: "remembered", rule: key };
    }
    for (const key of keys) {
      const d = this.config.rules[key];
      if (d) return { decision: d, source: "config.rule", rule: key };
    }
    for (const key of keys) {
      const d = BUILTIN_RULES[key] ?? (q.own ? BUILTIN_OWN_RULES[key] : undefined);
      if (d) return { decision: d, source: "builtin.rule", rule: key };
    }
    const klass = this.config.policy[q.principal as Exclude<PrincipalKind, "system">];
    return { decision: klass[q.risk], source: "config.class" };
  }

  /** Writes an answer into policy. `always` persists; `session` lasts while `sessionKey` does. */
  remember(
    q: { principal: PrincipalKind; action: string; target?: string; sessionKey?: string },
    decision: Decision,
    scope: "session" | "always",
    by: Principal,
    now = Date.now(),
  ): string {
    const key = ruleKey(q.principal, q.action, q.target);
    if (scope === "always") {
      const rule: PolicyRule = { key, principal: q.principal, action: q.action, decision, createdBy: by, createdAt: now };
      if (q.target !== undefined) rule.target = q.target;
      this.store.policy.put(rule);
      this.remembered.set(key, decision);
    } else if (q.sessionKey !== undefined) {
      let session = this.sessions.get(q.sessionKey);
      if (!session) {
        session = new Map();
        this.sessions.set(q.sessionKey, session);
      }
      session.set(key, decision);
    }
    return key;
  }

  forget(key: string): boolean {
    this.remembered.delete(key);
    return this.store.policy.delete(key);
  }

  /** Drops every `session` answer scoped to a key: on client disconnect, brain restart, node leave. */
  forgetSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  rules(): PolicyRule[] {
    return this.store.policy.list();
  }
}
