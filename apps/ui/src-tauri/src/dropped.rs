// Files and folders the user dropped on the view from the desktop (Explorer, the Finder, a
// file manager), by their full paths. A web page sees a dropped file's name and never where it
// is, so the shell says where, one small piece per platform.
//
// Windows (windows.rs): WebView2 gives the app the path of every `File` a frame hands it with
// `chrome.webview.postMessageWithAdditionalObjects`. The view posts
// `{ cophyla: "cophyla.filePaths", id }` with the files dropped on it and hears back, as a
// WebView2 message to its frame, `{ cophyla: "cophyla.filePaths", id, paths }`, in the files'
// order. The view posts them itself, past the host page, because WebView2 grants a dropped file
// to the process it was dropped into alone, and the view's frame is a process of its own: files
// the host page had re-posted would be refused. A frame's messages reach only the handlers on
// that frame, which only this shell adds, and only for a frame on the view origin; what comes
// back is only ever the paths of files the view was given, since WebView2 ends a frame that
// hands it any other.
//
// macOS and Linux (macos.rs, linux.rs): WebKit has no such seam, and hides even `text/uri-list`
// from a drop that carries files. The shell reads the paths natively as the drop passes into
// the page and keeps the last drop's; the view asks for them through its host
// (`host.filePaths`, which the host page asks of `dropped_paths`). They are handed over once,
// and only while the drop is fresh. On macOS the view names the files, and every name must be
// one of the paths' own. WebKitGTK (Linux) shows a page no dropped file at all
// (webkit.org/b/271957): the drop comes as a `text/uri-list` with nothing in it, so there the
// view asks with no names and is handed the drop's paths as they are. `filePaths` in
// `host.ready` tells the view it can ask, on every platform.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

use std::ffi::OsStr;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Runtime, WebviewWindow};

/// What a view posts its files with, and what the answer is marked with (Windows).
pub const MESSAGE: &str = "cophyla.filePaths";

/// How long a drop's paths wait for the view to ask: as long as the view waits for them
/// (`FILES_TIMEOUT_MS` in views/default/dropped.ts).
const FRESH: Duration = Duration::from_secs(5);

#[derive(Serialize)]
#[cfg_attr(not(windows), allow(dead_code))]
struct Answer<'a> {
    cophyla: &'a str,
    id: u64,
    paths: Vec<String>,
}

/// The id of a message a view posted files with, if the message is one.
#[cfg_attr(not(windows), allow(dead_code))]
fn message_id(json: &str) -> Option<u64> {
    let message: serde_json::Value = serde_json::from_str(json).ok()?;
    if message.get("cophyla")?.as_str()? != MESSAGE {
        return None;
    }
    message.get("id")?.as_u64()
}

/// Whether a message came from a view's frame.
#[cfg_attr(not(windows), allow(dead_code))]
fn from_view(source: &str) -> bool {
    tauri::Url::parse(source).is_ok_and(|u| crate::views::is_view(&u))
}

/// The paths of the last drop on the host web view, and when it came (macOS, Linux).
#[cfg_attr(windows, allow(dead_code))]
struct Dropped {
    paths: Vec<PathBuf>,
    at: Instant,
}

static LAST: Mutex<Option<Dropped>> = Mutex::new(None);

/// Keeps the paths of the files just dropped on the host web view, for the view to ask for.
#[cfg_attr(windows, allow(dead_code))]
fn record(paths: Vec<PathBuf>) {
    log::debug!("dropped files: {} kept", paths.len());
    *LAST.lock().unwrap_or_else(PoisonError::into_inner) = Some(Dropped { paths, at: Instant::now() });
}

