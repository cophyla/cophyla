// The device-code login: `POST /auth/device` for a code, answered to the client at once so
// it can show the code and open the page, then `POST /auth/token` every `intervalMs` until
// the server grants (200), refuses (410) or the code expires. The token goes to whoever
// started the flow; nothing here touches disk or the link.

import { RpcError, serverAuthHttp } from "@cophyla/protocol";
import type { Logger } from "../log.ts";

export interface DeviceOffer {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  intervalMs: number;
}

export interface Granted {
  token: string;
  subject: string;
  expiresAt: number;
}

export interface DeviceFlowDeps {
  url: string;
  /** Names this daemon on the account page. */
  node: string;
  fetch: typeof fetch;
  log: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Ends the polling early: a logout, or the daemon stopping. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DeviceFlow {
  offer: DeviceOffer;
  /** Resolves with the token once the user signed in; rejects with `denied` (refused or expired) or `cancelled`. */
  granted: Promise<Granted>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startDeviceFlow(deps: DeviceFlowDeps): Promise<DeviceFlow> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = deps.timeoutMs ?? 15_000;
  let res: Response;
  try {
    res = await deps.fetch(`${deps.url}/auth/device`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node: deps.node }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new RpcError("unavailable", `the server could not be reached: ${e instanceof Error ? e.message : String(e)}`, { provider: "server" });
  }
  if (res.status === 429) throw new RpcError("unavailable", "the server is rate-limiting logins from here; try again in a minute", { provider: "server" });
  if (!res.ok) throw new RpcError("unavailable", `the server refused the login: HTTP ${res.status}`, { provider: "server" });
  const parsed = serverAuthHttp["auth.device"].result.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new RpcError("unavailable", "the server's answer was not a device code", { provider: "server" });
  const offer = parsed.data;

  const granted = (async (): Promise<Granted> => {
    for (;;) {
      await sleep(offer.intervalMs);
      if (deps.signal?.aborted) throw new RpcError("cancelled", "the login was cancelled");
      if (now() > offer.expiresAt) throw new RpcError("denied", "the code expired before it was used");
      let poll: Response;
      try {
        poll = await deps.fetch(`${deps.url}/auth/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceCode: offer.deviceCode }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        deps.log.debug("token poll failed; trying again", { error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      if (poll.status === 202) continue;
      if (poll.status === 200) {
        const body = serverAuthHttp["auth.token"].result.safeParse(await poll.json().catch(() => undefined));
        if (!body.success) throw new RpcError("unavailable", "the server's answer was not a token", { provider: "server" });
        return body.data;
      }
      if (poll.status === 410) throw new RpcError("denied", "the code expired or the sign-in was refused");
      if (poll.status >= 500 || poll.status === 429) {
        deps.log.debug("token poll refused; trying again", { status: poll.status });
        continue;
      }
      throw new RpcError("unavailable", `the server refused the poll: HTTP ${poll.status}`, { provider: "server" });
    }
  })();
  return { offer, granted };
}
