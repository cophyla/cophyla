// @cophyla/viewhost: the host side of a view, shared by the desktop app and the controller. A
// `Connection` over an injected transport gives the host a request/response API; a
// `SnapshotCache` keeps the daemon's picture for whatever view mounts; a `Bridge` narrows one
// view to its manifest's scopes over postMessage; a `ViewHost` loads the default view into a
// sandboxed frame and reloads it when it changes; a `ViewChooser` is the host's view picker
// over it and a `SettingsPanel` its settings; an `AskNotifier` toasts asks. DOM-free except
// `ViewHost`, which owns the frame, and `ViewChooser` and `SettingsPanel`, which draw.

export * from "./connection.ts";
export * from "./bridge.ts";
export * from "./snapshot.ts";
export * from "./viewhost.ts";
export * from "./chooser.ts";
export * from "./settings.ts";
export * from "./notify.ts";
