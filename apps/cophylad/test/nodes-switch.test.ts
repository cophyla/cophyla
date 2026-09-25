// The switchable node link on its own: two ends over a relay and a data channel the test
// delivers by hand. Frames keep their order across the switch even when the channel runs
// ahead of the relay; a channel lost with frames in flight has them replayed on the relay,
// each taken once; silence past three seconds falls back, but a wall clock set forward is not
// silence; the side that hears a fallback falls back too; and a channel that stops
// acknowledging ends the link past the cap.

import { describe, expect, spyOn, test } from "bun:test";
import { silentLogger } from "../src/log.ts";
import { LINK_TOO_FAR_BEHIND, SwitchableLink } from "../src/nodes/switch.ts";
import type { LinkChannel, SwitchTimers } from "../src/nodes/switch.ts";

class Clock implements SwitchTimers {
  now = 0;
  private handlers = new Map<number, { every: number; next: number; fn: () => void }>();
  private id = 0;
  setInterval(fn: () => void, ms: number): unknown {
    const id = ++this.id;
    this.handlers.set(id, { every: ms, next: this.now + ms, fn });
    return id;
  }
  clearInterval(h: unknown): void {
    this.handlers.delete(h as number);
  }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.handlers.entries()].filter(([, h]) => h.next <= end).sort((a, b) => a[1].next - b[1].next)[0];
      if (!due) break;
      this.now = due[1].next;
      due[1].next += due[1].every;
      due[1].fn();
    }
    this.now = end;
  }
}

/** One direction of a wire: frames queue until delivered, or are lost. */
class Wire {
  readonly queue: string[] = [];
  onText?: (text: string) => void;
  count = 0;
  send(text: string): void {
    this.queue.push(text);
    this.count++;
  }
  deliver(n = Infinity): void {
    for (let i = 0; i < n && this.queue.length > 0; i++) this.onText?.(this.queue.shift()!);
  }
  drop(): void {
    this.queue.length = 0;
  }
}

class FakeChannel implements LinkChannel {
  closed?: string;
  private out: Wire;
  private onEnd?: (code: number, reason: string) => void;
  constructor(out: Wire, inbound: Wire) {
    this.out = out;
    inbound.onText = (t) => this.onText?.(t);
  }
  onText?: (text: string) => void;
  send(text: string): void {
    if (!this.closed) this.out.send(text);
  }
  close(_code?: number, reason = ""): void {
    this.closed = reason;
  }
  attach(onText: (text: string) => void, onEnd: (code: number, reason: string) => void): void {
    this.onText = onText;
    this.onEnd = onEnd;
  }
  end(reason: string): void {
    this.onEnd?.(1006, reason);
  }
}

function pair() {
  const clock = new Clock();
  const relayAB = new Wire();
  const relayBA = new Wire();
  const got = { a: [] as string[], b: [] as string[] };
  const closes: [string, number][] = [];
  const make = (name: "a" | "b", relayOut: Wire) =>
    new SwitchableLink({
      relay: (t) => (relayOut.send(t), true),
      deliver: (t) => got[name].push(t),
      close: (code) => closes.push([name, code]),
      log: silentLogger,
      timers: clock,
      now: () => clock.now,
      replayCapBytes: 4096,
    });
  const a = make("a", relayAB);
  const b = make("b", relayBA);
  relayAB.onText = (t) => b.fromRelay(t);
  relayBA.onText = (t) => a.fromRelay(t);
  const chAB = new Wire();
  const chBA = new Wire();
  const open = () => {
    const ca = new FakeChannel(chAB, chBA);
    const cb = new FakeChannel(chBA, chAB);
    a.attach(ca);
    b.attach(cb);
    return { ca, cb };
  };
  const flush = () => {
    for (let i = 0; i < 20; i++) {
      relayAB.deliver();
      relayBA.deliver();
      chAB.deliver();
      chBA.deliver();
    }
  };
  return { clock, a, b, got, closes, relayAB, relayBA, chAB, chBA, open, flush };
}

const f = (i: number) => JSON.stringify({ jsonrpc: "2.0", method: "replicate.write", params: { i } });

