// `annotate`, routed by the id's prefix to the session, thread or workspace it names: the
// brain's capability request, from this node's brain or forwarded by the primary's. It sets
// a session's intent, a thread's topic and workspace, and the summary and tags the archive
// writes, which are the brain's alone: a client never gets them. Each owner module stores
// the row and raises its `*.state`.

import { RpcError } from "@cophyla/protocol";
import type { Chat } from "./chat/index.ts";
import type { Sessions } from "./sessions/index.ts";
import type { Workspaces } from "./workspaces/index.ts";

export interface AnnotateDeps {
  sessions: Pick<Sessions, "annotate">;
  chat: Pick<Chat, "annotateThread">;
  workspaces: Pick<Workspaces, "annotate">;
}

export interface AnnotateInput {
  on: string;
  intent?: string;
  topic?: string;
  workspace?: string;
  summary?: string;
  tags?: string[];
}

const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export function annotate(deps: AnnotateDeps, p: AnnotateInput): void {
  const { summary, tags } = p;
  if (p.on.startsWith("sess_")) deps.sessions.annotate(p.on, defined({ intent: p.intent, summary, tags }));
  else if (p.on.startsWith("thr_")) deps.chat.annotateThread(p.on, defined({ topic: p.topic, workspace: p.workspace, summary, tags }));
  else if (p.on.startsWith("ws_")) deps.workspaces.annotate(p.on, defined({ summary, tags }));
  else throw new RpcError("invalid", `annotate: ${p.on} is not a session, thread or workspace`);
}
