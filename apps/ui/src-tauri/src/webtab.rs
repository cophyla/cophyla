// Web tabs: a web page beside an agent's chat, in a tab the agent's Playwright drives, on
// Windows for now. Each tab is a web view of its own laid over the host window, as a stream
// beside the view is (stream.rs): out of sight until the host page says where (`webtab_place`, a
// rectangle in the window's logical pixels, or out of sight again), since nothing of the host
// page can be drawn over it. Out of sight is out of the window's area, never hidden: a hidden
// page draws nothing, and an agent's clicks wait for it to draw (`put_away`). Unlike a stream's page it is the user's browser: it may go to any web page
// (http and https, and the blank page it may start on), keeps its logins (not incognito), and
// opens its DevTools. Its web views keep their data in a folder of their own (`webtabs` in the
// app's local data), and WebView2 runs a web view of another folder in a browser of its own,
// apart from the host page's: that browser alone listens for the debugging protocol, on a
// loopback port picked once a run, which cophylad's proxy hands on to the agents, each told only
// of its own session's tabs. It takes the host's browser arguments with the port beside them;
// being another browser, it may. `webtab_open` answers the port and the tab's id in that
// protocol, which the tab's own web view tells (`Target.getTargetInfo`). A window a page opens
// is not opened: the host page hears `webtab:newwindow` and opens it as a tab of its own. The
// host page hears how a tab is (`webtab:state`: its address as it goes there and once it is
// there, its title, whether it loads) and when it went without being asked to
// (`webtab:closed`: the page closed itself, or its browser ended). When the link to cophylad
// goes, every tab closes, as cophylad closes them. Like any web view but the host's, a tab
// holds no capability (they are granted to the host web view alone).

// What the shell tells of a tab, and how it reads its target, are the Windows shell's alone for now.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Serialize;
use tauri::{AppHandle, LogicalPosition, Manager, Runtime, Url};

/// What the host page hears when a tab moves to another page, loads, or has another title.
pub const STATE_EVENT: &str = "webtab:state";
/// What the host page hears when a tab's page asked for a window, which the host opens as a tab.
pub const NEW_WINDOW_EVENT: &str = "webtab:newwindow";
/// What the host page hears when a tab went without `webtab_close`.
pub const CLOSED_EVENT: &str = "webtab:closed";

/// The longest address a tab goes to: cophylad's `WEB_TAB_URL_MAX`.
const URL_MAX: usize = 8192;

/// The longest target id cophylad takes.
const TARGET_MAX: usize = 100;

/// What `webtab_open` answers: the debugging port of the tabs' browser, and the tab's id in it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Opened {
    pub port: u16,
    pub target: String,
}

#[derive(Clone, Default, Serialize)]
struct State {
    tab: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loading: Option<bool>,
}

#[derive(Clone, Serialize)]
struct NewWindow {
    tab: String,
    url: String,
}

#[derive(Clone, Serialize)]
struct Closed {
    tab: String,
}

/// A tab id as cophylad makes them (`wtb_` and a ULID), of `[A-Za-z0-9_]`, 64 at most.
fn tab_id(tab: &str) -> Result<&str, String> {
    if tab.is_empty() || tab.len() > 64 || !tab.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("invalid: bad web tab id".into());
    }
    Ok(tab)
}

/// A tab's web view label.
fn label(tab: &str) -> Result<String, String> {
    Ok(format!("webtab-{}", tab_id(tab)?))
}

/// Whether a tab may go to a page: an http or https one with a host, or the blank page.
fn may_go(url: &Url) -> bool {
    url.as_str().len() <= URL_MAX && (url.as_str() == "about:blank" || (matches!(url.scheme(), "http" | "https") && url.host_str().is_some_and(|h| !h.is_empty())))
}

/// The page a tab is asked to go to, if it may: none is the blank page.
fn web_page(raw: &str) -> Result<Url, String> {
    let raw = if raw.is_empty() { "about:blank" } else { raw };
    let url = Url::parse(raw).map_err(|_| "invalid: not a URL".to_string())?;
    if !may_go(&url) {
        return Err("invalid: only a web page opens in a web tab".into());
    }
    Ok(url)
}

