//! The two line protocols the shim speaks, platform-free.
//!
//! With its child, on stdio: newline-delimited JSON-RPC 2.0 notifications, no ids, UTF-8, one
//! compact object per line (serde_json never writes a raw line break inside one). The shim
//! sends `shim.hello` first, then `console.state`, `power.state`, `pipe.open`, `pipe.line`,
//! `pipe.close` and `shim.stop`; the child sends `pipe.send`, `pipe.drop` and `power.want`.
//! A child line that is not JSON goes to the log; a method the shim does not know is logged and
//! ignored, so either side can grow without breaking the other.
//!
//! With a test kit, on the console mode's stdin: `signin`, `locked`, `active`, `ac on`,
//! `ac off` and `stop`, one per line.

use serde_json::{json, Value};

use crate::console::Console;
use crate::constants::SHIM_PROTOCOL;

/// One notification, as the line written to the child.
pub fn notification(method: &str, params: Value) -> Vec<u8> {
    let mut line = serde_json::to_vec(&json!({ "jsonrpc": "2.0", "method": method, "params": params })).unwrap_or_default();
    line.push(b'\n');
    line
}

/// The first line after a spawn: what the child needs before anything else.
pub fn hello(console: Console, ac: bool, user_sid: &str) -> Vec<u8> {
    notification(
        "shim.hello",
        json!({ "protocol": SHIM_PROTOCOL, "version": env!("CARGO_PKG_VERSION"), "console": console.as_str(), "ac": ac, "userSid": user_sid }),
    )
}

pub fn console_state(console: Console) -> Vec<u8> {
    notification("console.state", json!({ "console": console.as_str() }))
}

pub fn power_state(ac: bool) -> Vec<u8> {
    notification("power.state", json!({ "ac": ac }))
}

pub fn pipe_open(conn: u64, sid: &str) -> Vec<u8> {
    notification("pipe.open", json!({ "conn": conn, "sid": sid }))
}

pub fn pipe_line(conn: u64, line: &str) -> Vec<u8> {
    notification("pipe.line", json!({ "conn": conn, "line": line }))
}

pub fn pipe_close(conn: u64) -> Vec<u8> {
    notification("pipe.close", json!({ "conn": conn }))
}

pub fn shim_stop() -> Vec<u8> {
    notification("shim.stop", json!({}))
}

/// A line the child wrote, read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FromChild {
    /// Write `line` and a newline to client `conn`.
    Send { conn: u64, line: String },
    /// Disconnect client `conn`.
    Drop { conn: u64 },
    /// The inputs to the power rule.
    Want { ready: bool, streaming: bool },
    /// A notification the shim does not know.
    Unknown { method: String },
    /// A known method with params the shim cannot use.
    Malformed { method: String, why: &'static str },
    /// Not a JSON-RPC notification at all: a stray print, logged as text.
    Text,
}

pub fn from_child(line: &[u8]) -> FromChild {
    let Ok(message) = serde_json::from_slice::<Value>(line) else { return FromChild::Text };
    let Some(method) = message.get("method").and_then(Value::as_str) else { return FromChild::Text };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let malformed = |why| FromChild::Malformed { method: method.to_string(), why };
    let conn = || params.get("conn").and_then(Value::as_u64);
    match method {
        "pipe.send" => {
            let Some(conn) = conn() else { return malformed("no conn") };
            let Some(text) = params.get("line").and_then(Value::as_str) else { return malformed("no line") };
            // the client reads lines: one with a break in it would be two
            if text.contains(['\n', '\r']) {
                return malformed("the line holds a line break");
            }
            FromChild::Send { conn, line: text.to_string() }
        }
        "pipe.drop" => match conn() {
            Some(conn) => FromChild::Drop { conn },
            None => malformed("no conn"),
        },
        "power.want" => {
            let flag = |name| params.get(name).map(Value::as_bool);
            match (flag("ready"), flag("streaming")) {
                (Some(Some(ready)), Some(Some(streaming))) => FromChild::Want { ready, streaming },
                (Some(Some(ready)), None) => FromChild::Want { ready, streaming: false },
                (None, Some(Some(streaming))) => FromChild::Want { ready: false, streaming },
                _ => malformed("ready and streaming must be booleans"),
            }
        }
        other => FromChild::Unknown { method: other.to_string() },
    }
}

/// A line of the console mode's stdin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Console(Console),
    Ac(bool),
    Stop,
}

