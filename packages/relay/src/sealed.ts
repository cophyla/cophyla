// A sealed socket: a tunnel's records over any transport that carries text in order, a
// WebSocket on the LAN, a relay tunnel's frames through the server, a data channel. It seals
// what it is given and sends it after everything before it, opens what arrives in order and
// hands it on, and closes on the first record that does not open (the far end lacks the key,
// or something between changed a byte). A close waits for what is already queued to leave.
//
// What waits to be sealed is in two queues, urgent (a phone's speech and voice state) and
// the rest, and one record is sealed at a time, urgent first. Each queue keeps its own
// order, and the sequence number is taken at the seal, so the far end opens the records in
// the order they left and the record format is untouched.
//
// On a transport with nothing in front of it (the LAN), two frames in the clear set it up:
// the initiator names the grant it holds, the kind of link and its ephemeral key; the
// responder looks the grant up, answers with its own key, and both derive the tunnel from
// the ECDH secret and the grant's key. Nothing in either frame is secret; a man in the
// middle who swaps a key derives a tunnel that opens no record.
//
//   hello  = {"v":"cophyla-sealed/1","grant":…,"kind":"node"|"enroll","epk":…,"curve":…}
//   answer = {"epk":…} | {"error":…}

import { derive, ephemeral } from "./tunnel.ts";
import type { Psk, RelayCurve, Tunnel, TunnelKind } from "./tunnel.ts";

export const SEALED_VERSION = "cophyla-sealed/1";

/** The close code for a record that failed to open. */
export const SEALED_BAD_RECORD = 4403;

/** What the transport under a sealed socket must do. */
export interface SealedTransport {
  send(frame: string): void;
  close(code: number, reason: string): void;
}

/** How a frame is sent: `urgent` overtakes the frames queued ahead of it that are not. */
export interface SealedSendOptions {
  urgent?: boolean;
}

export interface SealedEvents {
  onText(text: string): void;
  onClose(code: number, reason: string): void;
}

export class SealedSocket {
  readonly tunnel: Tunnel;
  private transport: SealedTransport;
  private events: SealedEvents;
  private sending: Promise<void> = Promise.resolve();
  private receiving: Promise<void> = Promise.resolve();
  /** The frames waiting to be sealed: urgent ones go first. */
  private urgent: string[] = [];
  private normal: string[] = [];
  private pumping = false;
  /** No more is sent or handed on. */
  private closing = false;
  private ended = false;
  /** Records in and out, for the close line. */
  in = 0;
  out = 0;

  constructor(tunnel: Tunnel, transport: SealedTransport, events: SealedEvents) {
    this.tunnel = tunnel;
    this.transport = transport;
    this.events = events;
  }

  get open(): boolean {
    return !this.closing;
  }

  /** Seals one frame of the inner protocol and sends it after every frame before it, or, urgent, after the urgent ones alone. */
  send(text: string, opts?: SealedSendOptions): boolean {
    if (this.closing) return false;
    this.out++;
    (opts?.urgent ? this.urgent : this.normal).push(text);
    if (!this.pumping) {
      this.pumping = true;
      this.sending = this.sending.then(() => this.pump());
    }
    return true;
  }

  /** Seals one record at a time, urgent first, until both queues are empty. */
  private async pump(): Promise<void> {
    try {
      for (;;) {
        const text = this.urgent.shift() ?? this.normal.shift();
        if (text === undefined) return;
        const record = await this.tunnel.seal(text);
        if (this.ended) {
          this.urgent = [];
          this.normal = [];
          return;
        }
        try {
          this.transport.send(record);
        } catch {
          // the transport went; its close is on its way
        }
      }
    } catch (e) {
      this.urgent = [];
      this.normal = [];
      this.fail(e instanceof Error ? e.message : String(e));
    } finally {
      this.pumping = false;
    }
  }

  /** One record from the far end: opened after every record before it and handed on; one that does not open closes the socket. */
  receive(record: string): void {
    if (this.closing || this.failed) return;
    this.in++;
    this.receiving = this.receiving
      .then(() => this.tunnel.open(record))
      .then((text) => {
        if (!this.ended && !this.failed) this.events.onText(text);
      })
      .catch((e: unknown) => this.fail(e instanceof Error ? e.message : String(e)));
  }

