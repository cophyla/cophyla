// The credential in the app's own preferences rather than the web view's storage: the
// native side holds it, a cleared web view does not lose it, and nothing served from a
// page can read it. The PKCE verifier of a sign-in in progress sits there too, because the
// browser the sign-in happens in may outlive the app's process.

import { Preferences } from "@capacitor/preferences";
import { asyncStore, SIGN_IN_TTL_MS } from "../pairing.ts";
import type { CredentialStore, PendingSignIn } from "../pairing.ts";

const SIGN_IN_KEY = "cophyla.signin";

/** The sign-in the app started, kept until its grant comes back: `take` hands it over once, and nothing past its time. */
export const pendingSignIn = {
  save: (p: PendingSignIn): Promise<void> => Preferences.set({ key: SIGN_IN_KEY, value: JSON.stringify(p) }),
  take: async (now = Date.now()): Promise<PendingSignIn | undefined> => {
    const raw = (await Preferences.get({ key: SIGN_IN_KEY })).value;
    await Preferences.remove({ key: SIGN_IN_KEY });
    if (!raw) return undefined;
    try {
      const p = JSON.parse(raw) as Partial<PendingSignIn>;
      if (typeof p.verifier !== "string" || typeof p.startedAt !== "number" || now - p.startedAt > SIGN_IN_TTL_MS) return undefined;
      return { verifier: p.verifier, startedAt: p.startedAt };
    } catch {
      return undefined;
    }
  },
};

export function preferencesStore(): CredentialStore {
  return asyncStore({
    get: async (key) => (await Preferences.get({ key })).value,
    set: (key, value) => Preferences.set({ key, value }),
    remove: (key) => Preferences.remove({ key }),
  });
}
