//! `cophyla-mcp`: the `cophyla-agents` MCP server an agent session starts on stdio.
//!   cophyla-mcp <hook.json> <harness> <profileId> [nonce]
//! Each JSON-RPC line on stdin goes to cophylad's `/mcp/agents` with the evidence that ties it
//! to a session (the harness, the profile, the nonce the session was started with, this
//! process's pid and parent, its folder, and the variables the harness sets), and what cophylad
//! answers is written back as one line. The MCP itself, the tools and who is calling are
//! cophylad's to decide. `hook.json` is read again for every line, so a restarted daemon (a new
//! port, a new token) is found without restarting the session; a daemon that is not there is
//! answered for by `fallback`.

mod fallback;
mod http;

use std::env;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{json, Map, Value};

const PATH: &str = "/mcp/agents";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/// A call may wait on another session or another machine; anything else is answered at once.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
const TIMEOUT: Duration = Duration::from_secs(10);

/// The variables a harness sets in its children that tell cophylad which session this is.
const ENV_EVIDENCE: [&str; 4] = ["CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_PID", "CLAUDE_CODE_SESSION_ID", "TETHER_SESSION"];

struct Shim {
    hook: Option<PathBuf>,
    /// The evidence object, serialised once: none of it changes while the process lives.
    evidence: String,
}

/// What became of a line sent to cophylad.
enum Forwarded {
    /// An answer to write.
    Answer(Value),
    /// Nothing to write: cophylad took a notification, or answers nothing to this one.
    Nothing,
    /// cophylad had the message and may have acted on it, but its answer is not JSON. Saying
    /// it was never sent would be wrong, so a request gets an internal error instead.
    Garbled,
    /// cophylad was not reached, or not as itself: the shim answers instead.
    Unreached,
    /// cophylad had the message and gave no whole answer in time. A call may have gone through,
    /// so it is not answered as never sent, which would have the model send it again.
    Lost,
}

impl Shim {
    /// `{port, token}` from `hook.json`, or nothing when it is missing or not what cophylad writes.
    fn daemon(&self) -> Option<(u16, String)> {
        let cfg: Value = serde_json::from_slice(&fs::read(self.hook.as_ref()?).ok()?).ok()?;
        let port = u16::try_from(cfg.get("port")?.as_u64()?).ok().filter(|p| *p != 0)?;
        let token = cfg.get("token")?.as_str()?;
        // a header value: a line break in it would be a header of its own
        if token.chars().any(|c| c.is_control()) {
            return None;
        }
        Some((port, token.to_string()))
    }

    fn forward(&self, line: &[u8], method: &str) -> Forwarded {
        let Some((port, token)) = self.daemon() else { return Forwarded::Unreached };
        // The line went through the parser already: it is one JSON value, sent on as it came.
        let mut body = Vec::with_capacity(self.evidence.len() + line.len() + 32);
        body.extend_from_slice(b"{\"evidence\":");
        body.extend_from_slice(self.evidence.as_bytes());
        body.extend_from_slice(b",\"message\":");
        body.extend_from_slice(line);
        body.push(b'}');
        let timeout = if method == "tools/call" { CALL_TIMEOUT } else { TIMEOUT };
        let response = match http::post(port, &token, PATH, &body, CONNECT_TIMEOUT, timeout) {
            Ok(r) => r,
            Err(http::Failure::NotSent) => return Forwarded::Unreached,
            Err(http::Failure::NoAnswer) => return if method == "tools/call" { Forwarded::Lost } else { Forwarded::Unreached },
        };
        match response.status {
            200 if response.body.iter().all(u8::is_ascii_whitespace) => Forwarded::Nothing,
            200 => serde_json::from_slice(&response.body).map_or(Forwarded::Garbled, Forwarded::Answer),
            202 | 204 => Forwarded::Nothing,
            _ => Forwarded::Unreached,
        }
    }

