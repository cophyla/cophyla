// Voice in the desktop app: the host page captures the microphone, listens for the wake words
// and plays the replies (`@cophyla/voicehost`, which the phone runs too); what the shell adds
// is what a page cannot do for itself. The microphone is granted to the app's own host page
// without a browser prompt — WebView2's permission event on Windows, WebKitGTK's on Linux, the
// UI delegate's media request on macOS (where the system then asks, with the text in
// Info.plist) — and never to a view, which runs in a sandboxed frame on another origin. Wry's
// macOS delegate grants every origin every device, camera included, so its method is replaced
// there, once for the class, as `dropped/macos.rs` does with the drop. Audio may start with no click first (WebView2's
// autoplay flag, in main.rs). And the talk key: a shortcut held anywhere on the desktop is
// push-to-talk, told to the host page as `voice:ptt {down}` when it goes down and when it
// comes up; the page names the shortcut (`ptt_shortcut`) from what the user chose, Ctrl+Alt+Space
// (Ctrl+Shift+Space on a Mac, where Control+Option+Space switches the input source) unless they
// chose another, since it keeps the settings.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::cophylad::HOST_LABEL;

/// The event the host page hears the talk key on.
pub const EVENT_PTT: &str = "voice:ptt";

#[derive(Clone, Serialize)]
struct Ptt {
    down: bool,
}

/// The shortcut registered now, if any.
#[derive(Default)]
pub struct TalkKey(Mutex<Option<Shortcut>>);

/// The global-shortcut plugin, with the talk key's going down and coming up sent to the host page.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            let down = event.state() == ShortcutState::Pressed;
            let _ = app.emit_to(HOST_LABEL, EVENT_PTT, Ptt { down });
        })
        .build()
}

/// Registers the talk key, replacing the one before; an empty name turns it off. Answers with
/// the name as given once it is held, or why it could not be had (a name the plugin does not
/// parse, or one another app holds).
#[tauri::command]
pub fn ptt_shortcut<R: Runtime>(app: AppHandle<R>, key: State<'_, TalkKey>, accelerator: String) -> Result<String, String> {
    let wanted = accelerator.trim();
    let parsed = if wanted.is_empty() {
        None
    } else {
        Some(wanted.parse::<Shortcut>().map_err(|e| format!("invalid: {wanted} is not a shortcut: {e}"))?)
    };
    let mut current = key.0.lock().map_err(|_| "unavailable: the talk key is poisoned".to_string())?;
    if *current == parsed {
        return Ok(wanted.to_string());
    }
    let shortcuts = app.global_shortcut();
    if let Some(old) = current.take() {
        if let Err(e) = shortcuts.unregister(old) {
            log::warn!("talk key {}: {e}", old.into_string());
        }
    }
    if let Some(new) = parsed {
        shortcuts.register(new).map_err(|e| format!("unavailable: {wanted} could not be had, another app may hold it: {e}"))?;
        log::info!("talk key {}", new.into_string());
        *current = Some(new);
    }
    Ok(wanted.to_string())
}

/// The host page may use the microphone with no prompt, and nothing else may.
pub fn allow_microphone<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(windows)]
    windows::allow_microphone(window);
    #[cfg(target_os = "linux")]
    linux::allow_microphone(window);
    #[cfg(target_os = "macos")]
    macos::allow_microphone(window);
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    let _ = window;
}

/// WebKit's `WKPermissionDecision` and `WKMediaCaptureType`, as the numbers they are.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod webkit {
    pub const GRANT: isize = 1;
    pub const DENY: isize = 2;
    pub const MICROPHONE: isize = 1;
}

/// What a page asking WebKit for a capture device is told: the microphone alone, for the host
/// page's own frame; anything else, a view's frame or a camera, is denied.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn media_decision(protocol: &str, host: &str, main_frame: bool, capture: isize) -> isize {
    if main_frame && capture == webkit::MICROPHONE && is_host_page(&format!("{protocol}://{host}/")) {
        webkit::GRANT
    } else {
        webkit::DENY
    }
}

/// Whether a page's URL is the app's own host page: `tauri.localhost` on Windows and Linux,
/// `tauri://localhost` on macOS.
pub fn is_host_page(url: &str) -> bool {
    let Ok(u) = tauri::Url::parse(url) else { return false };
    matches!((u.scheme(), u.host_str()), ("http" | "https", Some("tauri.localhost")) | ("tauri", Some("localhost")))
}

