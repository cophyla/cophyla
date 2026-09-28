// What a workspace node serves its primary, written out one by one rather than cut from the
// brain's table, so nothing the machine serves its own reaches another person's cluster by
// being added there. Each reads and acts through the workspace node's own views: its
// sessions, workspaces and asks, recall over its own sessions' chunks, its own samples. A
// session is started headless, under the profile the owner named (the primary names none),
// and a spawn's error says what went wrong without the machine's paths. Tools are the
// built-in ones that stay on the machine, run inside the folder. Profiles, events, the
// desktop, direct connections and streams are not served at all.
//
// Rows leave without where the machine keeps a session's transcript, terminal or job.

import { RpcError } from "@cophyla/protocol";
import type { CapabilityRequestName, Hit, MetricsSample, Node, Session } from "@cophyla/protocol";
import type { BrainMethodTable } from "../brain-link/methods.ts";
import type { AsksView } from "../gate/asks.ts";
import type { SessionsView, SpawnOptions } from "../sessions/index.ts";
import type { ToolConfinement, Tools } from "../tools/index.ts";
import type { WorkspacesView } from "../workspaces/index.ts";

/** The capability requests a workspace node answers. */
export const GUEST_SERVED: readonly CapabilityRequestName[] = [
  "node.list",
  "session.list",
  "session.history",
  "session.send",
  "session.spawn",
  "session.stop",
  "ask.answer",
  "annotate",
  "workspace.list",
  "workspace.put",
  "tool.list",
  "tool.run",
  "recall",
  "metrics.query",
];

export interface GuestServeDeps {
  node: () => Node;
  sessions: SessionsView;
  workspaces: WorkspacesView;
  asks: AsksView;
  tools: Pick<Tools, "list" | "risk" | "source" | "run">;
  confine: () => ToolConfinement;
  recall: (p: Parameters<NonNullable<BrainMethodTable["recall"]>["handler"]>[0]) => Promise<Hit[]>;
  metrics?: { latest(): MetricsSample[] };
  /** The profile its sessions run on; absent, each harness's usual one. */
  profile?: string;
  profiles: SpawnOptions["profiles"];
}

/** A session row, or a capability event carrying one, without the machine's transcript, terminal and job. */
export function stripRow(params: unknown): unknown {
  if (params === null || typeof params !== "object") return params;
  const p = params as { native?: unknown; session?: unknown };
  if (typeof p.native === "object" && p.native !== null) return stripSession(params as Session);
  if (typeof p.session === "object" && p.session !== null && typeof (p.session as { native?: unknown }).native === "object") return { ...(params as object), session: stripSession(p.session as Session) };
  return params;
}

function stripSession(s: Session): Session {
  const { transcript: _t, ...rest } = s;
  const { terminal: _term, job: _job, ...native } = s.native;
  return { ...rest, native };
}

/** An error a spawn met, without the machine's paths, commands or configuration in it. */
function spawnError(e: unknown): RpcError {
  const code = e instanceof RpcError ? e.code : "unavailable";
  const message = e instanceof Error ? e.message : String(e);
  // a message that names a path, a program or a folder of the machine's says only what kind of failure it was
  if (/[\\/]|[A-Za-z]:|\.exe\b|\n/.test(message)) return new RpcError(code, code === "not_found" ? "that workspace or profile is not on this node" : "the session could not start on this node");
  return new RpcError(code, message);
}

type Table = { [N in CapabilityRequestName]?: unknown };

