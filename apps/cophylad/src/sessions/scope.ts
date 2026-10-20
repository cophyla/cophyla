// Which of the user's own sessions this node connects to (`SessionScope`): every one until the
// user says otherwise, in the app's first-run screen or its Settings. Kept in this node's kv,
// never replicated or backed up, since profile ids and folders mean nothing on another machine.
// `admits` is the one test: a session Cophyla started (spawned over ACP, started by the brain,
// the chat's own) is always in; any other must be under a profile left on, in a tether
// terminal when only those are wanted, in an allowed folder when any is listed, and in no
// hidden folder. The registry asks it each time it would tell or list a session, so a session
// moves in or out as the scope changes or as it learns its terminal.

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { Session, SessionScope, SessionScopeState } from "@cophyla/protocol";
import { SESSION_SCOPE_NS } from "../grants/namespaces.ts";
import type { Store } from "../store/index.ts";
import { isWithin, plainPath } from "./paths.ts";

export const SCOPE_KV_NS = SESSION_SCOPE_NS;
const KEY_SCOPE = "scope";
const KEY_SETUP = "setupAt";

/** Every session: what a node connects to before the user sets anything. */
export const OPEN_SCOPE: SessionScope = { profilesOff: [], tetherOnly: false, allowedFolders: [], hiddenFolders: [] };

/** A scope as it is kept: each list without blanks or repeats, a folder written two ways (case, separators) kept once. */
export function normaliseScope(scope: SessionScope, platform: string = process.platform): SessionScope {
  const folders = (list: readonly string[]): string[] => {
    const out: string[] = [];
    for (const raw of list) {
      const f = plainPath(raw.trim());
      if (f !== "" && !out.some((o) => isWithin(o, f, platform) && isWithin(f, o, platform))) out.push(f);
    }
    return out;
  };
  return {
    profilesOff: [...new Set(scope.profilesOff)],
    tetherOnly: scope.tetherOnly,
    allowedFolders: folders(scope.allowedFolders),
    hiddenFolders: folders(scope.hiddenFolders),
  };
}

/**
 * A scope as an app sent it: `~` read as the home folder, and refused with a folder that is not
 * a whole path, since one written from where the daemon happens to run means nothing to the user.
 */
export function checkScope(scope: SessionScope, home: string = homedir()): SessionScope {
  const whole = (raw: string): string => {
    const f = raw.trim();
    const path = f === "~" ? home : /^~[\\/]/.test(f) ? join(home, f.slice(2)) : f;
    if (!isAbsolute(plainPath(path))) throw new RpcError("invalid", `${f} is not a whole path: write the folder from its drive or from /`);
    return path;
  };
  return { ...scope, allowedFolders: scope.allowedFolders.map(whole), hiddenFolders: scope.hiddenFolders.map(whole) };
}

/** What reads and sets a node's scope: its session registry. */
export interface ScopeHost {
  scopeState(): SessionScopeState;
  setScope(scope: SessionScope): SessionScopeState;
}

/** Whether the scope leaves every session in. */
export function isOpen(scope: SessionScope): boolean {
  return scope.profilesOff.length === 0 && !scope.tetherOnly && scope.allowedFolders.length === 0 && scope.hiddenFolders.length === 0;
}

/** Whether a session is one Cophyla connects to under the scope. */
export function admits(scope: SessionScope, s: Pick<Session, "profile" | "cwd" | "origin" | "role" | "native">, platform?: string): boolean {
  if (s.role === "assistant" || s.origin === "orchestrator" || s.native.transport === "acp") return true;
  if (scope.profilesOff.includes(s.profile)) return false;
  if (scope.tetherOnly && s.native.terminal === undefined) return false;
  const cwd = plainPath(s.cwd);
  if (scope.allowedFolders.length > 0 && !scope.allowedFolders.some((f) => isWithin(cwd, f, platform))) return false;
  return !scope.hiddenFolders.some((f) => isWithin(cwd, f, platform));
}

/** The node's scope in its kv, read once and kept. */
export class ScopeStore {
  private store: Pick<Store, "kv">;
  private cached: SessionScope;

  constructor(store: Pick<Store, "kv">) {
    this.store = store;
    this.cached = readScope(store.kv.get(SCOPE_KV_NS, KEY_SCOPE));
  }

  get(): SessionScope {
    return this.cached;
  }

  /** When the user first set it; absent until then. */
  setupAt(): number | undefined {
    const at = this.store.kv.get(SCOPE_KV_NS, KEY_SETUP);
    return typeof at === "number" ? at : undefined;
  }

  state(node: string): SessionScopeState {
    const setupAt = this.setupAt();
    return { node, scope: this.cached, ...(setupAt !== undefined ? { setupAt } : {}) };
  }

  /** Keeps the scope, marking it set the first time; answers it as kept. */
  set(scope: SessionScope, now = Date.now()): SessionScope {
    this.cached = normaliseScope(scope);
    this.store.kv.put(SCOPE_KV_NS, KEY_SCOPE, this.cached, now);
    if (this.setupAt() === undefined) this.store.kv.put(SCOPE_KV_NS, KEY_SETUP, now, now);
    return this.cached;
  }
}

/** A kept scope, each field checked: one written by an older or newer cophylad keeps what it can. */
function readScope(v: unknown): SessionScope {
  if (v === null || typeof v !== "object") return OPEN_SCOPE;
  const o = v as Record<string, unknown>;
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && s !== "") : []);
  return { profilesOff: strings(o["profilesOff"]), tetherOnly: o["tetherOnly"] === true, allowedFolders: strings(o["allowedFolders"]), hiddenFolders: strings(o["hiddenFolders"]) };
}
