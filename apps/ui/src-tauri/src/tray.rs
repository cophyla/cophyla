// The tray icon: Open, Launch at login, Restart to update <v> (only while a platform release
// is staged), Quit. A left click shows the window; only Quit ends the process, and cophylad
// keeps running either way. Launch at login registers the launcher when installed (the
// fixed entry point that survives updates), this executable from a checkout: a Run-key
// entry on Windows, a launch agent plist (`com.fareaststudios.cophyla.launcher`) on macOS, an autostart
// `.desktop` entry on Linux. The item is disabled when the launcher is not known.
//
// An installed Cophyla turns it on itself the first time it runs, because a node with its
// daemon down is a node the phone cannot reach and a machine whose sessions carry hooks
// nobody answers. It is a default, not a policy: the marker records that it was applied, and
// it is never applied twice, so turning it off in the menu stays off. A checkout never
// registers itself.
//
// On macOS the icon is a template image, as the menu bar's own are: the frog's shape in black
// with its white eyes left open, which the menu bar draws in its own colour for a light or dark
// bar. The coloured frog was hard to find in a full menu bar.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use auto_launch::{AutoLaunch, AutoLaunchBuilder};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager, Runtime};

use crate::install::Install;
use crate::cophylad::{Link, Paths, HOST_LABEL};

pub const TRAY_ID: &str = "tray";
pub const TOOLTIP: &str = "Cophyla";
/// The launch agent's label on macOS (`~/Library/LaunchAgents/<label>.plist`); the entry's name elsewhere.
#[cfg(target_os = "macos")]
pub const AUTOSTART_NAME: &str = "com.fareaststudios.cophyla.launcher";
#[cfg(not(target_os = "macos"))]
pub const AUTOSTART_NAME: &str = "Cophyla";

const OPEN: &str = "open";
const AUTOSTART: &str = "autostart";
const UPDATE: &str = "update";
const QUIT: &str = "quit";
/// Where the update item sits in the menu when a release is staged: under Launch at login.
const UPDATE_POSITION: usize = 2;

pub fn show_window<R: Runtime>(app: &AppHandle<R>) {
    crate::dock(app, true);
    if let Some(w) = app.get_webview_window(HOST_LABEL) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// What launch at login starts: the launcher with `--hidden` when installed (the entry
/// outlives every update), this executable from a checkout, nothing when installed without
/// a known launcher.
pub fn autostart_target(install: Option<&Install>) -> Option<PathBuf> {
    match install {
        Some(i) => i.launcher.clone(),
        None => std::env::current_exe().ok(),
    }
}

/// The login entry for a target: a Run-key value, a launch agent, an autostart `.desktop`.
pub fn autostart(target: Option<PathBuf>) -> Result<AutoLaunch, String> {
    let path = target.ok_or_else(|| "the launcher is not known".to_string())?;
    AutoLaunchBuilder::new()
        .set_app_name(AUTOSTART_NAME)
        .set_app_path(&path.to_string_lossy())
        .set_use_launch_agent(true)
        .set_args(&[crate::HIDDEN_FLAG])
        .build()
        .map_err(|e| e.to_string())
}

/// Where the first run records that it applied the launch-at-login default.
pub fn autostart_marker(paths: &Paths) -> PathBuf {
    paths.home.join("data").join("autostart.default")
}

/// Whether this run should turn launch at login on by itself: an installed Cophyla with a
/// launcher to point at, no decision on file yet, and the entry not already there.
pub fn adopt_default(installed: bool, decided: bool, enabled: bool) -> bool {
    installed && !decided && !enabled
}

/// Records the decision, so the default is offered once and the user's own choice stands.
fn record_decision(marker: &Path) {
    let written = marker.parent().map_or(Ok(()), fs::create_dir_all).and_then(|()| fs::write(marker, "launch at login: default applied\n"));
    if let Err(e) = written {
        log::warn!("launch at login: cannot record the default at {}: {e}", marker.display());
    }
}

/// macOS: whether the launch agent on file starts another program than `path`: one written
/// before the app was moved, or from where macOS ran it before it was installed.
#[cfg(target_os = "macos")]
fn agent_elsewhere(path: &str) -> bool {
    let Some(home) = std::env::var_os("HOME") else { return false };
    let plist = PathBuf::from(home).join("Library").join("LaunchAgents").join(format!("{AUTOSTART_NAME}.plist"));
    fs::read_to_string(plist).is_ok_and(|text| !text.contains(&format!("<string>{path}</string>")))
}

/// Applies the default when it is this run's to apply, and answers whether the entry is on.
fn launch_at_login(launcher: Option<&AutoLaunch>, install: Option<&Install>, marker: &Path) -> bool {
    let enabled = launcher.and_then(|l| l.is_enabled().ok()).unwrap_or(false);
    let Some(launcher) = launcher else { return enabled };
    #[cfg(target_os = "macos")]
    if enabled && agent_elsewhere(launcher.get_app_path()) {
        match launcher.enable() {
            Ok(()) => log::info!("launch at login: the agent now starts {}", launcher.get_app_path()),
            Err(e) => log::warn!("launch at login: the agent names another launcher and cannot be rewritten: {e}"),
        }
    }
    if !adopt_default(install.is_some(), marker.exists(), enabled) {
        return enabled;
    }
    match launcher.enable() {
        Ok(()) => {
            log::info!("launch at login: on by default at the first run");
            record_decision(marker);
            true
        }
        Err(e) => {
            log::warn!("launch at login: the default could not be applied: {e}");
            record_decision(marker);
            enabled
        }
    }
}

/// The menu and the update item, kept so the link can show and hide the item.
pub struct UpdateMenu<R: Runtime> {
    menu: Menu<R>,
    item: MenuItem<R>,
    shown: Mutex<bool>,
}

/// Shows "Restart to update <v>" while a platform release is staged, hides it otherwise.
pub fn set_update<R: Runtime>(app: &AppHandle<R>, staged: Option<&str>) {
    let Some(state) = app.try_state::<UpdateMenu<R>>() else { return };
    let Ok(mut shown) = state.shown.lock() else { return };
    match staged {
        Some(v) => {
            let _ = state.item.set_text(format!("Restart to update {v}"));
            if !*shown {
                if let Err(e) = state.menu.insert(&state.item, UPDATE_POSITION) {
                    log::warn!("tray: cannot show the update item: {e}");
                    return;
                }
                *shown = true;
            }
        }
        None => {
            if *shown {
                let _ = state.menu.remove(&state.item);
                *shown = false;
            }
        }
    }
}

/// The icon as a template image: every pixel black, as opaque as it is dark, so the frog's
/// green is its shape and its white eyes are holes (a pixel as dark as the green is fully ink).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn template_rgba(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4)
        .flat_map(|p| {
            let lightest = u32::from(p[0].min(p[1]).min(p[2]));
            let ink = ((255 - lightest) * 255 / 195).min(255);
            [0, 0, 0, (u32::from(p[3]) * ink / 255) as u8]
        })
        .collect()
}

