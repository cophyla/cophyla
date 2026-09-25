// The page's own elements: the three screens, and under the view a thin bar: the menu button
// that shows or hides the view's rail at the left, the talk button in the middle, the speaker
// and the ⋯ menu (the status line, Listen, Forget) at the right. It renders a `Chrome` and
// turns taps into the calls `main.ts` wired it with. Everything else on the screen belongs to
// the view in the frame.

import type { Chrome } from "./chrome.ts";

import type { NodeAddress } from "./pairing.ts";
import { parseAddress } from "./pairing.ts";

export interface UiActions {
  /** `address` is what the native app's address field holds; the browser has none. */
  pair(code: string, name: string, address: NodeAddress | undefined): Promise<void>;
  /** The native app's "Sign in with GitHub": the browser opens; the pairing finishes when the app is back. */
  signIn(): Promise<void>;
  /** Reads a pasted invite: the name of the node it would join, or a word on why it cannot be used. */
  readInvite(text: string): string;
  /** Redeems the invite read last under `name`. */
  redeem(name: string): Promise<void>;
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
    const name = ui.pairName.value.trim() || ui.pairName.placeholder;
    const address = ui.pairAddress && !ui.pairAddress.hidden ? parseAddress(ui.pairAddress.value) : undefined;
    ui.pairSubmit.disabled = true;
    void actions
      .pair(code, name, address)
      .catch((e: unknown) => {
        setText(ui.pairError, e instanceof Error ? e.message : String(e));
        setHidden(ui.pairError, false);
      })
      .finally(() => {
        ui.pairSubmit.disabled = false;
      });
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
    const name = ui.pairName.value.trim() || ui.pairName.placeholder;
    ui.inviteJoin.disabled = true;
    void actions
      .redeem(name)
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
