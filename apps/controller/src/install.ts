// Installing the page as an app of its own: a window with its icon and no address bar, opened
// from the computer's or the phone's own menu. The page says what it is in `app.webmanifest`,
// and a browser that installs pages offers it once its conditions hold: the manifest's name
// and icons, and a connection it trusts. One behind a certificate the user only made an
// exception for is not offered, so with the node's own certificate the offer comes where that
// certificate was made trusted on the device, or where the node serves one of the user's own.
//
// A browser that offers says so with `beforeinstallprompt`. The offer is kept so the page can
// make it from its own settings; in a wide window, which has no bar of its own to say so, it
// is held back from the browser's banner as well. A phone's browser keeps its own way of
// offering it. An offer asks once: whatever the answer, it is spent, and the browser makes
// another when it will.

/** What a browser hands the page when it would install it. */
export interface InstallPrompt {
  preventDefault(): void;
  prompt(): Promise<unknown>;
  userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallAnswer = "accepted" | "dismissed" | "unavailable";

export class InstallOffer {
  private offer?: InstallPrompt;
  private watchers = new Set<() => void>();
  /** The page was installed while it was open. */
  installed = false;

  constructor(target: { addEventListener(type: string, listener: (ev: unknown) => void): void }, opts: { hold: boolean }) {
    target.addEventListener("beforeinstallprompt", (ev) => {
      const offer = ev as InstallPrompt;
      if (opts.hold) offer.preventDefault();
      this.offer = offer;
      this.changed();
    });
    target.addEventListener("appinstalled", () => {
      this.offer = undefined;
      this.installed = true;
      this.changed();
    });
  }

  /** Whether the browser would install the page now. */
  get available(): boolean {
    return this.offer !== undefined;
  }

  /** Has the browser ask. Called from a press, which a browser wants for it. */
  async prompt(): Promise<InstallAnswer> {
    const offer = this.offer;
    if (!offer) return "unavailable";
    this.offer = undefined;
    this.changed();
    await offer.prompt();
    const choice = await offer.userChoice?.catch(() => undefined);
    return choice?.outcome ?? "dismissed";
  }

  /** Calls `changed` whenever an offer comes or goes; returns how to stop. */
  subscribe(changed: () => void): () => void {
    this.watchers.add(changed);
    return () => this.watchers.delete(changed);
  }

  private changed(): void {
    for (const w of [...this.watchers]) w();
  }
}
