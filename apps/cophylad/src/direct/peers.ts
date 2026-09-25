// One data channel the helper holds, as a socket the api or the nodes module can speak
// through. What goes out is sealed as an `@cophyla/relay` record and cut into messages of
// 16 KiB at most, each one `peer.send` to the helper, in order; what comes in (`peer.data`)
// is put back together and opened, in order. The helper sees ciphertext only. A record that
// fails to open closes the channel: the far end lacks the secret, or the stream was tampered
// with. `buffered()` is what the helper last said it holds for the channel, with what is
// still being sealed here.

import { chunk, Reassembler, TunnelError } from "@cophyla/relay";
import type { Tunnel } from "@cophyla/relay";
import type { Logger } from "../log.ts";

/** The close code when a record on a channel failed to open. */
export const CHANNEL_UNAUTHORIZED = 4401;

export interface ChannelSocketDeps {
  peer: string;
  tunnel: Tunnel;
  /** One message to the helper for this channel; false once it cannot take it. */
  send: (data: string) => boolean;
  /** Ends the channel at the helper. */
  close: (code: number, reason: string) => void;
  log: Logger;
  /** `direct:<peer>` or the like, for the log and the api's `remote`. */
  remote: string;
}

export class ChannelSocket {
  readonly remote: string;
  private deps: ChannelSocketDeps;
  private reassembler = new Reassembler();
  private sending: Promise<void> = Promise.resolve();
  private sealing = 0;
  private helperBuffered = 0;
  /** No more sends are taken: the socket was closed, or the channel went. */
  private closed = false;
  /** The channel itself went: nothing more reaches the helper. */
  private gone = false;
  private onText?: (text: string) => void;
  private onEnd?: (code: number, reason: string) => void;

  constructor(deps: ChannelSocketDeps) {
    this.deps = deps;
    this.remote = deps.remote;
  }

  /** Where the frames that come in go, and who hears the end. */
  attach(onText: (text: string) => void, onEnd: (code: number, reason: string) => void): void {
    this.onText = onText;
    this.onEnd = onEnd;
  }

  // --- the socket's side ------------------------------------------------------------------------

  send(text: string): void {
    if (this.closed) return;
    this.sealing += text.length;
    this.sending = this.sending
      .then(async () => {
        const record = await this.deps.tunnel.seal(text);
        this.sealing -= text.length;
        if (this.gone) return;
        for (const message of chunk(record)) if (!this.deps.send(message)) return;
      })
      .catch((e: unknown) => {
        this.deps.log.warn("a record could not be sealed; the channel closes", { peer: this.deps.peer, error: e instanceof Error ? e.message : String(e) });
        this.close(1011, "a record could not be sealed");
      });
  }

  /** Closes the channel once what was sent before has gone out, as a socket's close follows its last frame. */
  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.onEnd?.(code, reason);
    void this.sending.then(() => {
      if (this.gone) return;
      this.gone = true;
      this.deps.close(code, reason);
    });
  }

  buffered(): number {
    return this.helperBuffered + this.sealing;
  }

  // --- the helper's side ------------------------------------------------------------------------

  /** One `peer.data` message. */
  receive(message: string): void {
    if (this.closed) return;
    let record: string | undefined;
    try {
      record = this.reassembler.push(message);
    } catch (e) {
      this.deps.log.warn("a malformed message on a data channel", { peer: this.deps.peer, error: e instanceof Error ? e.message : String(e) });
      this.close(CHANNEL_UNAUTHORIZED, "a malformed message");
      return;
    }
    if (record === undefined) return;
    this.deps.tunnel.open(record).then(
      (text) => {
        if (!this.closed) this.onText?.(text);
      },
      (e: unknown) => {
        const why = e instanceof TunnelError ? e.message : String(e);
        this.deps.log.warn("a record on a data channel failed to open; the channel closes", { peer: this.deps.peer, why });
        this.close(CHANNEL_UNAUTHORIZED, "a record failed to open");
      },
    );
  }

  /** What the helper holds for this channel, from `peer.buffered`. */
  setBuffered(bytes: number): void {
    this.helperBuffered = bytes;
  }

  /** The helper says the channel is gone, or went itself. */
  ended(reason: string): void {
    this.gone = true;
    if (this.closed) return;
    this.closed = true;
    this.onEnd?.(1006, reason);
  }
}
