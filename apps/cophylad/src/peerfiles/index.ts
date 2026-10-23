// `peerfiles`: files between two people's Cophylas (the protocol's peer-files.ts), on the
// primary, which alone holds the links to a teammate's side and to a connection's far end.
//
// Out: an agent of this user's sends a file or a folder to another person's agent, a teammate's
// open one or the one its terminal is connected to (`send_file` to `login/name`). The file stays
// where it is: this side keeps an offer for it (kv `peer-files`, good for a day after its last
// read) and tells the other side, which pulls it, what it holds a page at a time and then a
// piece at a time, read here from whichever of this user's machines it is on. Only a file this
// side offered that side, or one posted in a group that side is in, is ever read for it. When it
// lands there or fails, the agent that sent it is told.
//
// In: the other side's agent sent one of this user's agents a file. It lands at once in the
// Downloads folder of that agent's machine, and the agent is told where; one over 1 GB asks
// the user first. Its bytes come through this primary: a transfer to another of the user's
// machines reads them through it (the node link's `peer.file.*`), for a file the primary started
// that transfer for (kv `peer-pulls`) and no other. Saving a file another side posted in a group
// goes the same way.

import { FILE_PIECE_BYTES, newId, peerFileRequests, RpcError } from "@cophyla/protocol";
import type { AskOption, FilePiece, FileTreePage, PeerFileSend, PeerSource, Session, Transfer, TransferConfirm } from "@cophyla/protocol";
import type { EnvelopeInfo } from "../agentmsg/envelope.ts";
import type { Bus } from "../bus.ts";
import { PEER_FILES_NS, PEER_PULLS_NS } from "../grants/namespaces.ts";
import type { Asks } from "../gate/asks.ts";
import type { Gate } from "../gate/index.ts";
import type { Groups, SaveStart } from "../groups/index.ts";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";
import type { TreePage } from "../transfers/tree.ts";

/** How long an offer is read for, from its last read. */
const OFFER_MS = 24 * 60 * 60_000;
/** How long an offer is read for at most, however often it is read: a side that never says it is done reads no longer. */
const OFFER_MAX_MS = 7 * 24 * 60 * 60_000;
/** How long a machine may read what the primary started a transfer of for it. */
const PULL_MS = 7 * 24 * 60 * 60_000;
/** Bytes over which a file from another person waits for the user's word. */
export const PEER_ASK_BYTES = 1024 ** 3;
/** How long the user has to take or turn down a big one. */
const ASK_MS = 24 * 60 * 60_000;
/** Files one side may send the other in a day, each way. */
const PER_DAY = 100;
const SWEEP_MS = 10 * 60_000;

export type PeerKind = "teammate" | "connection";

/** The other side a request came on or goes to: the teammate or the connection, its person, and a teammate's account. */
export interface PeerLink {
  kind: PeerKind;
  id: string;
  user: string;
  owner?: string;
}

/** A file this side offered another person's agent. */
interface Offer {
  id: string;
  peer: { kind: PeerKind; id: string };
  src: { node: string; path: string };
  name: string;
  kind: "file" | "folder";
  total: number;
  /** Its name there, and the agent here that sent it. */
  to: string;
  from: { session: string; alias: string };
  /** When it was made, its last read, and until when it is read. */
  made: number;
  at: number;
  until: number;
}

/** A file of another person's a machine of this user's may read through the primary. */
interface Pull {
  node: string;
  src: PeerSource;
  /** The transfer it is for, once started: how it ends goes back to the sender. */
  transfer?: string;
  until: number;
}

