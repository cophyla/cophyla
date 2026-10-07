//! The built shim over pipes, as a harness runs it: its own answers when cophylad is not there,
//! `hook.json` read again for every line, cophylad's answers passed on as one line each, and a
//! slow call that never holds up a `ping` behind it. cophylad is played by a small HTTP server.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

const DECLARED: &str = include_str!("../../../packages/protocol/agent-tools.json");
const WAIT: Duration = Duration::from_secs(15);
const QUIET: Duration = Duration::from_millis(700);

/// A temporary folder of the test's own, removed when it ends.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("cophyla-mcp-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The shim, running, with its stdout read into a channel line by line. Killed when dropped,
/// so a failing test leaves nothing behind.
struct Shim {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
}

impl Shim {
    fn start(args: &[&str], env: &[(&str, &str)]) -> Self {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_cophyla-mcp"));
        cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        for name in ["CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_PID", "CLAUDE_CODE_SESSION_ID", "TETHER_SESSION"] {
            cmd.env_remove(name);
        }
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().unwrap();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Shim { child, stdin, lines }
    }

    fn send(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(line.as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
    }

    fn next(&self) -> Value {
        let line = self.lines.recv_timeout(WAIT).expect("an answer");
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("not one JSON line ({e}): {line}"))
    }

    /// The next `n` answers, by id: lines are answered concurrently, so in any order.
    fn answers(&self, n: usize) -> HashMap<String, Value> {
        (0..n).map(|_| self.next()).map(|a| (a["id"].to_string(), a)).collect()
    }

    fn assert_quiet(&self) {
        if let Ok(line) = self.lines.recv_timeout(QUIET) {
            panic!("an answer nothing asked for: {line}");
        }
    }

    /// Closes stdin and waits for the exit, which must be a clean one.
    fn finish(mut self) {
        drop(self.stdin.take());
        let status = self.child.wait().unwrap();
        assert!(status.success(), "the shim exited {status}");
    }
}

impl Drop for Shim {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn write_hook(path: &Path, port: u16, token: &str) {
    fs::write(path, json!({ "port": port, "token": token }).to_string() + "\n").unwrap();
}

/// A port nothing listens on: one the system gave out and took back.
fn dead_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// One request as the fake cophylad saw it.
#[derive(Clone, Debug)]
struct Seen {
    request_line: String,
    headers: HashMap<String, String>,
    body: Value,
}

/// cophylad, played: it records each request and answers by the message's method.
/// `tools/call` waits 1.5 s; `silent/*` gets a 204, `empty/*` a 200 with no body, `fail/*` a
/// 500; `ping` is answered chunked; anything else gets a pretty-printed result naming itself.
struct Daemon {
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Daemon {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&seen);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let record = Arc::clone(&record);
                thread::spawn(move || serve(stream, record));
            }
        });
        Daemon { port, seen }
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

fn serve(stream: TcpStream, record: Arc<Mutex<Vec<Seen>>>) {
    let mut reader = BufReader::new(&stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).unwrap();
    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        let (k, v) = line.split_once(':').unwrap();
        headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
    }
    let length: usize = headers["content-length"].parse().unwrap();
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    let body: Value = serde_json::from_slice(&body).unwrap();
    record.lock().unwrap().push(Seen { request_line: request_line.trim_end().to_string(), headers, body: body.clone() });

    let message = &body["message"];
    let method = message["method"].as_str().unwrap_or("").to_string();
    let answer = json!({ "jsonrpc": "2.0", "id": message["id"], "result": { "from": "daemon", "method": method } });
    let mut out = &stream;
    let response = if method == "tools/call" {
        thread::sleep(Duration::from_millis(1500));
        let text = serde_json::to_string_pretty(&answer).unwrap();
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{text}", text.len())
    } else if method.starts_with("silent/") {
        "HTTP/1.1 204 No Content\r\n\r\n".to_string()
    } else if method.starts_with("empty/") {
        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_string()
    } else if method.starts_with("fail/") {
        "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 4\r\n\r\noops".to_string()
    } else if method == "ping" {
        let text = answer.to_string();
        let (a, b) = text.split_at(text.len() / 2);
        format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{a}\r\n{:x}\r\n{b}\r\n0\r\n\r\n", a.len(), b.len())
    } else {
        let text = serde_json::to_string_pretty(&answer).unwrap();
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{text}", text.len())
    };
    let _ = out.write_all(response.as_bytes());
}

