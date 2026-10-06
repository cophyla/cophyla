// The page's own elements: the three screens, and under the view a thin bar: the menu button
// that shows or hides the view's rail at the left, the talk button in the middle, the speaker
// and the ⋯ menu (the status line, Listen, Forget) at the right. It renders a `Chrome` and
// turns taps into the calls `main.ts` wired it with. Everything else on the screen belongs to
// the view in the frame. The pairing screen takes a key first where the page is a browser's
// (a key is typed at the node's own address), then the six digits, a name, and whether this
// is a shared computer; in a wide window on a computer (`desk`) there is no bar at all.

import type { Chrome } from "./chrome.ts";

import type { NodeAddress } from "./pairing.ts";
import { parseAddress } from "./pairing.ts";

/** What the pairing form says beside what was typed: the name, and whether this is a shared computer. */
export interface PairWith {
  name: string;
  shared: boolean;
}

export interface UiActions {
  /** `address` is what the native app's address field holds; the browser has none. */
  pair(code: string, how: PairWith, address: NodeAddress | undefined): Promise<void>;
  /** A browser's key, as it was typed. */
  pairKey(key: string, how: PairWith): Promise<void>;
  /** The native app's "Sign in with GitHub": the browser opens; the pairing finishes when the app is back. */
  signIn(): Promise<void>;
  /** Reads a pasted invite: the name of the node it would join, or a word on why it cannot be used. */
  readInvite(text: string): string;
  /** Redeems the invite read last. */
  redeem(how: PairWith): Promise<void>;
  /** The invite read last is put away unused. */
  cancelInvite(): void;
  start(): Promise<void>;
  /** The bar's menu button: the view shows or hides its rail. */
  menu(): void;
  listen(on: boolean): void;
  ptt(down: boolean): void;
  mute(on: boolean): void;
  forget(): Promise<void>;
}

export interface UiElements {
  pair: HTMLElement;
  gate: HTMLElement;
  main: HTMLElement;
  view: HTMLElement;
  statusText: HTMLElement;
  dot: HTMLElement;
  /** The menu's switch: listening for the wake word while the app is open. */
  listen: HTMLButtonElement;
  /** The bar's menu button, for the view's rail. */
  rail: HTMLButtonElement;
  ptt: HTMLButtonElement;
  pttLabel: HTMLElement;
  mute: HTMLButtonElement;
  /** The ⋯ button and the menu it opens. */
  more: HTMLButtonElement;
  menu: HTMLElement;
  forget: HTMLButtonElement;
  pairForm: HTMLFormElement;
  pairCode: HTMLInputElement;
  pairName: HTMLInputElement;
  /** The page's heading and the line over the code, which say what kind of device this is. */
  pairTitle?: HTMLElement;
  codeHint?: HTMLElement;
  /** A browser's key: its form, shown where the page is a browser's. */
  keyForm?: HTMLFormElement;
  pairKey?: HTMLInputElement;
  keySubmit?: HTMLButtonElement;
  /** "This is a shared computer", and what it means. */
  pairShared?: HTMLInputElement;
  pairSharedLine?: HTMLElement;
  pairSharedHint?: HTMLElement;
  inviteOr?: HTMLElement;
  /** The node's `host:port`, shown by the native app alone. */
  pairAddress?: HTMLInputElement;
  pairError: HTMLElement;
  pairSubmit: HTMLButtonElement;
  /** The sign-in with the account, shown by the native app alone; the line between it and the code; what the sign-in is doing. */
  pairAccount?: HTMLButtonElement;
  pairOr?: HTMLElement;
  pairStatus?: HTMLElement;
  /** An invite pasted from the desktop, and the screen that names the node before it is used. */
  inviteForm: HTMLFormElement;
  inviteText: HTMLInputElement;
  inviteConfirm: HTMLElement;
  inviteNode: HTMLElement;
  inviteJoin: HTMLButtonElement;
  inviteCancel: HTMLButtonElement;
  start: HTMLButtonElement;
  gateError: HTMLElement;
}

