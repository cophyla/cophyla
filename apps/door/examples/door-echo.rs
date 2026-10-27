//! A stand-in for cophylad's door child, for the shim's tests: it speaks the shim's protocol on
//! stdio and answers what a client writes, so a test can drive the whole path from a pipe
//! client through the shim to a child and back.
//!   on `pipe.open`   it sends the client one line: the `shim.hello` it got, the open's params,
//!                    its arguments, folder and environment's names, and a few values
//!   on `pipe.line`   `exit <n>` exits with n, `drop` asks the shim to drop the client,
//!                    `noise` prints a line that is not JSON, `want <ready> <streaming>` sends
//!                    `power.want`; anything else is sent back as it came
//!   on `console.state`, `power.state`  every client gets `{"got":<method>,"params":…}`
//!   on `shim.stop`   it exits 0
//! It builds on every OS; only the Windows tests run it.

use std::env;
use std::io::{self, BufRead, Write};
use std::process;

use serde_json::{json, Value};

fn send(method: &str, params: Value) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{}", json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    let _ = out.flush();
}

fn main() {
    eprintln!("door-echo: started");
    let mut hello = Value::Null;
    let mut conns: Vec<u64> = Vec::new();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let method = message["method"].as_str().unwrap_or_default().to_string();
        let params = message["params"].clone();
        match method.as_str() {
            "shim.hello" => hello = params,
            "pipe.open" => {
                let conn = params["conn"].as_u64().unwrap_or_default();
                conns.push(conn);
                let names: Vec<String> = env::vars_os().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
                let value = |name: &str| env::var(name).unwrap_or_default();
                let report = json!({
                    "hello": hello,
                    "open": params,
                    "args": env::args().skip(1).collect::<Vec<_>>(),
                    "cwd": env::current_dir().map(|d| d.display().to_string()).unwrap_or_default(),
                    "envNames": names,
                    "env": { "COPHYLA_DOOR": value("COPHYLA_DOOR"), "TEMP": value("TEMP"), "USERPROFILE": value("USERPROFILE"), "PATH": value("PATH") },
                });
                send("pipe.send", json!({ "conn": conn, "line": report.to_string() }));
            }
            "pipe.line" => {
                let conn = params["conn"].as_u64().unwrap_or_default();
                let text = params["line"].as_str().unwrap_or_default().to_string();
                let words: Vec<&str> = text.split_whitespace().collect();
                match words.as_slice() {
                    ["exit", n] => process::exit(n.parse().unwrap_or(1)),
                    ["drop"] => send("pipe.drop", json!({ "conn": conn })),
                    ["noise"] => {
                        println!("door-echo: not JSON");
                        send("pipe.send", json!({ "conn": conn, "line": "noise made" }));
                    }
                    ["want", ready, streaming] => {
                        send("power.want", json!({ "ready": *ready == "true", "streaming": *streaming == "true" }));
                        send("pipe.send", json!({ "conn": conn, "line": "wanted" }));
                    }
                    _ => send("pipe.send", json!({ "conn": conn, "line": text })),
                }
            }
            "pipe.close" => {
                let conn = params["conn"].as_u64().unwrap_or_default();
                conns.retain(|c| *c != conn);
            }
            "console.state" | "power.state" => {
                for conn in &conns {
                    send("pipe.send", json!({ "conn": conn, "line": json!({ "got": method, "params": params }).to_string() }));
                }
            }
            "shim.stop" => {
                eprintln!("door-echo: stopping");
                process::exit(0);
            }
            _ => {}
        }
    }
}
