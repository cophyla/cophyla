// The web tabs' client methods (`webtab.*`): listed and opened with `sessions:read` and
// `sessions:write`, a session's tabs limited to clients that may reach that session by the filter
// tables; `webtab.report` is the desktop app's own (no scope, so no view may send it), and only
// the app that opens the tabs may. Where a link in an agent's chat opens (`webtabs.*`) is read
// with `sessions:read` and set with `sessions:write`, refused to limited access by the filter
// tables, as the notes' switch.

import type { MethodTable } from "../api/methods.ts";
import type { WebTabs } from "./index.ts";

export function webTabsMethods(deps: { tabs: WebTabs }): MethodTable {
  return {
    "webtab.list": { handler: () => ({ tabs: deps.tabs.list() }) },
    "webtab.open": { handler: (p) => ({ tab: deps.tabs.open(p.session, p.url, "user") }) },
    "webtab.close": {
      handler: (p) => {
        deps.tabs.close(p.id);
        return {};
      },
    },
    "webtab.report": {
      handler: (p, ctx) => {
        deps.tabs.report(ctx.client.id, p);
        return {};
      },
    },
    "webtabs.get": { handler: () => deps.tabs.settings() },
    "webtabs.set": { handler: (p) => deps.tabs.configure({ links: p.links }) },
  };
}
