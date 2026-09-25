// Whether this page runs inside the Capacitor shell. Kept apart so a module can be tested
// under Bun without the bridge: everything native takes its plugins as arguments.

import { Capacitor } from "@capacitor/core";

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/** A file under the app's own storage as a URL the web view may load. */
export function fileUrl(path: string): string {
  return Capacitor.convertFileSrc(path);
}
