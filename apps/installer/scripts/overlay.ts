// The version- and machine-specific part of the launcher's bundle configuration, merged
// over src-tauri/tauri.conf.json with `--config` by build-installer.ts. Pure: what goes in
// the overlay per OS, with nothing read from the environment but what is passed in.
//
// Windows: NSIS writes the version directory, `current` and the brain straight into the
// install directory, which is the root; the bundler signs through sign.ts. macOS and Linux:
// the same three land under `seed/` in the sealed package (`Contents/Resources/seed`,
// `/usr/lib/Cophyla/seed`), which the launcher syncs into the user's root at first start;
// the package's identifier is the launcher's own (`com.fareaststudios.cophyla.launcher`), distinct from the
// shell bundle's (`com.fareaststudios.cophyla.desktop`), and the macOS signing identity is Tauri's variable, ad-hoc
// when unset.

import type { HostOs } from "../../cophylad/src/update/platform.ts";

export const LAUNCHER_IDENTIFIER = "com.fareaststudios.cophyla.launcher";
export const MIN_MACOS = "11.0";

export interface OverlayEnv {
  /** The Bun executable that runs sign.ts (`process.execPath`). */
  bun: string;
  /** The absolute path of scripts/sign.ts. */
  signScript: string;
  /** `APPLE_SIGNING_IDENTITY`, when set. */
  appleSigningIdentity?: string | undefined;
}

export type Overlay = Record<string, unknown>;

/** Sources are relative to src-tauri/, as the bundler reads them. */
function resources(version: string, prefix: string): Record<string, string> {
  return {
    [`../stage/versions/${version}`]: `${prefix}versions/${version}`,
    "../stage/current": `${prefix}current`,
    "../stage/brain": `${prefix}brain`,
  };
}

export function overlayFor(os: HostOs, version: string, env: OverlayEnv, opts: { appimage?: boolean } = {}): Overlay {
  switch (os) {
    case "windows":
      return {
        version,
        bundle: {
          resources: resources(version, ""),
          windows: { signCommand: { cmd: env.bun, args: ["run", env.signScript, "%1"] } },
        },
      };
    case "macos":
      return {
        version,
        identifier: LAUNCHER_IDENTIFIER,
        bundle: {
          targets: ["app", "dmg"],
          resources: resources(version, "seed/"),
          macOS: { signingIdentity: env.appleSigningIdentity ?? "-", minimumSystemVersion: MIN_MACOS },
        },
      };
    case "linux":
      return {
        version,
        identifier: LAUNCHER_IDENTIFIER,
        bundle: {
          targets: opts.appimage ? ["appimage"] : ["deb"],
          resources: resources(version, "seed/"),
        },
      };
  }
}
