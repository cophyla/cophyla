// The link to cophylad. The credential and the connection it authenticates live here, on the
// native side: the shell reads `[api]` from config.toml and `data/client.token`, opens the
// WebSocket, says `hello`, and pumps frames to and from the host page. The
// token never enters web content. When the connection is refused the same loop starts cophylad
// (detached, no console, writing its own `data/cophylad.log`, its stdio to
// `data/cophylad.stderr.log`) and never stops it: cophylad outlives the
// app by design. Installed, the shell runs cophylad from its own version directory with the
// shipped runtime; when another version waits (cophylad staged one, or the launcher already
// rotated `current` past this one) it relaunches through the launcher instead of starting a
// daemon of the wrong version, and while connected to a daemon of another version it asks
// that daemon to stop when idle with `update.apply`, so the versions converge.
//
// The page's side of the link never runs on the UI thread. What comes from cophylad is read as
// a batch, every frame the socket has ready at a wakeup, and goes to the page in order: over
// the page's link socket when it has one open (page.rs), else as one `cophylad:frames` event
// per batch, so a burst costs the UI thread one script rather than one a frame. The link's
// state goes the same way, and so may any event of the shell's (`page_event`). What the page
// sends comes over its socket too, or by the `cophylad_send` command, a batch at a time.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{FutureExt, SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::{self, Message};

use crate::install::Install;
use crate::tray;

pub const HOST_LABEL: &str = "host";
/// The page's frames while it has no link socket: an array of frames, as cophylad sent them, in order.
pub const EVENT_FRAMES: &str = "cophylad:frames";
pub const EVENT_STATE: &str = "cophylad:state";
/// The most frames, and bytes, one batch to the page carries.
const BATCH_FRAMES: usize = 256;
const BATCH_BYTES: usize = 4 << 20;
/// The messages waiting for the page's socket; past them the socket is let go, and the page,
/// which then attaches again, hears what follows as events.
const PAGE_QUEUE: usize = 4096;

const HELLO_ID: &str = "hello";
/// Requests the shell makes for itself carry this prefix; their answers are not forwarded to the host page.
const SHELL_ID_PREFIX: &str = "shell:";
pub const APPLY_ID: &str = "shell:apply";
const HELLO_DEADLINE: Duration = Duration::from_secs(5);
const CONNECT_DEADLINE: Duration = Duration::from_secs(5);
const PING_EVERY: Duration = Duration::from_secs(30);
const APPLY_RETRY: Duration = Duration::from_secs(60);
const SPAWN_COOLDOWN: Duration = Duration::from_secs(15);
/// How long cophylad's port may take connections nothing answers before the shell starts a
/// daemon anyway. A process a stopped daemon left running can hold its listening socket: the
/// port then looks taken, never refused, and only a new daemon frees it (it ends what a stopped
/// daemon left before it listens, or says in its log what holds the port).
const UNANSWERED_FOR: Duration = Duration::from_secs(20);
/// How often a daemon is started again while the port goes on taking connections nobody answers.
const UNANSWERED_RETRY: Duration = Duration::from_secs(60);
const BACKOFF_MIN: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(5);
const OUTBOUND_QUEUE: usize = 256;
const MIN_TOKEN_CHARS: usize = 32;

/// This shell's version; a daemon that says another is not ours.
pub const OWN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The shipped runtime inside the version directory; pinned equal to `BUN_NAMES` in apps/cophylad/src/update/platform.ts.
#[cfg(windows)]
pub const BUN: &str = "bun.exe";
#[cfg(not(windows))]
pub const BUN: &str = "bun";

// --- paths and config ----------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Paths {
    pub home: PathBuf,
    pub config: PathBuf,
    pub token: PathBuf,
    /// The daemon's own log, which it writes and rotates (`COPHYLAD_LOG_FILE`).
    pub log: PathBuf,
    /// Where the daemon's stdout and stderr go: what it never logged itself, a runtime's panic.
    pub stderr: PathBuf,
}

impl Paths {
    /// `COPHYLA_HOME`, then `~/.cophyla`: the same rule cophylad applies with no `--home`.
    pub fn resolve() -> Paths {
        let home = std::env::var_os("COPHYLA_HOME")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .or_else(|| dirs::home_dir().map(|h| h.join(".cophyla")))
            .unwrap_or_else(|| PathBuf::from(".cophyla"));
        Paths::under(home)
    }