/// The paths of the files a view names, in the order it names them, when they are a drop's:
/// one no older than `FRESH`, of as many files, each name an unused path's own (so two files
/// of the same name, from two folders, each have theirs), and every path text. With no names,
/// on Linux alone, where the page never sees a dropped file's name: every path of a drop no
/// older than `FRESH`, in its order, every one text.
fn claim(dropped: Option<Dropped>, names: Option<&[String]>, now: Instant) -> Result<Vec<String>, String> {
    if names.is_none() && !cfg!(target_os = "linux") {
        return Err("invalid: name the files dropped".into());
    }
    let dropped = dropped.filter(|d| now.saturating_duration_since(d.at) <= FRESH).ok_or_else(|| "unavailable: no files were dropped just now".to_string())?;
    let Some(names) = names else {
        return dropped.paths.into_iter().map(text).collect();
    };
    if dropped.paths.len() != names.len() {
        return Err(format!("invalid: {} files were dropped, not {}", dropped.paths.len(), names.len()));
    }
    let mut unused: Vec<Option<PathBuf>> = dropped.paths.into_iter().map(Some).collect();
    names
        .iter()
        .map(|name| {
            let path = unused
                .iter_mut()
                .find(|p| p.as_ref().is_some_and(|p| p.file_name() == Some(OsStr::new(name))))
                .and_then(Option::take)
                .ok_or_else(|| format!("invalid: no file named {name} was dropped"))?;
            text(path)
        })
        .collect()
}

/// A dropped path as the view takes it, text.
fn text(path: PathBuf) -> Result<String, String> {
    path.into_os_string().into_string().map_err(|p| format!("invalid: {} is not a path the view can take", p.to_string_lossy()))
}

/// Where the files just dropped on the host web view are, for the names the view saw them
/// under, or with none (Linux) all of them; a drop is handed over once, whether or not the
/// names were its own. On Windows none is ever kept: the view asks WebView2 there.
#[tauri::command]
pub fn dropped_paths(names: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let last = LAST.lock().unwrap_or_else(PoisonError::into_inner).take();
    claim(last, names.as_deref(), Instant::now())
}