pub fn command(line: &str) -> Option<Command> {
    let words: Vec<&str> = line.split_whitespace().collect();
    match words.as_slice() {
        ["stop"] => Some(Command::Stop),
        ["ac", "on"] => Some(Command::Ac(true)),
        ["ac", "off"] => Some(Command::Ac(false)),
        [state] => Console::parse(state).map(Command::Console),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(line: &[u8]) -> Value {
        assert_eq!(line.last(), Some(&b'\n'));
        let body = &line[..line.len() - 1];
        assert!(!body.contains(&b'\n'), "one line");
        serde_json::from_slice(body).unwrap()
    }

    #[test]
    fn hello_carries_what_the_child_starts_from() {
        let v = parsed(&hello(Console::Signin, true, "S-1-5-21-1-2-3-1001"));
        assert_eq!(
            v,
            json!({ "jsonrpc": "2.0", "method": "shim.hello", "params": { "protocol": 1, "version": env!("CARGO_PKG_VERSION"), "console": "signin", "ac": true, "userSid": "S-1-5-21-1-2-3-1001" } })
        );
        assert!(v.get("id").is_none());
    }

    #[test]
    fn each_notification_has_its_shape() {
        assert_eq!(parsed(&console_state(Console::Locked)), json!({ "jsonrpc": "2.0", "method": "console.state", "params": { "console": "locked" } }));
        assert_eq!(parsed(&power_state(false)), json!({ "jsonrpc": "2.0", "method": "power.state", "params": { "ac": false } }));
        assert_eq!(parsed(&pipe_open(3, "S-1-5-18")), json!({ "jsonrpc": "2.0", "method": "pipe.open", "params": { "conn": 3, "sid": "S-1-5-18" } }));
        assert_eq!(parsed(&pipe_close(3)), json!({ "jsonrpc": "2.0", "method": "pipe.close", "params": { "conn": 3 } }));
        assert_eq!(parsed(&shim_stop()), json!({ "jsonrpc": "2.0", "method": "shim.stop", "params": {} }));
    }

    #[test]
    fn a_pipe_line_with_breaks_and_quotes_stays_one_line() {
        let text = "{\"a\":\"x\\ny\"}\t\u{2028}é";
        let v = parsed(&pipe_line(7, text));
        assert_eq!(v["params"]["conn"], 7);
        assert_eq!(v["params"]["line"], text);
        let raw = pipe_line(7, "a\nb\rc");
        assert_eq!(raw.iter().filter(|b| **b == b'\n').count(), 1);
        assert!(!raw.contains(&b'\r'));
    }

    #[test]
    fn the_child_s_messages_are_read() {
        assert_eq!(from_child(br#"{"jsonrpc":"2.0","method":"pipe.send","params":{"conn":2,"line":"{\"ok\":true}"}}"#), FromChild::Send { conn: 2, line: "{\"ok\":true}".into() });
        assert_eq!(from_child(br#"{"jsonrpc":"2.0","method":"pipe.drop","params":{"conn":9}}"#), FromChild::Drop { conn: 9 });
        assert_eq!(from_child(br#"{"jsonrpc":"2.0","method":"power.want","params":{"ready":true,"streaming":false}}"#), FromChild::Want { ready: true, streaming: false });
        assert_eq!(from_child(br#"{"method":"power.want","params":{"streaming":true}}"#), FromChild::Want { ready: false, streaming: true });
        assert_eq!(from_child(br#"{"jsonrpc":"2.0","method":"door.log","params":{}}"#), FromChild::Unknown { method: "door.log".into() });
    }

    #[test]
    fn what_cannot_be_used_is_said() {
        assert_eq!(from_child(b"listening on 47989"), FromChild::Text);
        assert_eq!(from_child(b"[1,2]"), FromChild::Text);
        assert_eq!(from_child(br#"{"jsonrpc":"2.0","id":1,"result":{}}"#), FromChild::Text);
        assert!(matches!(from_child(br#"{"method":"pipe.send","params":{"conn":-1,"line":"x"}}"#), FromChild::Malformed { why: "no conn", .. }));
        assert!(matches!(from_child(br#"{"method":"pipe.send","params":{"conn":1}}"#), FromChild::Malformed { why: "no line", .. }));
        assert!(matches!(from_child(br#"{"method":"pipe.send","params":{"conn":1,"line":"a\nb"}}"#), FromChild::Malformed { .. }));
        assert!(matches!(from_child(br#"{"method":"pipe.drop"}"#), FromChild::Malformed { .. }));
        assert!(matches!(from_child(br#"{"method":"power.want","params":{"ready":"yes"}}"#), FromChild::Malformed { .. }));
        assert!(matches!(from_child(br#"{"method":"power.want","params":{}}"#), FromChild::Malformed { .. }));
    }

    #[test]
    fn console_commands() {
        assert_eq!(command("signin"), Some(Command::Console(Console::Signin)));
        assert_eq!(command("locked"), Some(Command::Console(Console::Locked)));
        assert_eq!(command(" active \r"), Some(Command::Console(Console::Active)));
        assert_eq!(command("ac on"), Some(Command::Ac(true)));
        assert_eq!(command("ac  off"), Some(Command::Ac(false)));
        assert_eq!(command("stop"), Some(Command::Stop));
        assert_eq!(command(""), None);
        assert_eq!(command("ac"), None);
        assert_eq!(command("stop now"), None);
        assert_eq!(command("Locked"), None);
    }
}
