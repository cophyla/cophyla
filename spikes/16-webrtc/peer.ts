// One uniform peer over the two libraries, the answering side (the node's): the other side's
// offer and candidates go in, the answer and ours come out, and the channel the other side
// opens is handed over with the same small surface either way.

export type Lib = "ndc" | "werift";
export type Only = "any" | "host" | "srflx";

export interface Chan {
  send(data: string | Uint8Array): void;
  buffered(): number;
  /** Called once the send buffer drops under `threshold`. */
  onLow(threshold: number, cb: () => void): void;
  onMessage(cb: (data: string | Uint8Array) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface Peer {
  /** Takes the offer, answers it; our candidates stream out through `onCandidate`. */
  answer(offerSdp: string): Promise<string>;
  addCandidate(candidate: string, mid: string): void;
  onCandidate(cb: (candidate: string, mid: string) => void): void;
  onChannel(cb: (ch: Chan) => void): void;
  onState(cb: (state: string) => void): void;
  /** The pair ICE chose, once connected, as the library says it. */
  selected(): unknown;
  close(): void;
}

export const STUN = ["stun.l.google.com:19302", "stun.cloudflare.com:3478"];

/** `typ host|srflx|relay|prflx` of an SDP candidate line. */
export const candType = (c: string): string => / typ (\w+)/.exec(c)?.[1] ?? "?";

export const keep = (only: Only, c: string): boolean => only === "any" || candType(c) === only;

/** Candidates without their SDP body: drops them from an SDP so only trickled ones count. */
export const stripSdpCandidates = (sdp: string): string =>
  sdp
    .split(/\r\n/)
    .filter((l) => !l.startsWith("a=candidate:") && l !== "a=end-of-candidates")
    .join("\r\n");

export async function makePeer(lib: Lib, opts: { stun: boolean }): Promise<Peer> {
  return lib === "ndc" ? ndcPeer(opts) : weriftPeer(opts);
}

async function ndcPeer(opts: { stun: boolean }): Promise<Peer> {
  const ndc = await import("node-datachannel");
  const pc = new ndc.PeerConnection("node", { iceServers: opts.stun ? STUN.map((s) => `stun:${s}`) : [] });
  let candCb: (c: string, mid: string) => void = () => {};
  let chanCb: (ch: Chan) => void = () => {};
  let stateCb: (s: string) => void = () => {};
  let localSdp: ((sdp: string) => void) | undefined;
  pc.onLocalDescription((sdp) => localSdp?.(sdp));
  pc.onLocalCandidate((c, mid) => candCb(c, mid));
  pc.onStateChange((s) => stateCb(s));
  pc.onIceStateChange((s) => stateCb(`ice:${s}`));
  pc.onDataChannel((dc) => {
    // messages can arrive before a handler is set: queue them
    let msgCb: ((d: string | Uint8Array) => void) | undefined;
    const early: (string | Uint8Array)[] = [];
    dc.onMessage((m) => {
      const d = typeof m === "string" ? m : new Uint8Array(m as ArrayBuffer);
      if (msgCb) msgCb(d);
      else early.push(d);
    });
    let closeCb: () => void = () => {};
    dc.onClosed(() => closeCb());
    chanCb({
      // a send on a closed channel throws, and uncaught it ends the process: drop it instead
      send: (d) => {
        if (!dc.isOpen()) return;
        try {
          if (typeof d === "string") dc.sendMessage(d);
          else dc.sendMessageBinary(d);
        } catch {}
      },
      buffered: () => (dc.isOpen() ? dc.bufferedAmount() : 0),
      onLow: (threshold, cb) => {
        dc.setBufferedAmountLowThreshold(threshold);
        dc.onBufferedAmountLow(cb);
      },
      onMessage: (cb) => {
        msgCb = cb;
        for (const d of early.splice(0)) cb(d);
      },
      onClose: (cb) => (closeCb = cb),
      close: () => dc.close(),
    });
  });
  return {
    answer: (offer) =>
      new Promise((resolve) => {
        localSdp = resolve;
        pc.setRemoteDescription(offer, "offer");
      }),
    addCandidate: (c, mid) => pc.addRemoteCandidate(c, mid),
    onCandidate: (cb) => (candCb = cb),
    onChannel: (cb) => (chanCb = cb),
    onState: (cb) => (stateCb = cb),
    selected: () => pc.getSelectedCandidatePair(),
    close: () => pc.close(),
  };
}

async function weriftPeer(opts: { stun: boolean }): Promise<Peer> {
  const { RTCPeerConnection } = await import("werift");
  const pc = new RTCPeerConnection({ iceServers: opts.stun ? STUN.map((s) => ({ urls: `stun:${s}` })) : [] });
  let candCb: (c: string, mid: string) => void = () => {};
  let chanCb: (ch: Chan) => void = () => {};
  pc.onicecandidate = ({ candidate }) => {
    if (candidate?.candidate) candCb(candidate.candidate, candidate.sdpMid ?? "0");
  };
  pc.ondatachannel = ({ channel }) => {
    let msgCb: ((d: string | Uint8Array) => void) | undefined;
    const early: (string | Uint8Array)[] = [];
    channel.onmessage = (e) => {
      const d = typeof e.data === "string" ? e.data : new Uint8Array(e.data);
      if (msgCb) msgCb(d);
      else early.push(d);
    };
    let closeCb: () => void = () => {};
    channel.onclose = () => closeCb();
    chanCb({
      send: (d) => channel.send(typeof d === "string" ? d : Buffer.from(d.buffer, d.byteOffset, d.byteLength)),
      buffered: () => channel.bufferedAmount,
      onLow: (threshold, cb) => {
        channel.bufferedAmountLowThreshold = threshold;
        channel.bufferedAmountLow.subscribe(() => cb());
      },
      onMessage: (cb) => {
        msgCb = cb;
        for (const d of early.splice(0)) cb(d);
      },
      onClose: (cb) => (closeCb = cb),
      close: () => channel.close(),
    });
  };
  let stateCb: (s: string) => void = () => {};
  pc.connectionStateChange.subscribe((s) => stateCb(s));
  return {
    answer: async (offer) => {
      await pc.setRemoteDescription({ type: "offer", sdp: offer });
      await pc.setLocalDescription(await pc.createAnswer());
      return pc.localDescription!.sdp;
    },
    addCandidate: (c, mid) => void pc.addIceCandidate({ candidate: c, sdpMid: mid }),
    onCandidate: (cb) => (candCb = cb),
    onChannel: (cb) => (chanCb = cb),
    onState: (cb) => (stateCb = cb),
    selected: () => {
      const pair = pc.sctpTransport?.dtlsTransport.iceTransport.connection.nominated;
      return pair ? { local: pair.localCandidate.toSdp(), remote: pair.remoteCandidate.toSdp() } : undefined;
    },
    close: () => void pc.close(),
  };
}
