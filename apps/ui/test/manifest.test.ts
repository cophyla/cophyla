// The check spike 07 asked for: an app command defined in Rust but missing from the app
// manifest is callable from every web view, silently. Four lists must agree without a
// cargo build: `#[tauri::command] fn <name>` in the sources, `generate_handler![…]`,
// commands.txt (what build.rs declares), and the `allow-<name>` grants in the capability
// files. A grant must go to the host web view alone, never by its window, which a stream's
// page beside the view shares; the host CSP must confine frames to the
// view origin; and no updater plugin may be present. The installer's package must carry the
// shell's identity and version, and the launcher's hooks must be the four the bundler inserts.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUN_NAMES, LAUNCHER_NAMES, SHELL_PATHS } from "../../cophylad/src/update/platform.ts";
import type { HostOs } from "../../cophylad/src/update/platform.ts";

const TAURI = join(import.meta.dir, "..", "src-tauri");
const read = (...p: string[]) => readFileSync(join(TAURI, ...p), "utf8");

function rustSources(): { name: string; text: string }[] {
  return readdirSync(join(TAURI, "src"))
    .filter((f) => f.endsWith(".rs"))
    .map((name) => ({ name, text: read("src", name) }));
}

/** `#[tauri::command]` followed by `pub fn name` or `fn name`, attributes and generics allowed between. */
function definedCommands(): Set<string> {
  const out = new Set<string>();
  for (const { text } of rustSources()) {
    for (const m of text.matchAll(/#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1]!);
  }
  return out;
}

function handlerCommands(): Set<string> {
  const out = new Set<string>();
  for (const { text } of rustSources()) {
    for (const m of text.matchAll(/generate_handler!\s*\[([^\]]*)\]/g)) {
      for (const raw of m[1]!.split(",")) {
        const name = raw.trim().split("::").pop()?.trim();
        if (name) out.add(name);
      }
    }
  }
  return out;
}

function declaredCommands(): Set<string> {
  return new Set(
    read("commands.txt")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#")),
  );
}

const kebab = (s: string) => s.replace(/_/g, "-");
const snake = (s: string) => s.replace(/-/g, "_");

interface Capability {
  file: string;
  windows?: string[];
  webviews?: string[];
  remote?: unknown;
  permissions: (string | { identifier: string })[];
}

function capabilities(): Capability[] {
  const dir = join(TAURI, "capabilities");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((file) => ({ file, ...(JSON.parse(readFileSync(join(dir, file), "utf8")) as Omit<Capability, "file">) }));
}

function grantedCommands(): Set<string> {
  const out = new Set<string>();
  for (const cap of capabilities()) {
    for (const p of cap.permissions) {
      const id = typeof p === "string" ? p : p.identifier;
      const m = /^allow-([a-z0-9-]+)$/.exec(id);
      if (m) out.add(snake(m[1]!));
    }
  }
  return out;
}

describe("app command manifest", () => {
  const defined = definedCommands();
  const handled = handlerCommands();
  const declared = declaredCommands();
  const granted = grantedCommands();

  test("there are commands to check", () => {
    expect(defined.size).toBeGreaterThan(0);
  });

  test("every #[tauri::command] is in generate_handler!, and nothing else is", () => {
    expect([...handled].sort()).toEqual([...defined].sort());
  });

  test("every #[tauri::command] is declared in commands.txt, and nothing else is", () => {
    expect([...declared].sort()).toEqual([...defined].sort());
  });

  test("every declared command is granted as allow-<kebab> in a capability, and nothing else is", () => {
    expect([...granted].sort()).toEqual([...declared].sort());
    for (const name of declared) expect(kebab(name)).toMatch(/^[a-z0-9-]+$/);
  });

  test("a capability that grants an app command applies to the host web view only, with no remote origin", () => {
    for (const cap of capabilities()) {
      const grantsApp = cap.permissions.some((p) => /^allow-/.test(typeof p === "string" ? p : p.identifier));
      if (!grantsApp) continue;
      // by window it would reach a stream's page laid over the host window too
      expect(cap.webviews).toEqual(["host"]);
      expect(cap.windows ?? []).toEqual([]);
      expect(cap.remote).toBeUndefined();
    }
  });

  test("build.rs declares the commands from commands.txt", () => {
    const build = read("build.rs");
    expect(build).toContain('include_str!("commands.txt")');
    expect(build).toContain("AppManifest::new()");
    expect(build).toContain(".commands(");
  });
});

const conf = JSON.parse(read("tauri.conf.json")) as { app: { security: { csp: string }; withGlobalTauri?: boolean }; identifier: string; productName: string; mainBinaryName?: string };

describe("shell configuration", () => {
  test("the host CSP confines frames to the view origin and scripts to the app", () => {
    const csp = conf.app.security.csp;
    // WebView2's form of the view origin and WebKit's (ORIGIN in views.rs), and nothing else
    expect(/frame-src ([^;]*)/.exec(csp)?.[1]?.split(" ").sort()).toEqual(["http://view.localhost", "view://localhost"]);
    expect(csp).toMatch(/script-src 'self'(;|$| )/);
    expect(csp).toContain("default-src 'none'");
  });

  test("the global Tauri object is off and the identity is the app's", () => {
    expect(conf.app.withGlobalTauri).toBe(false);
    expect(conf.identifier).toBe("com.fareaststudios.cophyla.desktop");
    expect(conf.productName).toBe("Cophyla");
  });

  test("Cargo.toml has no updater plugin; launch at login goes through auto-launch, not the autostart plugin", () => {
    const cargo = read("Cargo.toml");
    expect(cargo).not.toContain("tauri-plugin-updater");
    expect(cargo).toContain("tauri-plugin-single-instance");
    expect(cargo).toContain('auto-launch = "0.5"');
    expect(cargo).not.toContain("tauri-plugin-autostart");
    expect(cargo).toMatch(/\[\[bin\]\]\s*\r?\nname = "cophyla-ui"/);
    expect(conf.mainBinaryName).toBe("cophyla-ui");
  });

  test("the shell relaunches through the launcher and asks a daemon of another version to stop", () => {
    const cophylad = read("src", "cophylad.rs");
    expect(cophylad).toContain("Install::detect()");
    expect(cophylad).toContain("newer_waiting()");
    expect(cophylad).toContain('"method": "update.apply"');
    const install = read("src", "install.rs");
    expect(install).toContain('"--wait-pid"');
    expect(install).toContain('"COPHYLA_LAUNCHER"');
    expect(install).toContain('pub const LAUNCHER_FILE: &str = "launcher"');
  });

  test("the macOS bundle declares why it sends Apple events, so the Automation prompt for session.focus appears", () => {
    const plist = read("Info.plist");
    expect(plist).toContain("<key>NSAppleEventsUsageDescription</key>");
    expect(plist).toMatch(/<string>Cophyla raises the terminal[^<]*<\/string>/);
  });

  test("the macOS bundle says why it uses the local network, for the direct connections' helper", () => {
    const plist = read("Info.plist");
    expect(plist).toMatch(/<key>NSLocalNetworkUsageDescription<\/key>\s*<string>Cophyla connects[^<]*<\/string>/);
  });

  test("a stream's window opens only a loopback stream page and tells the host when it closes", () => {
    const stream = read("src", "stream.rs");
    expect(stream).toContain("pub fn loopback_page");
    expect(stream).toContain('pub const CLOSED_EVENT: &str = "stream:closed"');
    expect(stream).toContain(".incognito(true)");
    expect(stream).toContain('find_property("enable-webrtc")');
    expect(read("..", "host", "main.ts")).toContain('"stream:closed"');
  });

  test("notifications: WinRT toasts tagged by ask on Windows, notify-rust on Linux, its UNUserNotificationCenter backend on macOS with a wait that a dismissal stops; no notification plugin", () => {
    const cargo = read("Cargo.toml");
    expect(cargo).not.toContain("tauri-plugin-notification");
    expect(cargo).toMatch(/\[target\.'cfg\(target_os = "linux"\)'\.dependencies\]\s*\r?\nnotify-rust = "4\.18"/);
    expect(cargo).toMatch(/\[target\.'cfg\(target_os = "macos"\)'\.dependencies\]\s*\r?\nnotify-rust = \{ version = "4\.18", features = \["preview-macos-un"\] \}/);
    expect(cargo).toMatch(/\[target\.'cfg\(windows\)'\.dependencies\][^[]*\nwindows = \{[^}]*"Data_Xml_Dom"[^}]*"UI_Notifications"/);
    const notify = read("src", "notify.rs");
    expect(notify).toContain("toast.SetTag(&HSTRING::from(&ask.id))");
    expect(notify).toContain("RemoveGroupedTagWithId");
    expect(notify).toContain('#[cfg(any(target_os = "linux", target_os = "macos"))]');
    expect(notify).toContain("notify_rust::handle_action");
    expect(notify).toContain('"__closed"');
    // macOS: the backend itself, each wait racing the stop `dismiss` and `clear` fire
    expect(cargo).toMatch(/mac-usernotifications = "0\.3\.1"\s*\r?\nfutures-lite = "2"\s*\r?\nfutures-channel = "0\.3"/);
    expect(notify).toContain("future::or(async { handle.response().await.ok() }");
    expect(notify).toContain("let _ = n.stop.send(());");
  });

  test("launch at login uses a launch agent on macOS under the launcher's identifier, and the Dock follows the window", () => {
    const tray = read("src", "tray.rs");
    expect(tray).toContain(".set_use_launch_agent(true)");
    expect(tray).toContain('pub const AUTOSTART_NAME: &str = "com.fareaststudios.cophyla.launcher"');
    // a template image the menu bar draws in its own colour, made from the frog
    expect(tray).toContain(".icon_as_template(true)");
    expect(tray).toContain("template_rgba(icon.rgba())");
    const main = read("src", "main.rs");
    expect(main).toContain("set_dock_visibility(visible)");
    expect(main).toContain("RunEvent::Reopen");
  });
});

/**
 * `#[cfg(<predicate>)] pub const <NAME>: &str = "<value>";` pairs in a Rust source, keyed by the
 * OS the predicate names: `windows`, `target_os = "macos"`, `unix` without macOS as linux.
 */
function rustOsConsts(text: string, name: string): Partial<Record<HostOs, string>> {
  const out: Partial<Record<HostOs, string>> = {};
  for (const m of text.matchAll(new RegExp(`#\\[cfg\\(([^\\]]+)\\)\\]\\s*\\r?\\n\\s*pub const ${name}: &str = "([^"]+)";`, "g"))) {
    const cfg = m[1]!;
    const os: HostOs | undefined = cfg === "windows" ? "windows" : cfg.includes('target_os = "macos"') && !cfg.includes("not(") ? "macos" : cfg.includes("unix") || cfg.includes('target_os = "linux"') ? "linux" : undefined;
    if (os) out[os] = m[2]!;
  }
  return out;
}

describe("per-OS names", () => {
  const INSTALLER = join(import.meta.dir, "..", "..", "installer", "src-tauri");

  test("the launcher's SHELL, the shell's LAUNCHER and BUN are the cophylad tables, on every OS", () => {
    const layout = readFileSync(join(INSTALLER, "src", "layout.rs"), "utf8");
    expect(rustOsConsts(layout, "SHELL")).toEqual(SHELL_PATHS);
    const cophylad = read("src", "cophylad.rs");
    const bun = rustOsConsts(cophylad, "BUN");
    expect(bun.windows).toBe(BUN_NAMES.windows);
    // `#[cfg(not(windows))]` covers macOS and Linux, which share a name.
    const notWindows = /#\[cfg\(not\(windows\)\)\]\s*\r?\n\s*pub const BUN: &str = "([^"]+)";/.exec(cophylad)?.[1];
    expect(notWindows).toBe(BUN_NAMES.macos);
    expect(BUN_NAMES.linux).toBe(BUN_NAMES.macos);
    const install = read("src", "install.rs");
    expect(rustOsConsts(install, "LAUNCHER").windows).toBe(LAUNCHER_NAMES.windows);
    const launcherElse = /#\[cfg\(not\(windows\)\)\]\s*\r?\n\s*pub const LAUNCHER: &str = "([^"]+)";/.exec(install)?.[1];
    expect(launcherElse).toBe(LAUNCHER_NAMES.macos);
    expect(LAUNCHER_NAMES.linux).toBe(LAUNCHER_NAMES.macos);
    // the launcher file's name is the same on both sides
    expect(install).toContain('pub const LAUNCHER_FILE: &str = "launcher"');
    expect(layout).toContain('pub const LAUNCHER_FILE: &str = "launcher"');
  });

  test("the launcher seeds the root from the package on macOS and Linux and hands the shell its own path", () => {
    const main = readFileSync(join(INSTALLER, "src", "main.rs"), "utf8");
    expect(main).toContain("mod seed;");
    expect(main).toContain("seed::sync(");
    expect(main).toContain('.env("COPHYLA_LAUNCHER", launcher)');
    expect(main).toContain("process_group(0)");
    expect(main).toContain('join("Resources").join("seed")');
    expect(main).toContain('join("lib").join("Cophyla").join("seed")');
    expect(existsSync(join(INSTALLER, "src", "seed.rs"))).toBe(true);
    const cargo = readFileSync(join(INSTALLER, "Cargo.toml"), "utf8");
    expect(cargo).toMatch(/\[target\.'cfg\(unix\)'\.dependencies\]\s*\r?\n(#[^\n]*\r?\n)*libc = "0\.2"/);
    expect(cargo).toContain('dirs = "6"');
  });
});

describe("installer configuration", () => {
  const INSTALLER = join(import.meta.dir, "..", "..", "installer");
  const readInstaller = (...p: string[]) => readFileSync(join(INSTALLER, ...p), "utf8");
  const installerConf = JSON.parse(readInstaller("src-tauri", "tauri.conf.json")) as {
    productName: string;
    identifier: string;
    mainBinaryName?: string;
    bundle: { active: boolean; targets: string[]; licenseFile?: string; windows?: { nsis?: { installMode?: string; installerHooks?: string } } };
  };

  test("the launcher's package carries the shell's identity, so the shortcut's AUMID groups the app's toasts", () => {
    expect(installerConf.identifier).toBe(conf.identifier);
    expect(installerConf.productName).toBe(conf.productName);
    expect(installerConf.mainBinaryName).toBe("Cophyla");
  });

  test("an NSIS per-user package with the hooks and the licence text", () => {
    expect(installerConf.bundle.active).toBe(true);
    expect(installerConf.bundle.targets).toEqual(["nsis"]);
    expect(installerConf.bundle.windows?.nsis?.installMode).toBe("currentUser");
    expect(installerConf.bundle.windows?.nsis?.installerHooks).toBe("../hooks.nsh");
    expect(installerConf.bundle.licenseFile).toBe("../LICENSE.txt");
    const hooks = readInstaller("hooks.nsh");
    for (const macro of ["NSIS_HOOK_PREINSTALL", "NSIS_HOOK_POSTINSTALL", "NSIS_HOOK_PREUNINSTALL", "NSIS_HOOK_POSTUNINSTALL"]) expect(hooks).toContain(`!macro ${macro}`);
    expect(hooks).toContain('CheckIfAppIsRunning "cophyla-ui.exe"');
    expect(hooks).toContain('RMDir /r "$INSTDIR\\versions"');
  });

  test("the static launcher config carries the macOS and Linux bundle settings; the overlay adds the per-OS rest", () => {
    const conf = installerConf as unknown as { bundle: { icon: string[]; macOS?: { minimumSystemVersion?: string }; linux?: { deb?: { depends?: string[]; desktopTemplate?: string } } } };
    expect(conf.bundle.icon).toContain("../../ui/src-tauri/icons/icon.icns");
    expect(conf.bundle.macOS?.minimumSystemVersion).toBe("11.0");
    // the bundler adds webkit2gtk and gtk from the binary; the indicator library is what it misses
    expect(conf.bundle.linux?.deb?.depends).toEqual(["libayatana-appindicator3-1"]);
    expect(conf.bundle.linux?.deb?.desktopTemplate).toBe("../cophyla.desktop.hbs");
    const desktop = readInstaller("cophyla.desktop.hbs");
    expect(desktop).toContain("StartupWMClass=cophyla-ui");
    expect(desktop).toContain("Exec={{exec}}");
    const plist = readInstaller("src-tauri", "Info.plist");
    expect(plist).toContain("<key>LSUIElement</key>");
    expect(plist).toMatch(/<key>LSUIElement<\/key>\s*<true\/>/);
    expect(readInstaller("hooks.nsh")).toContain('Delete "$INSTDIR\\launcher"');
    const entitlements = readInstaller("entitlements.plist");
    for (const key of ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory", "com.apple.security.cs.disable-executable-page-protection"]) expect(entitlements).toContain(`<key>${key}</key>`);
    // The shell's own: its web view's microphone and the Apple Events focus sends, signed in by the bundler.
    const shell = readInstaller("entitlements-shell.plist");
    for (const key of ["com.apple.security.device.audio-input", "com.apple.security.automation.apple-events"]) expect(shell).toContain(`<key>${key}</key>`);
    expect(readInstaller("scripts", "stage-platform.ts")).toContain('entitlements: join(INSTALLER, "entitlements-shell.plist")');
    // codesign's parser keeps to XML: a double hyphen inside a comment fails every signing
    for (const file of ["entitlements.plist", "entitlements-shell.plist", "entitlements-net.plist"]) {
      for (const [, body] of readInstaller(file).matchAll(/<!--([\s\S]*?)-->/g)) expect(body!.includes("--"), file).toBe(false);
    }
  });

  test("neither crate carries the updater plugin; the launcher depends on tauri without its default features", () => {
    const cargo = readInstaller("src-tauri", "Cargo.toml");
    expect(cargo).not.toContain("tauri-plugin-updater");
    // The form the Tauri CLI's manifest rewriter leaves alone (it adds `features = []` otherwise).
    expect(cargo).toMatch(/tauri = \{ version = "2", default-features = false, features = \[\] \}/);
    expect(cargo).toMatch(/\[\[bin\]\]\s*\r?\nname = "cophyla-launcher"/);
  });

  test("the version is the same in every manifest", () => {
    const source = (JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "cophylad", "package.json"), "utf8")) as { version: string }).version;
    const cargoVersion = (text: string) => /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(text)?.[1];
    expect((JSON.parse(read("tauri.conf.json")) as { version: string }).version).toBe(source);
    expect(cargoVersion(read("Cargo.toml"))).toBe(source);
    expect((installerConf as unknown as { version: string }).version).toBe(source);
    expect(cargoVersion(readInstaller("src-tauri", "Cargo.toml"))).toBe(source);
  });

  test("the view protocol handler answers the host webview only and sends the frame CSP", () => {
    const views = read("src", "views.rs");
    expect(views).toContain('webview_label() != HOST_LABEL');
    expect(views).toContain("connect-src 'none'");
    expect(views).toContain("frame-ancestors {host}");
    // WebView2 serves the app's schemes as http://<scheme>.localhost, WebKit (macOS, Linux) as <scheme>://localhost.
    const notWindows = (name: string) => new RegExp(`#\\[cfg\\(not\\(windows\\)\\)\\]\\s*\\r?\\n\\s*pub const ${name}: &str = "([^"]+)";`).exec(views)?.[1];
    expect(rustOsConsts(views, "ORIGIN").windows).toBe("http://view.localhost");
    expect(notWindows("ORIGIN")).toBe("view://localhost");
    expect(rustOsConsts(views, "HOST_ORIGIN").windows).toBe("http://tauri.localhost");
    expect(notWindows("HOST_ORIGIN")).toBe("tauri://localhost");
    expect(views).toContain("ACCESS_CONTROL_ALLOW_ORIGIN");
    expect(views).toContain("X_CONTENT_TYPE_OPTIONS");
  });
});
