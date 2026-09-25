// The account token on disk: `data/account.token`, mode 0600, written once by the login and
// deleted by the logout. Revoking goes over plain HTTP so a logout works with the link down.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export class AccountFile {
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  read(): string | undefined {
    if (!existsSync(this.path)) return undefined;
    const t = readFileSync(this.path, "utf8").trim();
    return t.length >= 16 ? t : undefined;
  }

  write(token: string): void {
    writeFileSync(this.path, token + "\n", { encoding: "utf8", mode: 0o600 });
  }

  delete(): void {
    rmSync(this.path, { force: true });
  }
}

/** `POST /auth/revoke` with the token as bearer; the server answers 200 whether or not it still knew the token. */
export async function revokeToken(url: string, token: string, doFetch: typeof fetch, timeoutMs = 10_000): Promise<void> {
  const res = await doFetch(`${url}/auth/revoke`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`revoke: HTTP ${res.status}`);
}
