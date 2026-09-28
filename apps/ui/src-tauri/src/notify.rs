// OS notifications for asks, with the ask's options as buttons: a button answers the ask
// through the host page, the body shows the window. An ask that takes several options at
// once gets no buttons, only the body: one button is one answer. Action ids are
// `"<ask>|<option>"` on every platform, so `parse_action` is the one reader. While the
// window has the focus its asks are on screen, so none is shown, and when it gets the focus
// every one still up is taken down (`clear`). An ask settled anywhere takes its own down
// (`dismiss`).
//
// Windows: a toast through WinRT, tagged with the ask id for `dismiss`. A toast is
// attributed by AppUserModelID, so the process sets one before any window exists and
// registers it under HKCU best-effort, which is what makes a dev run say "Cophyla" rather
// than the name of the shell that launched it; the installer's Start Menu shortcut carries
// the same id. The icon comes from the version directory when installed.
//
// Linux: `org.freedesktop.Notifications` over D-Bus (notify-rust), actions as buttons where
// the desktop shows them (GNOME, KDE, dunst); the app name and desktop entry attribute it.
//
// macOS: `UNUserNotificationCenter` (mac-usernotifications, notify-rust's `preview-macos-un`
// backend, used directly), which needs the process to run inside a code-signed bundle with an
// identifier: a dev run from a checkout gets `unsupported`. The user is asked once for
// permission at start. Buttons come from a notification category the backend registers per
// set of actions; the body is the default action, so there is no "Open" button. macOS tells
// nothing when an app takes its own notification down, so each wait races a stop that
// `dismiss` and `clear` fire, and ends with the notification rather than living on.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::install::Install;

#[cfg_attr(not(windows), allow(dead_code))]
pub const AUMID: &str = "com.fareaststudios.cophyla.desktop";
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub const DISPLAY_NAME: &str = "Cophyla";
pub const EVENT_ACTIVATED: &str = "ask:activated";

/// How many option buttons a notification carries: what each platform shows at once.
#[cfg(windows)]
pub const MAX_BUTTONS: usize = 5;
#[cfg(target_os = "macos")]
pub const MAX_BUTTONS: usize = 4;
#[cfg(all(unix, not(target_os = "macos")))]
pub const MAX_BUTTONS: usize = 5;
const DETAIL_CHARS: usize = 200;

