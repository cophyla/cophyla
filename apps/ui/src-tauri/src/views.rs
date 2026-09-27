// Serving a staged view to the host page's sandboxed frame over the `view` scheme.
//
// The host fetches a view with `view.get` on its cophylad connection and hands the files to
// `view_stage`, which keeps them in memory keyed by id and version. The frame then loads
// `<ORIGIN>/<id>/<version>/<entry>` with `sandbox="allow-scripts allow-forms"`, so the
// document runs on an opaque origin: no storage, no IPC, and with the headers below no
// network either, nor anywhere for a form to submit to. Only the `host` webview is answered.
// The web view says where the scheme is: WebView2 serves it as `http://view.localhost` and
// the host page as `http://tauri.localhost` (Windows); WebKit (macOS, Linux) as
// `view://localhost`, the host page as `tauri://localhost`.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine as _;
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, Url};

pub const SCHEME: &str = "view";
#[cfg(windows)]
pub const ORIGIN: &str = "http://view.localhost";
#[cfg(not(windows))]
pub const ORIGIN: &str = "view://localhost";
pub const HOST_LABEL: &str = "host";

#[cfg(windows)]
pub const HOST_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(windows))]
pub const HOST_ORIGIN: &str = "tauri://localhost";

/// What the frame may do. Scripts, styles, images and fonts come only from the view origin;
/// there is no connect-src, so `fetch` and sockets are refused before any request leaves
/// the web view; only the app's own page may embed it (`frame-ancestors` is the host's
/// origin: `HOST_ORIGIN`, or `tauri dev`'s server when configured).
fn csp(host: &str) -> String {
    format!("default-src 'none'; script-src {ORIGIN}; style-src {ORIGIN} 'unsafe-inline'; img-src {ORIGIN} data:; font-src {ORIGIN}; connect-src 'none'; frame-ancestors {host}; base-uri 'none'; form-action 'none'")
}

/// Whether a URL is on the view origin. Compared part by part: the URL standard gives a scheme
/// it does not know (`view://`) an opaque origin, which matches no other, itself included.
pub fn is_view(url: &Url) -> bool {
    Url::parse(ORIGIN).is_ok_and(|view| url.scheme() == view.scheme() && url.host_str() == view.host_str() && url.port() == view.port())
}

/// The origin of `build.devUrl` when `tauri dev` serves the page from its own server.
pub fn dev_origin<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<String> {
    app.config().build.dev_url.as_ref().map(|u| u.origin().ascii_serialization())
}

#[derive(Debug, Clone, Deserialize)]
pub struct StageFile {
    pub path: String,
    pub mime: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub base64: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StageView {
    pub id: String,
    pub version: String,
    pub files: Vec<StageFile>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StagedBase {
    /// `<ORIGIN>/<id>/<version>/`; the entry is appended by the host.
    pub base: String,
}

struct StagedFile {
    mime: String,
    bytes: Vec<u8>,
}

/// id → version → path → file. Older versions of a view are dropped when a new one arrives.
#[derive(Default)]
pub struct Staged(Mutex<HashMap<String, (String, HashMap<String, StagedFile>)>>);

fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

fn valid_path(p: &str) -> bool {
    !p.is_empty() && !p.starts_with('/') && p.split('/').all(valid_segment)
}

impl Staged {
    pub fn stage(&self, view: StageView) -> Result<StagedBase, String> {
        if !valid_segment(&view.id) || !valid_segment(&view.version) {
            return Err("view id and version must be [A-Za-z0-9._-]".into());
        }
        let mut files = HashMap::with_capacity(view.files.len());
        for f in view.files {
            if !valid_path(&f.path) {
                return Err(format!("view {}: bad file path {:?}", view.id, f.path));
            }
            let bytes = match (f.text, f.base64) {
                (Some(t), _) => t.into_bytes(),
                (None, Some(b)) => base64::engine::general_purpose::STANDARD
                    .decode(b.as_bytes())
                    .map_err(|e| format!("view {}: {} is not base64: {e}", view.id, f.path))?,
                (None, None) => Vec::new(),
            };
            files.insert(f.path, StagedFile { mime: f.mime, bytes });
        }
        let base = format!("{ORIGIN}/{}/{}/", view.id, view.version);
        self.0
            .lock()
            .map_err(|_| "staged views poisoned".to_string())?
            .insert(view.id, (view.version, files));
        Ok(StagedBase { base })
    }

    fn lookup(&self, id: &str, version: &str, path: &str) -> Option<(String, Vec<u8>)> {
        let map = self.0.lock().ok()?;
        let (v, files) = map.get(id)?;
        if v != version {
            return None;
        }
        let f = files.get(path)?;
        Some((f.mime.clone(), f.bytes.clone()))
    }
}

fn respond(status: StatusCode, mime: &str, body: Vec<u8>, host_origin: &str) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_SECURITY_POLICY, csp(host_origin))
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Cow::Owned(body))
        .expect("static response")
}

