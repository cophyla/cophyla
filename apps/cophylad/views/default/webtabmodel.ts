// Web tabs in the view, without the page: the tabs the node says are open beside agents' chats
// (`webtab.list`, `webtab.state`), which one of a session's shows, whether the user put the
// session's panel away, and what an address typed in the bar opens. A tab an agent opens, or the
// user, shows at once and brings the session's panel back.

import type { WebTab } from "@cophyla/protocol";

export interface WebTabsUi {
  /** The open tabs, by id, in the order they opened. */
  tabs: Map<string, WebTab>;
  /** The tab each session shows, when one was chosen. */
  active: Map<string, string>;
  /** Sessions whose panel the user put away while it has tabs. */
  away: Set<string>;
}

export function webTabsUi(): WebTabsUi {
  return { tabs: new Map(), active: new Map(), away: new Set() };
}

/** A session's open tabs, oldest first. */
export function sessionTabs(ui: WebTabsUi, session: string): WebTab[] {
  return [...ui.tabs.values()].filter((t) => t.session === session);
}

/** The tab a session shows: the one chosen while it is open, else its newest. */
export function activeTab(ui: WebTabsUi, session: string): WebTab | undefined {
  const chosen = ui.active.get(session);
  const tab = chosen !== undefined ? ui.tabs.get(chosen) : undefined;
  return tab ?? sessionTabs(ui, session).at(-1);
}

/** Whether a session's panel shows: it has a tab, and the user has not put it away. */
export function webShown(ui: WebTabsUi, session: string | undefined): boolean {
  return session !== undefined && !ui.away.has(session) && sessionTabs(ui, session).length > 0;
}

/** Folds in what the node said of a tab; a tab new here shows, and its session's panel comes back. Whether it was new. */
export function foldWebTab(ui: WebTabsUi, tab: WebTab): boolean {
  if (tab.closed) {
    ui.tabs.delete(tab.id);
    if (ui.active.get(tab.session) === tab.id) ui.active.delete(tab.session);
    if (sessionTabs(ui, tab.session).length === 0) ui.away.delete(tab.session);
    return false;
  }
  const fresh = !ui.tabs.has(tab.id);
  ui.tabs.set(tab.id, tab);
  if (fresh) {
    ui.active.set(tab.session, tab.id);
    ui.away.delete(tab.session);
  }
  return fresh;
}

/** The whole list again, after a connect: the tabs as the node has them, the choices of tabs still open kept. */
export function resetWebTabs(ui: WebTabsUi, tabs: WebTab[]): void {
  ui.tabs = new Map(tabs.map((t) => [t.id, t]));
  for (const [session, id] of [...ui.active]) if (!ui.tabs.has(id)) ui.active.delete(session);
}

const LOCAL = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i;

/**
 * What an address typed in the bar opens: an http or https page as typed, `localhost:3000` and
 * other addresses on this machine over http, a bare name with a dot (`example.com/a`) over https.
 * Anything else (a search, a file, a script) opens nothing.
 */
export function addressUrl(text: string): string | undefined {
  const t = text.trim();
  if (t === "") return undefined;
  if (t === "about:blank") return t;
  const parse = (s: string): string | undefined => {
    try {
      const u = new URL(s);
      return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "" && u.username === "" && u.password === "" ? u.href : undefined;
    } catch {
      return undefined;
    }
  };
  if (/^https?:\/\//i.test(t)) return parse(t);
  if (/\s/.test(t) || /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(t)) return undefined;
  if (LOCAL.test(t)) return parse(`http://${t}`);
  if (/^\d+$/.test(t)) return parse(`http://localhost:${t}`);
  if (/^[^/]+\.[^/]+/.test(t)) return parse(`https://${t}`);
  return undefined;
}

/** What a tab's strip button says: its title, else its address without the scheme, else "New tab". */
export function tabLabel(tab: WebTab): string {
  if (tab.title && tab.title.trim() !== "" && tab.title !== "about:blank") return tab.title.trim();
  if (tab.url === "about:blank") return "New tab";
  return tab.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