#[test]
fn with_no_daemon_the_shim_answers_from_the_tools_it_was_built_with() {
    let scratch = Scratch::new("fallback");
    let missing = scratch.0.join("no-such-hook.json");
    let mut shim = Shim::start(&[missing.to_str().unwrap(), "claude", "prof_test"], &[]);
    let declared: Value = serde_json::from_str(DECLARED).unwrap();

    // led by the byte-order mark a .NET client writes first
    shim.send("\u{feff}{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{}}}");
    shim.send(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
    shim.send(r#"{"jsonrpc":"2.0","id":"two","method":"tools/list"}"#);
    shim.send(r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"send_message","arguments":{"to":"x","message":"hi"}}}"#);
    shim.send(r#"{"jsonrpc":"2.0","id":4,"method":"ping"}"#);
    shim.send(r#"{"jsonrpc":"2.0","id":5,"method":"resources/list"}"#);
    shim.send(r#"{"jsonrpc":"2.0","id":6,"method":"initialize","params":{}}"#);
    // neither a request nor a notification: not JSON, and a client's answer
    shim.send("not json");
    shim.send(r#"{"jsonrpc":"2.0","id":7,"result":{}}"#);
    shim.send("   ");

    let answers = shim.answers(6);
    let init = &answers["1"];
    assert_eq!(init["jsonrpc"], "2.0");
    assert_eq!(init["id"], 1);
    assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(init["result"]["capabilities"], json!({ "tools": {} }));
    assert_eq!(init["result"]["serverInfo"], json!({ "name": "cophyla-agents", "version": env!("CARGO_PKG_VERSION") }));
    assert_eq!(init["result"]["instructions"], declared["instructions"]);
    assert_eq!(answers["6"]["result"]["protocolVersion"], "2025-06-18");

    let list = &answers["\"two\""];
    assert_eq!(list["id"], "two");
    assert_eq!(list["result"]["tools"], declared["tools"]);

    let call = &answers["3"];
    assert_eq!(call["result"]["isError"], true);
    assert_eq!(call["result"]["content"], json!([{ "type": "text", "text": "Cophyla isn't running on this machine; nothing was sent." }]));

    assert_eq!(answers["4"], json!({ "jsonrpc": "2.0", "id": 4, "result": {} }));
    assert_eq!(answers["5"], json!({ "jsonrpc": "2.0", "id": 5, "error": { "code": -32601, "message": "method not found: resources/list" } }));

    shim.assert_quiet();
    shim.finish();
}

#[test]
fn hook_json_is_read_again_for_every_line() {
    let scratch = Scratch::new("reread");
    let hook = scratch.0.join("hook.json");
    let daemon = Daemon::start();
    write_hook(&hook, dead_port(), "stale");
    let mut shim = Shim::start(
        &[hook.to_str().unwrap(), "codex", "prof_test", "nonce-1"],
        &[("TETHER_SESSION", "tether-7"), ("CLAUDE_PID", ""), ("CLAUDE_CODE_SESSION_ID", "sess-9")],
    );

    // cophylad is not where hook.json says: the shim answers
    shim.send(r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_agents","arguments":{}}}"#);
    let fallen = shim.next();
    assert_eq!(fallen["id"], 1);
    assert_eq!(fallen["result"]["isError"], true);
    assert!(daemon.seen().is_empty());

    // cophylad restarted on another port with another token: the next line finds it
    write_hook(&hook, daemon.port, "secret");
    shim.send(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);
    assert_eq!(shim.next(), json!({ "jsonrpc": "2.0", "id": 2, "result": { "from": "daemon", "method": "tools/list" } }));

    let seen = daemon.seen();
    assert_eq!(seen.len(), 1);
    let request = &seen[0];
    assert_eq!(request.request_line, "POST /mcp/agents HTTP/1.1");
    assert_eq!(request.headers["authorization"], "Bearer secret");
    assert_eq!(request.headers["content-type"], "application/json");
    assert_eq!(request.headers["connection"], "close");
    let evidence = &request.body["evidence"];
    assert_eq!(evidence["harness"], "codex");
    assert_eq!(evidence["profile"], "prof_test");
    assert_eq!(evidence["nonce"], "nonce-1");
    assert_eq!(evidence["pid"], shim.child.id());
    assert!(evidence["ppid"].is_u64(), "a parent pid: {evidence}");
    assert!(evidence["cwd"].as_str().is_some_and(|c| !c.is_empty()));
    // the empty variable is left out, the unset ones too
    assert_eq!(evidence["env"], json!({ "TETHER_SESSION": "tether-7", "CLAUDE_CODE_SESSION_ID": "sess-9" }));
    assert_eq!(request.body["message"], json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));

    // 204, and 200 with no body: nothing written; a 500: the shim answers; chunked: passed on
    shim.send(r#"{"jsonrpc":"2.0","id":3,"method":"silent/thing"}"#);
    shim.send(r#"{"jsonrpc":"2.0","id":4,"method":"empty/thing"}"#);
    shim.send(r#"{"jsonrpc":"2.0","id":"five","method":"fail/thing"}"#);
    shim.send(r#"{"jsonrpc":"2.0","id":6,"method":"ping"}"#);
    let answers = shim.answers(2);
    assert_eq!(answers["\"five\""], json!({ "jsonrpc": "2.0", "id": "five", "error": { "code": -32601, "message": "method not found: fail/thing" } }));
    assert_eq!(answers["6"], json!({ "jsonrpc": "2.0", "id": 6, "result": { "from": "daemon", "method": "ping" } }));
    shim.assert_quiet();
    assert_eq!(daemon.seen().len(), 5);
    shim.finish();
}

#[test]
fn a_slow_call_does_not_hold_up_a_ping_behind_it() {
    let scratch = Scratch::new("concurrent");
    let hook = scratch.0.join("hook.json");
    let daemon = Daemon::start();
    write_hook(&hook, daemon.port, "secret");
    let mut shim = Shim::start(&[hook.to_str().unwrap(), "claude", "prof_test"], &[]);

    shim.send(r#"{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"list_agents","arguments":{}}}"#);
    shim.send(r#"{"jsonrpc":"2.0","id":11,"method":"ping"}"#);
    let first = shim.next();
    assert_eq!(first["id"], 11, "the ping first: {first}");
    let second = shim.next();
    // the daemon's pretty-printed answer came out as one line
    assert_eq!(second, json!({ "jsonrpc": "2.0", "id": 10, "result": { "from": "daemon", "method": "tools/call" } }));
    shim.finish();
}

#[test]
fn a_call_in_flight_at_stdin_s_end_is_still_answered() {
    let scratch = Scratch::new("drain");
    let hook = scratch.0.join("hook.json");
    let daemon = Daemon::start();
    write_hook(&hook, daemon.port, "secret");
    let mut shim = Shim::start(&[hook.to_str().unwrap(), "muse", "prof_test"], &[]);

    shim.send(r#"{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"list_agents","arguments":{}}}"#);
    // the call has reached the daemon, which takes 1.5 s over it
    for _ in 0..100 {
        if !daemon.seen().is_empty() {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    drop(shim.stdin.take());
    assert_eq!(shim.next()["id"], 20);
    let status = shim.child.wait().unwrap();
    assert!(status.success());
}

#[test]
fn a_call_cophylad_took_and_never_answered_is_not_said_to_be_unsent() {
    let scratch = Scratch::new("lost");
    let hook = scratch.0.join("hook.json");
    // cophylad, played as one that reads a request whole and hangs up without a word
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { break };
            let mut reader = BufReader::new(&stream);
            let mut length = 0;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                let line = line.trim_end();
                if line.is_empty() {
                    break;
                }
                if let Some((k, v)) = line.split_once(':') {
                    if k.eq_ignore_ascii_case("content-length") {
                        length = v.trim().parse().unwrap();
                    }
                }
            }
            let mut body = vec![0; length];
            let _ = reader.read_exact(&mut body);
        }
    });
    write_hook(&hook, port, "secret");
    let mut shim = Shim::start(&[hook.to_str().unwrap(), "codex", "prof_test"], &[]);

    shim.send(r#"{"jsonrpc":"2.0","id":30,"method":"tools/call","params":{"name":"send_message","arguments":{"to":"a","text":"b"}}}"#);
    let call = shim.next();
    assert_eq!(call["id"], 30);
    assert_eq!(call["result"]["isError"], true);
    let text = call["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("may have been sent"), "{text}");
    assert!(!text.contains("nothing was sent"), "{text}");
    // anything else it took and dropped is answered as when it is not there
    shim.send(r#"{"jsonrpc":"2.0","id":31,"method":"tools/list"}"#);
    assert!(shim.next()["result"]["tools"].as_array().is_some_and(|t| t.len() == 2));
    shim.finish();
}