pub fn build<R: Runtime>(app: &App<R>, install: Option<&Install>) -> tauri::Result<()> {
    let launcher = autostart(autostart_target(install)).map_err(|e| log::warn!("launch at login unavailable: {e}")).ok();
    let on = launch_at_login(launcher.as_ref(), install, &autostart_marker(&Paths::resolve()));
    let open = MenuItem::with_id(app, OPEN, "Open", true, None::<&str>)?;
    let autostart_item = CheckMenuItem::with_id(app, AUTOSTART, "Launch at login", launcher.is_some(), on, None::<&str>)?;
    let update = MenuItem::with_id(app, UPDATE, "Restart to update", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &autostart_item, &PredefinedMenuItem::separator(app)?, &quit])?;
    app.manage(UpdateMenu { menu: menu.clone(), item: update, shown: Mutex::new(false) });

    let icon = app.default_window_icon().cloned().ok_or_else(|| tauri::Error::AssetNotFound("window icon".into()))?;
    #[cfg(target_os = "macos")]
    let icon = tauri::image::Image::new_owned(template_rgba(icon.rgba()), icon.width(), icon.height());
    let builder = TrayIconBuilder::with_id(TRAY_ID).icon(icon).tooltip(TOOLTIP).menu(&menu).show_menu_on_left_click(false);
    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);
    builder
        .on_menu_event(move |app, event| match event.id.as_ref() {
            OPEN => show_window(app),
            AUTOSTART => {
                let Some(launcher) = launcher.as_ref() else { return };
                let enabled = launcher.is_enabled().unwrap_or(false);
                let result = if enabled { launcher.disable() } else { launcher.enable() };
                match result {
                    Ok(()) => {
                        let _ = autostart_item.set_checked(!enabled);
                    }
                    Err(e) => {
                        log::warn!("launch at login: {e}");
                        let _ = autostart_item.set_checked(launcher.is_enabled().unwrap_or(enabled));
                    }
                }
            }
            UPDATE => {
                // The daemon stops when idle (else answers `conflict`, logged); the link then
                // relaunches through the launcher, which rotates the pointers.
                if let Err(e) = app.state::<Link>().request_platform_apply() {
                    log::warn!("restart to update: {e}");
                }
            }
            QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::adopt_default;
    use super::template_rgba;

    #[test]
    fn the_template_is_the_frogs_shape_with_its_eyes_open() {
        // the frog's green, an eye's white, an edge between them, and the clear background
        let green = [0x1b, 0x9e, 0x6e, 255];
        let white = [255, 255, 255, 255];
        let edge = [0x8d, 0xce, 0xb6, 255];
        let clear = [0x1b, 0x9e, 0x6e, 0];
        let out = template_rgba(&[green, white, edge, clear].concat());
        assert_eq!(&out[0..4], &[0, 0, 0, 255]);
        assert_eq!(&out[4..8], &[0, 0, 0, 0]);
        assert!(out[11] > 0 && out[11] < 255, "{}", out[11]);
        assert_eq!(&out[12..16], &[0, 0, 0, 0]);
    }

    #[test]
    fn launch_at_login_defaults_on_once_for_an_install() {
        // The first run of an installed Cophyla, with no entry yet.
        assert!(adopt_default(true, false, false));
        // Applied before: whatever the user chose since then stands, on or off.
        assert!(!adopt_default(true, true, false));
        assert!(!adopt_default(true, true, true));
        // Already registered: nothing to apply.
        assert!(!adopt_default(true, false, true));
        // A checkout never registers itself, however often it runs.
        assert!(!adopt_default(false, false, false));
    }
}
