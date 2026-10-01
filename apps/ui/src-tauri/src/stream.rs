// Another node's desktop, from a stream page cophylad serves on this machine's loopback: its own
// moonlight-web's where the host is on the LAN, or the host's own through a forwarder where
// there is no route to it. The view shows it in one of two ways. In a window of its own
// (`stream_open`), for a desktop with no route to it. Or beside the view (`stream_embed`): a
// web view of its own laid over the host window, hidden until the view says where
// (`stream_place`, a rectangle in the window's logical pixels, or hidden), since nothing of
// the host page can be drawn over it. Either opens only `http://127.0.0.1:<port>/remote/…`,
// never leaves that origin, holds no capability (they are granted to the host web view
// alone), keeps no storage past its life where the platform allows, and when it closes the
// host page hears `stream:closed` so cophylad ends the session. On Windows it takes the host's
// own browser arguments: WebView2 runs every web view of the app in one browser, which
// refuses a web view asking for other ones. On Linux WebKitGTK's WebRTC, off by default, is
// switched on before the page loads; where the WebKitGTK has none the window's page opens in
// the system browser instead, and one beside the view is refused.

use serde::Serialize;
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Runtime, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::cophylad::HOST_LABEL;

/// What the host page hears when a stream's window, or its page beside the view, is gone.
pub const CLOSED_EVENT: &str = "stream:closed";

#[derive(Clone, Serialize)]
struct Closed {
    stream: String,
}

/// A stream id as cophylad makes them, of `[a-z0-9_]`.
fn stream_id(stream: &str) -> Result<&str, String> {
    if stream.is_empty() || stream.len() > 64 || !stream.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("invalid: bad stream id".into());
    }
    Ok(stream)
}

/// A stream's window label.
fn label(stream: &str) -> Result<String, String> {
    Ok(format!("stream-{}", stream_id(stream)?))
}

/// The label of a stream's page beside the view.
fn embed_label(stream: &str) -> Result<String, String> {
    Ok(format!("embed-{}", stream_id(stream)?))
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

/// Where a stream's page may go: its own origin, and the blank page it starts on.
fn same_origin(page: &Url, what: &'static str) -> impl Fn(&Url) -> bool + Send + 'static {
    let origin = page.origin();
    move |u: &Url| {
        let ok = u.origin() == origin || u.as_str() == "about:blank";
        if !ok {
            log::warn!("{what} refused navigation to {u}");
        }
        ok
    }
}

/// What a stream's page loads first: on Linux a blank page, until WebRTC is switched on.
fn first_page(page: &Url) -> Result<Url, String> {
    if cfg!(target_os = "linux") {
        Url::parse("about:blank").map_err(|e| e.to_string())
    } else {
        Ok(page.clone())
    }
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
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(first_page(&page)?))
        .title("Cophyla — remote desktop")
        .inner_size(1280.0, 800.0)
        .min_inner_size(480.0, 320.0)
        .incognito(true)
        .on_navigation(same_origin(&page, "stream window"));
    #[cfg(windows)]
    let builder = builder.additional_browser_args(crate::BROWSER_ARGS);
    let window = builder.build().map_err(|e| format!("unavailable: the stream window did not open: {e}"))?;
    let handle = app.clone();
    let id = stream.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            let _ = handle.emit_to(HOST_LABEL, CLOSED_EVENT, Closed { stream: id.clone() });
        }
    });
    #[cfg(target_os = "linux")]
    {
        if linux::enable_webrtc(window.as_ref()) {
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

/// Lays the stream page over the host window, hidden until `stream_place` says where; one
/// there already is left as it is.
#[tauri::command]
pub async fn stream_embed<R: Runtime>(app: AppHandle<R>, url: String, stream: String) -> Result<(), String> {
    let page = loopback_page(&url)?;
    let label = embed_label(&stream)?;
    if app.get_webview(&label).is_some() {
        return Ok(());
    }
    let window = app.get_window(HOST_LABEL).ok_or_else(|| "unavailable: the app has no window".to_string())?;
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(first_page(&page)?))
        .incognito(true)
        .focused(false)
        .on_navigation(same_origin(&page, "stream beside the view"));
    #[cfg(windows)]
    let builder = builder.additional_browser_args(crate::BROWSER_ARGS);
    let webview = window
        .add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))
        .map_err(|e| format!("unavailable: the stream did not open beside the view: {e}"))?;
    let _ = webview.hide();
    #[cfg(target_os = "linux")]
    {
        if linux::enable_webrtc(&webview) {
            webview.navigate(page).map_err(|e| e.to_string())?;
        } else {
            let _ = webview.close();
            return Err("unsupported: this WebKitGTK has no WebRTC to show a stream beside the view".into());
        }
    }
    Ok(())
}

