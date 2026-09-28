// Cophyla's desktop app: a Tauri 2 shell around one web view. It holds no
// product logic. It keeps the client-protocol credential and connection on this side,
// starts cophylad when none is listening and never stops it, hosts views in a sandboxed frame
// on their own origin, puts asks on OS notifications while it is not in front (and takes
// them down when it comes to the front), names the files dropped on a view from the desktop
// (dropped.rs), and lives in the tray when the
// window is closed (on macOS the Dock icon goes with the window: it is there while the
// window is, and a click on it in the Dock or the Finder shows the window again). Its host
// page hears the wake words and the talk key, and speaks the replies (voice.rs).
// Installed, it runs from a version directory behind the launcher and relaunches through
// it when a newer version waits. See apps/ui/README.md.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod dropped;
mod install;
mod links;
mod notify;
mod cophylad;
mod stream;
mod tray;
mod views;
mod voice;

use tauri::{AppHandle, Manager, RunEvent, Runtime, Theme, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const HIDDEN_FLAG: &str = "--hidden";

/// Shows or hides the app in the Dock (macOS); nothing elsewhere.
pub fn dock<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = app.set_dock_visibility(visible) {
            log::warn!("dock visibility: {e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, visible);
    }
}

/// The title bar in the view's own ground (#14121a) on Windows 11; the dark theme alone gives
/// Windows' grey there, and that is what Windows 10, which does not know the colour, keeps.
#[cfg(windows)]
fn caption_color<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use windows::Win32::Foundation::{COLORREF, HWND};
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CAPTION_COLOR};
    let Ok(hwnd) = window.hwnd() else { return };
    let color = COLORREF(0x001a_1214); // 0x00BBGGRR
    let size = std::mem::size_of::<COLORREF>() as u32;
    // SAFETY: the handle is this window's, and the attribute reads one COLORREF from `color`.
    if let Err(e) = unsafe { DwmSetWindowAttribute(HWND(hwnd.0), DWMWA_CAPTION_COLOR, (&raw const color).cast(), size) } {
        log::debug!("caption colour: {e}");
    }
}

fn hide_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(cophylad::HOST_LABEL) {
        let _ = w.hide();
    }
    dock(app, false);
}

/// The macOS menu bar: the system's usual menus (Edit is what gives the web view copy and
/// paste), with ⌘Q as the app's own item. The stock Quit is AppKit's `terminate:`, which ends
/// the process before `RunEvent::ExitRequested` could hold it (tao registers no
/// `applicationShouldTerminate:`), while Cophyla stays in the menu bar when its window goes:
/// ⌘Q closes the window, as the close button does. "Quit Cophyla", with no key, ends it, as
/// Quit in the tray does.
#[cfg(target_os = "macos")]
mod app_menu {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
    use tauri::{AppHandle, Runtime};

    pub const CLOSE: &str = "app-close";
    pub const QUIT: &str = "app-quit";

    pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
        let sep = || PredefinedMenuItem::separator(app);
        let about = AboutMetadata { name: Some("Cophyla".into()), version: Some(app.package_info().version.to_string()), ..Default::default() };
        let cophyla = Submenu::with_items(
            app,
            "Cophyla",
            true,
            &[
                &PredefinedMenuItem::about(app, Some("About Cophyla"), Some(about))?,
                &sep()?,
                &PredefinedMenuItem::services(app, None)?,
                &sep()?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &sep()?,
                &MenuItem::with_id(app, CLOSE, "Close Cophyla", true, Some("CmdOrCtrl+Q"))?,
                &MenuItem::with_id(app, QUIT, "Quit Cophyla", true, None::<&str>)?,
            ],
        )?;
        let edit = Submenu::with_items(
            app,
            "Edit",
            true,
            &[
                &PredefinedMenuItem::undo(app, None)?,
                &PredefinedMenuItem::redo(app, None)?,
                &sep()?,
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ],
        )?;
        let view = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;
        let window = Submenu::with_items(
            app,
            "Window",
            true,
            &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?, &sep()?, &PredefinedMenuItem::close_window(app, None)?],
        )?;
        Menu::with_items(app, &[&cophyla, &edit, &view, &window])
    }
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    // Before any window: the id a toast is attributed to belongs to the process.
    notify::set_process_aumid();
    let hidden = std::env::args().skip(1).any(|a| a == HIDDEN_FLAG);
    let install = install::Install::detect();

    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu::build).on_menu_event(|app, event| match event.id().as_ref() {
        app_menu::CLOSE => hide_window(app),
        app_menu::QUIT => app.exit(0),
        _ => {}
    });
    let app = builder
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| tray::show_window(app)))
        .plugin(voice::plugin())
        .manage(cophylad::Link::new())
        .manage(voice::TalkKey::default())
        .manage(views::Staged::default())
        .register_uri_scheme_protocol(views::SCHEME, views::handle)
        .invoke_handler(tauri::generate_handler![commands::cophylad_attach, commands::cophylad_send, commands::view_stage, commands::notify_ask, commands::dismiss_ask, dropped::dropped_paths, stream::stream_open, stream::stream_close, links::open_link, voice::ptt_shortcut])
        .setup(move |app| {
            notify::register(app.handle(), install.as_ref());
            let dev_origin = views::dev_origin(app.handle());
            let builder = WebviewWindowBuilder::new(app, cophylad::HOST_LABEL, WebviewUrl::App("index.html".into()));
            // The host page starts its audio with no click first, as the phone app's does: wry's
            // own flags, and the autoplay policy that lets an AudioContext run from the start.
            #[cfg(windows)]
            let builder = builder.additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required");
            let window = builder
                .title("Cophyla")
                .inner_size(1100.0, 760.0)
                .min_inner_size(640.0, 420.0)
                // The view is dark, and so is the title bar.
                .theme(Some(Theme::Dark))
                // The page's own drag and drop, a file dragged from the view's explorer onto its
                // chat or terminal: on Windows the native file-drop handler would swallow it. A
                // file dragged in from the desktop reaches the page too, and dropped.rs names it.
                .disable_drag_drop_handler()
                .visible(false)
                // The host page never leaves the app's own origin (or `tauri dev`'s server when
                // one is configured). A view's frame is governed by the host CSP's frame-src;
                // WebView2 never shows this callback a frame's navigation, WebKit (macOS,
                // Linux) does, so the view origin is allowed here too (`view://localhost`
                // there, whose origin the URL standard leaves opaque, so it is matched by its
                // parts): the frame is sandboxed without `allow-top-navigation`, so nothing can
                // take the host itself there.
                .on_navigation(move |url| {
                    let local = url.scheme() == "tauri"
                        || url.host_str() == Some("tauri.localhost")
                        || views::is_view(url)
                        || dev_origin.as_deref().is_some_and(|o| url.origin().ascii_serialization() == o);
                    if !local {
                        log::warn!("refused navigation to {url}");
                    }
                    local
                })
                .build()?;
            #[cfg(windows)]
            caption_color(&window);
            voice::allow_microphone(&window);
            dropped::listen(&window);
            tray::build(app, install.as_ref())?;
            let handle = app.handle().clone();
            window.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    hide_window(&handle);
                }
                // The user is at the app: its asks are in front of them, and the notifications go.
                WindowEvent::Focused(true) => notify::clear(),
                _ => {}
            });
            if hidden {
                dock(app.handle(), false);
            } else {
                let _ = window.show();
                // started by the launcher, which is gone by then: in front, not behind the Finder
                let _ = window.set_focus();
            }
            tauri::async_runtime::spawn(cophylad::run_link(app.handle().clone()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the tauri application");

    app.run(|app, event| match &event {
        // Only Quit (app.exit) ends the process; a closed window (or Cmd+Q) is a hidden one.
        RunEvent::ExitRequested { code: None, api, .. } => {
            api.prevent_exit();
            hide_window(app);
        }
        // A click on the Dock icon or the app in the Finder while running.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => tray::show_window(app),
        _ => {}
    });
}
