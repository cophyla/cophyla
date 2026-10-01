// What the primary holds of each linked node: its live sessions, open asks, workspaces,
// running terminals and update states, filled at the join and kept by the upward stream. The
// forwarder asks it which node owns a session, an ask, a workspace or a terminal; the merged
// lists come from it; when a node drops, its sessions are announced ended, its terminals
// exited and its asks cancelled, so no client keeps a row nothing will update.

import type { Ask, ClientNotificationParams, Session, Terminal, Workspace } from "@cophyla/protocol";

type UpdateState = ClientNotificationParams<"update.state">;

interface NodeMirror {
  sessions: Map<string, Session>;
  asks: Map<string, Ask>;
  workspaces: Map<string, Workspace>;
  terminals: Map<string, Terminal>;
  updates: Map<string, UpdateState>;
}

const fresh = (): NodeMirror => ({ sessions: new Map(), asks: new Map(), workspaces: new Map(), terminals: new Map(), updates: new Map() });

export class Mirror {
  private nodes = new Map<string, NodeMirror>();

  private of(node: string): NodeMirror {
    let m = this.nodes.get(node);
    if (!m) this.nodes.set(node, (m = fresh()));
    return m;
  }

  /** A node's lists at its join, replacing whatever was mirrored before. */
  fill(node: string, lists: { sessions: Session[]; workspaces: Workspace[]; asks: Ask[]; terminals?: Terminal[] }): void {
    const m = fresh();
    for (const s of lists.sessions) if (s.status !== "ended") m.sessions.set(s.id, s);
    for (const w of lists.workspaces) m.workspaces.set(w.id, w);
    for (const a of lists.asks) if (a.status === "open") m.asks.set(a.id, a);
    for (const t of lists.terminals ?? []) if (t.status === "running") m.terminals.set(t.id, t);
    this.nodes.set(node, m);
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
      default:
        break;
    }
  }

  /** Forgets a node; returns what it held, so the owner can announce the ends. */
  drop(node: string): { sessions: Session[]; asks: Ask[]; terminals: Terminal[] } {
    const m = this.nodes.get(node);
    this.nodes.delete(node);
    return { sessions: m ? [...m.sessions.values()] : [], asks: m ? [...m.asks.values()] : [], terminals: m ? [...m.terminals.values()] : [] };
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

  ownerOfTerminal(id: string): string | undefined {
    for (const [node, m] of this.nodes) if (m.terminals.has(id)) return node;
    return undefined;
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
