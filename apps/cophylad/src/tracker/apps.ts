// Which clients are the user's own apps, whose sends are the user's own words: the desktop app
// (it says `name: "desktop"`, here or relayed from another machine), the phone (`controller`),
// and a browser the LAN listener served. Anything else that connects with a token (the cophylad
// CLI, a script, a kit) sends as a tool does.

import type { MethodContext } from "../api/methods.ts";

export function usersApp(ctx: Pick<MethodContext, "client" | "browser">): boolean {
  if (ctx.browser === true) return true;
  if (ctx.client.kind === "controller") return true;
  return ctx.client.kind === "ui" && ctx.client.name === "desktop";
}