    fn under(home: PathBuf) -> Paths {
        let data = home.join("data");
        Paths { config: home.join("config.toml"), token: data.join("client.token"), log: data.join("cophylad.log"), stderr: data.join("cophylad.stderr.log"), home }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Api {
    pub host: String,
    pub port: u16,
}

impl Api {
    pub fn url(&self) -> String {
        format!("ws://{}:{}/ws/client", self.host, self.port)
    }
}

/// `[api] host` and `port` from config.toml, with cophylad's defaults for anything missing or unreadable.
pub fn read_api(paths: &Paths) -> Api {
    let mut api = Api { host: "127.0.0.1".into(), port: 4817 };
    let Ok(text) = std::fs::read_to_string(&paths.config) else { return api };
    // A byte-order mark from Notepad or PowerShell is not TOML; cophylad strips it too.
    let Ok(doc) = text.trim_start_matches('\u{FEFF}').parse::<toml::Table>() else { return api };
    if let Some(section) = doc.get("api").and_then(|v| v.as_table()) {
        if let Some(h) = section.get("host").and_then(|v| v.as_str()) {
            if !h.is_empty() {
                api.host = h.to_string();
            }
        }
        if let Some(p) = section.get("port").and_then(|v| v.as_integer()) {
            if (1..=65535).contains(&p) {
                api.port = p as u16;
            }
        }
    }
    api
}

/// The client token, once cophylad has written one worth presenting.
pub fn read_token(paths: &Paths) -> Option<String> {
    let text = std::fs::read_to_string(&paths.token).ok()?;
    let token = text.trim().to_string();
    (token.chars().count() >= MIN_TOKEN_CHARS).then_some(token)
}

// --- starting cophylad ------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct CophyladCommand {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
}

/// The bun a checkout runs the daemon with: the PATH's, else the one Bun's installer puts in
/// `~/.bun/bin`, since an app the Finder or the Dock starts has only the system's PATH.
fn checkout_bun(path: Option<std::ffi::OsString>, home: Option<PathBuf>, is_file: impl Fn(&Path) -> bool) -> String {
    let name = if cfg!(windows) { "bun.exe" } else { "bun" };
    if path.is_some_and(|p| std::env::split_paths(&p).any(|d| is_file(&d.join(name)))) {
        return "bun".into();
    }
    home.map(|h| h.join(".bun").join("bin").join(name)).filter(|p| is_file(p)).map_or_else(|| "bun".into(), |p| p.to_string_lossy().into_owned())
}

/// `COPHYLAD_COMMAND` (+ `COPHYLAD_ARGS`, whitespace-split) when set; installed, the shipped
/// runtime over the daemon in this version directory, told where the install is; otherwise
/// the daemon from this repository, run by bun on the resolved home.
pub fn resolve_command(paths: &Paths, install: Option<&Install>) -> CophyladCommand {
    let home = paths.home.to_string_lossy().into_owned();
    if let Some(program) = std::env::var("COPHYLAD_COMMAND").ok().filter(|s| !s.trim().is_empty()) {
        let args = std::env::var("COPHYLAD_ARGS")
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_string)
            .collect();
        return CophyladCommand { program, args, cwd: None, env: Vec::new() };
    }
    if let Some(install) = install {
        let cophylad = install.file("cophylad").join("apps").join("cophylad");
        let main = cophylad.join("src").join("main.ts");
        return CophyladCommand {
            program: install.file(BUN).to_string_lossy().into_owned(),
            args: vec!["run".into(), main.to_string_lossy().into_owned(), "--home".into(), home],
            cwd: Some(cophylad),
            env: vec![
                ("COPHYLA_INSTALL_DIR".into(), install.dir.to_string_lossy().into_owned()),
                ("COPHYLA_PLATFORM_DIR".into(), install.version_dir.to_string_lossy().into_owned()),
            ],
        };
    }
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(3).map(Path::to_path_buf).unwrap_or_default();
    let main = repo.join("apps").join("cophylad").join("src").join("main.ts");
    let bun = checkout_bun(std::env::var_os("PATH"), std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from), Path::is_file);
    CophyladCommand { program: bun, args: vec!["run".into(), main.to_string_lossy().into_owned(), "--home".into(), home], cwd: None, env: Vec::new() }
}

/// The daemon's process as the shell starts it, but for its stdio: `cmd`, told to write its own
/// log to `paths.log` (`COPHYLAD_LOG_FILE`, an absolute path), which it rotates itself.
fn daemon_command(paths: &Paths, cmd: &CophyladCommand) -> Command {
    let mut command = Command::new(&cmd.program);
    command.args(&cmd.args);
    if let Some(cwd) = &cmd.cwd {
        command.current_dir(cwd);
    }
    for (k, v) in &cmd.env {
        command.env(k, v);
    }
    command.env("COPHYLAD_LOG_FILE", std::path::absolute(&paths.log).unwrap_or_else(|_| paths.log.clone()));
    command
}

/// Starts cophylad detached: no console of its own, its log its own to write, and its stdout
/// and stderr appended to `paths.stderr`. Nothing ends it when the app exits; the handle is kept
/// only to tell whether it still runs.
pub fn spawn(paths: &Paths, cmd: &CophyladCommand) -> Result<std::process::Child, String> {
    if let Some(dir) = paths.stderr.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let open_log = || std::fs::OpenOptions::new().create(true).append(true).open(&paths.stderr);
    let out = open_log().map_err(|e| format!("cannot open {}: {e}", paths.stderr.display()))?;
    let err = open_log().map_err(|e| format!("cannot open {}: {e}", paths.stderr.display()))?;
    let mut command = daemon_command(paths, cmd);
    command.stdin(Stdio::null()).stdout(Stdio::from(out)).stderr(Stdio::from(err));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        // Its own process group: a signal to the shell's group (launchd ending a login item's
        // session, a terminal's Ctrl+C in a dev run) must not reach the daemon.
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn().map_err(|e| format!("cannot start {} {}: {e}", cmd.program, cmd.args.join(" ")))
}

