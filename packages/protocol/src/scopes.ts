// Which scope each client request and notification needs. Zod-free on purpose: the daemon
// checks requests against a client's scopes here, and the view host in the desktop app
// narrows a view to its manifest's scopes with the same tables. `hello` needs none: it is
// what establishes the scopes; `pair.claim` and `pair.account` come before `hello` and need
// none either, and neither does `invite.redeem`; `relay.info` and the push registration are the
// host's own, about the phone itself, answered by the pairing node, never a view's;
// `voice.wakeword` and `voice.wake` are the phone host's own, so no view can move where its
// phone's wake word is detected or start an utterance on it. A terminal's row is a headline
// like a session's; its screen and its keys need `terminal`, since raw keys can do what
// `session.send` cannot (Shift+Tab into bypassing permissions).
//
// `null` means the host's alone, for signals and notifications too: a data channel's
// signalling (`direct.*`), which hands out TURN credentials and moves the host's own link,
// and a stream's pipes (`remote.pipe.*`), which carry another page's bytes. No view sends or
// hears them.

import type { Scope } from "./entities.ts";
import type { ClientNotificationName, ClientRequestName, ClientSignalName } from "./client.ts";

export const requestScopes = {
  hello: null,
  "chat.send": "chat",
  "chat.load": "chat",
  "session.list": "sessions:read",
  "session.history": "sessions:read",
  "session.send": "sessions:write",
  "session.focus": "sessions:write",
  "session.stop": "sessions:write",
  "session.watch": "sessions:read",
  "session.files": "sessions:read",
  "session.git": "sessions:read",
  "session.file": "sessions:read",
  "terminal.list": "sessions:read",
  "terminal.spawn": "terminal",
  "terminal.open": "terminal",
  "terminal.close": "terminal",
  "terminal.file": "terminal",
  "ask.answer": "asks:answer",
  "task.list": "tasks:read",
  "task.create": "tasks:write",
  "task.update": "tasks:write",
  "workspace.list": "sessions:read",
  "workspace.put": "sessions:write",
  "event.list": "nodes",
  "voice.ptt": "voice",
  "voice.wakeword": null,
  "voice.wake": null,
  "voice.settings": "voice",
  "voice.configure": "voice",
  "voice.preview": "voice",
  "voice.install": "voice",
  "view.list": "views",
  "view.get": "views",
  "view.setDefault": "views",
  "view.stage": "views",
  "pair.start": "controllers",
  "pair.claim": null,
  "pair.account": null,
  "invite.redeem": null,
  "relay.info": null,
  "push.register": null,
  "push.unregister": null,
  "controller.list": "controllers",
  "controller.revoke": "controllers",
  "grant.invite": "controllers",
  "grant.list": "controllers",
  "grant.revoke": "controllers",
  "node.list": "nodes",
  "node.join": "nodes",
  "node.leave": "nodes",
  "guest.add": "nodes",
  "guest.list": "nodes",
  "guest.join": "nodes",
  "guest.leave": "nodes",
  "guest.remove": "nodes",
  "node.promote": "nodes",
  "node.restart": "nodes",
  "listener.list": "nodes",
  "listener.remove": "nodes",
  "profile.list": "nodes",
  "profile.limits": "nodes",
  "profile.update": "nodes",
  "metrics.subscribe": "metrics:read",
  "metrics.unsubscribe": "metrics:read",
  "metrics.history": "metrics:read",
  "remote.pair": "remote",
  "remote.invite": "remote",
  "remote.open": "remote",
  "remote.close": "remote",
  "remote.pipe.open": null,
  "remote.revoke": "remote",
  "account.login": "account",
  "account.logout": "account",
  "account.apiKey": "account",
  "backup.enable": "account",
  "backup.disable": "account",
  "backup.restore": "account",
  "direct.enable": "account",
  "direct.disable": "account",
  "direct.info": null,
  "direct.offer": null,
  "update.check": "updates",
  "update.apply": "updates",
} as const satisfies Record<ClientRequestName, Scope | null>;

export const notificationScopes = {
  "chat.message": "chat",
  "chat.delta": "chat",
  "chat.retract": "chat",
  "chat.progress": "chat",
  "session.state": "sessions:read",
  "session.event": "sessions:read",
  "terminal.state": "sessions:read",
  "terminal.output": "terminal",
  "task.state": "tasks:read",
  "thread.state": "chat",
  "workspace.state": "sessions:read",
  "ask.state": "asks:answer",
  "voice.state": "voice",
  "voice.partial": "voice",
  "voice.audio": "voice",
  "voice.setup": "voice",
  "view.content": "views",
  "view.changed": "views",
  "node.state": "nodes",
  "metrics.sample": "metrics:read",
  "remote.state": "remote",
  "audit.entry": "audit:read",
  "account.state": "account",
  "direct.state": "account",
  "direct.candidate": null,
  "remote.pipe.data": null,
  "remote.pipe.ack": null,
  "remote.pipe.close": null,
  "update.state": "updates",
} as const satisfies Record<ClientNotificationName, Scope | null>;

/** Which scope each client signal needs: a host forwards a view's signal only within its scopes, never a `null` one. */
export const signalScopes = {
  "chat.typing": "chat",
  "voice.audio": "voice",
  "voice.played": "voice",
  "terminal.input": "terminal",
  "terminal.resize": "terminal",
  "direct.candidate": null,
  "remote.pipe.data": null,
  "remote.pipe.ack": null,
  "remote.pipe.close": null,
} as const satisfies Record<ClientSignalName, Scope | null>;

/** The scope a request needs, or `null` for the host's own (`hello`, the pairing and redeeming, `relay.info`, push, `direct.*` signalling, pipes); `undefined` for a name that is not a request. */
export function requestScope(method: string): Scope | null | undefined {
  return Object.prototype.hasOwnProperty.call(requestScopes, method) ? (requestScopes as Record<string, Scope | null>)[method] : undefined;
}

/** The scope a notification needs, `null` for the host's alone; `undefined` for a name that is not a notification. */
export function notificationScope(method: string): Scope | null | undefined {
  return Object.prototype.hasOwnProperty.call(notificationScopes, method) ? (notificationScopes as Record<string, Scope | null>)[method] : undefined;
}

/** The scope a signal needs, `null` for the host's alone; `undefined` for a name that is not a signal. */
export function signalScope(method: string): Scope | null | undefined {
  return Object.prototype.hasOwnProperty.call(signalScopes, method) ? (signalScopes as Record<string, Scope | null>)[method] : undefined;
}