/// The tab's id in the debugging protocol, from what `Target.getTargetInfo` answered.
fn target_id(json: &str) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|_| "unavailable: the tab's answer is not JSON".to_string())?;
    match value.pointer("/targetInfo/targetId").and_then(serde_json::Value::as_str) {
        Some(id) if !id.is_empty() && id.len() <= TARGET_MAX => Ok(id.to_string()),
        _ => Err("unavailable: the tab did not say its id".into()),
    }
}

/// Opens a tab at the page given, out of sight until `webtab_place` says where, and answers where its
/// browser listens and the tab's id there; a tab open already is left as it is and answered alike.
#[tauri::command]
pub async fn webtab_open<R: Runtime>(app: AppHandle<R>, tab: String, url: String) -> Result<Opened, String> {
    let label = label(&tab)?;
    let page = web_page(&url)?;
    #[cfg(windows)]
    {
        windows::open(&app, &tab, &label, page).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, label, page);
        Err("unsupported: web tabs open in the Windows app for now".into())
    }
}

/// Where a tab no one is looking at waits: far left of the window, out of sight, at the size it had.
const AWAY_X: f64 = -20000.0;

/// A tab out of sight, though not hidden: WebView2 stops drawing a hidden page, and an agent's
/// Playwright waits for a drawn frame before it clicks, so a tab the user is not looking at
/// (another session's, the panel put away, the window minimized) still draws, out of the
/// window's area, and its clicks land.
fn put_away<R: Runtime>(webview: &tauri::Webview<R>) -> Result<(), String> {
    webview.set_position(LogicalPosition::new(AWAY_X, 0.0)).map_err(|e| e.to_string())
}

/// Puts a tab over the rectangle given, or out of sight.
#[tauri::command]
pub async fn webtab_place<R: Runtime>(app: AppHandle<R>, tab: String, x: Option<f64>, y: Option<f64>, width: Option<f64>, height: Option<f64>, hidden: Option<bool>) -> Result<(), String> {
    let webview = app.get_webview(&label(&tab)?).ok_or_else(|| "not_found: no such web tab".to_string())?;
    if hidden == Some(true) {
        return put_away(&webview);
    }
    let (Some(x), Some(y), Some(width), Some(height)) = (x, y, width, height) else {
        return Err("invalid: a place needs x, y, width and height, or hidden".into());
    };
    webview.set_bounds(crate::stream::placement(x, y, width, height)?).map_err(|e| e.to_string())?;
    webview.show().map_err(|e| e.to_string())
}

/// What `webtab_go` does besides going to a page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Back,
    Forward,
    Reload,
    DevTools,
}

fn action(raw: &str) -> Result<Action, String> {
    match raw {
        "back" => Ok(Action::Back),
        "forward" => Ok(Action::Forward),
        "reload" => Ok(Action::Reload),
        "devtools" => Ok(Action::DevTools),
        _ => Err("invalid: a web tab goes back, forward, reloads or opens its DevTools".into()),
    }
}

/// Takes a tab to a page (`url`), or back, forward, reloads it, or opens its DevTools (`action`).
#[tauri::command]
pub async fn webtab_go<R: Runtime>(app: AppHandle<R>, tab: String, url: Option<String>, action: Option<String>) -> Result<(), String> {
    let webview = app.get_webview(&label(&tab)?).ok_or_else(|| "not_found: no such web tab".to_string())?;
    match (url, action) {
        (Some(url), None) => webview.navigate(web_page(&url)?).map_err(|e| e.to_string()),
        (None, Some(raw)) => match self::action(&raw)? {
            Action::Reload => webview.reload().map_err(|e| e.to_string()),
            Action::DevTools => {
                webview.open_devtools();
                Ok(())
            }
            #[cfg(windows)]
            step => windows::step(&webview, step == Action::Back),
            #[cfg(not(windows))]
            _ => Err("unsupported: web tabs open in the Windows app for now".into()),
        },
        _ => Err("invalid: a web tab goes to a url, or does an action".into()),
    }
}

