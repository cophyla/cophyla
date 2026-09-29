// The daemon's picture as the host last saw it: the latest `session.state` per live session,
// `workspace.state` per workspace, `node.state`, `remote.state` and `direct.state` per node,
// `task.state` per open task, every open `ask.state`, the latest `voice.state`, the words heard
// so far of this client's utterance (`voice.partial`, whole), the voice engine still being set
// up (`voice.setup`), whether the next reply is read out (`voice.next`), the account
// (`account.state`) and the brain's turn while it runs (`chat.progress`). cophylad sends
// them right after `hello` and never again, and there is no `ask.list`, so a view mounted or
// reloaded later is given this replay instead. Upserts are idempotent; a replay after a live
// notification changes nothing.

import type { Ask, ClientNotificationParams, DirectState, Node, RpcNotification, Session, Task, Workspace } from "@cophyla/protocol";

type VoiceStateParams = ClientNotificationParams<"voice.state">;
type RemoteStateParams = ClientNotificationParams<"remote.state">;
type VoiceSetupParams = ClientNotificationParams<"voice.setup">;
type VoicePartialParams = ClientNotificationParams<"voice.partial">;
type VoiceNextParams = ClientNotificationParams<"voice.next">;
type AccountStateParams = ClientNotificationParams<"account.state">;
type ProgressParams = ClientNotificationParams<"chat.progress">;

export class SnapshotCache {
  readonly sessions = new Map<string, Session>();
  readonly workspaces = new Map<string, Workspace>();
  readonly nodes = new Map<string, Node>();
  /** Each node's desktop host and viewers, by node. */
  readonly remote = new Map<string, RemoteStateParams>();
  /** Each node's direct connections, by node: the account card's switch and state. */
  readonly direct = new Map<string, DirectState>();
  readonly asks = new Map<string, Ask>();
  readonly tasks = new Map<string, Task>();
  /** The latest voice state, replayed after the rest so a view shows the conversation in flight. */
  voice?: VoiceStateParams;
  /**
   * This client's utterance as heard so far, whole: each `voice.partial` sends only what follows
   * the part it keeps, so a view mounted mid-utterance starts from this. Gone once the utterance
   * ends or its message is named.
   */
  heard?: VoicePartialParams;
  /** A voice engine still being set up; a step that ended leaves nothing to show. */
  voiceSetup?: VoiceSetupParams;
  /** Whether the next reply is read out: a view that mounts late shows the speaker as it is. */
  voiceNext?: VoiceNextParams;
  /** The account as the node sees it: a view that mounts late would otherwise say signed out. */
  account?: AccountStateParams;
  /** The brain's turn while it runs; a turn that ended leaves nothing to show. */
  progress?: ProgressParams;