// --- link state ----------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkState {
    /// cophylad was just started and its socket is not up yet.
    Starting,
    Connecting,
    Connected,
    Disconnected,
    /// cophylad refused the token or the hello.
    Unauthorized,
}

#[derive(Debug, Clone, Serialize)]
pub struct LinkSnapshot {
    pub state: LinkState,
    /// The `hello` result while connected: client, node, protocol and platform versions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hello: Option<Value>,
    /// Milliseconds since the epoch when this state began.
    pub since: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub url: String,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// What the link hands the app beside the page's socket: the page's frames and the link's state
/// as events while the page has no socket, the media server's answers, and a staged update for
/// the tray. The app's handle, or a test's.
pub trait Shell {
    fn emit_frames(&self, frames: Vec<String>);
    fn emit_state(&self, snapshot: &LinkSnapshot);
    fn media_answered(&self, id: &str, frame: &Value);
    fn update_staged(&self, staged: Option<&str>);
}

impl<R: Runtime> Shell for AppHandle<R> {
    fn emit_frames(&self, frames: Vec<String>) {
        let _ = self.emit_to(HOST_LABEL, EVENT_FRAMES, frames);
    }

    fn emit_state(&self, snapshot: &LinkSnapshot) {
        let _ = self.emit_to(HOST_LABEL, EVENT_STATE, snapshot);
    }

    fn media_answered(&self, id: &str, frame: &Value) {
        if let Some(media) = self.try_state::<crate::media::Media>() {
            media.answered(id, frame);
        }
    }

    fn update_staged(&self, staged: Option<&str>) {
        tray::set_update(self, staged);
    }
}

/// The page's link socket while it is open: which one it is, and its queue.
struct Page {
    id: u64,
    tx: mpsc::Sender<String>,
}

/// What the commands share with the link task.
pub struct Link {
    tx: mpsc::Sender<String>,
    rx: Mutex<Option<mpsc::Receiver<String>>>,
    snapshot: Mutex<LinkSnapshot>,
    reattach: Notify,
    /// What the hello says of the app's audio: the host page's microphone and speaker, and the
    /// codecs its web view speaks, as it said them at attach; none until it has.
    audio: Mutex<Value>,
    /// The host page opens web tabs (webtab.rs), as it said at attach: the hello says `webTabs`.
    web_tabs: AtomicBool,
    page: Mutex<Option<Page>>,
    pages: AtomicU64,
}

/// The hello's `audio` before the host page has said what it has: nothing, as before it could.
fn no_audio() -> Value {
    json!({ "in": false, "out": false })
}

/// The link's state as the page's socket carries it: `["state", snapshot]`. The shell's own
/// messages on the socket are arrays, which no frame of cophylad's is.
pub fn state_message(snapshot: &LinkSnapshot) -> String {
    serde_json::to_string(&("state", snapshot)).unwrap_or_default()
}

/// An event of the shell's as the page's socket carries it: `["event", name, payload]`.
pub fn event_message(event: &str, payload: &impl Serialize) -> String {
    serde_json::to_string(&("event", event, payload)).unwrap_or_default()
}

/// A frame the page may send: a JSON object, and not `hello`, which is the shell's alone: the
/// token is not the page's to present, and a second hello on an open connection is a conflict anyway.
pub fn check_frame(frame: &Value) -> Result<(), String> {
    let Some(obj) = frame.as_object() else {
        return Err("invalid: frame must be a JSON object".into());
    };
    if obj.get("method").and_then(Value::as_str) == Some("hello") {
        return Err("denied: hello is sent by the shell".into());
    }
    Ok(())
}

/// Sends an event of the shell's to the host page: over its socket when it has one open, else as a
/// Tauri event.
pub fn page_event<R: Runtime, P: Serialize + Clone>(app: &AppHandle<R>, event: &str, payload: P) {
    let sent = app.try_state::<Link>().is_some_and(|link| link.to_page(vec![event_message(event, &payload)]).is_ok());
    if !sent {
        let _ = app.emit_to(HOST_LABEL, event, payload);
    }
}

impl Link {
    pub fn new() -> Link {
        let (tx, rx) = mpsc::channel(OUTBOUND_QUEUE);
        Link {
            tx,
            rx: Mutex::new(Some(rx)),
            snapshot: Mutex::new(LinkSnapshot { state: LinkState::Connecting, hello: None, since: now_ms(), error: None, url: String::new() }),
            reattach: Notify::new(),
            audio: Mutex::new(no_audio()),
            web_tabs: AtomicBool::new(false),
            page: Mutex::new(None),
            pages: AtomicU64::new(1),
        }
    }

    /// The frames queued for cophylad, for the link task: once.
    pub(crate) fn take_outbound(&self) -> Option<mpsc::Receiver<String>> {
        self.rx.lock().ok().and_then(|mut r| r.take())
    }