/// Closes a tab, if it is open. The host page asked, so it hears nothing of it.
#[tauri::command]
pub fn webtab_close<R: Runtime>(app: AppHandle<R>, tab: String) -> Result<(), String> {
    if let Some(v) = app.get_webview(&label(&tab)?) {
        v.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Closes every tab: the link to cophylad went, and cophylad closes them all when it does, so
/// a host page that loads again finds none open it does not know of.
pub fn close_all<R: Runtime>(app: &AppHandle<R>) {
    for (label, webview) in app.webviews() {
        if label.starts_with("webtab-") {
            let _ = webview.close();
        }
    }
}

#[cfg(windows)]
mod windows {
    use std::net::{Ipv4Addr, TcpListener};
    use std::sync::OnceLock;
    use std::time::Duration;

    use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
    use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, Url, Webview, WebviewUrl};
    use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED};
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, ProcessFailedEventHandler, SourceChangedEventHandler, WindowCloseRequestedEventHandler};
    use windows_core_wv2::{w, PWSTR};

    use super::{may_go, target_id, Closed, NewWindow, Opened, State, CLOSED_EVENT, NEW_WINDOW_EVENT, STATE_EVENT};
    use crate::cophylad::HOST_LABEL;

    /// How long a tab may take to say its id in the debugging protocol.
    const TARGET_WAIT: Duration = Duration::from_secs(10);

    /// The loopback port the tabs' browser listens on for the debugging protocol: free when it
    /// was picked, at the first tab of the run, and the same for every tab after, since WebView2
    /// takes a data folder's browser arguments from the first web view that opens it.
    fn debug_port() -> Result<u16, String> {
        static PORT: OnceLock<u16> = OnceLock::new();
        if let Some(port) = PORT.get() {
            return Ok(*port);
        }
        let free = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).and_then(|l| l.local_addr()).map_err(|e| format!("unavailable: no free port for the web tabs' browser: {e}"))?;
        Ok(*PORT.get_or_init(|| free.port()))
    }

    fn state<R: Runtime>(app: &AppHandle<R>, state: State) {
        let _ = app.emit_to(HOST_LABEL, STATE_EVENT, state);
    }

    /// The tab went without the host page asking: it hears so, and the web view goes too, later,
    /// since WebView2 must not lose it inside one of its own events.
    fn gone<R: Runtime>(app: &AppHandle<R>, tab: &str) {
        let _ = app.emit_to(HOST_LABEL, CLOSED_EVENT, Closed { tab: tab.to_string() });
        let Ok(label) = super::label(tab) else { return };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(v) = app.get_webview(&label) {
                let _ = v.close();
            }
        });
    }

    pub async fn open<R: Runtime>(app: &AppHandle<R>, tab: &str, label: &str, page: Url) -> Result<Opened, String> {
        let port = debug_port()?;
        let webview = match app.get_webview(label) {
            Some(v) => v,
            None => {
                let window = app.get_window(HOST_LABEL).ok_or_else(|| "unavailable: the app has no window".to_string())?;
                let dir = app.path().app_local_data_dir().map_err(|e| format!("unavailable: no folder for the web tabs: {e}"))?.join("webtabs");
                let (on_nav, on_new, on_title, on_load) = (app.clone(), app.clone(), app.clone(), app.clone());
                let (nav_tab, new_tab, title_tab, load_tab) = (tab.to_string(), tab.to_string(), tab.to_string(), tab.to_string());
                let builder = WebviewBuilder::new(label, WebviewUrl::External(page))
                    .data_directory(dir)
                    .additional_browser_args(&format!("{} --remote-debugging-port={port}", crate::BROWSER_ARGS))
                    .devtools(true)
                    .focused(false)
                    .on_navigation(move |url| {
                        let ok = may_go(url);
                        if ok {
                            state(&on_nav, State { tab: nav_tab.clone(), url: Some(url.to_string()), loading: Some(true), ..State::default() });
                        } else {
                            log::warn!("web tab refused navigation to {url}");
                        }
                        ok
                    })
                    .on_new_window(move |url, _features| {
                        if may_go(&url) {
                            let _ = on_new.emit_to(HOST_LABEL, NEW_WINDOW_EVENT, NewWindow { tab: new_tab.clone(), url: url.to_string() });
                        } else {
                            log::warn!("web tab refused a window for {url}");
                        }
                        NewWindowResponse::Deny
                    })
                    .on_document_title_changed(move |_, title| state(&on_title, State { tab: title_tab.clone(), title: Some(title), ..State::default() }))
                    .on_page_load(move |_, payload| {
                        let loading = matches!(payload.event(), PageLoadEvent::Started);
                        state(&on_load, State { tab: load_tab.clone(), url: Some(payload.url().to_string()), loading: Some(loading), ..State::default() });
                    });
                // out of sight until the view places it, at a page's usual size, drawing (see `put_away`)
                let webview = window
                    .add_child(builder, LogicalPosition::new(super::AWAY_X, 0.0), LogicalSize::new(1280.0, 800.0))
                    .map_err(|e| format!("unavailable: the web tab did not open: {e}"))?;
                watch(&webview, app, tab);
                webview
            }
        };
        let target = target_of(&webview).await?;
        Ok(Opened { port, target })
    }

    /// What wry does not say of a tab: its address moving within the page (a history push, a
    /// fragment), the page closing itself, and its browser ending.
    fn watch<R: Runtime>(webview: &Webview<R>, app: &AppHandle<R>, tab: &str) {
        let (moved, closed, failed) = (app.clone(), app.clone(), app.clone());
        let (moved_tab, closed_tab, failed_tab) = (tab.to_string(), tab.to_string(), tab.to_string());
        let asked = webview.with_webview(move |w| {
            // SAFETY: the controller and the core are this tab's live WebView2 objects, used on
            // the thread with_webview runs on, which is the one that owns them, as the handlers are.
            let result = unsafe {
                w.controller().CoreWebView2().and_then(|core| {
                    let mut token = Default::default();
                    core.add_SourceChanged(
                        &SourceChangedEventHandler::create(Box::new(move |core, _| {
                            let Some(core) = core else { return Ok(()) };
                            let mut uri = PWSTR::null();
                            core.Source(&mut uri)?;
                            let url = webview2_com::take_pwstr(uri);
                            state(&moved, State { tab: moved_tab.clone(), url: Some(url), ..State::default() });
                            Ok(())
                        })),
                        &mut token,
                    )?;
                    core.add_WindowCloseRequested(
                        &WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
                            gone(&closed, &closed_tab);
                            Ok(())
                        })),
                        &mut token,
                    )?;
                    core.add_ProcessFailed(
                        &ProcessFailedEventHandler::create(Box::new(move |_, args| {
                            let Some(args) = args else { return Ok(()) };
                            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                            args.ProcessFailedKind(&mut kind)?;
                            // a page's own process failing leaves the tab to be reloaded; its browser ending ends it
                            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                                gone(&failed, &failed_tab);
                            }
                            Ok(())
                        })),
                        &mut token,
                    )
                })
            };
            if let Err(e) = result {
                log::warn!("web tab handlers: {e}");
            }
        });
        if let Err(e) = asked {
            log::warn!("web tab handlers: {e}");
        }
    }

    /// The tab's id in the debugging protocol, as its own web view tells it.
    async fn target_of<R: Runtime>(webview: &Webview<R>) -> Result<String, String> {
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
        webview
            .with_webview(move |w| {
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                    let _ = tx.send(result.map_err(|e| format!("unavailable: the tab did not say its id: {e}")).and_then(|()| target_id(&json)));
                    Ok(())
                }));
                // SAFETY: as in `watch`; the handler is called once, on the same thread.
                let asked = unsafe { w.controller().CoreWebView2().and_then(|core| core.CallDevToolsProtocolMethod(w!("Target.getTargetInfo"), w!("{}"), &handler)) };
                if let Err(e) = asked {
                    // the handler, and the sender in it, go unused: the wait below ends at once
                    log::warn!("web tab target: {e}");
                }
            })
            .map_err(|e| format!("unavailable: the tab did not say its id: {e}"))?;
        match tokio::time::timeout(TARGET_WAIT, rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err("unavailable: the tab did not say its id".into()),
            Err(_) => Err("unavailable: the tab did not say its id in time".into()),
        }
    }

    /// Back or forward in the tab's history; nothing where there is none that way.
    pub fn step<R: Runtime>(webview: &Webview<R>, back: bool) -> Result<(), String> {
        webview
            .with_webview(move |w| {
                // SAFETY: as in `watch`.
                let result = unsafe { w.controller().CoreWebView2().and_then(|core| if back { core.GoBack() } else { core.GoForward() }) };
                if let Err(e) = result {
                    log::debug!("web tab history: {e}");
                }
            })
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tab_id_makes_its_label_and_nothing_else_does() {
        assert_eq!(label("wtb_01ARZ3NDEKTSV4RRFFQ69G5FB7").unwrap(), "webtab-wtb_01ARZ3NDEKTSV4RRFFQ69G5FB7");
        // whatever the id, the label is never the host's own
        assert_eq!(label("host").unwrap(), "webtab-host");
        for bad in ["", "a/b", "webtab-x", "wtb 1", "wtb_é", "../host", "wtb_1\0", &"x".repeat(65)] {
            assert!(label(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_tab_goes_only_to_a_web_page_or_the_blank_one() {
        for good in ["http://example.com/", "https://example.com/a?b=1#c", "http://127.0.0.1:5173/", "http://localhost:3000/x", "https://[::1]:8443/", "about:blank"] {
            assert!(web_page(good).is_ok(), "{good}");
            assert!(may_go(&Url::parse(good).unwrap()), "{good}");
        }
        assert_eq!(web_page("").unwrap().as_str(), "about:blank");
        for bad in [
            "file:///C:/Windows/notepad.exe",
            "javascript:alert(1)",
            "data:text/html,<p>hi</p>",
            "blob:https://example.com/0f3c",
            "about:settings",
            "about:blank#x",
            "edge://settings",
            "chrome://version",
            "devtools://devtools/bundled/inspector.html",
            "view-source:https://example.com/",
            "ftp://example.com/",
            "ws://127.0.0.1:4817/ws/client",
            "tauri://localhost/index.html",
            "view://localhost/",
            "not a url",
            "https://",
        ] {
            assert!(web_page(bad).is_err(), "{bad}");
        }
        let long = format!("https://example.com/{}", "a".repeat(URL_MAX));
        assert!(web_page(&long).is_err());
    }

    #[test]
    fn the_tabs_target_is_read_from_its_answer() {
        let answer = r#"{"targetInfo":{"targetId":"8F2A1C0D7E4B9A33","type":"page","title":"x","url":"about:blank","attached":true,"canAccessOpener":false}}"#;
        assert_eq!(target_id(answer).unwrap(), "8F2A1C0D7E4B9A33");
        for bad in ["", "{}", r#"{"targetInfo":{}}"#, r#"{"targetInfo":{"targetId":""}}"#, r#"{"targetInfo":{"targetId":7}}"#, &format!(r#"{{"targetInfo":{{"targetId":"{}"}}}}"#, "a".repeat(101))] {
            assert!(target_id(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn an_action_is_one_of_four() {
        assert_eq!(action("back").unwrap(), Action::Back);
        assert_eq!(action("forward").unwrap(), Action::Forward);
        assert_eq!(action("reload").unwrap(), Action::Reload);
        assert_eq!(action("devtools").unwrap(), Action::DevTools);
        for bad in ["", "close", "Back", "eval"] {
            assert!(action(bad).is_err(), "{bad}");
        }
    }
}
