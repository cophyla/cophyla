// The gate's vocabulary: every request name on the capability and client protocols with its
// risk class. Default policy is per risk class; `tool.run` takes the risk of the tool it
// runs. See entities.md, "Tool risk is the gate's vocabulary".

import type { LaunchMode, RiskClass } from "./entities.ts";
import { capabilityRequests } from "./capability.ts";
import { clientRequests } from "./client.ts";

export interface ActionDefinition {
  risk: RiskClass;
  /**
   * Settled by structure, never by policy: the gate allows these for any principal that is
   * entitled to them and still audits every one. Opening an ask to answer an ask would loop.
   */
  control?: true;
}

export const actions = {
  hello: { risk: "read", control: true },
  "ask.answer": { risk: "write", control: true },
  cancel: { risk: "write", control: true },

  "node.list": { risk: "read" },
  "node.promote": { risk: "exec" },
  "node.restart": { risk: "exec" },
  "profile.list": { risk: "read" },
  "profile.limits": { risk: "read" },
  "profile.update": { risk: "write" },
  "session.list": { risk: "read" },
  "session.history": { risk: "read" },
  "session.send": { risk: "write" },
  "session.spawn": { risk: "exec" },
  "session.stop": { risk: "exec" },
  // `exec` at most: `sessionModeRisk` says which a given mode is.
  "session.mode": { risk: "exec" },
  "session.focus": { risk: "write" },
  "session.watch": { risk: "read" },
  "session.files": { risk: "read" },
  "session.git": { risk: "read" },
  "session.file": { risk: "read" },
  "session.reveal": { risk: "read" },
  "terminal.list": { risk: "read" },
  "terminal.spawn": { risk: "exec" },
  // Watching is a read; typing into it (`input`, `drive`) is `exec`, and so is ending it.
  "terminal.open": { risk: "read" },
  "terminal.close": { risk: "read" },
  "terminal.file": { risk: "read" },
  "terminal.folders": { risk: "read" },
  "workspace.list": { risk: "read" },
  "workspace.put": { risk: "write" },
  annotate: { risk: "write" },
  "task.list": { risk: "read" },
  "task.get": { risk: "read" },
  "task.create": { risk: "write" },
  "task.update": { risk: "write" },
  "prompt.list": { risk: "read" },
  "prompt.search": { risk: "read" },
  "prompt.read": { risk: "read" },
  "prompt.write": { risk: "write" },
  "prompt.delete": { risk: "write" },
  "memory.list": { risk: "read" },
  "memory.read": { risk: "read" },
  "memory.write": { risk: "write" },
  "memory.delete": { risk: "write" },
  "event.list": { risk: "read" },
  "event.history": { risk: "read" },
  "tool.list": { risk: "read" },
  "tool.run": { risk: "exec" },
  recall: { risk: "read" },
  "voice.speak": { risk: "write" },
  "ui.say": { risk: "write" },
  "ui.ask": { risk: "write" },
  "thread.start": { risk: "write" },
  "thread.list": { risk: "read" },
  "thread.history": { risk: "read" },
  "llm.complete": { risk: "network" },
  "compute.embed": { risk: "network" },
  "store.get": { risk: "read" },
  "store.put": { risk: "write" },
  "store.delete": { risk: "write" },
  "store.list": { risk: "read" },
  "metrics.query": { risk: "read" },
  "listener.add": { risk: "write" },
  "listener.remove": { risk: "write" },
  "listener.list": { risk: "read" },
  "brain.context": { risk: "read" },
  "metrics.subscribe": { risk: "read" },
  "metrics.unsubscribe": { risk: "read" },
  "metrics.history": { risk: "read" },
  "remote.pair": { risk: "exec" },
  "remote.invite": { risk: "exec" },
  "remote.open": { risk: "exec" },
  "remote.close": { risk: "write" },
  // A connection to the stream proxy, which itself asks for the ticket `remote.open` minted.
  "remote.pipe.open": { risk: "read", control: true },
  "remote.revoke": { risk: "write" },
  // Starting the desktop's host may install it; stopping only ends what streams.
  "remote.enable": { risk: "exec" },
  "remote.disable": { risk: "write" },
  // A node asking for a stream page of this desktop for a viewer of its own (the node link's).
  "remote.ticket": { risk: "exec" },
  "remote.screenshot": { risk: "exec" },
  "chat.send": { risk: "write" },
  "chat.load": { risk: "read" },
  "voice.ptt": { risk: "write" },
  "voice.wakeword": { risk: "read" },
  "voice.wake": { risk: "write" },
  "voice.settings": { risk: "read" },
  "voice.configure": { risk: "write" },
  "voice.preview": { risk: "write" },
  "voice.hush": { risk: "write" },
  // Fetches an engine and its runtime from the network onto this machine.
  "voice.install": { risk: "network" },
  "view.list": { risk: "read" },
  "view.get": { risk: "read" },
  "view.setDefault": { risk: "write" },
  "view.stage": { risk: "read" },
  "pair.start": { risk: "write" },
  "pair.claim": { risk: "write", control: true },
  "pair.account": { risk: "write", control: true },
  "invite.redeem": { risk: "write", control: true },
  "relay.info": { risk: "read", control: true },
  "push.register": { risk: "write" },
  "push.unregister": { risk: "write" },
  "controller.list": { risk: "read" },
  "controller.revoke": { risk: "write" },
  "grant.invite": { risk: "write" },
  "grant.list": { risk: "read" },
  "grant.revoke": { risk: "write" },
  "grant.rekey": { risk: "write", control: true },
  "node.join": { risk: "exec" },
  "node.leave": { risk: "write" },
  "guest.add": { risk: "exec" },
  "guest.list": { risk: "read" },
  "guest.join": { risk: "exec" },
  "guest.leave": { risk: "write" },
  "guest.remove": { risk: "write" },
  "node.enroll": { risk: "write", control: true },
  "direct.turn": { risk: "network", control: true },
  "account.login": { risk: "network" },
  "account.logout": { risk: "write" },
  // A vendor's key kept on this node; the audit row keeps it redacted.
  "account.apiKey": { risk: "write" },
  "backup.enable": { risk: "network" },
  "backup.disable": { risk: "write" },
  "backup.restore": { risk: "exec" },
  "direct.enable": { risk: "network" },
  "direct.disable": { risk: "write" },
  // The phone's own link moving to a data channel: signalling, settled by structure.
  "direct.info": { risk: "read", control: true },
  "direct.offer": { risk: "read", control: true },
  "update.check": { risk: "network" },
  "update.apply": { risk: "exec" },
} as const satisfies Record<string, ActionDefinition>;

export type ActionName = keyof typeof actions;

/** Compile-time check that every request on both protocols has an action entry. */
type MissingCapability = Exclude<keyof typeof capabilityRequests, ActionName>;
type MissingClient = Exclude<keyof typeof clientRequests, ActionName>;
const _missingCapability: MissingCapability extends never ? true : MissingCapability = true;
const _missingClient: MissingClient extends never ? true : MissingClient = true;
void _missingCapability;
void _missingClient;

export function actionDefinition(name: string): ActionDefinition | undefined {
  return (actions as Record<string, ActionDefinition>)[name];
}

/**
 * The risk of putting a session in a permission mode: `exec` for one that lets it do more
 * unasked than asking before each edit, `write` for manual and the stricter ones.
 */
export function sessionModeRisk(mode: LaunchMode): RiskClass {
  return mode === "default" || mode === "plan" || mode === "dontAsk" ? "write" : "exec";
}
