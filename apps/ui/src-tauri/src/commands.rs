// The app commands the host page may call for the link, the views and the asks (a stream's
// window has its own two, in stream.rs). Every one is named in commands.txt, which build.rs
// turns into the app manifest, and granted to the `host` window alone in
// capabilities/host.json. A view never reaches them: it runs in a sandboxed frame with no
// IPC, and speaks to the host by postMessage.

use serde_json::Value;
use tauri::{AppHandle, Runtime, State};

use crate::notify::{self, NotifyAsk};
use crate::cophylad::{Link, LinkSnapshot, LinkState};
use crate::views::{StageView, Staged, StagedBase};

/// The link's state now. When the link is already connected the host page just (re)loaded
/// after the hello, so the link reconnects and cophylad re-sends its post-hello snapshot; the
/// page is told `connecting` and learns of the new connection like any other. `audio` is what
/// the page has — a microphone, a speaker, the codecs its web view speaks — and the hello says
/// it from then on.
#[tauri::command]
pub fn cophylad_attach(link: State<'_, Link>, audio: Option<Value>) -> LinkSnapshot {
    if let Some(audio) = audio {
        link.set_audio(&audio);
    }
    let mut snapshot = link.snapshot();
    if snapshot.state == LinkState::Connected {
        link.reattach();
        snapshot.state = LinkState::Connecting;
        snapshot.hello = None;
    }
    snapshot
}

/// Sends one JSON-RPC frame to cophylad. `hello` is the shell's alone: the token is not the
/// page's to present, and a second hello on an open connection is a conflict anyway.
#[tauri::command]
pub fn cophylad_send(link: State<'_, Link>, frame: Value) -> Result<(), String> {
    let Some(obj) = frame.as_object() else {
        return Err("invalid: frame must be a JSON object".into());
    };
    if obj.get("method").and_then(Value::as_str) == Some("hello") {
        return Err("denied: hello is sent by the shell".into());
    }
    link.send(frame.to_string())
}

/// Stages a view's files for the `view` protocol and returns the base URL of the frame.
#[tauri::command]
pub fn view_stage(staged: State<'_, Staged>, view: StageView) -> Result<StagedBase, String> {
    staged.stage(view)
}

/// Shows an OS notification for an open ask, with its options as buttons unless several may
/// be chosen; none while the window has the focus, since the ask is on screen in the view.
#[tauri::command]
pub fn notify_ask<R: Runtime>(app: AppHandle<R>, ask: NotifyAsk) -> Result<(), String> {
    if notify::window_focused(&app) {
        return Ok(());
    }
    notify::show(&app, ask)
}

/// Takes a settled ask's notification down: answered elsewhere, expired or cancelled.
#[tauri::command]
pub fn dismiss_ask(ask: String) {
    notify::dismiss(&ask);
}