/// Where the files dropped on the host window's view are: its frame asks WebView2 (Windows),
/// or the drop's paths are kept as it passes into the page (macOS, Linux).
pub fn listen<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(windows)]
    windows::listen(window);
    #[cfg(target_os = "macos")]
    macos::listen(window);
    #[cfg(target_os = "linux")]
    linux::listen(window);
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    let _ = window;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_views_files_message_is_read() {
        assert_eq!(message_id(r#"{"cophyla":"cophyla.filePaths","id":7}"#), Some(7));
        for other in [r#""cophyla.filePaths""#, r#"{"cophyla":"other","id":7}"#, r#"{"cophyla":"cophyla.filePaths"}"#, r#"{"cophyla":"cophyla.filePaths","id":-1}"#, r#"{"cmd":"open_link"}"#, "not json"] {
            assert_eq!(message_id(other), None, "{other}");
        }
        let view = crate::views::ORIGIN;
        assert!(from_view(&format!("{view}/default/1.2.0/index.html")));
        let lookalike = view.replacen("localhost", "localhost.example.com", 1);
        let other_port = format!("{view}:1/");
        for other in [crate::views::HOST_ORIGIN, "about:blank", lookalike.as_str(), other_port.as_str(), "https://view.localhost/", "not a url"] {
            assert!(!from_view(other), "{other}");
        }
    }

    fn drop_of(paths: &[&str], at: Instant) -> Option<Dropped> {
        Some(Dropped { paths: paths.iter().map(PathBuf::from).collect(), at })
    }

    fn names(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn a_fresh_drop_answers_in_the_names_order() {
        let at = Instant::now();
        let dropped = drop_of(&["/home/u/drop me/a.txt", "/home/u/drop me/b c.txt", "/home/u/docs/"], at);
        assert_eq!(claim(dropped, Some(&names(&["docs", "b c.txt", "a.txt"])), at + FRESH), Ok(names(&["/home/u/docs/", "/home/u/drop me/b c.txt", "/home/u/drop me/a.txt"])));
        assert_eq!(claim(drop_of(&["/Users/u/café.md"], at), Some(&names(&["café.md"])), at), Ok(names(&["/Users/u/café.md"])));
    }

    #[test]
    fn two_files_of_one_name_each_have_their_path() {
        let at = Instant::now();
        let dropped = drop_of(&["/x/a.txt", "/y/a.txt"], at);
        assert_eq!(claim(dropped, Some(&names(&["a.txt", "a.txt"])), at), Ok(names(&["/x/a.txt", "/y/a.txt"])));
    }

    #[test]
    fn a_stale_missing_or_mismatched_drop_is_refused() {
        let at = Instant::now();
        let stale = claim(drop_of(&["/x/a.txt"], at), Some(&names(&["a.txt"])), at + FRESH + Duration::from_millis(1));
        assert!(stale.as_ref().is_err_and(|e| e.starts_with("unavailable:")), "{stale:?}");
        assert!(claim(None, Some(&names(&["a.txt"])), at).is_err_and(|e| e.starts_with("unavailable:")));
        let refused: [(&[&str], &[&str]); 5] = [(&["/x/a.txt", "/x/b.txt"], &["a.txt"]), (&["/x/a.txt"], &["a.txt", "a.txt"]), (&["/x/a.txt"], &["b.txt"]), (&["/x/a.txt", "/x/b.txt"], &["a.txt", "a.txt"]), (&["/"], &[""])];
        for (paths, asked) in refused {
            let got = claim(drop_of(paths, at), Some(&names(asked)), at);
            assert!(got.as_ref().is_err_and(|e| e.starts_with("invalid:")), "{paths:?} {asked:?}: {got:?}");
        }
    }

    #[test]
    fn a_path_that_is_not_text_is_refused() {
        #[cfg(unix)]
        let odd = {
            use std::os::unix::ffi::OsStringExt;
            PathBuf::from(std::ffi::OsString::from_vec(b"/\xff/a.txt".to_vec()))
        };
        #[cfg(windows)]
        let odd = {
            use std::os::windows::ffi::OsStringExt;
            let mut wide: Vec<u16> = "C:\\".encode_utf16().collect();
            wide.push(0xd800);
            wide.extend("\\a.txt".encode_utf16());
            PathBuf::from(std::ffi::OsString::from_wide(&wide))
        };
        let at = Instant::now();
        let got = claim(Some(Dropped { paths: vec![odd.clone()], at }), Some(&names(&["a.txt"])), at);
        assert!(got.as_ref().is_err_and(|e| e.starts_with("invalid:")), "{got:?}");
        let got = claim(Some(Dropped { paths: vec![PathBuf::from("/x/b.txt"), odd], at }), None, at);
        assert!(got.as_ref().is_err_and(|e| e.starts_with("invalid:")), "{got:?}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_fresh_drop_asked_with_no_names_answers_all_its_paths() {
        let at = Instant::now();
        let paths = ["/home/u/drop me/b c.txt", "/home/u/docs/", "/home/u/café.md"];
        assert_eq!(claim(drop_of(&paths, at), None, at + FRESH), Ok(names(&paths)));
        let stale = claim(drop_of(&paths, at), None, at + FRESH + Duration::from_millis(1));
        assert!(stale.as_ref().is_err_and(|e| e.starts_with("unavailable:")), "{stale:?}");
        assert!(claim(None, None, at).is_err_and(|e| e.starts_with("unavailable:")));
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn a_drop_is_named_off_linux() {
        let at = Instant::now();
        let got = claim(drop_of(&["/x/a.txt"], at), None, at);
        assert_eq!(got, Err("invalid: name the files dropped".to_string()));
    }

    #[test]
    fn a_drop_is_handed_over_once() {
        record(vec![PathBuf::from("/x/a.txt")]);
        assert_eq!(dropped_paths(Some(names(&["a.txt"]))), Ok(names(&["/x/a.txt"])));
        assert!(dropped_paths(Some(names(&["a.txt"]))).is_err());
        // a claim that fails takes the drop all the same
        record(vec![PathBuf::from("/x/a.txt")]);
        assert!(dropped_paths(Some(names(&["b.txt"]))).is_err());
        assert!(dropped_paths(Some(names(&["a.txt"]))).is_err());
        // and so does one with no names, which only Linux answers
        record(vec![PathBuf::from("/x/a.txt")]);
        assert_eq!(dropped_paths(None).is_ok(), cfg!(target_os = "linux"));
        assert!(dropped_paths(None).is_err());
        assert!(dropped_paths(Some(names(&["a.txt"]))).is_err());
    }
}