export function elements(doc: Document): UiElements {
  const el = <T extends HTMLElement>(id: string): T => doc.getElementById(id) as T;
  return {
    pair: el("pair"),
    gate: el("gate"),
    main: el("main"),
    view: el("view"),
    statusText: el("status-text"),
    dot: el("status").querySelector<HTMLElement>(".dot")!,
    listen: el<HTMLButtonElement>("listen"),
    rail: el<HTMLButtonElement>("rail"),
    ptt: el<HTMLButtonElement>("ptt"),
    pttLabel: el("ptt-label"),
    mute: el<HTMLButtonElement>("mute"),
    more: el<HTMLButtonElement>("more"),
    menu: el("menu"),
    forget: el<HTMLButtonElement>("forget"),
    pairForm: el<HTMLFormElement>("pair-form"),
    pairCode: el<HTMLInputElement>("pair-code"),
    pairName: el<HTMLInputElement>("pair-name"),
    ...(doc.getElementById("pair-title") ? { pairTitle: el("pair-title") } : {}),
    ...(doc.getElementById("code-hint") ? { codeHint: el("code-hint") } : {}),
    ...(doc.getElementById("key-form") ? { keyForm: el<HTMLFormElement>("key-form"), pairKey: el<HTMLInputElement>("pair-key"), keySubmit: el<HTMLButtonElement>("key-submit") } : {}),
    ...(doc.getElementById("pair-shared") ? { pairShared: el<HTMLInputElement>("pair-shared"), pairSharedLine: el("pair-shared-line"), pairSharedHint: el("pair-shared-hint") } : {}),
    ...(doc.getElementById("invite-or") ? { inviteOr: el("invite-or") } : {}),
    ...(doc.getElementById("pair-address") ? { pairAddress: el<HTMLInputElement>("pair-address") } : {}),
    pairError: el("pair-error"),
    pairSubmit: el<HTMLButtonElement>("pair-submit"),
    ...(doc.getElementById("pair-account") ? { pairAccount: el<HTMLButtonElement>("pair-account") } : {}),
    ...(doc.getElementById("pair-or") ? { pairOr: el("pair-or") } : {}),
    ...(doc.getElementById("pair-status") ? { pairStatus: el("pair-status") } : {}),
    inviteForm: el<HTMLFormElement>("invite-form"),
    inviteText: el<HTMLInputElement>("invite-text"),
    inviteConfirm: el("invite-confirm"),
    inviteNode: el("invite-node"),
    inviteJoin: el<HTMLButtonElement>("invite-join"),
    inviteCancel: el<HTMLButtonElement>("invite-cancel"),
    start: el<HTMLButtonElement>("start"),
    gateError: el("gate-error"),
  };
}

const setHidden = (node: HTMLElement, hidden: boolean) => {
  if (node.hidden !== hidden) node.hidden = hidden;
};
const setText = (node: HTMLElement, text: string) => {
  if (node.textContent !== text) node.textContent = text;
};

export function render(ui: UiElements, chrome: Chrome, listening: boolean): void {
  setHidden(ui.pair, chrome.screen !== "pair");
  setHidden(ui.gate, chrome.screen !== "gate");
  setHidden(ui.main, chrome.screen !== "main");
  setText(ui.statusText, chrome.overlay ?? chrome.status);
  if (ui.dot.dataset["status"] !== chrome.dot) ui.dot.dataset["status"] = chrome.dot;
  // A preference, not a live control: it can be flipped while offline and holds from then on.
  ui.listen.setAttribute("aria-checked", listening ? "true" : "false");
  ui.ptt.disabled = !chrome.pttEnabled;
  setText(ui.pttLabel, chrome.pttLabel);
  // The microphone takes the dot's colour, and the whole status line is the button's title.
  if (ui.ptt.dataset["status"] !== chrome.dot) ui.ptt.dataset["status"] = chrome.dot;
  const title = chrome.overlay ?? chrome.status;
  if (ui.ptt.title !== title) ui.ptt.title = title;
  ui.mute.setAttribute("aria-pressed", chrome.muted ? "true" : "false");
  const muteWords = chrome.muted ? "Unmute the speaker" : "Mute the speaker";
  if (ui.mute.getAttribute("aria-label") !== muteWords) {
    ui.mute.setAttribute("aria-label", muteWords);
    ui.mute.title = muteWords;
  }
}

