// The app commands the host page may call for the link, the views and the asks (a stream's
// window has its own, in stream.rs, and a web tab its own, in webtab.rs). Every one is named
// in commands.txt, which build.rs turns into the app manifest, and granted to the `host` window
// alone in capabilities/host.json. A view never reaches them: it runs in a sandboxed frame with no
// IPC, and speaks to the host by postMessage. A command that does more than read a value the
// shell holds is async, so it runs on the async runtime and never on the UI thread.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::cophylad::{check_frame, Link, LinkSnapshot, LinkState};
use crate::notify::{self, NotifyAsk};
use crate::views::{StageView, Staged, StagedBase};

/// What `cophylad_attach` answers: the link's state, and where the page's link socket is when
/// the page asked for one and the shell serves it.
#[derive(Serialize)]
pub struct Attached {
    #[serde(flatten)]
    snapshot: LinkSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    socket: Option<String>,
}

/// The link's state now. When the link is already connected the host page just (re)loaded
/// after the hello, so the link reconnects and cophylad re-sends its post-hello snapshot; the
/// page is told `connecting` and learns of the new connection like any other. With `socket`, the
/// page means to open its link socket (page.rs): the answer says where, and the link reconnects
/// once the socket opens, so the new connection's frames all come over it; without a socket to
/// give, it reconnects now. `audio` is what the page has — a microphone, a speaker, the codecs
/// its web view speaks — and the hello says it from then on; `webTabs`, that the page opens web
/// tabs (webtab.rs), likewise.
#[tauri::command]
pub fn cophylad_attach<R: Runtime>(app: AppHandle<R>, link: State<'_, Link>, audio: Option<Value>, web_tabs: Option<bool>, socket: Option<bool>) -> Attached {
    if let Some(audio) = audio {
        link.set_audio(&audio);
    }
    if let Some(on) = web_tabs {
        link.set_web_tabs(on);
    }
    let socket = socket.unwrap_or(false).then(|| app.try_state::<crate::media::Media>().and_then(|m| m.link_url())).flatten();
    let mut snapshot = link.snapshot();
    if snapshot.state == LinkState::Connected {
        if socket.is_none() {
            link.reattach();
        }
        snapshot.state = LinkState::Connecting;
        snapshot.hello = None;
    }
    Attached { snapshot, socket }
}

/// Sends JSON-RPC frames to cophylad: `frames`, a batch, answered with each one's error or
/// none, in order; or one `frame`, failed with its error. `hello` is refused (`check_frame`).
#[tauri::command]
pub async fn cophylad_send(link: State<'_, Link>, frame: Option<Value>, frames: Option<Vec<Value>>) -> Result<Vec<Option<String>>, String> {
    let send = |frame: &Value| check_frame(frame).and_then(|()| link.send(frame.to_string()));
    match (frame, frames) {
        (_, Some(frames)) => Ok(frames.iter().map(|f| send(f).err()).collect()),
        (Some(frame), None) => send(&frame).map(|()| Vec::new()),
        (None, None) => Err("invalid: no frame".into()),
    }
}

/// Stages a view's files for the `view` protocol and returns the base URL of the frame.
#[tauri::command]
pub async fn view_stage(staged: State<'_, Staged>, view: StageView) -> Result<StagedBase, String> {
    staged.stage(view)
}

/// Shows an OS notification for an open ask, with its options as buttons unless several may
/// be chosen; none while the window has the focus, since the ask is on screen in the view.
#[tauri::command]
pub async fn notify_ask<R: Runtime>(app: AppHandle<R>, ask: NotifyAsk) -> Result<(), String> {
    if notify::window_focused() {
        return Ok(());
    }
    notify::show(&app, ask).await
}

/// Takes a settled ask's notification down: answered elsewhere, expired or cancelled.
#[tauri::command]
pub async fn dismiss_ask(ask: String) -> Result<(), String> {
    notify::dismiss(&ask);
    Ok(())
}

/// How long since the last keyboard or mouse input on this machine, for whether anyone is
/// at it to see an ask's notification; none where the system cannot tell.
#[tauri::command]
pub fn user_idle_ms() -> Option<u64> {
    crate::idle::idle_ms()
}