/// The `view` scheme handler: `/<id>/<version>/<path>` from the staged files, for the
/// host webview only.
pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let host = dev_origin(ctx.app_handle()).unwrap_or_else(|| HOST_ORIGIN.to_string());
    if ctx.webview_label() != HOST_LABEL {
        return respond(StatusCode::FORBIDDEN, "text/plain", b"not the host".to_vec(), &host);
    }
    let path = request.uri().path();
    let decoded = match percent_decode_str(path).decode_utf8() {
        Ok(p) => p.into_owned(),
        Err(_) => return respond(StatusCode::NOT_FOUND, "text/plain", b"not found".to_vec(), &host),
    };
    let mut parts = decoded.trim_start_matches('/').splitn(3, '/');
    let (Some(id), Some(version), Some(file)) = (parts.next(), parts.next(), parts.next()) else {
        return respond(StatusCode::NOT_FOUND, "text/plain", b"not found".to_vec(), &host);
    };
    if !valid_segment(id) || !valid_segment(version) || !valid_path(file) {
        return respond(StatusCode::NOT_FOUND, "text/plain", b"not found".to_vec(), &host);
    }
    let staged = ctx.app_handle().state::<Staged>();
    match staged.lookup(id, version, file) {
        Some((mime, bytes)) => respond(StatusCode::OK, &mime, bytes, &host),
        None => respond(StatusCode::NOT_FOUND, "text/plain", b"not found".to_vec(), &host),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_staged_view_is_served_from_the_view_origin() {
        let staged = Staged::default();
        let view = StageView { id: "default".into(), version: "1.2.0".into(), files: vec![StageFile { path: "index.html".into(), mime: "text/html".into(), text: Some("<!doctype html>".into()), base64: None }] };
        let base = staged.stage(view).expect("staged").base;
        assert_eq!(base, format!("{ORIGIN}/default/1.2.0/"));
        assert!(is_view(&Url::parse(&format!("{base}index.html")).unwrap()));
        assert_eq!(staged.lookup("default", "1.2.0", "index.html").map(|(mime, _)| mime).as_deref(), Some("text/html"));
    }

    #[test]
    fn only_the_view_origin_is_the_views() {
        let view = Url::parse(ORIGIN).unwrap();
        let host = view.host_str().unwrap();
        assert!(is_view(&view));
        assert!(is_view(&Url::parse(&format!("{ORIGIN}/default/1.2.0/index.html?x#y")).unwrap()));
        let others = [
            format!("{ORIGIN}:8080/"),
            format!("{}://{host}/", if view.scheme() == "http" { "https" } else { "http" }),
            format!("{}://{host}.example.com/", view.scheme()),
            format!("{}://x{host}/", view.scheme()),
            HOST_ORIGIN.to_string(),
            "http://view.localhost.example.com/".into(),
            "view://example.com/".into(),
            "about:blank".into(),
            "data:text/html,x".into(),
        ];
        for other in others {
            assert!(!is_view(&Url::parse(&other).unwrap()), "{other}");
        }
        // the other platform's form is not this one's
        let elsewhere = if cfg!(windows) { "view://localhost/default/" } else { "http://view.localhost/default/" };
        assert!(!is_view(&Url::parse(elsewhere).unwrap()));
    }

    #[test]
    fn the_frame_csp_names_the_view_origin_and_its_embedder() {
        let policy = csp(HOST_ORIGIN);
        for directive in ["script-src", "style-src", "img-src", "font-src"] {
            assert!(policy.contains(&format!("{directive} {ORIGIN}")), "{directive}: {policy}");
        }
        assert!(policy.contains(&format!("frame-ancestors {HOST_ORIGIN};")), "{policy}");
        assert!(policy.contains("connect-src 'none'"));
        assert!(policy.starts_with("default-src 'none';"));
    }
}
