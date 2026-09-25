// Spike 07: does the Tauri 2 shell described in architecture.md actually behave
// that way on Windows? The run is scripted on a timer so the whole thing is
// reproducible without a human clicking anything. Findings land in ../../out/rust.jsonl.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{create_dir_all, OpenOptions};
use std::io::Write as _;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;

fn spike_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("spike root")
        .to_path_buf()
}

fn record(step: &str, data: Value) {
    let dir = spike_root().join("out");
    let _ = create_dir_all(&dir);
    let line = json!({ "at": chrono_now(), "who": "rust", "step": step, "data": data });
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("rust.jsonl"))
    {
        let _ = writeln!(f, "{}", line);
    }
    println!("[spike] {} {}", step, data);
}

// Avoids pulling in the chrono crate for one timestamp.
fn chrono_now() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}", d.as_secs(), d.subsec_millis())
}

#[tauri::command]
fn host_ping() -> String {
    "pong-from-rust".to_string()
}

#[tauri::command]
fn record_cmd(step: String, data: Value) {
    record(&step, data);
}

fn tray_image() -> Image<'static> {
    // A solid orange 32x32 so it is identifiable in a screenshot of the tray.
    let mut rgba = Vec::with_capacity(32 * 32 * 4);
    for _ in 0..(32 * 32) {
        rgba.extend_from_slice(&[0xf9, 0x73, 0x16, 0xff]);
    }
    Image::new_owned(rgba, 32, 32)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .invoke_handler(tauri::generate_handler![host_ping, record_cmd])
        .setup(|app| {
            record(
                "boot",
                json!({
                    "pid": std::process::id(),
                    "webview_version": tauri::webview_version().ok(),
                    "os": tauri_plugin_os_stub(),
                }),
            );

            // T7 and T8 (child process, launch at login) were answered in round 1 and are
            // not repeated here, so this run touches neither the registry nor node.

            // T3: tray.
            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let tray = TrayIconBuilder::with_id("tray")
                .icon(tray_image())
                .tooltip("cophyla spike 07")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("host") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app);
            match &tray {
                Ok(_) => record("tray_built", json!({ "ok": true })),
                Err(e) => record("tray_failed", json!({ "error": e.to_string() })),
            }

            // T2: host page, loaded from embedded files, not a URL.
            let host = WebviewWindowBuilder::new(app, "host", WebviewUrl::App("index.html".into()))
                .title("cophyla spike 07 - host")
                .inner_size(880.0, 640.0)
                .position(60.0, 60.0)
                .build()?;

            // T5: the view. Same origin as the host, different window label, and
            // deliberately absent from capabilities/host.json.
            let view =
                WebviewWindowBuilder::new(app, "view", WebviewUrl::App("view/index.html".into()))
                    .title("cophyla spike 07 - view (untrusted)")
                    .inner_size(760.0, 640.0)
                    .position(960.0, 60.0)
                    .build()?;
            record(
                "windows_built",
                json!({ "host": host.label(), "view": view.label() }),
            );

            // T3: closing the window hides it instead of quitting.
            let h = app.handle().clone();
            host.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Some(w) = h.get_webview_window("host") {
                        let _ = w.hide();
                    }
                    record("close_requested_prevented", json!({ "hidden": true }));
                }
            });

            // T4: OS notification.
            match app
                .notification()
                .builder()
                .title("cophyla spike 07")
                .body("notification from an unbundled dev build")
                .show()
            {
                Ok(()) => record("notification_shown", json!({ "ok": true })),
                Err(e) => record("notification_failed", json!({ "error": e.to_string() })),
            }

            let app_handle = app.handle().clone();
            thread::spawn(move || {
                // T3 readback: after the host page closed itself, is the process still
                // up with the window merely hidden?
                thread::sleep(Duration::from_secs(10));
                let visible = app_handle
                    .get_webview_window("host")
                    .and_then(|w| w.is_visible().ok());
                let tray_present = app_handle.tray_by_id("tray").is_some();
                record(
                    "after_close",
                    json!({
                        "host_window_visible": visible,
                        "process_alive": true,
                        "tray_present": tray_present,
                        "pid": std::process::id()
                    }),
                );

                thread::sleep(Duration::from_secs(8));
                record("exiting", json!({ "ok": true }));
                app_handle.exit(0);
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn tauri_plugin_os_stub() -> String {
    std::env::consts::OS.to_string()
}
