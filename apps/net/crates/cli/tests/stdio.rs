//! Two `cophyla-net` processes, driven over their stdio the way cophylad drives one: `hello`,
//! loopback-only configuration, an offer and its answer, candidates carried across as
//! requests, the channel open, frames both ways as `peer.send` and `peer.data`, an unknown
//! method refused, and a helper whose stdin closes exiting on its own while the other hears
//! its peer go.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<Value>,
    next: u64,
    /// Notifications read while waiting for a reply.
    pending: Vec<Value>,
}

impl Helper {
    fn spawn() -> Helper {
        let mut child = Command::new(env!("CARGO_BIN_EXE_cophyla-net"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("cophyla-net starts");
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let value: Value = serde_json::from_str(&line).expect("every line is JSON");
                if tx.send(value).is_err() {
                    break;
                }
            }
        });
        let stdin = child.stdin.take();
        Helper { child, stdin, lines, next: 1, pending: Vec::new() }
    }

    fn write(&mut self, msg: Value) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        writeln!(stdin, "{msg}").unwrap();
        stdin.flush().unwrap();
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, Value> {
        let id = self.next;
        self.next += 1;
        self.write(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            let msg = self.lines.recv_timeout(end.saturating_duration_since(Instant::now())).expect("a reply in time");
            if msg.get("id") == Some(&json!(id)) {
                return match msg.get("error") {
                    Some(e) => Err(e.clone()),
                    None => Ok(msg["result"].clone()),
                };
            }
            self.pending.push(msg);
        }
    }

    fn notify(&mut self, method: &str, params: Value) {
        self.write(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    /// The next notification, from those put aside first.
    fn next_notification(&mut self, wait: Duration) -> Option<Value> {
        if !self.pending.is_empty() {
            return Some(self.pending.remove(0));
        }
        match self.lines.recv_timeout(wait) {
            Ok(v) => Some(v),
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => None,
        }
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn loopback_only() -> Value {
    json!({ "port": 0, "loopback": true, "map": false, "ipv6": false, "skipInterfaces": ["*"] })
}

#[test]
fn two_helpers_open_a_channel_over_stdio() {
    let mut a = Helper::spawn();
    let mut b = Helper::spawn();
    let hello = a.call("hello", json!({ "protocol": 1 })).unwrap();
    assert_eq!(hello["protocol"], 1);
    assert!(hello["version"].as_str().is_some());
    let refused = a.call("peer.teleport", json!({})).unwrap_err();
    assert_eq!(refused["data"]["code"], "unsupported");

    a.call("net.configure", loopback_only()).unwrap();
    b.call("net.configure", loopback_only()).unwrap();
    let offer = a.call("peer.offer", json!({ "peer": "to-b" })).unwrap();
    let answer = b.call("peer.answer", json!({ "peer": "to-a", "sdp": offer["sdp"] })).unwrap();
    a.call("peer.accept", json!({ "peer": "to-b", "sdp": answer["sdp"] })).unwrap();

    let (mut open_a, mut open_b) = (false, false);
    let mut sent = false;
    let (mut got_b, mut got_a) = (Vec::new(), Vec::new());
    let end = Instant::now() + Duration::from_secs(30);
    while Instant::now() < end && (got_b.len() < 3 || got_a.len() < 1) {
        let mut idle = true;
        while let Some(n) = a.next_notification(Duration::from_millis(1)) {
            idle = false;
            match n["method"].as_str().unwrap_or("") {
                "peer.candidate" => {
                    b.call("peer.candidate", json!({ "peer": "to-a", "candidate": n["params"]["candidate"] })).unwrap();
                }
                "peer.open" => open_a = true,
                "peer.data" => got_a.push(n["params"]["data"].as_str().unwrap().to_string()),
                _ => {}
            }
        }
        while let Some(n) = b.next_notification(Duration::from_millis(1)) {
            idle = false;
            match n["method"].as_str().unwrap_or("") {
                "peer.candidate" => {
                    a.call("peer.candidate", json!({ "peer": "to-b", "candidate": n["params"]["candidate"] })).unwrap();
                }
                "peer.open" => open_b = true,
                "peer.data" => got_b.push(n["params"]["data"].as_str().unwrap().to_string()),
                _ => {}
            }
        }
        if open_a && open_b && !sent {
            sent = true;
            for text in ["one", "two", "three"] {
                a.notify("peer.send", json!({ "peer": "to-b", "data": text }));
            }
            b.notify("peer.send", json!({ "peer": "to-a", "data": "back" }));
        }
        if idle {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    assert!(open_a && open_b, "both ends open");
    assert_eq!(got_b, ["one", "two", "three"]);
    assert_eq!(got_a, ["back"]);

    // cophylad gone: the helper's stdin closes and it exits by itself; its peer hears the channel go
    drop(a.stdin.take());
    let exit = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = a.child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < exit, "the helper exits once its stdin closes");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "{status}");
    let heard = Instant::now() + Duration::from_secs(20);
    let mut gone = false;
    while Instant::now() < heard && !gone {
        if let Some(n) = b.next_notification(Duration::from_millis(200)) {
            gone = n["method"] == "peer.state" && matches!(n["params"]["state"].as_str(), Some("closed" | "failed" | "disconnected"));
        }
    }
    assert!(gone, "the far end heard its peer go");
}