#[derive(Debug, Clone, Deserialize)]
pub struct NotifyOption {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NotifyAsk {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub options: Vec<NotifyOption>,
    /// Several options may be chosen at once: the toast carries no buttons.
    #[serde(default)]
    pub multiple: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Activated {
    pub ask: String,
    pub option: String,
}

/// The action id of one option button: `"<ask>|<option>"`.
pub fn action_id(ask: &str, option: &str) -> String {
    format!("{ask}|{option}")
}

/// `"<ask>|<option>"` on a button; anything else is the body. Ask ids are `ask_` and a
/// ULID, so the first `|` ends the id and an option id may carry one itself.
pub fn parse_action(action: &str) -> Option<Activated> {
    let (ask, option) = action.split_once('|')?;
    if ask.is_empty() || option.is_empty() {
        return None;
    }
    Some(Activated { ask: ask.to_string(), option: option.to_string() })
}

/// The option buttons an ask gets: none on a `multiple` ask, at most `MAX_BUTTONS` otherwise.
pub fn buttons(ask: &NotifyAsk) -> Vec<(String, String)> {
    if ask.multiple {
        return Vec::new();
    }
    ask.options.iter().take(MAX_BUTTONS).map(|o| (action_id(&ask.id, &o.id), o.label.clone())).collect()
}

pub fn truncate(text: &str, max: usize) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        return one_line;
    }
    let mut out: String = one_line.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Whether the app's window has the focus: the view shows the asks, and a notification would only repeat them.
pub fn window_focused<R: Runtime>(app: &AppHandle<R>) -> bool {
    use tauri::Manager;
    app.get_webview_window(crate::cophylad::HOST_LABEL).and_then(|w| w.is_focused().ok()).unwrap_or(false)
}

/// What an activation does: a button answers the ask through the host page, anything else shows the window.
fn activated<R: Runtime>(app: &AppHandle<R>, action: Option<&str>) {
    use tauri::{Emitter, Manager};
    match action.and_then(parse_action) {
        Some(a) => {
            let _ = app.emit_to(crate::cophylad::HOST_LABEL, EVENT_ACTIVATED, a);
        }
        None => {
            crate::dock(app, true);
            if let Some(w) = app.get_webview_window(crate::cophylad::HOST_LABEL) {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
    }
}

/// The icon a notification carries: the version directory's when installed, the source tree's otherwise.
fn icon_path(install: Option<&Install>) -> std::path::PathBuf {
    match install {
        Some(i) => i.icon("128x128.png"),
        None => std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("icons").join("128x128.png"),
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows::core::{h, IInspectable, Interface, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastActivatedEventArgs, ToastNotification, ToastNotificationManager};

    /// Every ask toast's group; its tag is the ask id.
    const GROUP: &str = "asks";

    pub fn set_process_aumid() {
        use windows::core::w;
        use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
        if let Err(e) = unsafe { SetCurrentProcessExplicitAppUserModelID(w!("com.fareaststudios.cophyla.desktop")) } {
            log::warn!("SetCurrentProcessExplicitAppUserModelID: {e}");
        }
    }

    /// `HKCU\Software\Classes\AppUserModelId\<AUMID>` with a display name and an icon, so
    /// the toast is attributed to the app. Best-effort: a failure only changes the label.
    pub fn register<R: Runtime>(_app: &AppHandle<R>, install: Option<&Install>) {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let path = format!(r"Software\Classes\AppUserModelId\{AUMID}");
        let result = RegKey::predef(HKEY_CURRENT_USER).create_subkey(&path).and_then(|(key, _)| {
            key.set_value("DisplayName", &DISPLAY_NAME)?;
            let icon = icon_path(install);
            if icon.exists() {
                key.set_value("IconUri", &icon.to_string_lossy().into_owned())?;
                key.set_value("IconBackgroundColor", &"0")?;
            }
            Ok(())
        });
        if let Err(e) = result {
            log::warn!("cannot register {AUMID} under HKCU: {e}");
        }
    }

    pub fn show<R: Runtime>(app: &AppHandle<R>, ask: NotifyAsk) -> Result<(), String> {
        toast(app, &ask).map_err(|e| format!("toast failed: {e}"))
    }

    /// A Reminder toast, up until acted on or taken down: the title, the detail, a button per option.
    fn toast<R: Runtime>(app: &AppHandle<R>, ask: &NotifyAsk) -> windows::core::Result<()> {
        let doc = XmlDocument::new()?;
        let root = doc.CreateElement(h!("toast"))?;
        root.SetAttribute(h!("scenario"), h!("reminder"))?;
        root.SetAttribute(h!("duration"), h!("long"))?;
        let visual = doc.CreateElement(h!("visual"))?;
        let binding = doc.CreateElement(h!("binding"))?;
        binding.SetAttribute(h!("template"), h!("ToastGeneric"))?;
        let detail = ask.detail.as_deref().filter(|d| !d.trim().is_empty()).map(|d| truncate(d, DETAIL_CHARS));
        for line in std::iter::once(ask.title.clone()).chain(detail) {
            let text = doc.CreateElement(h!("text"))?;
            text.SetInnerText(&HSTRING::from(line))?;
            binding.AppendChild(&text)?;
        }
        visual.AppendChild(&binding)?;
        root.AppendChild(&visual)?;
        let buttons = buttons(ask);
        if !buttons.is_empty() {
            let actions = doc.CreateElement(h!("actions"))?;
            for (id, label) in buttons {
                let action = doc.CreateElement(h!("action"))?;
                action.SetAttribute(h!("content"), &HSTRING::from(label))?;
                action.SetAttribute(h!("arguments"), &HSTRING::from(id))?;
                actions.AppendChild(&action)?;
            }
            root.AppendChild(&actions)?;
        }
        doc.AppendChild(&root)?;
        let toast = ToastNotification::CreateToastNotification(&doc)?;
        toast.SetTag(&HSTRING::from(&ask.id))?;
        toast.SetGroup(&HSTRING::from(GROUP))?;
        let handle = app.clone();
        toast.Activated(&TypedEventHandler::new(move |_, args| {
            let args: &Option<IInspectable> = &args;
            let action = args.as_ref().and_then(|a| a.cast::<ToastActivatedEventArgs>().ok()).and_then(|a| a.Arguments().ok()).map(|a| a.to_string());
            activated(&handle, action.as_deref().filter(|a| !a.is_empty()));
            Ok(())
        }))?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))?.Show(&toast)
    }

    /// Takes the app's toasts down, from the screen and from the notification centre.
    pub fn clear() {
        if let Err(e) = ToastNotificationManager::History().and_then(|h| h.ClearWithId(&HSTRING::from(AUMID))) {
            log::debug!("clearing toasts: {e}");
        }
    }

    /// Takes one ask's toast down, found by its tag: none up is not an error.
    pub fn dismiss(ask: &str) {
        let removed = ToastNotificationManager::History().and_then(|h| h.RemoveGroupedTagWithId(&HSTRING::from(ask), &HSTRING::from(GROUP), &HSTRING::from(AUMID)));
        if let Err(e) = removed {
            log::debug!("dismissing the toast for {ask}: {e}");
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod platform {
    use super::*;
    #[cfg(target_os = "linux")]
    use notify_rust::Notification;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    /// The icon path, kept from `register` for `show` (Linux attaches it to every notification).
    static ICON: OnceLock<std::path::PathBuf> = OnceLock::new();

    /// A notification up, for `clear` and `dismiss`: on Linux its handle, which closes it and
    /// keeps its connection (some desktops need it for the buttons); on macOS its identifier,
    /// and the stop that ends its wait (dropped, it ends it too).
    #[cfg(target_os = "linux")]
    type Up = notify_rust::NotificationHandle;
    #[cfg(target_os = "macos")]
    struct Up {
        id: String,
        stop: futures_channel::oneshot::Sender<()>,
    }

    /// The notifications up, each with the ask it is for.
    static SHOWN: Mutex<Vec<(String, Up)>> = Mutex::new(Vec::new());

    fn shown() -> MutexGuard<'static, Vec<(String, Up)>> {
        SHOWN.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_process_aumid() {}

    /// Linux: nothing to register beyond the icon. macOS: outside a bundle notifications
    /// stay unsupported; inside one the user is asked once, at start, for permission. The
    /// first time, the answer waits on the user's click on the system's prompt, so the ask
    /// runs on a thread of its own: `register` is called from `setup`, before the window, the
    /// tray and the daemon exist, and none of them may wait on it.
    pub fn register<R: Runtime>(_app: &AppHandle<R>, install: Option<&Install>) {
        let _ = ICON.set(icon_path(install));
        #[cfg(target_os = "macos")]
        match notify_rust::check_bundle() {
            Ok(()) => {
                let ask = std::thread::Builder::new().name("notification-auth".into()).spawn(|| match notify_rust::request_auth_blocking() {
                    Ok(status) => log::info!("notifications: authorization {status:?}"),
                    Err(e) => log::warn!("notifications: authorization request failed: {e}"),
                });
                if let Err(e) = ask {
                    log::warn!("notifications: cannot ask for authorization: {e}");
                }
            }
            Err(e) => log::info!("notifications unsupported outside an app bundle: {e}"),
        }
    }

    #[cfg(target_os = "linux")]
    pub fn show<R: Runtime>(app: &AppHandle<R>, ask: NotifyAsk) -> Result<(), String> {
        let mut n = Notification::new();
        n.summary(&ask.title).appname(DISPLAY_NAME);
        if let Some(detail) = ask.detail.as_deref().filter(|d| !d.trim().is_empty()) {
            n.body(&truncate(detail, DETAIL_CHARS));
        }
        n.hint(notify_rust::Hint::DesktopEntry(DISPLAY_NAME.into()));
        if let Some(icon) = ICON.get().filter(|p| p.exists()) {
            n.icon(&icon.to_string_lossy());
        }
        for (id, label) in buttons(&ask) {
            n.action(&id, &label);
        }
        n.action("default", "Open");
        let handle = n.show().map_err(|e| format!("notification failed: {e}"))?;
        let app = app.clone();
        let on_action = move |action: &str| match action {
            "__closed" => {}
            "default" | "" => activated(&app, None),
            other => activated(&app, Some(other)),
        };
        // The wait blocks until the user acts or the notification goes away: its own thread.
        // Linux listens by id, so the handle can stay in `SHOWN` for `clear` to close.
        let id = handle.id();
        shown().push((ask.id.clone(), handle));
        let wait = move || {
            let _ = notify_rust::handle_action(id, |response| match response {
                notify_rust::ActionResponse::Custom(action) => on_action(*action),
                notify_rust::ActionResponse::Closed(_) => {}
            });
            shown().retain(|(_, h)| h.id() != id);
        };
        std::thread::Builder::new().name("notification".into()).spawn(wait).map_err(|e| format!("cannot wait for the notification: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub fn show<R: Runtime>(app: &AppHandle<R>, ask: NotifyAsk) -> Result<(), String> {
        use futures_lite::future;
        use mac_usernotifications::{Action, NotificationResponse};

        notify_rust::check_bundle().map_err(|e| format!("unsupported: not running from an app bundle ({e})"))?;
        let mut n = mac_usernotifications::Notification::new().title(&ask.title);
        if let Some(detail) = ask.detail.as_deref().filter(|d| !d.trim().is_empty()) {
            n = n.message(truncate(detail, DETAIL_CHARS));
        }
        for (id, label) in buttons(&ask) {
            n = n.action(Action::button(id, label));
        }
        let handle = n.send_blocking().map_err(|e| format!("notification failed: {e}"))?;
        let id = handle.notification_id().to_owned();
        let (stop, stopped) = futures_channel::oneshot::channel::<()>();
        shown().push((ask.id.clone(), Up { id: id.clone(), stop }));
        let app = app.clone();
        // The response comes through the backend's delegate on the main thread; this thread
        // waits for it or for the stop, whichever is first.
        let wait = move || {
            let answered: Option<NotificationResponse> = future::block_on(future::or(async { handle.response().await.ok() }, async {
                let _ = stopped.await;
                None
            }));
            shown().retain(|(_, up)| up.id != id);
            match answered {
                Some(r) if r.is_dismiss_action() || r.is_timed_out() => {}
                Some(r) if r.is_default_action() => activated(&app, None),
                Some(r) => activated(&app, Some(&r.action_identifier)),
                None => {}
            }
        };
        std::thread::Builder::new().name("notification".into()).spawn(wait).map_err(|e| format!("cannot wait for the notification: {e}"))?;
        Ok(())
    }

    /// Closes notifications off the calling thread: a close is a round trip each.
    fn close(up: Vec<(String, Up)>) {
        if up.is_empty() {
            return;
        }
        let _ = std::thread::Builder::new().name("notification-close".into()).spawn(move || {
            for (_, n) in up {
                #[cfg(target_os = "linux")]
                n.close();
                #[cfg(target_os = "macos")]
                {
                    mac_usernotifications::blocking::close_delivered(&n.id);
                    let _ = n.stop.send(());
                }
            }
        });
    }

    /// Takes every notification still up down.
    pub fn clear() {
        close(std::mem::take(&mut *shown()));
    }

    /// Takes one ask's notification down, if it is still up.
    pub fn dismiss(ask: &str) {
        let mut up = shown();
        let (gone, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut *up).into_iter().partition(|(a, _)| a == ask);
        *up = kept;
        drop(up);
        close(gone);
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod platform {
    use super::*;

    pub fn set_process_aumid() {}

    pub fn register<R: Runtime>(_app: &AppHandle<R>, _install: Option<&Install>) {}

    pub fn show<R: Runtime>(_app: &AppHandle<R>, _ask: NotifyAsk) -> Result<(), String> {
        Err("unsupported: no notification backend on this platform".into())
    }

    pub fn clear() {}

    pub fn dismiss(_ask: &str) {}
}

pub use platform::{clear, dismiss, register, set_process_aumid, show};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_action_splits_on_the_first_bar() {
        let a = parse_action("ask_01ARZ3NDEKTSV4RRFFQ69G5FB5|allow").unwrap();
        assert_eq!(a.ask, "ask_01ARZ3NDEKTSV4RRFFQ69G5FB5");
        assert_eq!(a.option, "allow");
        let b = parse_action("ask_01ARZ3NDEKTSV4RRFFQ69G5FB5|a | b").unwrap();
        assert_eq!(b.option, "a | b");
        assert!(parse_action("").is_none());
        assert!(parse_action("body").is_none());
        assert!(parse_action("default").is_none());
        assert!(parse_action("|allow").is_none());
        assert!(parse_action("ask_x|").is_none());
    }

    #[test]
    fn action_id_round_trips_through_parse_action() {
        let id = action_id("ask_01ARZ3NDEKTSV4RRFFQ69G5FB5", "a | b");
        assert_eq!(id, "ask_01ARZ3NDEKTSV4RRFFQ69G5FB5|a | b");
        let a = parse_action(&id).unwrap();
        assert_eq!((a.ask.as_str(), a.option.as_str()), ("ask_01ARZ3NDEKTSV4RRFFQ69G5FB5", "a | b"));
    }

    #[test]
    fn buttons_are_capped_per_platform_and_absent_on_a_multiple_ask() {
        let options = (0..8).map(|i| NotifyOption { id: format!("o{i}"), label: format!("Option {i}") }).collect::<Vec<_>>();
        let ask = NotifyAsk { id: "ask_1".into(), title: "t".into(), detail: None, options: options.clone(), multiple: false };
        let b = buttons(&ask);
        assert_eq!(b.len(), MAX_BUTTONS);
        assert_eq!(b[0], ("ask_1|o0".to_string(), "Option 0".to_string()));
        assert!(MAX_BUTTONS >= 4 && MAX_BUTTONS <= 5);
        let many = NotifyAsk { multiple: true, ..ask };
        assert!(buttons(&many).is_empty());
    }

    #[test]
    fn truncate_folds_whitespace_and_caps_by_chars() {
        assert_eq!(truncate("a\n  b\tc", 10), "a b c");
        assert_eq!(truncate("abcdef", 6), "abcdef");
        assert_eq!(truncate("abcdefg", 6), "abcde…");
        assert_eq!(truncate("ééééééé", 4), "ééé…");
    }

    #[test]
    fn notify_ask_reads_multiple_as_false_by_default() {
        let ask: NotifyAsk = serde_json::from_str(r#"{"id":"ask_1","title":"t","options":[{"id":"a","label":"A"}]}"#).unwrap();
        assert!(!ask.multiple);
        assert_eq!(ask.options.len(), 1);
        let many: NotifyAsk = serde_json::from_str(r#"{"id":"ask_1","title":"t","options":[],"multiple":true}"#).unwrap();
        assert!(many.multiple);
    }
}
