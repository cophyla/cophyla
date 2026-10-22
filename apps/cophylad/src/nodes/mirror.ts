// What the primary holds of each linked node: its live sessions, open asks, workspaces,
// running terminals, update states and the transfers it receives, filled at the join and kept
// by the upward stream. The forwarder asks it which node owns a session, an ask, a workspace,
// a terminal or a transfer; the merged lists come from it; when a node drops, its sessions are
// announced ended, its terminals exited and its asks cancelled, so no client keeps a row
// nothing will update. Its transfers stay, the unfinished ones waiting for it, until it joins
// again with its own.

import type { Ask, ClientNotificationParams, Session, Terminal, Transfer, Workspace } from "@cophyla/protocol";

type UpdateState = ClientNotificationParams<"update.state">;

interface NodeMirror {
  sessions: Map<string, Session>;
  asks: Map<string, Ask>;
  workspaces: Map<string, Workspace>;
  terminals: Map<string, Terminal>;
  updates: Map<string, UpdateState>;
  transfers: Map<string, Transfer>;
}

const fresh = (): NodeMirror => ({ sessions: new Map(), asks: new Map(), workspaces: new Map(), terminals: new Map(), updates: new Map(), transfers: new Map() });

/** A transfer its machine came back without: it failed there, and its row goes from every list. */
function lost(t: Transfer, now: number): Transfer {
  const { rate: _rate, ...rest } = t;
  return { ...rest, state: "failed", error: "its machine stopped before it kept this transfer: send it again", endedAt: now, dismissed: true };
}

/** A transfer whose machine went away, as its row says until the machine is back. */
function away(t: Transfer): Transfer {
  if (t.state !== "running" && t.state !== "queued" && t.state !== "waiting") return t;
  const { rate: _rate, ...rest } = t;
  return { ...rest, state: "waiting", error: "its machine is offline" };
}

export class Mirror {
  private nodes = new Map<string, NodeMirror>();
  /** The transfers of nodes that went, by node. */
  private gone = new Map<string, Map<string, Transfer>>();
  /** Transfers the user ended while their machine was away: held out of every list until they end there. */
  private held = new Set<string>();

  private of(node: string): NodeMirror {
    let m = this.nodes.get(node);
    if (!m) this.nodes.set(node, (m = fresh()));
    return m;
  }

  /** A node's lists at its join, replacing whatever was mirrored before. */
  /**
   * A node's rows at its join, replacing what was mirrored of it. Returns the transfers it was
   * known to hold under way that its join no longer lists, ended as failed and dismissed: its
   * machine stopped before it kept them, and no one could cancel or retry them there. A node
   * whose join lists no transfers at all (an older one) loses none.
   */
  fill(node: string, lists: { sessions: Session[]; workspaces: Workspace[]; asks: Ask[]; terminals?: Terminal[]; transfers?: Transfer[] }, now = Date.now(), held: string[] = []): Transfer[] {
    for (const id of held) this.held.add(id);
    const before = [...(this.nodes.get(node)?.transfers.values() ?? []), ...(this.gone.get(node)?.values() ?? [])];
    const m = fresh();
    for (const s of lists.sessions) if (s.status !== "ended") m.sessions.set(s.id, s);
    for (const w of lists.workspaces) m.workspaces.set(w.id, w);
    for (const a of lists.asks) if (a.status === "open") m.asks.set(a.id, a);
    for (const t of lists.terminals ?? []) if (t.status === "running") m.terminals.set(t.id, t);
    for (const t of lists.transfers ?? []) if (!t.dismissed && !this.held.has(t.id)) m.transfers.set(t.id, t);
    this.nodes.set(node, m);
    this.gone.delete(node);
    if (!lists.transfers) return [];
    const listed = new Set(lists.transfers.map((t) => t.id));
    return before.filter((t) => !listed.has(t.id) && (t.state === "queued" || t.state === "running" || t.state === "waiting")).map((t) => lost(t, now));
  }

  /** One upward notification: the row it carries replaces the mirrored one, or drops it when it ended or closed. */
  apply(node: string, method: string, params: unknown): void {
    const m = this.of(node);
    switch (method) {
      case "session.state": {
        const s = params as Session;
        if (s.status === "ended") m.sessions.delete(s.id);
        else m.sessions.set(s.id, s);
        break;
      }
      case "ask.state": {
        const a = params as Ask;
        if (a.status === "open") m.asks.set(a.id, a);
        else m.asks.delete(a.id);
        break;
      }
      case "workspace.state": {
        const w = params as Workspace;
        m.workspaces.set(w.id, w);
        break;
      }
      case "terminal.state": {
        const t = params as Terminal;
        if (t.status === "running") m.terminals.set(t.id, t);
        else m.terminals.delete(t.id);
        break;
      }
      case "update.state": {
        const u = params as UpdateState;
        m.updates.set(`${u.component}:${u.name ?? ""}`, u);
        break;
      }
      case "transfer.state": {
        const t = params as Transfer;
        if (t.dismissed) m.transfers.delete(t.id);
        else m.transfers.set(t.id, t);
        break;
      }
      default:
        break;
    }
  }