#[cfg(windows)]
mod windows {
    use tauri::{Runtime, WebviewWindow};
    use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW};
    use webview2_com::PermissionRequestedEventHandler;
    use windows_core_wv2::PWSTR;

    pub fn allow_microphone<R: Runtime>(window: &WebviewWindow<R>) {
        let asked = window.with_webview(|w| {
            // SAFETY: the controller and the core are this window's live WebView2 objects, used on
            // the thread with_webview runs on, which is the one that owns them.
            let result = unsafe {
                w.controller().CoreWebView2().and_then(|core| {
                    let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                        args.PermissionKind(&mut kind)?;
                        if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                            return Ok(());
                        }
                        let mut uri = PWSTR::null();
                        args.Uri(&mut uri)?;
                        let uri = webview2_com::take_pwstr(uri);
                        // Anything else is left to WebView2, which asks the user.
                        if super::is_host_page(&uri) {
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                        }
                        Ok(())
                    }));
                    let mut token = Default::default();
                    core.add_PermissionRequested(&handler, &mut token)
                })
            };
            if let Err(e) = result {
                log::warn!("microphone permission handler: {e}");
            }
        });
        if let Err(e) = asked {
            log::warn!("microphone permission handler: {e}");
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use glib::object::ObjectExt;
    use tauri::{Runtime, WebviewWindow};
    use webkit2gtk::{PermissionRequestExt, UserMediaPermissionRequest, WebViewExt};

    pub fn allow_microphone<R: Runtime>(window: &WebviewWindow<R>) {
        let asked = window.with_webview(|w| {
            let view = w.inner();
            if let Some(settings) = WebViewExt::settings(&view) {
                if settings.find_property("enable-media-stream").is_some() {
                    settings.set_property("enable-media-stream", true);
                }
            }
            view.connect_permission_request(|view, request| {
                if !request.is::<UserMediaPermissionRequest>() {
                    return false;
                }
                let own = WebViewExt::uri(view).is_some_and(|u| super::is_host_page(u.as_str()));
                let audio = request.property::<bool>("is-for-audio-device");
                let video = request.property::<bool>("is-for-video-device");
                if own && audio && !video {
                    request.allow();
                } else {
                    request.deny();
                }
                true
            });
        });
        if let Err(e) = asked {
            log::warn!("microphone permission handler: {e}");
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::OnceLock;

    use block2::Block;
    use objc2::runtime::{AnyObject, Bool, Imp, Sel};
    use objc2::{msg_send, sel};
    use objc2_foundation::NSString;
    use tauri::{Runtime, WebviewWindow};

    /// `- webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:`.
    type RequestMediaCapture = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut AnyObject, isize, *mut Block<dyn Fn(isize)>);

    /// Set once the delegate class's method is replaced: it is the class's, for every web view.
    static REPLACED: OnceLock<()> = OnceLock::new();

    pub fn allow_microphone<R: Runtime>(window: &WebviewWindow<R>) {
        let asked = window.with_webview(|w| {
            let view = w.inner().cast::<AnyObject>();
            if view.is_null() {
                return;
            }
            // SAFETY: `inner()` is this window's live WKWebView, on the main thread
            // with_webview runs on; its UI delegate is wry's, alive as long as the view.
            let delegate: *mut AnyObject = unsafe { msg_send![view, UIDelegate] };
            let Some(delegate) = (unsafe { delegate.as_ref() }) else {
                log::warn!("microphone permission handler: the web view has no UI delegate");
                return;
            };
            let Some(method) = delegate.class().instance_method(sel!(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:)) else {
                log::warn!("microphone permission handler: the UI delegate answers no media request");
                return;
            };
            if REPLACED.set(()).is_ok() {
                // SAFETY: the replacement has the method's signature, and is set on the main
                // thread, where WebKit calls it.
                unsafe { method.set_implementation(std::mem::transmute::<RequestMediaCapture, Imp>(request_media_capture)) };
            }
        });
        if let Err(e) = asked {
            log::warn!("microphone permission handler: {e}");
        }
    }

    fn text(s: *mut NSString) -> String {
        // SAFETY: WebKit's own strings, alive for the call; none reads as empty.
        unsafe { s.as_ref() }.map(|s| s.to_string()).unwrap_or_default()
    }

    /// Answers WebKit with `media_decision`: the origin's scheme and host, and whether the asking frame is the page's own.
    unsafe extern "C-unwind" fn request_media_capture(_this: *mut AnyObject, _cmd: Sel, _webview: *mut AnyObject, origin: *mut AnyObject, frame: *mut AnyObject, capture: isize, handler: *mut Block<dyn Fn(isize)>) {
        // SAFETY: WebKit passes a live WKSecurityOrigin and WKFrameInfo for the call.
        let (protocol, host, main) = unsafe {
            let protocol: *mut NSString = msg_send![origin, protocol];
            let host: *mut NSString = msg_send![origin, host];
            let main: Bool = msg_send![frame, isMainFrame];
            (text(protocol), text(host), main.as_bool())
        };
        let decision = super::media_decision(&protocol, &host, main, capture);
        let said = if decision == super::webkit::GRANT { "granted" } else { "refused" };
        log::info!("media request {said}: {protocol}://{host} (main frame: {main}, type {capture})");
        // SAFETY: the decision handler WebKit passed, to be called once.
        if let Some(h) = unsafe { handler.as_ref() } {
            h.call((decision,));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_host_page_is_the_host_page() {
        assert!(is_host_page("http://tauri.localhost/index.html"));
        assert!(is_host_page("https://tauri.localhost/"));
        assert!(is_host_page("tauri://localhost/index.html"));
        for other in ["http://view.localhost/default/index.html", "https://example.com/", "http://tauri.localhost.example.com/", "file:///C:/x.html", "not a url"] {
            assert!(!is_host_page(other), "{other}");
        }
    }

    #[test]
    fn webkit_gives_the_microphone_to_the_host_pages_own_frame_and_nothing_else() {
        assert_eq!(media_decision("tauri", "localhost", true, webkit::MICROPHONE), webkit::GRANT);
        // a view's frame, a sandboxed frame of the host page, a camera, another origin
        assert_eq!(media_decision("http", "view.localhost", true, webkit::MICROPHONE), webkit::DENY);
        assert_eq!(media_decision("tauri", "localhost", false, webkit::MICROPHONE), webkit::DENY);
        assert_eq!(media_decision("tauri", "localhost", true, 0), webkit::DENY);
        assert_eq!(media_decision("tauri", "localhost", true, 2), webkit::DENY);
        assert_eq!(media_decision("https", "example.com", true, webkit::MICROPHONE), webkit::DENY);
    }

    #[test]
    fn the_talk_keys_the_page_offers_parse() {
        // DEFAULT_TALK_KEY and MAC_TALK_KEY in host/voice.ts, and the examples the settings give.
        for key in ["Ctrl+Alt+Space", "Ctrl+Shift+Space", "Ctrl+Shift+F9"] {
            assert!(key.parse::<Shortcut>().is_ok(), "{key}");
        }
    }
}
