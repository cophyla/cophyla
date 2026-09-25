// What a target names, looked up the one way everything here does it: a session, an ask or a
// workspace this node holds itself, else the one a linked node's mirror holds. The access
// checks read it (which node, workspace and folder a request or a row is about), and so does
// the forwarder (which node a request goes to), so the two can never disagree about who owns
// what.

import { askTarget } from "@cophyla/protocol";
import type { Ask, Session, TargetLookup, Workspace } from "@cophyla/protocol";

export interface LookupSources {
  /** This node's id. */
  self: () => string;
  session(id: string): Session | undefined;
  ask(id: string): Ask | undefined;
  workspace(id: string): Workspace | undefined;
}

export function targetLookup(src: LookupSources): TargetLookup {
  return {
    get self() {
      return src.self();
    },
    session: (id) => {
      const s = src.session(id);
      return s ? { node: s.node, path: s.cwd, ...(s.workspace !== undefined ? { workspace: s.workspace } : {}) } : undefined;
    },
    ask: (id) => {
      const a = src.ask(id);
      return a ? askTarget(a) : undefined;
    },
    workspace: (id) => {
      const w = src.workspace(id);
      return w ? { node: w.node, path: w.path } : undefined;
    },
  };
}

/** A lookup that knows nothing: limited access reaches nothing through it but what a row says of itself. */
export const EMPTY_LOOKUP: TargetLookup = { self: "", session: () => undefined, ask: () => undefined, workspace: () => undefined };
