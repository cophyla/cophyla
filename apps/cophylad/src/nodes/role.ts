// The role state machine. The primary is the machine the user chose, and the epoch counts
// the user's choices. The chosen node starts by CLAIMING (listening for a live primary of a
// higher epoch, a later choice, before it takes the role) unless it has never heard of
// another node and cannot discover one; every other node starts SEEKING the chosen one.
// LINKED is a secondary with a live link; one that loses it seeks again, and never takes the
// role on its own. PROMOTING is the user's choice landing here; STEP_DOWN hands the role to
// the node the user chose. UNLINKED is a node in no cluster, waiting for an invite to redeem;
// a node that leaves its cluster goes back to it. The machine holds the state and the epoch
// and checks each transition; the nodes module does the work each state means.

import type { NodeRole } from "@cophyla/protocol";

export type RoleState = "unlinked" | "claiming" | "primary" | "seeking" | "linked" | "promoting" | "stepping_down" | "stopped";

const ALLOWED: Record<RoleState, RoleState[]> = {
  unlinked: ["seeking", "stopped"],
  claiming: ["primary", "seeking", "stopped", "unlinked"],
  primary: ["stepping_down", "stopped"],
  seeking: ["linked", "stopped", "promoting", "unlinked"],
  linked: ["seeking", "promoting", "stopped", "unlinked"],
  promoting: ["primary", "stopped"],
  stepping_down: ["seeking", "stopped"],
  stopped: [],
};

export class RoleMachine {
  private stateValue: RoleState;
  private epochValue: number;
  private configured: NodeRole;
  private listeners = new Set<(from: RoleState, to: RoleState) => void>();

  constructor(opts: { configured: NodeRole; epoch: number; start: RoleState }) {
    this.configured = opts.configured;
    this.epochValue = opts.epoch;
    this.stateValue = opts.start;
  }

  get state(): RoleState {
    return this.stateValue;
  }

  get epoch(): number {
    return this.epochValue;
  }

  /** The role as the rest of the daemon sees it: primary while primary or promoting, secondary otherwise. */
  get role(): NodeRole {
    return this.stateValue === "primary" || this.stateValue === "promoting" ? "primary" : "secondary";
  }

  /** Whether this node holds the replica, so the user can make it the primary with the state: configured so, or a primary that stepped down; never a node joined as hands. */
  get backup(): boolean {
    return !this.hands && (this.configured === "primary" || this.configuredBackup);
  }

  configuredBackup = false;

  /** Joined as hands: the primary drives it, and it never holds the replica or takes the role. */
  hands = false;

  setEpoch(epoch: number): void {
    this.epochValue = Math.max(this.epochValue, epoch);
  }

  onChange(listener: (from: RoleState, to: RoleState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Moves to `next`; a move the table does not allow is refused with an error. */
  go(next: RoleState): void {
    const from = this.stateValue;
    if (from === next) return;
    if (!ALLOWED[from].includes(next)) throw new Error(`role: cannot go from ${from} to ${next}`);
    this.stateValue = next;
    for (const l of [...this.listeners]) l(from, next);
  }

  is(...states: RoleState[]): boolean {
    return states.includes(this.stateValue);
  }
}