/** What the page calls the device it runs on, and whether it pairs with a key. */
export interface Wording {
  device: "phone" | "browser";
  /** A key is typed here: the page is a browser's, on the node's own address. */
  key?: boolean;
  /** A wide window on a computer: the bar is not drawn. */
  desk?: boolean;
}

/** The page's own words and form for the device it is: what it is called, the key's form, and no bar in a wide window. */
export function dress(ui: UiElements, w: Wording): void {
  const doc = ui.pair.ownerDocument;
  doc.documentElement.dataset["form"] = w.desk ? "desk" : "phone";
  if (ui.pairTitle) setText(ui.pairTitle, `Pair this ${w.device}`);
  ui.pairName.setAttribute("aria-label", `What to call this ${w.device}`);
  setText(ui.forget, `Forget this ${w.device}`);
  if (w.key) {
    if (ui.keyForm) setHidden(ui.keyForm, false);
    if (ui.pairSharedLine) setHidden(ui.pairSharedLine, false);
    if (ui.codeHint) ui.codeHint.replaceChildren("Or type the six digits ", strong(doc, w.device === "browser" ? "Pair with a code" : "Pair a phone"), " shows on a device that is already in.");
    if (ui.inviteOr) setText(ui.inviteOr, `Or paste an invite made for this ${w.device}:`);
  }
}

function strong(doc: Document, text: string): HTMLElement {
  const s = doc.createElement("strong");
  s.textContent = text;
  return s;
}

/** What the form says beside the code, the key or the invite: the name typed, else the one guessed, and the shared-computer box. */
function pairWith(ui: UiElements): PairWith {
  return { name: ui.pairName.value.trim() || ui.pairName.placeholder, shared: ui.pairShared?.checked === true && ui.pairSharedLine?.hidden === false };
}

/**
 * The pairing screen with an invite read: the node it would join and Join or Cancel, the
 * other ways in put aside meanwhile; `undefined` puts the screen back.
 */
export function showInvite(ui: UiElements, node: string | undefined): void {
  const confirming = node !== undefined;
  setText(ui.inviteNode, node ?? "");
  setHidden(ui.inviteConfirm, !confirming);
  setHidden(ui.inviteForm, confirming);
  setHidden(ui.pairForm, confirming);
  if (ui.keyForm && ui.keyForm.dataset["on"] !== "0") ui.keyForm.classList.toggle("aside", confirming);
  if (!confirming) ui.inviteText.value = "";
}

function openMenu(ui: UiElements, open: boolean): void {
  setHidden(ui.menu, !open);
  ui.more.setAttribute("aria-expanded", open ? "true" : "false");
}