    /// A page socket opened: from now on the page's frames, the link's state and the shell's
    /// events go to it, and a socket open before it is let go. Answers its number and its queue.
    pub fn page_opened(&self) -> (u64, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel(PAGE_QUEUE);
        let id = self.pages.fetch_add(1, Ordering::Relaxed);
        *self.page.lock().unwrap_or_else(PoisonError::into_inner) = Some(Page { id, tx });
        (id, rx)
    }

    /// Page socket `id` closed: what follows goes as events, unless another opened since.
    pub fn page_closed(&self, id: u64) {
        let mut page = self.page.lock().unwrap_or_else(PoisonError::into_inner);
        if page.as_ref().is_some_and(|p| p.id == id) {
            *page = None;
        }
    }

    /// Hands messages to the page's socket, in order. Without one, all come back, for the events;
    /// when its queue is full the socket is let go and the rest come back.
    pub fn to_page(&self, messages: Vec<String>) -> Result<(), Vec<String>> {
        let mut page = self.page.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(p) = page.as_ref() else { return Err(messages) };
        let mut rest = messages.into_iter();
        while let Some(m) = rest.next() {
            if let Err(e) = p.tx.try_send(m) {
                let (m, why) = match e {
                    mpsc::error::TrySendError::Full(m) => (m, "its queue is full"),
                    mpsc::error::TrySendError::Closed(m) => (m, "it closed"),
                };
                log::warn!("page socket {}: {why}; the page hears the link as events until it attaches again", p.id);
                *page = None;
                return Err(std::iter::once(m).chain(rest).collect());
            }
        }
        Ok(())
    }

    /// Whether the next hello says the host page opens web tabs: only where the shell has them,
    /// on Windows.
    pub fn set_web_tabs(&self, on: bool) {
        self.web_tabs.store(on && cfg!(windows), Ordering::Relaxed);
    }

    /// The host page's audio for the next hello: `in` and `out` as booleans, `codecs` as the
    /// names cophylad knows, `played` and `asked` as booleans, anything else dropped.
    pub fn set_audio(&self, audio: &Value) {
        let flag = |key: &str| audio.get(key).and_then(Value::as_bool).unwrap_or(false);
        let mut clean = json!({ "in": flag("in"), "out": flag("out") });
        if let Some(codecs) = audio.get("codecs").and_then(Value::as_array) {
            let known: Vec<Value> = codecs.iter().filter(|c| matches!(c.as_str(), Some("opus" | "pcm"))).cloned().collect();
            if !known.is_empty() {
                clean["codecs"] = Value::Array(known);
            }
        }
        if flag("played") {
            clean["played"] = Value::Bool(true);
        }
        if flag("asked") {
            clean["asked"] = Value::Bool(true);
        }
        if let Ok(mut a) = self.audio.lock() {
            *a = clean;
        }
    }

    fn audio(&self) -> Value {
        self.audio.lock().map(|a| a.clone()).unwrap_or_else(|_| no_audio())
    }

    pub fn snapshot(&self) -> LinkSnapshot {
        self.snapshot.lock().map(|s| s.clone()).unwrap_or_else(|p| p.into_inner().clone())
    }

    pub fn is_connected(&self) -> bool {
        self.snapshot().state == LinkState::Connected
    }

    /// Queues a frame for the socket; `unavailable` when the link is down or the queue is full.
    pub fn send(&self, frame: String) -> Result<(), String> {
        if !self.is_connected() {
            return Err("unavailable: not connected to cophylad".into());
        }
        self.tx.try_send(frame).map_err(|e| match e {
            mpsc::error::TrySendError::Full(_) => "unavailable: outbound queue is full".to_string(),
            mpsc::error::TrySendError::Closed(_) => "unavailable: link task is gone".to_string(),
        })
    }

    /// The tray's Restart to update: `update.apply {component: platform, whenIdle}`, so the daemon
    /// stops as soon as nothing waits on it (the view's note says on what meanwhile) and the shell
    /// relaunches through the launcher.
    pub fn request_platform_apply(&self) -> Result<(), String> {
        self.send(apply_frame(true).to_string())
    }

    /// Asks the link to close and reconnect, so cophylad re-sends its post-hello snapshot to a
    /// host page that (re)loaded after the connection was made.
    pub fn reattach(&self) {
        self.reattach.notify_one();
    }

    pub(crate) fn set<S: Shell + ?Sized>(&self, shell: &S, state: LinkState, hello: Option<Value>, error: Option<String>, url: &str) {
        let snap = LinkSnapshot { state, hello, since: now_ms(), error, url: url.to_string() };
        if let Ok(mut s) = self.snapshot.lock() {
            *s = snap.clone();
        }
        log::info!("link {:?}{}", state, snap.error.as_deref().map(|e| format!(": {e}")).unwrap_or_default());
        if self.to_page(vec![state_message(&snap)]).is_err() {
            shell.emit_state(&snap);
        }
    }

