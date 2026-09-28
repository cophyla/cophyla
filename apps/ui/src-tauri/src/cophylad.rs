// The link to cophylad. The credential and the connection it authenticates live here, on the
// native side: the shell reads `[api]` from config.toml and `data/client.token`, opens the
// WebSocket, says `hello`, and pumps frames to and from the host page as Tauri events. The
// token never enters web content. When the connection is refused the same loop starts cophylad
// (detached, no console, stdio to `data/cophylad.log`) and never stops it: cophylad outlives the
// app by design. Installed, the shell runs cophylad from its own version directory with the
// shipped runtime; when another version waits (cophylad staged one, or the launcher already
// rotated `current` past this one) it relaunches through the launcher instead of starting a
// daemon of the wrong version, and while connected to a daemon of another version it asks
// that daemon to stop when idle with `update.apply`, so the versions converge.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::{self, Message};

use crate::install::Install;
use crate::tray;

pub const HOST_LABEL: &str = "host";
pub const EVENT_FRAME: &str = "cophylad:frame";
pub const EVENT_STATE: &str = "cophylad:state";

const HELLO_ID: &str = "hello";
/// Requests the shell makes for itself carry this prefix; their answers are not forwarded to the host page.
const SHELL_ID_PREFIX: &str = "shell:";
pub const APPLY_ID: &str = "shell:apply";
const HELLO_DEADLINE: Duration = Duration::from_secs(5);
const CONNECT_DEADLINE: Duration = Duration::from_secs(5);
const PING_EVERY: Duration = Duration::from_secs(30);
const APPLY_RETRY: Duration = Duration::from_secs(60);
const SPAWN_COOLDOWN: Duration = Duration::from_secs(15);
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
    pub log: PathBuf,
}

