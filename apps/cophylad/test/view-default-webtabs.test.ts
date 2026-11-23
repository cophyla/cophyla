// The default view's web tabs without the page (webtabmodel.ts): what the node says of tabs folded
// in, which tab of a session shows, the panel put away and brought back by a new tab, and what
// an address typed in the bar opens.

import { describe, expect, test } from "bun:test";
import type { WebTab } from "@cophyla/protocol";
import { activeTab, addressUrl, foldWebTab, resetWebTabs, sessionTabs, tabLabel, webShown, webTabsUi } from "../views/default/webtabmodel.ts";

const S1 = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const S2 = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2";
let n = 0;
const tab = (session: string, o: Partial<WebTab> = {}): WebTab => ({ id: `wtb_01ARZ3NDEKTSV4RRFFQ69G5W${String(++n).padStart(2, "0")}` as WebTab["id"], session: session as WebTab["session"], url: "about:blank", by: "user", at: n, ...o });

describe("web tabs in the view", () => {
  test("a new tab shows, and its session's panel comes back", () => {
    const ui = webTabsUi();
    expect(webShown(ui, S1)).toBe(false);
    const a = tab(S1);
    expect(foldWebTab(ui, a)).toBe(true);
    expect(webShown(ui, S1)).toBe(true);
    expect(activeTab(ui, S1)?.id).toBe(a.id);
    ui.away.add(S1);
    expect(webShown(ui, S1)).toBe(false);
    // the agent opens another: it shows, and the panel is back
    const b = tab(S1, { by: "agent" });
    foldWebTab(ui, b);
    expect(webShown(ui, S1)).toBe(true);
    expect(activeTab(ui, S1)?.id).toBe(b.id);
    // what changes in an open tab is not new, and leaves the choice alone
    ui.active.set(S1, a.id);
    expect(foldWebTab(ui, { ...b, url: "http://localhost:3000/", title: "App" })).toBe(false);
    expect(activeTab(ui, S1)?.id).toBe(a.id);
    expect(sessionTabs(ui, S1).map((t) => t.id)).toEqual([a.id, b.id]);
    expect(sessionTabs(ui, S2)).toEqual([]);
    expect(webShown(ui, undefined)).toBe(false);
  });

  test("a closed tab goes; the newest left shows; with none left the panel's put-away is forgotten", () => {
    const ui = webTabsUi();
    const a = tab(S1);
    const b = tab(S1);
    foldWebTab(ui, a);
    foldWebTab(ui, b);
    foldWebTab(ui, { ...b, closed: true });
    expect(activeTab(ui, S1)?.id).toBe(a.id);
    ui.away.add(S1);
    foldWebTab(ui, { ...a, closed: true });
    expect(activeTab(ui, S1)).toBeUndefined();
    expect(ui.away.has(S1)).toBe(false);
  });

  test("the whole list after a connect keeps the choices of tabs still open", () => {
    const ui = webTabsUi();
    const a = tab(S1);
    const b = tab(S1);
    const c = tab(S2);
    foldWebTab(ui, a);
    foldWebTab(ui, b);
    foldWebTab(ui, c);
    ui.active.set(S1, a.id);
    resetWebTabs(ui, [a, b]);
    expect(activeTab(ui, S1)?.id).toBe(a.id);
    expect(ui.active.has(S2)).toBe(false);
    expect(sessionTabs(ui, S2)).toEqual([]);
  });

  test("an address opens an http or https page, and nothing else", () => {
    expect(addressUrl("http://localhost:5173")).toBe("http://localhost:5173/");
    expect(addressUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(addressUrl("localhost:3000/login?x=1")).toBe("http://localhost:3000/login?x=1");
    expect(addressUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
    expect(addressUrl("[::1]:5173")).toBe("http://[::1]:5173/");
    expect(addressUrl("3000")).toBe("http://localhost:3000/");
    expect(addressUrl("localhost")).toBe("http://localhost/");
    expect(addressUrl("example.com/docs")).toBe("https://example.com/docs");
    expect(addressUrl("https://example.com")).toBe("https://example.com/");
    expect(addressUrl(" about:blank ")).toBe("about:blank");
    for (const no of ["", "   ", "how do I", "file:///C:/x", "javascript:alert(1)", "chrome://settings", "http://u:p@host/", "ftp://example.com"]) expect(addressUrl(no)).toBeUndefined();
  });

  test("a tab says its title, else its address, else that it is new", () => {
    expect(tabLabel(tab(S1, { title: "  My app " }))).toBe("My app");
    expect(tabLabel(tab(S1, { url: "http://localhost:3000/", title: "about:blank" }))).toBe("localhost:3000");
    expect(tabLabel(tab(S1))).toBe("New tab");
  });
});
