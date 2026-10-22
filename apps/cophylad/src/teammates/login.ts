// The user's own GitHub login, which the daemon is never told at sign-in (it keeps the account's
// id): asked of the server as its word on this account (`identity.attest`, bound to an audience
// of its own that no exchange takes), read from the token it signs, and kept, so a restart with
// the server out of reach still names the user. Group chats name the user by it, and teammates
// see it.

import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";
import { TEAMMATES_KV_NS } from "../grants/namespaces.ts";

const KEY = "self";
/** The audience of the token that only tells this node its own login. */
export const SELF_AUDIENCE = "cophyla-self/1";

export interface SelfLoginDeps {
  store: Store;
  log: Logger;
  /** The account this node is signed in to, once known. */
  account: () => string | undefined;
  attest: (aud: string) => Promise<string>;
  verify: (token: string, aud: string) => { subject: string; login: string };
}

export class SelfLogin {
  private deps: SelfLoginDeps;
  private asking?: Promise<void>;

  constructor(deps: SelfLoginDeps) {
    this.deps = deps;
  }

  /** The login of the account signed in now, when known. */
  login(): string | undefined {
    const account = this.deps.account();
    if (!account) return undefined;
    const kept = this.deps.store.kv.get(TEAMMATES_KV_NS, KEY) as { subject: string; login: string } | undefined;
    return kept && kept.subject === account ? kept.login : undefined;
  }

  /** Asks the server again; quiet when it cannot be reached or the plan has no relay. */
  refresh(): Promise<void> {
    this.asking ??= this.ask().finally(() => (this.asking = undefined));
    return this.asking;
  }

  private async ask(): Promise<void> {
    if (!this.deps.account()) return;
    try {
      const token = await this.deps.attest(SELF_AUDIENCE);
      const who = this.deps.verify(token, SELF_AUDIENCE);
      const kept = this.deps.store.kv.get(TEAMMATES_KV_NS, KEY) as { subject: string; login: string } | undefined;
      if (kept?.subject === who.subject && kept.login === who.login) return;
      this.deps.store.kv.put(TEAMMATES_KV_NS, KEY, { subject: who.subject, login: who.login });
      this.deps.log.info("the account's login is known", { login: who.login });
    } catch (e) {
      this.deps.log.debug("the account's login was not asked now", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}