    /// Frames for the page, in order: to its socket, or as one event.
    fn deliver<S: Shell + ?Sized>(&self, shell: &S, frames: Vec<String>) {
        if frames.is_empty() {
            return;
        }
        if let Err(rest) = self.to_page(frames) {
            shell.emit_frames(rest);
        }
    }
}

impl Default for Link {
    fn default() -> Self {
        Link::new()
    }
}

/// `update.apply` for the platform: `when_idle` for the user's request, which waits for an idle
/// daemon; without it for the version check, which asks again every minute anyway.
fn apply_frame(when_idle: bool) -> Value {
    let params = if when_idle { json!({ "component": "platform", "whenIdle": true }) } else { json!({ "component": "platform" }) };
    json!({ "jsonrpc": "2.0", "id": APPLY_ID, "method": "update.apply", "params": params })
}

// --- the loop --------------------------------------------------------------------------------

struct Spawner {
    paths: Paths,
    install: Option<Install>,
    last: Option<Instant>,
    /// The daemon this shell started last, while it may still be starting.
    child: Option<std::process::Child>,
}

impl Spawner {
    /// Starts cophylad unless the one started last still runs, or one was started within the
    /// cooldown. A daemon still running is waited for however long it takes to answer (a first
    /// start on a Mac can wait on a permission prompt): a second one would race it for the
    /// store and the token. Returns what happened, for the snapshot.
    fn maybe(&mut self) -> Result<Option<u32>, String> {
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(None) => return Ok(None),
                // gone, and reaped
                _ => self.child = None,
            }
        }
        if let Some(last) = self.last {
            if last.elapsed() < SPAWN_COOLDOWN {
                return Ok(None);
            }
        }
        self.last = Some(Instant::now());
        let cmd = resolve_command(&self.paths, self.install.as_ref());
        log::info!("starting cophylad: {} {}", cmd.program, cmd.args.join(" "));
        let child = spawn(&self.paths, &cmd)?;
        let pid = child.id();
        self.child = Some(child);
        Ok(Some(pid))
    }
}

/// Whether the port has taken connections that nothing answered for long enough that a daemon
/// should be started anyway.
#[derive(Default)]
struct Unanswered {
    since: Option<Instant>,
    tried: Option<Instant>,
}

impl Unanswered {
    /// One attempt's outcome: `true` when the connection was taken and never answered. Says
    /// whether to start a daemon now.
    fn note(&mut self, unanswered: bool, now: Instant) -> bool {
        if !unanswered {
            self.since = None;
            return false;
        }
        let since = *self.since.get_or_insert(now);
        if now.duration_since(since) < UNANSWERED_FOR {
            return false;
        }
        if self.tried.is_some_and(|t| now.duration_since(t) < UNANSWERED_RETRY) {
            return false;
        }
        self.tried = Some(now);
        true
    }
}

fn is_refused(e: &tungstenite::Error) -> bool {
    match e {
        tungstenite::Error::Io(io) => matches!(io.kind(), std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::ConnectionReset),
        _ => false,
    }
}

pub(crate) enum Attempt {
    /// The socket closed after a good hello; reconnect after the backoff.
    Dropped(String),
    /// Could not connect; `refused` says cophylad is not listening.
    Unreachable { refused: bool, error: String },
    /// The port took the connection and nothing answered it.
    Unanswered,
    /// cophylad answered the hello with an error or closed before answering.
    Refused(String),
}

/// Nothing listens and another version waits: hand over to the launcher rather than start a
/// daemon of this version. The launcher waits for this process, rotates, and starts `current`.
fn relaunch<R: Runtime>(app: &AppHandle<R>, install: &Install, version: &str) -> bool {
    let hidden = app.get_window(HOST_LABEL).and_then(|w| w.is_visible().ok()).map(|v| !v).unwrap_or(false);
    match install.relaunch(hidden, false) {
        Ok(()) => {
            log::info!("relaunching through the launcher: version {version} waits (this is {OWN_VERSION})");
            app.exit(0);
            true
        }
        Err(e) => {
            log::warn!("cannot start the launcher {}: {e}", install.launcher.as_deref().map(|p| p.display().to_string()).unwrap_or_else(|| "(unknown)".into()));
            false
        }
    }
}

