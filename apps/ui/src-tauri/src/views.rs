// Serving a staged view to the host page's sandboxed frame over `http://view.localhost`.
//
// The host fetches a view with `view.get` on its cophylad connection and hands the files to
// `view_stage`, which keeps them in memory keyed by id and version. The frame then loads
// `http://view.localhost/<id>/<version>/<entry>` with `sandbox="allow-scripts allow-forms"`,
// so the document runs on an opaque origin: no storage, no IPC, and with the headers below no
// network either, nor anywhere for a form to submit to. Only the `host` webview is answered.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine as _;
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext};

pub const SCHEME: &str = "view";
pub const ORIGIN: &str = "http://view.localhost";
pub const HOST_LABEL: &str = "host";

/// What the frame may do. Scripts, styles, images and fonts come only from this origin;
/// there is no connect-src, so `fetch` and sockets are refused before any request leaves
/// the web view; only the app's own page may embed it (`frame-ancestors` is filled in with
/// the host's origin: `http://tauri.localhost`, or `tauri dev`'s server when configured).
const CSP: &str = "default-src 'none'; script-src http://view.localhost; style-src http://view.localhost 'unsafe-inline'; img-src http://view.localhost data:; font-src http://view.localhost; connect-src 'none'; frame-ancestors {host}; base-uri 'none'; form-action 'none'";

pub const HOST_ORIGIN: &str = "http://tauri.localhost";

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
    /// `http://view.localhost/<id>/<version>/`; the entry is appended by the host.
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
        .header(header::CONTENT_SECURITY_POLICY, CSP.replace("{host}", host_origin))
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
