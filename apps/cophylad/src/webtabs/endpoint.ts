// An agent's Playwright on the web tabs' debugging endpoint, before its proxy starts: a session
// with no tab yet gets a blank one first, since Playwright looks for a page as it connects and the
// desktop app's browser (and its debugging port) only runs once a tab is open. What Playwright
// sends meanwhile waits, and goes to the proxy in order once it starts.

import type { SessionId } from "@cophyla/protocol";
import type { CdpSocket } from "../api/server.ts";
import type { Logger } from "../log.ts";
import type { WebTabs } from "./index.ts";

/** The most frames an agent's Playwright may send before its tab is open. */
const EARLY_MAX = 1000;

export function agentEndpoint(tabs: WebTabs, session: SessionId, proxy: () => CdpSocket, log: Logger): CdpSocket {
  let started: CdpSocket | undefined;
  const early: string[] = [];
  let closed = false;
  return {
    open(agent) {
      const ready = tabs.of(session).length > 0 && tabs.port() !== undefined ? Promise.resolve() : tabs.openForAgent(session, "about:blank").then(() => undefined);
      ready.then(
        () => {
          if (closed) return;
          started = proxy();
          started.open(agent);
          for (const m of early.splice(0)) started.message(m);
        },
        (e: unknown) => {
          const why = e instanceof Error ? e.message : String(e);
          log.warn("web tabs: an agent's Playwright found no tab to drive", { session, error: why });
          // a close reason holds 123 bytes
          agent.close(1011, `no web tab: ${why}`.slice(0, 120));
        },
      );
    },
    message(text) {
      if (started) started.message(text);
      else if (early.length < EARLY_MAX) early.push(text);
    },
    close() {
      closed = true;
      started?.close();
    },
  };
}