pub async fn run_link<R: Runtime>(app: AppHandle<R>) {
    let link = app.state::<Link>();
    let paths = Paths::resolve();
    let install = Install::detect();
    log::info!("shell {OWN_VERSION}, {}", crate::install::describe(install.as_ref()));
    let mut rx = link.take_outbound().expect("run_link runs once");
    let mut spawner = Spawner { paths: paths.clone(), install: install.clone(), last: None, child: None };
    let mut unanswered = Unanswered::default();
    let mut backoff = BACKOFF_MIN;

    loop {
        let api = read_api(&paths);
        let url = api.url();
        let Some(token) = read_token(&paths) else {
            // No token yet: cophylad has never run on this home. Start it and wait for the file.
            if let Some(v) = install.as_ref().and_then(|i| i.newer_waiting()) {
                if relaunch(&app, install.as_ref().unwrap(), &v) {
                    return;
                }
            }
            match spawner.maybe() {
                Ok(_) => link.set(&app, LinkState::Starting, None, None, &url),
                Err(e) => link.set(&app, LinkState::Disconnected, None, Some(e), &url),
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(BACKOFF_MAX);
            continue;
        };
        link.set(&app, LinkState::Connecting, None, None, &url);

        let outcome = attempt(&app, &link, &url, &token, &mut rx, install.as_ref()).await;
        let start_anyway = unanswered.note(matches!(outcome, Attempt::Unanswered), Instant::now());
        match outcome {
            Attempt::Unanswered => {
                let held = "cophylad's port takes connections but nothing answers them";
                if start_anyway {
                    log::warn!("{held}: starting cophylad, which frees the port of what a stopped daemon left running");
                    match spawner.maybe() {
                        Ok(Some(pid)) => link.set(&app, LinkState::Starting, None, Some(format!("{held}; started cophylad (pid {pid})")), &url),
                        Ok(None) => link.set(&app, LinkState::Disconnected, None, Some(held.into()), &url),
                        Err(e) => link.set(&app, LinkState::Disconnected, None, Some(e), &url),
                    }
                } else {
                    link.set(&app, LinkState::Disconnected, None, Some(held.into()), &url);
                }
            }
            Attempt::Dropped(reason) => {
                link.set(&app, LinkState::Disconnected, None, Some(reason), &url);
                // cophylad closes the web tabs of a host that goes, and so does the shell
                crate::webtab::close_all(&app);
                // the answers to the media server's reads went with the connection
                if let Some(media) = app.try_state::<crate::media::Media>() {
                    media.link_lost();
                }
                backoff = BACKOFF_MIN;
            }
            Attempt::Unreachable { refused, error } => {
                if refused {
                    if let Some(v) = install.as_ref().and_then(|i| i.newer_waiting()) {
                        link.set(&app, LinkState::Disconnected, None, Some(format!("restarting into version {v}")), &url);
                        if relaunch(&app, install.as_ref().unwrap(), &v) {
                            return;
                        }
                    }
                    match spawner.maybe() {
                        Ok(Some(pid)) => link.set(&app, LinkState::Starting, None, Some(format!("started cophylad (pid {pid})")), &url),
                        Ok(None) => link.set(&app, LinkState::Starting, None, None, &url),
                        Err(e) => link.set(&app, LinkState::Disconnected, None, Some(e), &url),
                    }
                } else {
                    link.set(&app, LinkState::Disconnected, None, Some(error), &url);
                }
            }
            Attempt::Refused(reason) => {
                link.set(&app, LinkState::Unauthorized, None, Some(reason), &url);
                backoff = BACKOFF_MAX;
            }
        }
        // Frames queued while the link was down would arrive out of context; drop them.
        while rx.try_recv().is_ok() {}
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// The daemon runs another version than this shell, or the launcher already rotated
/// `current` past us: ask it to stop when idle so the versions converge at the next start.
fn version_mismatch(hello: &Value, install: Option<&Install>) -> Option<String> {
    let install = install?;
    let daemon = hello.get("platformVersion").and_then(Value::as_str).unwrap_or("?");
    if daemon != OWN_VERSION {
        return Some(format!("daemon runs {daemon}, shell is {OWN_VERSION}"));
    }
    match install.current() {
        Some(c) if c != install.version => Some(format!("current pointer names {c}, shell is {OWN_VERSION}")),
        _ => None,
    }
}

/// A `shell:` response is the shell's own, and a `media:` one the media server's (media.rs), which
/// reads the pieces it streams itself so they never pass through the page; anything else goes to
/// the host page, in `page`. `update.state` for the platform also drives the tray item.
fn on_frame<S: Shell + ?Sized>(shell: &S, text: String, page: &mut Vec<String>) {
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        page.push(text);
        return;
    };
    if let Some(id) = v.get("id").and_then(Value::as_str) {
        if id.starts_with(SHELL_ID_PREFIX) {
            match v.get("error") {
                Some(err) => log::info!("{id}: {}", err.get("data").and_then(|d| d.get("message")).or_else(|| err.get("message")).and_then(Value::as_str).unwrap_or("error")),
                None => log::info!("{id}: ok"),
            }
            return;
        }
        if id.starts_with(crate::media::RPC_PREFIX) {
            shell.media_answered(id, &v);
            return;
        }
    }
    if v.get("method").and_then(Value::as_str) == Some("update.state") {
        if let Some(params) = v.get("params") {
            if params.get("component").and_then(Value::as_str) == Some("platform") {
                shell.update_staged(params.get("staged").and_then(Value::as_str));
            }
        }
    }
    page.push(text);
}

/// Why a read off cophylad's socket ends the connection; none for a frame or a control message.
fn ending(msg: Option<Result<Message, tungstenite::Error>>, shell: &(impl Shell + ?Sized), page: &mut Vec<String>) -> Option<Attempt> {
    match msg {
        Some(Ok(Message::Text(text))) => {
            on_frame(shell, text.as_str().to_owned(), page);
            None
        }
        Some(Ok(Message::Close(frame))) => Some(Attempt::Dropped(frame.map(|f| format!("cophylad closed the socket: {} {}", u16::from(f.code), f.reason)).unwrap_or_else(|| "cophylad closed the socket".into()))),
        Some(Ok(_)) => None,
        Some(Err(e)) => Some(Attempt::Dropped(e.to_string())),
        None => Some(Attempt::Dropped("socket ended".into())),
    }
}

/// The shell's hello: the token, the app's audio as the page said it, and `webTabs` where the
/// page opens web tabs; nothing else the page said gets into it.
fn hello_frame(token: &str, audio: Value, web_tabs: bool) -> Value {
    let mut params = json!({ "token": token, "kind": "ui", "name": "desktop", "audio": audio });
    if web_tabs {
        params["webTabs"] = Value::Bool(true);
    }
    json!({ "jsonrpc": "2.0", "id": HELLO_ID, "method": "hello", "params": params })
}

/// One connection to cophylad: the hello, then frames both ways until it ends. What comes in is
/// read a batch at a wakeup (every frame the socket has ready, `BATCH_FRAMES` and `BATCH_BYTES` at
/// most) and handed to the page as one; what goes out is written likewise, flushed once.
pub(crate) async fn attempt<S: Shell + ?Sized>(shell: &S, link: &Link, url: &str, token: &str, rx: &mut mpsc::Receiver<String>, install: Option<&Install>) -> Attempt {
    let connect = tokio::time::timeout(CONNECT_DEADLINE, tokio_tungstenite::connect_async(url)).await;
    let (mut ws, _) = match connect {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => return Attempt::Unreachable { refused: is_refused(&e), error: e.to_string() },
        Err(_) => return Attempt::Unanswered,
    };

    let hello = hello_frame(token, link.audio(), link.web_tabs.load(Ordering::Relaxed));
    if let Err(e) = ws.send(Message::text(hello.to_string())).await {
        return Attempt::Unreachable { refused: false, error: format!("hello not sent: {e}") };
    }
    let deadline = tokio::time::sleep(HELLO_DEADLINE);
    tokio::pin!(deadline);
    let result = loop {
        tokio::select! {
            _ = &mut deadline => return Attempt::Refused("no answer to hello within 5 s".into()),
            msg = ws.next() => match msg {
                Some(Ok(Message::Text(text))) => {
                    let v: Value = match serde_json::from_str(&text) { Ok(v) => v, Err(_) => continue };
                    if v.get("id").and_then(Value::as_str) != Some(HELLO_ID) { continue; }
                    if let Some(err) = v.get("error") {
                        let message = err.get("data").and_then(|d| d.get("message")).or_else(|| err.get("message")).and_then(Value::as_str).unwrap_or("hello refused");
                        return Attempt::Refused(message.to_string());
                    }
                    break v.get("result").cloned().unwrap_or(Value::Null);
                }
                Some(Ok(Message::Close(frame))) => {
                    let reason = frame.map(|f| format!("closed {} {}", u16::from(f.code), f.reason)).unwrap_or_else(|| "closed".into());
                    return Attempt::Refused(reason);
                }
                Some(Ok(_)) => continue,
                Some(Err(e)) => return Attempt::Refused(e.to_string()),
                None => return Attempt::Refused("closed before answering hello".into()),
            },
        }
    };
    link.set(shell, LinkState::Connected, Some(result.clone()), None, url);

    let mismatch = version_mismatch(&result, install);
    if let Some(why) = &mismatch {
        log::warn!("{why}: asking the daemon to stop when idle");
        if let Err(e) = ws.send(Message::text(apply_frame(false).to_string())).await {
            return Attempt::Dropped(format!("send failed: {e}"));
        }
    }

    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    let mut apply = tokio::time::interval(APPLY_RETRY);
    apply.tick().await;
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(text) => {
                    let mut sent = ws.feed(Message::text(text)).await;
                    let mut n = 1;
                    while sent.is_ok() && n < BATCH_FRAMES {
                        let Ok(text) = rx.try_recv() else { break };
                        sent = ws.feed(Message::text(text)).await;
                        n += 1;
                    }
                    if let Err(e) = sent.and(ws.flush().await) {
                        return Attempt::Dropped(format!("send failed: {e}"));
                    }
                }
                None => return Attempt::Dropped("link closed".into()),
            },
            msg = ws.next() => {
                let mut page = Vec::new();
                let mut end = ending(msg, shell, &mut page);
                let mut bytes: usize = page.iter().map(String::len).sum();
                while end.is_none() && page.len() < BATCH_FRAMES && bytes < BATCH_BYTES {
                    let Some(msg) = ws.next().now_or_never() else { break };
                    let before = page.len();
                    end = ending(msg, shell, &mut page);
                    bytes += page[before..].iter().map(String::len).sum::<usize>();
                }
                link.deliver(shell, page);
                if let Some(end) = end {
                    return end;
                }
            }
            _ = link.reattach.notified() => {
                let _ = ws.close(None).await;
                return Attempt::Dropped("reattaching".into());
            }
            _ = ping.tick() => {
                if let Err(e) = ws.send(Message::Ping(Vec::new().into())).await {
                    return Attempt::Dropped(format!("ping failed: {e}"));
                }
            }
            _ = apply.tick() => {
                // The rule re-evaluated, so a rotation that happened while connected is seen too.
                if let Some(why) = version_mismatch(&result, install) {
                    log::info!("{why}: asking again");
                    if let Err(e) = ws.send(Message::text(apply_frame(false).to_string())).await {
                        return Attempt::Dropped(format!("send failed: {e}"));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_port_that_takes_connections_nobody_answers_starts_a_daemon_after_a_while_and_then_once_a_minute() {
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let mut u = Unanswered::default();
        assert!(!u.note(true, at(0)));
        assert!(!u.note(true, at(10)));
        assert!(u.note(true, at(20)));
        assert!(!u.note(true, at(30)));
        assert!(!u.note(true, at(79)));
        assert!(u.note(true, at(80)));
        // any answer, or a refusal, starts the count again
        assert!(!u.note(false, at(81)));
        assert!(!u.note(true, at(82)));
        assert!(!u.note(true, at(101)));
        assert!(u.note(true, at(142)));
    }

    #[test]
    fn installed_the_daemon_runs_under_the_shipped_runtime_from_the_version_directory() {
        let root = std::env::temp_dir().join(format!("cophyla-cophylad-test-{}", std::process::id()));
        let vdir = root.join("versions").join("0.1.2");
        std::fs::create_dir_all(&vdir).unwrap();
        let install = Install { dir: root.clone(), version_dir: vdir.clone(), launcher: None, version: "0.1.2".into() };
        let paths = Paths::under(root.join("home"));
        std::env::remove_var("COPHYLAD_COMMAND");
        let cmd = resolve_command(&paths, Some(&install));
        assert_eq!(Path::new(&cmd.program), vdir.join(BUN));
        assert_eq!(cmd.args[0], "run");
        assert!(cmd.args[1].ends_with("main.ts"));
        assert_eq!(cmd.args[2], "--home");
        assert_eq!(cmd.cwd.as_deref(), Some(vdir.join("cophylad").join("apps").join("cophylad").as_path()));
        assert!(cmd.env.iter().any(|(k, v)| k == "COPHYLA_INSTALL_DIR" && Path::new(v) == root));
        let checkout = resolve_command(&paths, None);
        assert!(checkout.program == "bun" || Path::new(&checkout.program).ends_with(Path::new(".bun").join("bin").join(BUN)), "{}", checkout.program);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_daemon_writes_its_own_log_and_its_stdio_goes_beside_it() {
        let paths = Paths::under(PathBuf::from("rel-home"));
        assert_eq!(paths.log, Path::new("rel-home").join("data").join("cophylad.log"));
        assert_eq!(paths.stderr, Path::new("rel-home").join("data").join("cophylad.stderr.log"));
        let cmd = CophyladCommand { program: "bun".into(), args: vec!["run".into()], cwd: None, env: vec![("A".into(), "1".into())] };
        let command = daemon_command(&paths, &cmd);
        let env: Vec<(String, String)> = command.get_envs().filter_map(|(k, v)| Some((k.to_string_lossy().into_owned(), v?.to_string_lossy().into_owned()))).collect();
        let file = env.iter().find(|(k, _)| k == "COPHYLAD_LOG_FILE").map(|(_, v)| PathBuf::from(v)).expect("COPHYLAD_LOG_FILE");
        assert!(file.is_absolute(), "{}", file.display());
        assert!(file.ends_with(Path::new("rel-home").join("data").join("cophylad.log")), "{}", file.display());
        assert!(env.contains(&("A".into(), "1".into())));
    }

    #[test]
    fn the_hello_says_web_tabs_only_where_the_page_opens_them_on_windows() {
        let link = Link::new();
        link.set_audio(&json!({ "in": true, "out": true, "asked": true, "webTabs": true }));
        let plain = hello_frame("t", link.audio(), link.web_tabs.load(Ordering::Relaxed));
        assert_eq!(plain["params"], json!({ "token": "t", "kind": "ui", "name": "desktop", "audio": { "in": true, "out": true, "asked": true } }));
        link.set_web_tabs(true);
        let tabs = hello_frame("t", link.audio(), link.web_tabs.load(Ordering::Relaxed));
        assert_eq!(tabs["params"].get("webTabs"), cfg!(windows).then_some(&Value::Bool(true)));
        assert_eq!(tabs["method"], "hello");
        link.set_web_tabs(false);
        assert!(hello_frame("t", link.audio(), link.web_tabs.load(Ordering::Relaxed))["params"].get("webTabs").is_none());
    }

    #[test]
    fn a_checkout_started_from_the_finder_finds_bun_where_its_installer_put_it() {
        let installed = PathBuf::from("/Users/u").join(".bun").join("bin").join(BUN);
        let has = |p: &Path| p == installed.as_path() || p == Path::new("/opt/bin").join(BUN).as_path();
        let path = |dirs: &[&str]| std::env::join_paths(dirs).ok();
        assert_eq!(checkout_bun(path(&["/opt/bin", "/usr/bin"]), Some(PathBuf::from("/Users/u")), has), "bun");
        assert_eq!(checkout_bun(path(&["/usr/bin", "/bin"]), Some(PathBuf::from("/Users/u")), has), installed.to_string_lossy());
        assert_eq!(checkout_bun(path(&["/usr/bin"]), Some(PathBuf::from("/Users/v")), has), "bun");
        assert_eq!(checkout_bun(None, None, has), "bun");
    }
}
