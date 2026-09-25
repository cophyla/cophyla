// Another node's desktop in a window of its own, when this machine has no route to it: cophylad
// runs a forwarder on this machine's loopback that carries the stream page from the host
// node, and the window shows that page and nothing else. It opens only
// `http://127.0.0.1:<port>/remote/…`, never leaves that origin, holds no capability (they
// are granted to the host window alone), keeps no storage past its life where the platform
// allows, and when it closes the host page hears `stream:closed` so cophylad ends the session.
// On Linux WebKitGTK's WebRTC, off by default, is switched on before the page loads; where
// the WebKitGTK has none the page opens in the system browser instead.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::cophylad::HOST_LABEL;

/// What the host page hears when a stream's window is gone.
pub const CLOSED_EVENT: &str = "stream:closed";

#[derive(Clone, Serialize)]
struct Closed {
    stream: String,
}

/// A stream's window label: the stream id, which cophylad makes of `[a-z0-9_]`.
fn label(stream: &str) -> Result<String, String> {
    if stream.is_empty() || stream.len() > 64 || !stream.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("invalid: bad stream id".into());
    }
    Ok(format!("stream-{stream}"))
}

/// The page's URL, if it is a stream page on this machine's loopback.
pub fn loopback_page(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "invalid: not a URL".to_string())?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"));
    if url.scheme() != "http" || !loopback || url.port().is_none() || !url.path().starts_with("/remote/") || url.username() != "" || url.password().is_some() {
        return Err("invalid: only a stream page on this machine's loopback opens here".into());
    }
    Ok(url)
}

/// Opens the stream page in its window, or brings that window forward when it is open already.
#[tauri::command]
pub async fn stream_open<R: Runtime>(app: AppHandle<R>, url: String, stream: String) -> Result<(), String> {
    let page = loopback_page(&url)?;
    let label = label(&stream)?;
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    let origin = page.origin();
    // On Linux the page waits for WebRTC to be switched on; elsewhere it loads at once.
    let first = if cfg!(target_os = "linux") { Url::parse("about:blank").map_err(|e| e.to_string())? } else { page.clone() };
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(first))
        .title("Cophyla — remote desktop")
        .inner_size(1280.0, 800.0)
        .min_inner_size(480.0, 320.0)
        .incognito(true)
        .on_navigation(move |u| {
            let ok = u.origin() == origin || u.as_str() == "about:blank";
            if !ok {
                log::warn!("stream window refused navigation to {u}");
            }
            ok
        })
        .build()
        .map_err(|e| format!("unavailable: the stream window did not open: {e}"))?;
    let handle = app.clone();
    let id = stream.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            let _ = handle.emit_to(HOST_LABEL, CLOSED_EVENT, Closed { stream: id.clone() });
        }
    });
    #[cfg(target_os = "linux")]
    {
        if linux::enable_webrtc(&window) {
            window.navigate(page).map_err(|e| e.to_string())?;
        } else {
            // no WebRTC in this WebKitGTK: the system browser shows the page, and the window goes
            log::info!("WebKitGTK has no WebRTC; the stream opens in the browser");
            let _ = window.close();
            linux::browse(page.as_str())?;
        }
    }
    Ok(())
}

/// Closes a stream's window, if it is open.
#[tauri::command]
pub fn stream_close<R: Runtime>(app: AppHandle<R>, stream: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&label(&stream)?) {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
mod linux {
    use std::time::Duration;

    use glib::object::ObjectExt;
    use tauri::{Runtime, WebviewWindow};
    use webkit2gtk::WebViewExt;

    /// Switches WebRTC on in the window's WebKitGTK; whether it is on.
    pub fn enable_webrtc<R: Runtime>(window: &WebviewWindow<R>) -> bool {
        let (tx, rx) = std::sync::mpsc::channel();
        let asked = window.with_webview(move |w| {
            let on = WebViewExt::settings(&w.inner()).is_some_and(|s| {
                if s.find_property("enable-webrtc").is_none() {
                    return false;
                }
                s.set_property("enable-webrtc", true);
                s.property::<bool>("enable-webrtc")
            });
            let _ = tx.send(on);
        });
        asked.is_ok() && rx.recv_timeout(Duration::from_secs(3)).unwrap_or(false)
    }

    /// The page in the system browser.
    pub fn browse(url: &str) -> Result<(), String> {
        std::process::Command::new("xdg-open").arg(url).spawn().map(|_| ()).map_err(|e| format!("unavailable: no browser to show the stream: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_loopback_stream_page_opens() {
        assert!(loopback_page("http://127.0.0.1:50123/remote/?t=abc").is_ok());
        assert!(loopback_page("http://localhost:50123/remote/stream.html").is_ok());
        for bad in [
            "https://127.0.0.1:50123/remote/",
            "http://192.168.1.44:4818/remote/",
            "http://127.0.0.1/remote/",
            "http://127.0.0.1:50123/ws/client",
            "http://user:pw@127.0.0.1:50123/remote/",
            "file:///remote/",
            "not a url",
        ] {
            assert!(loopback_page(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_stream_id_makes_a_label() {
        assert_eq!(label("stream_0123abcd").unwrap(), "stream-stream_0123abcd");
        assert!(label("").is_err());
        assert!(label("a/b").is_err());
        assert!(label(&"x".repeat(65)).is_err());
    }
}