  /** Forgets a node; returns what it held, so the owner can announce the ends: its transfers as they now stand, kept here. */
  drop(node: string): { sessions: Session[]; asks: Ask[]; terminals: Terminal[]; transfers: Transfer[] } {
    const m = this.nodes.get(node);
    this.nodes.delete(node);
    const transfers = m ? [...m.transfers.values()].map(away) : [];
    if (transfers.length > 0) this.gone.set(node, new Map(transfers.map((t) => [t.id, t])));
    const changed = m ? transfers.filter((t) => t !== m.transfers.get(t.id)) : [];
    return { sessions: m ? [...m.sessions.values()] : [], asks: m ? [...m.asks.values()] : [], terminals: m ? [...m.terminals.values()] : [], transfers: changed };
  }

  ownerOfSession(id: string): string | undefined {
    for (const [node, m] of this.nodes) if (m.sessions.has(id)) return node;
    return undefined;
  }

  ownerOfAsk(id: string): string | undefined {
    for (const [node, m] of this.nodes) if (m.asks.has(id)) return node;
    return undefined;
  }

  ownerOfWorkspace(id: string): string | undefined {
    for (const [node, m] of this.nodes) if (m.workspaces.has(id)) return node;
    return undefined;
  }

  /** A node's terminal as its last row told it, while it runs. */
  terminal(node: string, id: string): Terminal | undefined {
    return this.nodes.get(node)?.terminals.get(id);
  }

  ownerOfTerminal(id: string): string | undefined {
    for (const [node, m] of this.nodes) if (m.terminals.has(id)) return node;
    return undefined;
  }

  /** The machine a transfer goes to, linked or gone. */
  ownerOfTransfer(id: string): string | undefined {
    for (const [node, m] of this.nodes) if (m.transfers.has(id)) return node;
    for (const [node, kept] of this.gone) if (kept.has(id)) return node;
    return undefined;
  }

  /** A transfer of a node that went, as its row last stood. */
  goneTransfer(id: string): { node: string; transfer: Transfer } | undefined {
    for (const [node, kept] of this.gone) {
      const transfer = kept.get(id);
      if (transfer) return { node, transfer };
    }
    return undefined;
  }

  /** Forgets a gone node's transfer: the user ended it here. */
  forgetGone(id: string): void {
    for (const [node, kept] of this.gone) if (kept.delete(id) && kept.size === 0) this.gone.delete(node);
  }

  /**
   * Whether `t` is held out of the lists: what its machine says of it before it ends there is
   * not news. Its dismissal lets the hold go.
   */
  holds(t: Transfer): boolean {
    if (!this.held.has(t.id)) return false;
    if (t.dismissed) this.held.delete(t.id);
    return true;
  }

  /** Lets a hold go: the transfer could not be ended on its machine, so the user sees it again. */
  release(id: string): void {
    this.held.delete(id);
  }

  /** Every linked node's transfers, and those of nodes that went. */
  transfers(): Transfer[] {
    return [...[...this.nodes.values()].flatMap((m) => [...m.transfers.values()]), ...[...this.gone.values()].flatMap((kept) => [...kept.values()])];
  }

  ask(id: string): Ask | undefined {
    for (const m of this.nodes.values()) {
      const a = m.asks.get(id);
      if (a) return a;
    }
    return undefined;
  }

  sessions(): Session[] {
    return [...this.nodes.values()].flatMap((m) => [...m.sessions.values()]);
  }

  asks(): Ask[] {
    return [...this.nodes.values()].flatMap((m) => [...m.asks.values()]);
  }

  workspaces(): Workspace[] {
    return [...this.nodes.values()].flatMap((m) => [...m.workspaces.values()]);
  }

  terminals(): Terminal[] {
    return [...this.nodes.values()].flatMap((m) => [...m.terminals.values()]);
  }

  updates(): UpdateState[] {
    return [...this.nodes.values()].flatMap((m) => [...m.updates.values()]);
  }

  nodeIds(): string[] {
    return [...this.nodes.keys()];
  }
}