  upsert(n: RpcNotification): void {
    if (n.method === "voice.state") {
      const v = n.params as VoiceStateParams | undefined;
      if (!v || typeof v !== "object" || typeof v.state !== "string") return;
      this.voice = v;
      // The utterance the words were of is over, or a new one begins.
      if ((v.state === "listening" || v.state === "idle") && v.client === this.heard?.client) this.heard = undefined;
      return;
    }
    if (n.method === "voice.partial") {
      const p = n.params as VoicePartialParams | undefined;
      if (!p || typeof p !== "object" || typeof p.text !== "string") return;
      if (p.message !== undefined) this.heard = undefined;
      else this.heard = { ...(p.client !== undefined ? { client: p.client } : {}), text: (this.heard?.text ?? "").slice(0, p.from ?? 0) + p.text };
      return;
    }
    if (n.method === "voice.setup") {
      const v = n.params as VoiceSetupParams | undefined;
      if (!v || typeof v !== "object" || typeof v.step !== "string") return;
      if (v.step === "ready" || v.step === "failed") this.voiceSetup = undefined;
      else this.voiceSetup = v;
      return;
    }
    if (n.method === "voice.next") {
      const v = n.params as VoiceNextParams | undefined;
      if (v && typeof v === "object" && typeof v.speak === "boolean") this.voiceNext = v;
      return;
    }
    if (n.method === "chat.progress") {
      const p = n.params as ProgressParams | undefined;
      this.progress = p && typeof p === "object" && p.turn && typeof p.turn === "object" ? p : undefined;
      return;
    }
    if (n.method === "account.state") {
      const a = n.params as AccountStateParams | undefined;
      if (a && typeof a === "object" && typeof a.plan === "string") this.account = a;
      return;
    }
    if (n.method === "remote.state") {
      const r = n.params as RemoteStateParams | undefined;
      if (r && typeof r === "object" && typeof r.node === "string") this.remote.set(r.node, r);
      return;
    }
    if (n.method === "direct.state") {
      const d = n.params as DirectState | undefined;
      if (d && typeof d === "object" && typeof d.node === "string" && typeof d.state === "string") this.direct.set(d.node, d);
      return;
    }
    const p = n.params as { id?: unknown; status?: unknown } | undefined;
    if (!p || typeof p !== "object" || typeof p.id !== "string") return;
    switch (n.method) {
      case "session.state": {
        const s = n.params as Session;
        if (s.status === "ended") this.sessions.delete(s.id);
        else this.sessions.set(s.id, s);
        return;
      }
      case "workspace.state":
        this.workspaces.set(p.id, n.params as Workspace);
        return;
      case "node.state":
        this.nodes.set(p.id, n.params as Node);
        return;
      case "ask.state": {
        const a = n.params as Ask;
        if (a.status === "open") this.asks.set(a.id, a);
        else this.asks.delete(a.id);
        return;
      }
      case "task.state": {
        const t = n.params as Task;
        if (t.status === "done" || t.status === "cancelled") this.tasks.delete(t.id);
        else this.tasks.set(t.id, t);
        return;
      }
      default:
        return;
    }
  }

  /** In the daemon's post-hello order: asks, sessions, workspaces, nodes and their remote state, tasks, the voice state, the words heard, the setup and the speaker, the account and the nodes' direct connections, then the brain's turn. */
  replay(): RpcNotification[] {
    const out: RpcNotification[] = [];
    for (const ask of this.asks.values()) out.push({ jsonrpc: "2.0", method: "ask.state", params: ask });
    for (const session of this.sessions.values()) out.push({ jsonrpc: "2.0", method: "session.state", params: session });
    for (const workspace of this.workspaces.values()) out.push({ jsonrpc: "2.0", method: "workspace.state", params: workspace });
    for (const node of this.nodes.values()) out.push({ jsonrpc: "2.0", method: "node.state", params: node });
    for (const state of this.remote.values()) out.push({ jsonrpc: "2.0", method: "remote.state", params: state });
    for (const task of this.tasks.values()) out.push({ jsonrpc: "2.0", method: "task.state", params: task });
    if (this.voice) out.push({ jsonrpc: "2.0", method: "voice.state", params: this.voice });
    if (this.heard) out.push({ jsonrpc: "2.0", method: "voice.partial", params: this.heard });
    if (this.voiceSetup) out.push({ jsonrpc: "2.0", method: "voice.setup", params: this.voiceSetup });
    if (this.voiceNext) out.push({ jsonrpc: "2.0", method: "voice.next", params: this.voiceNext });
    if (this.account) out.push({ jsonrpc: "2.0", method: "account.state", params: this.account });
    for (const state of this.direct.values()) out.push({ jsonrpc: "2.0", method: "direct.state", params: state });
    if (this.progress) out.push({ jsonrpc: "2.0", method: "chat.progress", params: this.progress });
    return out;
  }

  clear(): void {
    this.sessions.clear();
    this.workspaces.clear();
    this.nodes.clear();
    this.remote.clear();
    this.direct.clear();
    this.asks.clear();
    this.tasks.clear();
    this.voice = undefined;
    this.heard = undefined;
    this.voiceSetup = undefined;
    this.voiceNext = undefined;
    this.account = undefined;
    this.progress = undefined;
  }
}