export function guestServedTable(deps: GuestServeDeps, primaryId: string): BrainMethodTable {
  const id = () => deps.node().id;
  const t: Table = {
    "node.list": { handler: () => ({ nodes: [deps.node()] }) },
    "session.list": { handler: (p: { filter?: Parameters<SessionsView["list"]>[0] }) => ({ sessions: deps.sessions.list(p.filter ?? {}).map(stripSession) }) },
    "session.history": {
      target: (p: { id: string }) => p.id,
      handler: (p: { id: string; before?: number; around?: number; limit?: number }) => ({
        events: deps.sessions.history(p.id, { ...(p.before !== undefined ? { before: p.before } : {}), ...(p.around !== undefined ? { around: p.around } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}) }),
      }),
    },
    "session.send": {
      target: (p: { id: string }) => p.id,
      handler: (p: { id: string; text: string; as?: "user" | "brain" }) => deps.sessions.send(p.id, p.text, { from: p.as ?? "brain" }),
    },
    "session.spawn": {
      target: (p: { workspace: string }) => p.workspace,
      handler: async (p: { harness: string; workspace: string; prompt: string; model?: unknown; task?: string }) => {
        if (p.harness !== "claude" && p.harness !== "codex" && p.harness !== "muse") throw new RpcError("unsupported", `this node does not run ${p.harness} sessions`);
        try {
          const s = await deps.sessions.spawn(
            {
              harness: p.harness,
              workspace: p.workspace,
              prompt: p.prompt,
              ...(p.model ? { model: p.model as never } : {}),
              ...(p.task !== undefined ? { task: p.task } : {}),
              // the owner's choice, never the primary's
              ...(deps.profile !== undefined ? { profile: deps.profile } : {}),
            },
            { profiles: deps.profiles },
          );
          return { id: s.id };
        } catch (e) {
          throw spawnError(e);
        }
      },
    },
    "session.stop": {
      target: (p: { id: string }) => p.id,
      handler: async (p: { id: string; as?: "user" | "brain" }) => {
        await deps.sessions.stopSession(p.id, { as: p.as ?? "brain" });
        return {};
      },
    },
    "ask.answer": {
      target: (p: { id: string }) => p.id,
      handler: (p: { id: string; option: string; options?: string[]; text?: string }) => {
        const input: { option: string; options?: string[]; text?: string } = { option: p.option };
        if (p.options !== undefined) input.options = p.options;
        if (p.text !== undefined) input.text = p.text;
        deps.asks.answer(p.id, input, { kind: "node", id: primaryId });
        return {};
      },
    },
    annotate: {
      target: (p: { on: string }) => p.on,
      handler: (p: { on: string; intent?: string; summary?: string; tags?: string[] }) => {
        const patch = Object.fromEntries(Object.entries({ intent: p.intent, summary: p.summary, tags: p.tags }).filter(([, v]) => v !== undefined));
        if (p.on.startsWith("sess_")) deps.sessions.annotate(p.on, patch);
        else if (p.on.startsWith("ws_")) deps.workspaces.annotate(p.on, { ...(p.summary !== undefined ? { summary: p.summary } : {}), ...(p.tags !== undefined ? { tags: p.tags } : {}) });
        else throw new RpcError("not_found", `no ${p.on} on this node`);
        return {};
      },
    },
    "workspace.list": { handler: () => ({ workspaces: deps.workspaces.list() }) },
    "workspace.put": {
      target: (p: { path: string }) => p.path,
      handler: (p: { id?: string; node: string; path: string; name: string }) => ({ id: deps.workspaces.put(p).id }),
    },
    // What stays on the machine: no editable tool of the owner's, nothing that reaches the network.
    "tool.list": { handler: () => ({ tools: deps.tools.list().filter((x) => x.source !== "editable" && x.risk !== "network").map((x) => ({ ...x, node: id() })) }) },
    "tool.run": {
      target: (p: { name: string }) => p.name,
      risk: (p: { name: string }) => deps.tools.risk(p.name),
      handler: async (p: { name: string; args: unknown }, ctx: { signal: AbortSignal }) => ({ result: await deps.tools.run(p.name, p.args, { signal: ctx.signal, confine: deps.confine(), workspaces: deps.workspaces }) }),
    },
    recall: { handler: (p: Parameters<GuestServeDeps["recall"]>[0]) => deps.recall(p).then((hits) => ({ hits })) },
    "metrics.query": {
      target: (p: { node: string }) => p.node,
      handler: (p: { node: string }) => {
        if (p.node !== id()) throw new RpcError("not_found", `no node ${p.node} here`);
        if (!deps.metrics) throw new RpcError("unsupported", "this node keeps no metrics");
        return { samples: deps.metrics.latest() };
      },
    },
  };
  for (const name of Object.keys(t)) if (!GUEST_SERVED.includes(name as CapabilityRequestName)) throw new Error(`guest table serves ${name}, which is not in GUEST_SERVED`);
  return t as BrainMethodTable;
}