impl Paths {
    /// `COPHYLA_HOME`, then `~/.cophyla`: the same rule cophylad applies with no `--home`.
    pub fn resolve() -> Paths {
        let home = std::env::var_os("COPHYLA_HOME")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .or_else(|| dirs::home_dir().map(|h| h.join(".cophyla")))
            .unwrap_or_else(|| PathBuf::from(".cophyla"));
        Paths {
            config: home.join("config.toml"),
            token: home.join("data").join("client.token"),
            log: home.join("data").join("cophylad.log"),
            home,
        }
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

/// Starts cophylad detached: no console of its own, stdout and stderr appended to the log.
/// Nothing ends it when the app exits; the handle is kept only to tell whether it still runs.
pub fn spawn(paths: &Paths, cmd: &CophyladCommand) -> Result<std::process::Child, String> {
    if let Some(dir) = paths.log.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let open_log = || std::fs::OpenOptions::new().create(true).append(true).open(&paths.log);
    let out = open_log().map_err(|e| format!("cannot open {}: {e}", paths.log.display()))?;
    let err = open_log().map_err(|e| format!("cannot open {}: {e}", paths.log.display()))?;
    let mut command = Command::new(&cmd.program);
    command.args(&cmd.args).stdin(Stdio::null()).stdout(Stdio::from(out)).stderr(Stdio::from(err));
    if let Some(cwd) = &cmd.cwd {
        command.current_dir(cwd);
    }
    for (k, v) in &cmd.env {
        command.env(k, v);
    }
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

/// What the commands share with the link task.
pub struct Link {
    tx: mpsc::Sender<String>,
    rx: Mutex<Option<mpsc::Receiver<String>>>,
    snapshot: Mutex<LinkSnapshot>,
    reattach: Notify,
    /// What the hello says of the app's audio: the host page's microphone and speaker, and the
    /// codecs its web view speaks, as it said them at attach; none until it has.
    audio: Mutex<Value>,
}

/// The hello's `audio` before the host page has said what it has: nothing, as before it could.
fn no_audio() -> Value {
    json!({ "in": false, "out": false })
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
        }
    }

    /// The host page's audio for the next hello: `in` and `out` as booleans, `codecs` as the
    /// names cophylad knows and `played` as a boolean, anything else dropped.
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

    /// `update.apply {component: platform}`: the daemon stops when idle and the shell relaunches through the launcher.
    pub fn request_platform_apply(&self) -> Result<(), String> {
        self.send(apply_frame().to_string())
    }

    /// Asks the link to close and reconnect, so cophylad re-sends its post-hello snapshot to a
    /// host page that (re)loaded after the connection was made.
    pub fn reattach(&self) {
        self.reattach.notify_one();
    }

    fn set<R: Runtime>(&self, app: &AppHandle<R>, state: LinkState, hello: Option<Value>, error: Option<String>, url: &str) {
        let snap = LinkSnapshot { state, hello, since: now_ms(), error, url: url.to_string() };
        if let Ok(mut s) = self.snapshot.lock() {
            *s = snap.clone();
        }
        log::info!("link {:?}{}", state, snap.error.as_deref().map(|e| format!(": {e}")).unwrap_or_default());
        let _ = app.emit_to(HOST_LABEL, EVENT_STATE, snap);
    }
}

impl Default for Link {
    fn default() -> Self {
        Link::new()
    }
}

fn apply_frame() -> Value {
    json!({ "jsonrpc": "2.0", "id": APPLY_ID, "method": "update.apply", "params": { "component": "platform" } })
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

fn is_refused(e: &tungstenite::Error) -> bool {
    match e {
        tungstenite::Error::Io(io) => matches!(io.kind(), std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::ConnectionReset),
        _ => false,
    }
}

enum Attempt {
    /// The socket closed after a good hello; reconnect after the backoff.
    Dropped(String),
    /// Could not connect; `refused` says cophylad is not listening.
    Unreachable { refused: bool, error: String },
    /// cophylad answered the hello with an error or closed before answering.
    Refused(String),
}

/// Nothing listens and another version waits: hand over to the launcher rather than start a
/// daemon of this version. The launcher waits for this process, rotates, and starts `current`.
fn relaunch<R: Runtime>(app: &AppHandle<R>, install: &Install, version: &str) -> bool {
    let hidden = app.get_webview_window(HOST_LABEL).and_then(|w| w.is_visible().ok()).map(|v| !v).unwrap_or(false);
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
    let mut rx = link.rx.lock().ok().and_then(|mut r| r.take()).expect("run_link runs once");
    let mut spawner = Spawner { paths: paths.clone(), install: install.clone(), last: None, child: None };
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

        match attempt(&app, &link, &url, &token, &mut rx, install.as_ref()).await {
            Attempt::Dropped(reason) => {
                link.set(&app, LinkState::Disconnected, None, Some(reason), &url);
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

/// A `shell:` response is the shell's own; anything else goes to the host page. `update.state`
/// for the platform also drives the tray item.
fn on_frame<R: Runtime>(app: &AppHandle<R>, text: &str) {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        let _ = app.emit_to(HOST_LABEL, EVENT_FRAME, text);
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
    }
    if v.get("method").and_then(Value::as_str) == Some("update.state") {
        if let Some(params) = v.get("params") {
            if params.get("component").and_then(Value::as_str) == Some("platform") {
                let staged = params.get("staged").and_then(Value::as_str).map(str::to_string);
                tray::set_update(app, staged.as_deref());
            }
        }
    }
    let _ = app.emit_to(HOST_LABEL, EVENT_FRAME, text);
}

async fn attempt<R: Runtime>(app: &AppHandle<R>, link: &Link, url: &str, token: &str, rx: &mut mpsc::Receiver<String>, install: Option<&Install>) -> Attempt {
    let connect = tokio::time::timeout(CONNECT_DEADLINE, tokio_tungstenite::connect_async(url)).await;
    let (mut ws, _) = match connect {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => return Attempt::Unreachable { refused: is_refused(&e), error: e.to_string() },
        Err(_) => return Attempt::Unreachable { refused: false, error: "connect timed out".into() },
    };

    let hello = json!({
        "jsonrpc": "2.0",
        "id": HELLO_ID,
        "method": "hello",
        "params": { "token": token, "kind": "ui", "name": "desktop", "audio": link.audio() },
    });
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
    link.set(app, LinkState::Connected, Some(result.clone()), None, url);

    let mismatch = version_mismatch(&result, install);
    if let Some(why) = &mismatch {
        log::warn!("{why}: asking the daemon to stop when idle");
        if let Err(e) = ws.send(Message::text(apply_frame().to_string())).await {
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
                    if let Err(e) = ws.send(Message::text(text)).await {
                        return Attempt::Dropped(format!("send failed: {e}"));
                    }
                }
                None => return Attempt::Dropped("link closed".into()),
            },
            msg = ws.next() => match msg {
                Some(Ok(Message::Text(text))) => on_frame(app, text.as_str()),
                Some(Ok(Message::Close(frame))) => {
                    return Attempt::Dropped(frame.map(|f| format!("cophylad closed the socket: {} {}", u16::from(f.code), f.reason)).unwrap_or_else(|| "cophylad closed the socket".into()));
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => return Attempt::Dropped(e.to_string()),
                None => return Attempt::Dropped("socket ended".into()),
            },
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
                    if let Err(e) = ws.send(Message::text(apply_frame().to_string())).await {
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
    fn installed_the_daemon_runs_under_the_shipped_runtime_from_the_version_directory() {
        let root = std::env::temp_dir().join(format!("cophyla-cophylad-test-{}", std::process::id()));
        let vdir = root.join("versions").join("0.1.2");
        std::fs::create_dir_all(&vdir).unwrap();
        let install = Install { dir: root.clone(), version_dir: vdir.clone(), launcher: None, version: "0.1.2".into() };
        let paths = Paths { home: root.join("home"), config: root.join("home/config.toml"), token: root.join("home/data/client.token"), log: root.join("home/data/cophylad.log") };
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