/** Binds the page's controls. The button is a pointer press, so a drag off it still releases. */
export function bind(ui: UiElements, actions: UiActions): void {
  ui.pairForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    setHidden(ui.pairError, true);
    const code = ui.pairCode.value;
    const address = ui.pairAddress && !ui.pairAddress.hidden ? parseAddress(ui.pairAddress.value) : undefined;
    ui.pairSubmit.disabled = true;
    void actions
      .pair(code, pairWith(ui), address)
      .catch((e: unknown) => {
        setText(ui.pairError, e instanceof Error ? e.message : String(e));
        setHidden(ui.pairError, false);
      })
      .finally(() => {
        ui.pairSubmit.disabled = false;
      });
  });

  ui.keyForm?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    setHidden(ui.pairError, true);
    const submit = ui.keySubmit!;
    submit.disabled = true;
    void actions
      .pairKey(ui.pairKey!.value, pairWith(ui))
      .then(() => {
        ui.pairKey!.value = "";
      })
      .catch((e: unknown) => {
        setText(ui.pairError, e instanceof Error ? e.message : String(e));
        setHidden(ui.pairError, false);
      })
      .finally(() => {
        submit.disabled = false;
      });
  });

  // What ticking the box means is said under it, while it is ticked.
  ui.pairShared?.addEventListener("change", () => {
    if (ui.pairSharedHint) setHidden(ui.pairSharedHint, !ui.pairShared!.checked);
  });

  ui.pairAccount?.addEventListener("click", () => {
    setHidden(ui.pairError, true);
    const button = ui.pairAccount!;
    button.disabled = true;
    void actions
      .signIn()
      .catch((e: unknown) => {
        setText(ui.pairError, e instanceof Error ? e.message : String(e));
        setHidden(ui.pairError, false);
      })
      .finally(() => {
        button.disabled = false;
      });
  });

  const showError = (e: unknown) => {
    setText(ui.pairError, e instanceof Error ? e.message : String(e));
    setHidden(ui.pairError, false);
  };

  ui.inviteForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    setHidden(ui.pairError, true);
    try {
      showInvite(ui, actions.readInvite(ui.inviteText.value));
    } catch (e) {
      showError(e);
    }
  });

  ui.inviteJoin.addEventListener("click", () => {
    setHidden(ui.pairError, true);
    ui.inviteJoin.disabled = true;
    void actions
      .redeem(pairWith(ui))
      .then(() => showInvite(ui, undefined))
      .catch(showError)
      .finally(() => {
        ui.inviteJoin.disabled = false;
      });
  });

  ui.inviteCancel.addEventListener("click", () => {
    setHidden(ui.pairError, true);
    actions.cancelInvite();
    showInvite(ui, undefined);
  });

  ui.start.addEventListener("click", () => {
    setHidden(ui.gateError, true);
    void actions.start().catch((e: unknown) => {
      setText(ui.gateError, e instanceof Error ? e.message : String(e));
      setHidden(ui.gateError, false);
    });
  });

  ui.rail.addEventListener("click", () => {
    openMenu(ui, false);
    actions.menu();
  });

  ui.mute.addEventListener("click", () => {
    actions.mute(ui.mute.getAttribute("aria-pressed") !== "true");
  });

  // The menu: ⋯ opens and closes it; a tap anywhere else, or Escape, closes it.
  ui.more.addEventListener("click", () => openMenu(ui, ui.more.getAttribute("aria-expanded") !== "true"));
  const doc = ui.more.ownerDocument;
  doc.addEventListener("click", (ev) => {
    if (ui.menu.hidden) return;
    const target = ev.target as Node | null;
    if (target && (ui.menu.contains(target) || ui.more.contains(target))) return;
    openMenu(ui, false);
  });
  doc.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") openMenu(ui, false);
  });

  ui.listen.addEventListener("click", () => {
    actions.listen(ui.listen.getAttribute("aria-checked") !== "true");
    openMenu(ui, false);
  });

  ui.forget.addEventListener("click", () => {
    openMenu(ui, false);
    void actions.forget();
  });

  const down = (ev: Event) => {
    ev.preventDefault();
    if (ui.ptt.disabled || ui.ptt.dataset["down"] === "1") return;
    ui.ptt.dataset["down"] = "1";
    actions.ptt(true);
  };
  const up = (ev: Event) => {
    ev.preventDefault();
    if (ui.ptt.dataset["down"] !== "1") return;
    delete ui.ptt.dataset["down"];
    actions.ptt(false);
  };
  ui.ptt.addEventListener("pointerdown", down);
  for (const name of ["pointerup", "pointercancel", "pointerleave"]) ui.ptt.addEventListener(name, up);
}