/// The rectangle a stream's page beside the view takes, in the window's logical pixels, once it
/// is one: finite, its corner anywhere, at least a pixel each way.
fn placement(x: f64, y: f64, width: f64, height: f64) -> Result<Rect, String> {
    if ![x, y, width, height].iter().all(|v| v.is_finite()) || width < 1.0 || height < 1.0 {
        return Err("invalid: not a rectangle".into());
    }
    Ok(Rect { position: LogicalPosition::new(x, y).into(), size: LogicalSize::new(width, height).into() })
}

/// Puts a stream's page beside the view over the rectangle given and shows it, or hides it.
#[tauri::command]
pub async fn stream_place<R: Runtime>(app: AppHandle<R>, stream: String, x: Option<f64>, y: Option<f64>, width: Option<f64>, height: Option<f64>, hidden: Option<bool>) -> Result<(), String> {
    let webview = app.get_webview(&embed_label(&stream)?).ok_or_else(|| "not_found: no such stream beside the view".to_string())?;
    if hidden == Some(true) {
        return webview.hide().map_err(|e| e.to_string());
    }
    let (Some(x), Some(y), Some(width), Some(height)) = (x, y, width, height) else {
        return Err("invalid: a place needs x, y, width and height, or hidden".into());
    };
    webview.set_bounds(placement(x, y, width, height)?).map_err(|e| e.to_string())?;
    webview.show().map_err(|e| e.to_string())
}

/// Closes a stream's window, or its page beside the view, if either is open. A page beside the
/// view has no event of its own when it goes, so the host page hears it from here.
#[tauri::command]
pub fn stream_close<R: Runtime>(app: AppHandle<R>, stream: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&label(&stream)?) {
        w.close().map_err(|e| e.to_string())?;
    }
    if let Some(v) = app.get_webview(&embed_label(&stream)?) {
        v.close().map_err(|e| e.to_string())?;
        let _ = app.emit_to(HOST_LABEL, CLOSED_EVENT, Closed { stream });
    }
    Ok(())
}

#[cfg(target_os = "linux")]
mod linux {
    use std::time::Duration;

    use glib::object::ObjectExt;
    use tauri::{Runtime, Webview};
    use webkit2gtk::WebViewExt;

    /// Switches WebRTC on in a web view's WebKitGTK; whether it is on.
    pub fn enable_webrtc<R: Runtime>(webview: &Webview<R>) -> bool {
        let (tx, rx) = std::sync::mpsc::channel();
        let asked = webview.with_webview(move |w| {
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
    fn a_stream_id_makes_a_label_of_each_kind() {
        assert_eq!(label("stream_0123abcd").unwrap(), "stream-stream_0123abcd");
        assert_eq!(embed_label("stream_0123abcd").unwrap(), "embed-stream_0123abcd");
        for bad in ["", "a/b", "embed-x", &"x".repeat(65)] {
            assert!(label(bad).is_err(), "{bad}");
            assert!(embed_label(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_place_is_a_finite_rectangle_of_a_pixel_or_more() {
        assert!(placement(10.5, 40.0, 640.0, 480.0).is_ok());
        assert!(placement(-4.0, -4.0, 1.0, 1.0).is_ok());
        for (x, y, w, h) in [(0.0, 0.0, 0.0, 10.0), (0.0, 0.0, 10.0, 0.5), (f64::NAN, 0.0, 10.0, 10.0), (0.0, 0.0, f64::INFINITY, 10.0)] {
            assert!(placement(x, y, w, h).is_err(), "{x} {y} {w} {h}");
        }
    }

    #[test]
    fn a_page_stays_on_its_own_origin() {
        let page = loopback_page("http://127.0.0.1:50123/remote/?t=abc").unwrap();
        let allowed = same_origin(&page, "test");
        assert!(allowed(&Url::parse("http://127.0.0.1:50123/remote/stream.html?hostId=1").unwrap()));
        assert!(allowed(&Url::parse("about:blank").unwrap()));
        assert!(!allowed(&Url::parse("http://127.0.0.1:50124/remote/").unwrap()));
        assert!(!allowed(&Url::parse("https://example.com/").unwrap()));
    }
}
