// The document frame (@cophyla/protocol's docframe.ts), served over the `doc` scheme: a small
// page on an origin of its own that a view frames to run an HTML file's scripts, under a policy
// of its own that sandboxes it and lets it reach nothing. A separate origin from the view's
// keeps it out of `views::is_view`, so nothing that answers the view's frame (the dropped files'
// handler) ever answers it. The page and its policy are the protocol's; `docframe.html` and
// `CSP` here are the desktop's copies, which apps/ui/test/docframe.test.ts checks against them.
// Only the host webview is answered. The web view says where the scheme is, as for `view`:
// `http://doc.localhost` on Windows, `doc://localhost` on macOS and Linux.

use std::borrow::Cow;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext, Url};

use crate::views::HOST_LABEL;

pub const SCHEME: &str = "doc";
#[cfg(windows)]
pub const ORIGIN: &str = "http://doc.localhost";
#[cfg(not(windows))]
pub const ORIGIN: &str = "doc://localhost";
/// Where the page is under the origin: the protocol's `DOC_FRAME_PATH`.
pub const PATH: &str = "/doc/frame.html";

const PAGE: &str = include_str!("docframe.html");

/// The page's policy: the protocol's `DOC_FRAME_CSP`.
pub const CSP: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; worker-src blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/// The page's URL, as a view is told it in `host.ready`.
pub fn url() -> String {
    format!("{ORIGIN}{PATH}")
}

/// Whether a URL is on the document frame's origin, compared part by part as `views::is_view` does.
pub fn is_doc(url: &Url) -> bool {
    Url::parse(ORIGIN).is_ok_and(|doc| url.scheme() == doc.scheme() && url.host_str() == doc.host_str() && url.port() == doc.port())
}

fn respond(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_SECURITY_POLICY, CSP)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .body(Cow::Owned(body))
        .expect("static response")
}

/// The `doc` scheme handler: the page at `PATH`, for the host webview only.
pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    if ctx.webview_label() != HOST_LABEL {
        return respond(StatusCode::FORBIDDEN, "text/plain", b"not the host".to_vec());
    }
    if request.uri().path() != PATH {
        return respond(StatusCode::NOT_FOUND, "text/plain", b"not found".to_vec());
    }
    respond(StatusCode::OK, "text/html; charset=utf-8", PAGE.as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_is_on_its_own_origin_not_the_views() {
        let page = Url::parse(&url()).unwrap();
        assert!(is_doc(&page));
        assert!(!crate::views::is_view(&page));
        assert!(!is_doc(&Url::parse(&format!("{}/default/1/index.html", crate::views::ORIGIN)).unwrap()));
        for other in [format!("{ORIGIN}:8080/"), crate::views::HOST_ORIGIN.to_string(), "http://doc.localhost.example.com/".into(), "about:blank".into()] {
            assert!(!is_doc(&Url::parse(&other).unwrap()), "{other}");
        }
    }

    #[test]
    fn the_policy_sandboxes_it_and_lets_it_reach_nothing() {
        assert!(CSP.starts_with("sandbox allow-scripts;"));
        for directive in ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"] {
            assert!(CSP.contains(directive), "{directive}: {CSP}");
        }
        assert!(!CSP.contains("allow-same-origin") && !CSP.contains("allow-top-navigation") && !CSP.contains("allow-popups"));
        assert!(PAGE.contains("ev.source !== parent"));
    }
}
