// The moonlight-web release the web sidecar runs, pinned by version, size and hash per
// target. It is a GPL program fetched from its own releases on first use, never bundled.
// Every archive unpacks to `package/` with
// `web-server`, `streamer` and `static/`. There is no macOS build: a Mac serves no phones
// until one appears here.

export interface WebAsset {
  url: string;
  size: number;
  sha256: string;
  kind: "zip" | "tar.gz";
}

export const WEB_VERSION = "v2.10.0";

const BASE = `https://github.com/MrCreativ3001/moonlight-web-stream/releases/download/${WEB_VERSION}`;

export const WEB_ASSETS: Record<string, WebAsset> = {
  "windows-x64": {
    url: `${BASE}/moonlight-web-x86_64-pc-windows-gnu.zip`,
    size: 23972957,
    sha256: "1dc3019952c610fbd7deb76dc84e3c4c6f26458ebb44823ea1f02ad883a36da9",
    kind: "zip",
  },
  "linux-x64": {
    url: `${BASE}/moonlight-web-x86_64-unknown-linux-gnu.tar.gz`,
    size: 16043675,
    sha256: "b17fa535676a1c118bc1eb009134644cab98190b36a0776fb1b4a505d569f5eb",
    kind: "tar.gz",
  },
  "linux-arm64": {
    url: `${BASE}/moonlight-web-aarch64-unknown-linux-gnu.tar.gz`,
    size: 16549870,
    sha256: "1a6bb6845756883671a5a783c0797367e84166c8210f8cfa51059f434f0e5a3a",
    kind: "tar.gz",
  },
};

/** The asset for `<os>-<arch>`, or nothing when the release has none. */
export function webAssetFor(target: string): WebAsset | undefined {
  return WEB_ASSETS[target];
}