describe("the switchable node link", () => {
  test("a wall clock set forward (a VM's time sync, an NTP step) is not silence: the channel stays", () => {
    const timers = new Clock();
    const relay = new Wire();
    const wall = spyOn(Date, "now");
    let now = 1_000_000;
    wall.mockImplementation(() => now);
    try {
      const link = new SwitchableLink({ relay: (t) => (relay.send(t), true), deliver: () => undefined, close: () => undefined, log: silentLogger, timers });
      const toLink = new Wire();
      const fromLink = new Wire();
      link.attach(new FakeChannel(fromLink, toLink));
      const ack = JSON.stringify({ jsonrpc: "2.0", method: "link.ack", params: { n: 0 } });
      toLink.send(ack);
      toLink.deliver();
      expect(link.mode).toBe("direct");
      for (let i = 0; i < 5; i++) {
        // each second the wall clock leaps four; the acks keep coming
        now += 4000;
        timers.advance(1000);
        toLink.send(ack);
        toLink.deliver();
      }
      expect(link.mode).toBe("direct");
      expect(link.hasChannel).toBe(true);
      link.shut();
    } finally {
      wall.mockRestore();
    }
  });

  test("switches once each side heard the other on the channel; order holds when the channel runs ahead of the relay", async () => {
    const { a, b, got, relayAB, chAB, chBA, open, flush } = pair();
    a.send(f(1));
    flush();
    open();
    // the hellos cross: both sides switch, each with its last relay frame
    chAB.deliver();
    chBA.deliver();
    expect(a.mode).toBe("direct");
    expect(b.mode).toBe("direct");
    // a's relay is slow: its link.switch has not reached b when a's channel frames do
    a.send(f(2));
    a.send(f(3));
    chAB.deliver();
    expect(got.b).toEqual([f(1)]);
    relayAB.deliver();
    expect(got.b).toEqual([f(1), f(2), f(3)]);
    b.send(f(10));
    flush();
    expect(got.a).toEqual([f(10)]);
    const relayBefore = relayAB.count;
    for (let i = 4; i < 8; i++) a.send(f(i));
    flush();
    expect(relayAB.count).toBe(relayBefore);
    expect(got.b.slice(3)).toEqual([f(4), f(5), f(6), f(7)]);
  });

  test("a channel lost with frames in flight: the fallbacks cross, the lost frames come again on the relay once each, then what was held", () => {
    const { clock, a, b, got, chAB, chBA, relayAB, open, flush } = pair();
    const { ca } = open();
    flush();
    expect(a.mode).toBe("direct");
    a.send(f(1));
    a.send(f(2));
    chAB.deliver(1);
    // acks go out each second: b says it took one
    clock.advance(1000);
    chBA.deliver();
    // f(3) never arrives; a notices the channel go
    a.send(f(3));
    chAB.drop();
    chBA.drop();
    ca.end("the helper went");
    expect(a.mode).toBe("relay");
    a.send(f(4));
    // nothing leaves a but its fallback until b says how far it got
    expect(relayAB.queue.map((t) => JSON.parse(t).method)).toEqual(["link.fallback"]);
    flush();
    expect(got.b).toEqual([f(1), f(2), f(3), f(4)]);
    expect(b.mode).toBe("relay");
    expect(b.hasChannel).toBe(false);
    // the relay carries on both ways
    b.send(f(20));
    a.send(f(5));
    flush();
    expect(got.a).toEqual([f(20)]);
    expect(got.b.at(-1)).toBe(f(5));
  });

  test("silence past three seconds falls back; a new channel switches again and numbering carries on", () => {
    const { clock, a, b, got, chAB, chBA, open, flush } = pair();
    open();
    flush();
    a.send(f(1));
    flush();
    // b's side of the channel stops answering
    chBA.drop();
    clock.advance(1000);
    chBA.drop();
    clock.advance(1000);
    chBA.drop();
    // the tick after three silent seconds
    clock.advance(1000);
    expect(a.mode).toBe("direct");
    chBA.drop();
    clock.advance(1000);
    expect(a.mode).toBe("relay");
    flush();
    expect(b.mode).toBe("relay");
    a.send(f(2));
    flush();
    open();
    flush();
    expect(a.mode).toBe("direct");
    a.send(f(3));
    flush();
    expect(got.b).toEqual([f(1), f(2), f(3)]);
  });

  test("frames not acknowledged past the cap end the link with 4408", () => {
    const { a, closes, chBA, open, flush } = pair();
    open();
    flush();
    for (let i = 0; i < 100 && closes.length === 0; i++) {
      a.send(JSON.stringify({ pad: "z".repeat(200), i }));
      chBA.drop();
    }
    expect(closes).toEqual([["a", LINK_TOO_FAR_BEHIND]]);
  });
});