export interface PeerFilesDeps {
  store: Store;
  bus: Pick<Bus, "on">;
  log: Logger;
  selfId: () => string;
  /** A machine's name, for the words. */
  nodeName: (node: string) => string;
  /** What a path on one of this user's machines holds, a page at a time. */
  tree: (node: string, path: string, from?: number) => Promise<TreePage>;
  /** A piece of a file on one of this user's machines. */
  read: (node: string, path: string, rel: string | undefined, at: number) => Promise<{ data: Uint8Array; size: number; mtimeMs: number }>;
  /** A file request to the other person's Cophyla, on that link's tunnel, paced with its messages. */
  request: (peer: { kind: PeerKind; id: string }, method: "send" | "tree" | "read" | "done", params: unknown) => Promise<unknown>;
  groups: () => Groups | undefined;
  /** A transfer started on the machine it goes to. */
  start: (p: SaveStart) => Promise<{ transfer?: Transfer; confirm?: TransferConfirm }>;
  /** Cophyla's own words into a session of this user's, wherever it runs. */
  tell: (session: string, text: string, info: EnvelopeInfo) => Promise<void>;
  asks?: Pick<Asks, "open" | "wait">;
  /** Audits a file coming in, as the system's. */
  gate?: Pick<Gate, "run">;
  now?: () => number;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Words from the other side, put in a line of this side's: one line, no markup, at most `max` characters. */
export function theirWords(text: string, max: number): string {
  const line = text
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** Bytes as a person reads them. */
export function sizeWords(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

const pullKey = (node: string, src: Pick<PeerSource, "kind" | "id" | "file">) => `${node} ${src.kind} ${src.id} ${src.file}`;

export class PeerFiles {
  private deps: PeerFilesDeps;
  private log: Logger;
  private now: () => number;
  private days = new Map<string, { day: string; in: number; out: number }>();
  private timer?: ReturnType<typeof setInterval>;
  private offs: (() => void)[] = [];

  constructor(deps: PeerFilesDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.offs.push(this.deps.bus.on("transfer.state", (t) => this.onTransfer(t)));
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const off of this.offs.splice(0)) off();
  }

  private get kv(): Store["kv"] {
    return this.deps.store.kv;
  }

  private day(peer: { kind: PeerKind; id: string }): { day: string; in: number; out: number } {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const key = `${peer.kind}:${peer.id}`;
    let d = this.days.get(key);
    if (!d || d.day !== today) this.days.set(key, (d = { day: today, in: 0, out: 0 }));
    return d;
  }

  // --- out: a file of this user's, for another person's agent ------------------------------------

  /**
   * An agent of this side sends another person's agent `src`, which `what` says holds: offered
   * there, and pulled by that side. Answered as that side took it: pulling it now, or asking its
   * user first.
   */
  async offer(caller: Session, alias: string, p: { src: { node: string; path: string }; what: { kind: "file" | "folder"; name: string; total: number; files: number }; reason?: string; peer: PeerLink; to: string }): Promise<"sending" | "asked"> {
    const day = this.day(p.peer);
    if (day.out >= PER_DAY) throw new RpcError("denied", `your agents sent ${p.peer.user} ${PER_DAY} files today, the most in a day`);
    const at = this.now();
    const offer: Offer = { id: newId("peerFile"), peer: { kind: p.peer.kind, id: p.peer.id }, src: p.src, name: p.what.name, kind: p.what.kind, total: p.what.total, to: p.to, from: { session: caller.id, alias }, made: at, at, until: at + OFFER_MS };
    this.kv.put(PEER_FILES_NS, offer.id, offer);
    const send: PeerFileSend = {
      file: offer.id,
      to: p.to,
      name: p.what.name.slice(0, 255),
      kind: p.what.kind,
      total: p.what.total,
      files: p.what.files,
      ...(p.reason ? { reason: p.reason } : {}),
      from: { name: alias.slice(0, 120), harness: caller.harness },
      sentAt: at,
    };
    try {
      const r = peerFileRequests.send.result.parse(await this.deps.request(p.peer, "send", send));
      day.out++;
      this.log.info("a file offered to another person's agent", { file: offer.id, peer: p.peer.kind, to: `${p.peer.user}/${p.to}`, bytes: p.what.total, status: r.status });
      return r.status;
    } catch (e) {
      this.kv.delete(PEER_FILES_NS, offer.id);
      throw e;
    }
  }

  /** Where a file the other side asks to read is: an offer of this side's to it, or a file of a group's post both are in. */
  private sourceFor(peer: PeerLink, ref: { file: string; group?: string }): { node: string; path: string } {
    if (ref.file.startsWith("pfile_")) {
      const o = this.kv.get(PEER_FILES_NS, ref.file) as Offer | undefined;
      if (!o || o.peer.kind !== peer.kind || o.peer.id !== peer.id) throw new RpcError("not_found", "no such file offered to you");
      if (o.until <= this.now()) {
        this.kv.delete(PEER_FILES_NS, o.id);
        throw new RpcError("not_found", "the file was offered more than a day ago: ask for it again");
      }
      // read lately: it is read on for another day, and never past a week from when it was made
      if (this.now() - o.at > 60_000) this.kv.put(PEER_FILES_NS, o.id, { ...o, at: this.now(), until: Math.min(this.now() + OFFER_MS, (o.made ?? o.at) + OFFER_MAX_MS) });
      return o.src;
    }
    if (!ref.group || peer.kind !== "teammate" || !peer.owner) throw new RpcError("not_found", "no such file offered to you");
    const groups = this.deps.groups();
    if (!groups) throw new RpcError("unavailable", "group chats are off here");
    return groups.fileSource(peer.owner, ref.group, ref.file);
  }

  /** What a file the other side may read holds, a page at a time. */
  async serveTree(peer: PeerLink, ref: { file: string; group?: string; from?: number }): Promise<FileTreePage> {
    const src = this.sourceFor(peer, ref);
    const p = await this.deps.tree(src.node, src.path, ref.from);
    return { ...p, name: p.name.slice(0, 255) };
  }

  /** A piece of a file the other side may read. */
  async serveRead(peer: PeerLink, ref: { file: string; group?: string; rel?: string; at: number }): Promise<FilePiece> {
    const src = this.sourceFor(peer, ref);
    const r = await this.deps.read(src.node, src.path, ref.rel, ref.at);
    return { data: Buffer.from(r.data).toString("base64"), size: r.size, mtimeMs: r.mtimeMs };
  }

  /** How a file this side offered ended on the other side: its sender is told, and the offer goes. */
  async doneThere(peer: PeerLink, d: { file: string; ok: boolean; why?: string }): Promise<void> {
    const o = this.kv.get(PEER_FILES_NS, d.file) as Offer | undefined;
    if (!o || o.peer.kind !== peer.kind || o.peer.id !== peer.id) return;
    this.kv.delete(PEER_FILES_NS, o.id);
    const what = o.kind === "folder" ? `the folder ${o.name}` : o.name;
    const to = `${peer.user}/${o.to}`;
    const text = d.ok ? `${what} reached ${to}: it landed on their machine, and they were told where.` : `${what} did not reach ${to}. Their Cophyla says: "${theirWords(d.why ?? "it failed there", 200)}"`;
    try {
      await this.deps.tell(o.from.session, text, { messageId: newId("agentMessage") });
    } catch (e) {
      this.log.info("the sender of a file was not told how it ended", { file: o.id, error: message(e) });
    }
  }

  // --- in: a file of another person's, for one of this user's agents --------------------------------

  /**
   * The other side's agent sent `target`, one of this user's agents, a file: pulled at once into
   * the Downloads folder of its machine, or, over PEER_ASK_BYTES, once the user says so.
   */
  async incoming(peer: PeerLink, p: PeerFileSend, target: Session): Promise<{ status: "sending" | "asked" }> {
    const day = this.day(peer);
    if (day.in >= PER_DAY) throw new RpcError("denied", `${PER_DAY} files in a day is the most this side takes from you`);
    day.in++;
    const agent = theirWords(p.from.name, 60) || "agent";
    const src: PeerSource = { kind: peer.kind, id: peer.id, file: p.file, user: peer.user, agent };
    const from = `${peer.user}/${agent}`;
    // audited as it comes in, as a message from another person is
    if (this.deps.gate) await this.deps.gate.run({ principal: { kind: "system" }, action: "peer.file.receive", target: target.id, args: { from, name: theirWords(p.name, 255), kind: p.kind, bytes: p.total, ...(p.reason ? { reason: theirWords(p.reason, 120) } : {}), via: peer.kind } }, () => undefined);
    const go = async (relayOk: boolean) => {
      this.allowPull(target.node, src);
      const r = await this.deps.start({ from: { node: this.deps.selfId(), path: p.name }, to: { node: target.node }, ...(p.reason ? { reason: p.reason } : {}), ...(relayOk ? { relayOk: true } : {}), by: { kind: "user" }, notify: target.id, peer: src });
      if (r.transfer) this.tracked(target.node, src, r.transfer.id);
      else throw new RpcError("unavailable", "the transfer did not start");
    };
    if (p.total <= PEER_ASK_BYTES) {
      await go(false);
      this.log.info("a file from another person's agent is coming", { peer: peer.kind, from, to: target.id, bytes: p.total });
      return { status: "sending" };
    }
    const asks = this.deps.asks;
    if (!asks) throw new RpcError("unavailable", "no one can be asked about a file this big here");
    const now = this.now();
    const options: AskOption[] = [
      { id: "allow", label: "Take it", style: "primary" },
      { id: "deny", label: "Don't", style: "danger" },
    ];
    const ask = asks.open(
      {
        type: "choice",
        source: { kind: "harness", session: target.id },
        title: `Take ${p.kind === "folder" ? `the folder ${theirWords(p.name, 120)}` : theirWords(p.name, 120)} (${sizeWords(p.total)}) from ${from}?`,
        detail: `${p.reason ? `${theirWords(p.reason, 120)}\n` : ""}${peer.user}'s agent sends it to your agent; it comes through the Cophyla server's relay into the Downloads folder on ${this.deps.nodeName(target.node)}.`,
        options,
        answerableBy: ["user"],
        expiresAt: now + ASK_MS,
      },
      now,
      this.deps.selfId(),
    );
    void asks.wait(ask.id).then(
      async (settled) => {
        if (settled.status === "answered" && settled.answer?.option === "allow") {
          try {
            await go(true);
            return;
          } catch (e) {
            await this.tellDone(peer, p.file, false, `it could not start there: ${message(e)}`);
            return;
          }
        }
        await this.tellDone(peer, p.file, false, settled.status === "expired" ? "no one answered for a day on their side" : "the person it was for turned it down");
      },
      () => undefined,
    );
    return { status: "asked" };
  }

  /** Tells the other side how a file it sent ended here. */
  private async tellDone(peer: { kind: PeerKind; id: string }, file: string, ok: boolean, why?: string): Promise<void> {
    if (!file.startsWith("pfile_")) return;
    try {
      await this.deps.request(peer, "done", { file, ok, ...(why ? { why: why.slice(0, 300) } : {}) });
    } catch (e) {
      this.log.info("the other side was not told how its file ended", { file, error: message(e) });
    }
  }

  /**
   * A transfer of another person's file started on one of this user's machines, which may then
   * read it through the primary (a group's file saved from another side): its pull allowed first,
   * since the machine asks as soon as it starts, and dropped when it ends.
   */
  async startPull(p: SaveStart & { peer: PeerSource }): Promise<{ transfer?: Transfer; confirm?: TransferConfirm }> {
    this.allowPull(p.to.node, p.peer);
    const r = await this.deps.start(p);
    if (r.transfer) this.tracked(p.to.node, p.peer, r.transfer.id);
    return r;
  }

  /** A machine of this user's may read `src` through the primary, for a transfer started for it. */
  allowPull(node: string, src: PeerSource): void {
    const key = pullKey(node, src);
    const was = this.kv.get(PEER_PULLS_NS, key) as Pull | undefined;
    this.kv.put(PEER_PULLS_NS, key, { ...(was ?? {}), node, src, until: this.now() + PULL_MS } satisfies Pull);
  }

  private tracked(node: string, src: PeerSource, transfer: string): void {
    const key = pullKey(node, src);
    const was = this.kv.get(PEER_PULLS_NS, key) as Pull | undefined;
    this.kv.put(PEER_PULLS_NS, key, { node, src, transfer, until: was?.until ?? this.now() + PULL_MS } satisfies Pull);
  }

  /** Whether a machine was let read `src`: the primary started a transfer of it there. */
  mayPull(node: string, src: PeerSource): boolean {
    const v = this.kv.get(PEER_PULLS_NS, pullKey(node, src)) as Pull | undefined;
    return v !== undefined && v.until > this.now() && v.src.user === src.user;
  }

  /** What a file of another person's holds, a page at a time, asked of their side. */
  async pullTree(src: PeerSource, from?: number): Promise<TreePage> {
    const r = peerFileRequests.tree.result.parse(await this.deps.request(src, "tree", { file: src.file, ...(src.group ? { group: src.group } : {}), ...(from !== undefined ? { from } : {}) }));
    return r;
  }

  /** A piece of a file of another person's, asked of their side. */
  async pullRead(src: PeerSource, rel: string | undefined, at: number): Promise<{ data: Uint8Array; size: number; mtimeMs: number }> {
    const r = peerFileRequests.read.result.parse(await this.deps.request(src, "read", { file: src.file, ...(src.group ? { group: src.group } : {}), ...(rel !== undefined ? { rel } : {}), at }));
    const data = new Uint8Array(Buffer.from(r.data, "base64"));
    if (data.length > FILE_PIECE_BYTES) throw new RpcError("invalid", "a piece past its limit");
    return { data, size: r.size, mtimeMs: r.mtimeMs };
  }

  /** A transfer of a file another person sent ended: they are told, once, and the machine reads it no more. */
  private onTransfer(t: Transfer): void {
    const ended = t.dismissed === true || t.state === "done" || t.state === "failed" || t.state === "cancelled";
    if (!ended || !t.peer) return;
    for (const key of this.kv.list(PEER_PULLS_NS)) {
      const v = this.kv.get(PEER_PULLS_NS, key) as Pull | undefined;
      if (!v || v.transfer !== t.id) continue;
      // a failed one may be tried again: its machine keeps reading it until it is dismissed
      if (t.state === "failed" && !t.dismissed) continue;
      this.kv.delete(PEER_PULLS_NS, key);
      if (t.dismissed && t.state === "done") continue;
      const ok = t.state === "done";
      void this.tellDone(v.src, v.src.file, ok, ok ? undefined : t.state === "cancelled" ? "the person it was for stopped it" : (t.error ?? "it failed"));
    }
  }

  private sweep(): void {
    const at = this.now();
    for (const key of this.kv.list(PEER_FILES_NS)) {
      const v = this.kv.get(PEER_FILES_NS, key) as Offer | undefined;
      if (!v || v.until <= at) this.kv.delete(PEER_FILES_NS, key);
    }
    for (const key of this.kv.list(PEER_PULLS_NS)) {
      const v = this.kv.get(PEER_PULLS_NS, key) as Pull | undefined;
      if (!v || v.until <= at) this.kv.delete(PEER_PULLS_NS, key);
    }
  }
}
