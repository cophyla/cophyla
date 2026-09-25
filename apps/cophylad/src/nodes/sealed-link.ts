// The node link's sockets, sealed from the first frame to the last. On the LAN the
// initiator's WebSocket carries the two frames in the clear (the grant it holds, the
// ephemeral keys) and records after them; through the server it is a relay peer holding its
// own grant's relay token, whose tunnel the server's `relay.open` sets up. Either way what
// the link module gets is a `LinkSocket` that speaks the node link's text, and a record that
// does not open closes it. TLS under the LAN socket is only the transport: the grant's key is
// what proves each end to the other.

import { PeerSession, SealedError, sealedInitiate, SealedSocket } from "@cophyla/relay";
import type { Psk, SealedKind } from "@cophyla/relay";
import { RpcError } from "@cophyla/protocol";
import type { LinkSocket } from "./outbound.ts";

/** A `LinkSocket` whose text arrives before anyone listens: held until a listener comes. */
function buffered(): { socket: Pick<LinkSocket, "onMessage" | "onClose">; text(t: string): void; closed(code: number, reason: string): void } {
  const texts: string[] = [];
  let listener: ((t: string) => void) | undefined;
  const closers: ((code: number, reason: string) => void)[] = [];
  let ended: { code: number; reason: string } | undefined;
  return {
    socket: {
      onMessage: (fn) => {
        listener = fn;
        for (const t of texts.splice(0)) fn(t);
      },
      onClose: (fn) => {
        if (ended) fn(ended.code, ended.reason);
        else closers.push(fn);
      },
    },
    text: (t) => (listener ? listener(t) : void texts.push(t)),
    closed: (code, reason) => {
      if (ended) return;
      ended = { code, reason };
      for (const fn of closers.splice(0)) fn(code, reason);
    },
  };
}

/**
 * Seals a LAN WebSocket as the initiator: sends the hello naming `grant`, waits for the
 * answer, and keys the tunnel from `psk`. A refusal, a close or silence past `timeoutMs`
 * rejects; the raw socket is closed then.
 */
export async function sealLan(raw: LinkSocket, opts: { grant: string; kind: SealedKind; psk: Psk; timeoutMs: number }): Promise<LinkSocket> {
  const init = await sealedInitiate({ grant: opts.grant, kind: opts.kind, psk: opts.psk });
  const out = buffered();
  let sealed: SealedSocket | undefined;
  let answered: (text: string) => void = () => undefined;
  let refused: (e: Error) => void = () => undefined;
  const answer = new Promise<string>((resolve, reject) => {
    answered = resolve;
    refused = reject;
  });
  raw.onMessage((text) => {
    if (sealed) sealed.receive(text);
    else answered(text);
  });
  raw.onClose((code, reason) => {
    if (sealed) sealed.transportClosed(code, reason);
    else refused(new RpcError("unavailable", `${raw.remote ?? "the node"} closed the link before it was sealed (${code} ${reason})`));
  });
  if (!raw.send(init.hello)) throw new RpcError("unavailable", "the link closed before its hello");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      answer,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RpcError("timeout", `${raw.remote ?? "the node"}: no answer to the hello within ${opts.timeoutMs} ms`)), opts.timeoutMs);
      }),
    ]);
    const tunnel = await init.finish(text);
    sealed = new SealedSocket(tunnel, { send: (f) => void raw.send(f), close: (code, reason) => raw.close(code, reason) }, { onText: out.text, onClose: out.closed });
  } catch (e) {
    raw.close(1000, "not sealed");
    if (e instanceof SealedError) throw new RpcError("denied", `${raw.remote ?? "the node"} refused the link: ${e.message}`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const s = sealed;
  return { send: (text) => s.send(text), close: (code = 1000, reason = "closed") => s.close(code, reason), ...out.socket, ...(raw.remote !== undefined ? { remote: raw.remote } : {}) };
}

/**
 * A link through the server relay: a peer socket at `/ws/relay` holding this node's grant's
 * relay token (or an invite's), whose `relay.open` the server sends to the primary it names.
 */
export async function openRelayLink(opts: { url: string; token: string; peer: string; psk: Psk; kind: SealedKind; timeoutMs?: number }): Promise<LinkSocket> {
  const out = buffered();
  const session = new PeerSession({ url: opts.url, token: opts.token, peer: opts.peer, psk: opts.psk, kind: opts.kind, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) }, { onText: out.text, onClose: out.closed });
  try {
    await session.connect();
  } catch (e) {
    const code = (e as { code?: string }).code;
    throw new RpcError(code === "denied" ? "denied" : "unavailable", `the relay: ${e instanceof Error ? e.message : String(e)}`, { provider: "server" });
  }
  return {
    send: (text) => {
      if (!session.open) return false;
      session.send(text);
      return true;
    },
    close: (code = 1000, reason = "closed") => session.close(code, reason),
    ...out.socket,
    remote: `relay:${session.node ?? "primary"}`,
  };
}