    /// Answers one line. Lines that are not JSON-RPC requests or notifications (a client's
    /// answer to something, or noise) are dropped without a word.
    fn serve(&self, line: &[u8]) {
        let Ok(message) = serde_json::from_slice::<Value>(line) else { return };
        let Some(method) = message.get("method").and_then(Value::as_str) else { return };
        let answer = match self.forward(line, method) {
            Forwarded::Answer(answer) => Some(answer),
            Forwarded::Nothing => None,
            Forwarded::Garbled => message
                .get("id")
                .filter(|id| !id.is_null())
                .map(|id| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": "cophylad's answer is not JSON" } })),
            Forwarded::Unreached => fallback::answer(&message),
            Forwarded::Lost => fallback::lost(&message),
        };
        if let Some(answer) = answer {
            write_line(&answer);
        }
    }
}

/// One answer, compact (so a pretty body cannot break the framing), as one whole line: the
/// lock is held for the line and its flush, so lines from two threads never interleave. A
/// closed stdout means the client has gone; stdin's end follows.
fn write_line(answer: &Value) {
    let Ok(mut text) = serde_json::to_vec(answer) else { return };
    text.push(b'\n');
    let mut out = io::stdout().lock();
    let _ = out.write_all(&text).and_then(|_| out.flush());
}

fn evidence(harness: &str, profile: &str, nonce: Option<&str>) -> Value {
    let mut e = Map::new();
    e.insert("harness".into(), harness.into());
    e.insert("profile".into(), profile.into());
    if let Some(nonce) = nonce {
        e.insert("nonce".into(), nonce.into());
    }
    e.insert("pid".into(), std::process::id().into());
    if let Some(ppid) = parent_pid() {
        e.insert("ppid".into(), ppid.into());
    }
    if let Ok(cwd) = env::current_dir() {
        e.insert("cwd".into(), cwd.to_string_lossy().into_owned().into());
    }
    let mut vars = Map::new();
    for name in ENV_EVIDENCE {
        if let Some(value) = env::var_os(name).filter(|v| !v.is_empty()) {
            vars.insert(name.into(), value.to_string_lossy().into_owned().into());
        }
    }
    e.insert("env".into(), Value::Object(vars));
    Value::Object(e)
}

#[cfg(unix)]
fn parent_pid() -> Option<u32> {
    Some(std::os::unix::process::parent_id())
}

/// Windows keeps a process's parent only in a snapshot of every process: this one's entry names it.
#[cfg(windows)]
fn parent_pid() -> Option<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};

    let me = std::process::id();
    // SAFETY: the snapshot handle is checked before use and closed once; the entry is a plain
    // struct whose size field is set, as Process32FirstW requires.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut parent = None;
        let mut more = Process32FirstW(snapshot, &mut entry);
        while more != 0 {
            if entry.th32ProcessID == me {
                parent = Some(entry.th32ParentProcessID);
                break;
            }
            more = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        parent
    }
}

#[cfg(not(any(unix, windows)))]
fn parent_pid() -> Option<u32> {
    None
}

fn main() {
    let mut args = env::args_os().skip(1);
    let hook = args.next().map(PathBuf::from);
    let mut text = || args.next().map(|a| a.to_string_lossy().into_owned());
    let harness = text().unwrap_or_default();
    let profile = text().unwrap_or_default();
    let nonce = text().filter(|n| !n.is_empty());
    let evidence = evidence(&harness, &profile, nonce.as_deref());
    let shim = Arc::new(Shim { hook, evidence: evidence.to_string() });

    // Each line is answered on a thread of its own: a call may wait two minutes on another
    // session, and a `ping` or a second call behind it must not wait with it.
    let mut running: Vec<JoinHandle<()>> = Vec::new();
    let mut input = io::stdin().lock();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match input.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
        // .NET writes a byte-order mark ahead of what it pipes into a child, which no JSON parser takes
        let line = buf.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&buf).trim_ascii();
        if line.is_empty() {
            continue;
        }
        let line = line.to_vec();
        running.retain(|t| !t.is_finished());
        let job = {
            let shim = Arc::clone(&shim);
            let line = line.clone();
            move || shim.serve(&line)
        };
        match thread::Builder::new().name("cophyla-mcp-line".into()).spawn(job) {
            Ok(t) => running.push(t),
            // no thread to be had: answer it here, late rather than never
            Err(_) => shim.serve(&line),
        }
    }
    // stdin's end is the session's: what is in flight is still answered before the exit
    for t in running {
        let _ = t.join();
    }
}