  /** A record did not open: nothing after it is handed on. */
  private failed = false;

  private fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    this.close(SEALED_BAD_RECORD, reason.slice(0, 120));
  }

  /**
   * Closes after what is queued has left: the transport closes, and the owner hears it once.
   * Settles once the transport was told, so what is said about the far end after it (a relay
   * token revoked) cannot overtake the last records.
   */
  close(code = 1000, reason = "closed"): Promise<void> {
    if (this.closing) return this.sending;
    this.closing = true;
    this.sending = this.sending.then(() => this.end(code, reason, true));
    return this.sending;
  }

  /** The transport went away under the socket: what already arrived is still handed on, then the owner hears the close once. */
  transportClosed(code: number, reason: string): void {
    this.closing = true;
    void this.receiving.then(() => this.end(code, reason, false));
  }

  private end(code: number, reason: string, closeTransport: boolean): void {
    if (this.ended) return;
    this.ended = true;
    if (closeTransport) {
      try {
        this.transport.close(code, reason);
      } catch {
        // already gone
      }
    }
    this.events.onClose(code, reason);
  }
}

// --- the LAN's two frames in the clear -----------------------------------------------------

export type SealedKind = Extract<TunnelKind, "node" | "enroll">;

export interface SealedHello {
  v: typeof SEALED_VERSION;
  grant: string;
  kind: SealedKind;
  epk: string;
  curve: RelayCurve;
}

/** The first frame on a sealed transport, or undefined when it is not one. */
export function parseSealedHello(text: string): SealedHello | undefined {
  let m: Partial<SealedHello>;
  try {
    m = JSON.parse(text) as Partial<SealedHello>;
  } catch {
    return undefined;
  }
  if (m === null || typeof m !== "object" || m.v !== SEALED_VERSION) return undefined;
  if (typeof m.grant !== "string" || m.grant.length === 0 || m.grant.length > 64) return undefined;
  if (m.kind !== "node" && m.kind !== "enroll") return undefined;
  if (typeof m.epk !== "string" || m.epk.length === 0 || m.epk.length > 256) return undefined;
  if (m.curve !== "x25519" && m.curve !== "p256") return undefined;
  return { v: SEALED_VERSION, grant: m.grant, kind: m.kind, epk: m.epk, curve: m.curve };
}

/**
 * The initiator's half: the hello to send first, and, from the responder's answer, the tunnel.
 * The binding is the kind and the grant, so a key derived for one grant opens nothing of another.
 */
export async function sealedInitiate(opts: { grant: string; kind: SealedKind; psk: Psk; curve?: RelayCurve }): Promise<{ hello: string; finish(answer: string): Promise<Tunnel> }> {
  const eph = await ephemeral(opts.curve);
  const hello: SealedHello = { v: SEALED_VERSION, grant: opts.grant, kind: opts.kind, epk: eph.publicKey, curve: eph.curve };
  return {
    hello: JSON.stringify(hello),
    finish: async (answer) => {
      let a: { epk?: unknown; error?: unknown };
      try {
        a = JSON.parse(answer) as { epk?: unknown; error?: unknown };
      } catch {
        throw new SealedError("the answer to the hello was not JSON");
      }
      if (typeof a?.error === "string") throw new SealedError(a.error);
      if (typeof a?.epk !== "string") throw new SealedError("the answer to the hello carried no key");
      return derive("initiator", eph, a.epk, opts.psk, { kind: opts.kind, peer: opts.grant });
    },
  };
}

/** The responder's half: the answer to send, and the tunnel keyed from the grant's key. */
export async function sealedRespond(hello: SealedHello, psk: Psk): Promise<{ answer: string; tunnel: Tunnel }> {
  const eph = await ephemeral(hello.curve);
  const tunnel = await derive("responder", eph, hello.epk, psk, { kind: hello.kind, peer: hello.grant });
  return { answer: JSON.stringify({ epk: eph.publicKey }), tunnel };
}

/** The answer that refuses a hello: the initiator reads it as an error, then the transport closes. */
export function sealedRefusal(reason: string): string {
  return JSON.stringify({ error: reason });
}

export class SealedError extends Error {}
