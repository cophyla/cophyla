//! `cophyla-net`: cophylad's helper for direct connections. With no arguments it speaks NDJSON
//! JSON-RPC on stdin and stdout (see `net-proto`), logs JSON lines on stderr, and exits when
//! stdin closes or cophylad says `shutdown`. `--probe-portmap [port] [seconds]` asks the router
//! for a mapping and prints what it answered; `--version` prints the version.

use std::time::Duration;

use net_core::{run, CoreError, Input, Output, Request};
use net_proto::{HelloResult, PROTOCOL};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn error(code: &str, message: &str) -> Value {
    json!({ "code": -32000, "message": message, "data": { "code": code, "message": message, "retryable": false } })
}

fn parse<T: serde::de::DeserializeOwned>(params: &Value) -> Result<T, CoreError> {
    serde_json::from_value(params.clone()).map_err(|e| CoreError { code: "invalid", message: format!("bad params: {e}") })
}

/// What one line from cophylad comes to.
enum Line {
    /// For the core.
    Input(Input),
    /// Answered here: `hello`, or a request that did not parse.
    Reply(Value, Result<Value, CoreError>),
    Nothing,
}

fn read_line(line: &str) -> Line {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return Line::Nothing,
    };
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    let Some(id) = msg.get("id").cloned().filter(|v| !v.is_null()) else {
        // notifications
        return match method {
            "peer.send" => serde_json::from_value(params).map(|f| Line::Input(Input::Send(f))).unwrap_or(Line::Nothing),
            "shutdown" => Line::Input(Input::Shutdown),
            _ => Line::Nothing,
        };
    };
    let req = match method {
        "hello" => return Line::Reply(id, Ok(serde_json::to_value(HelloResult { protocol: PROTOCOL, version: VERSION.to_string() }).unwrap())),
        "net.configure" => parse(&params).map(Request::Configure),
        "peer.offer" => parse(&params).map(Request::Offer),
        "peer.answer" => parse(&params).map(Request::Answer),
        "peer.accept" => parse(&params).map(Request::Accept),
        "peer.candidate" => parse(&params).map(Request::Candidate),
        "peer.close" => parse(&params).map(Request::Close),
        "map.ports" => parse(&params).map(Request::MapPorts),
        _ => Err(CoreError { code: "unsupported", message: format!("unsupported: {method}") }),
    };
    match req {
        Ok(req) => Line::Input(Input::Request { id, req }),
        Err(e) => Line::Reply(id, Err(e)),
    }
}

fn line_of(o: &Output) -> Value {
    match o {
        Output::Reply { id, result: Ok(v) } => json!({ "jsonrpc": "2.0", "id": id, "result": v }),
        Output::Reply { id, result: Err(e) } => json!({ "jsonrpc": "2.0", "id": id, "error": error(e.code, &e.message) }),
        other => {
            let (method, params) = other.notification().unwrap();
            json!({ "jsonrpc": "2.0", "method": method, "params": params })
        }
    }
}

async fn serve() {
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Input>();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Output>();
    let replies = out_tx.clone();
    let reader = tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            match read_line(&line) {
                Line::Input(input) => {
                    let shutdown = matches!(input, Input::Shutdown);
                    if in_tx.send(input).is_err() || shutdown {
                        break;
                    }
                }
                Line::Reply(id, result) => {
                    let _ = replies.send(Output::Reply { id, result });
                }
                Line::Nothing => {}
            }
        }
        // stdin closed: cophylad is gone, and so is the helper
        let _ = in_tx.send(Input::Shutdown);
    });
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::BufWriter::new(tokio::io::stdout());
        while let Some(o) = out_rx.recv().await {
            let mut text = line_of(&o).to_string();
            text.push('\n');
            if stdout.write_all(text.as_bytes()).await.is_err() {
                return;
            }
            while let Ok(o) = out_rx.try_recv() {
                let mut text = line_of(&o).to_string();
                text.push('\n');
                if stdout.write_all(text.as_bytes()).await.is_err() {
                    return;
                }
            }
            if stdout.flush().await.is_err() {
                return;
            }
        }
    });
    run(in_rx, out_tx).await;
    reader.abort();
    let _ = tokio::time::timeout(Duration::from_secs(1), writer).await;
}

async fn probe_portmap(port: u16, seconds: u64) {
    let client = portmapper::Client::new(portmapper::Config::default());
    let probe = client.probe();
    match tokio::time::timeout(Duration::from_secs(10), probe).await {
        Ok(Ok(Ok(out))) => println!("{}", json!({ "probe": { "upnp": out.upnp, "pcp": out.pcp, "natPmp": out.nat_pmp } })),
        Ok(Ok(Err(e))) => println!("{}", json!({ "probe": { "error": e.to_string() } })),
        _ => println!("{}", json!({ "probe": { "error": "no answer within 10 s" } })),
    }
    if let Some(p) = std::num::NonZeroU16::new(port) {
        client.update_local_port(p);
        client.procure_mapping();
        let mut rx = client.watch_external_address();
        let end = tokio::time::Instant::now() + Duration::from_secs(seconds);
        loop {
            tokio::select! {
                r = rx.changed() => {
                    if r.is_err() { break; }
                    println!("{}", json!({ "external": rx.borrow().map(|a| a.to_string()) }));
                }
                _ = tokio::time::sleep_until(end) => break,
            }
        }
        println!("{}", json!({ "done": true, "external": rx.borrow().map(|a| a.to_string()) }));
        client.deactivate();
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a tokio runtime");
    match args.first().map(String::as_str) {
        Some("--version") => println!("cophyla-net {VERSION} (protocol {PROTOCOL})"),
        Some("--probe-portmap") => {
            let port = args.get(1).and_then(|p| p.parse().ok()).unwrap_or(0);
            let seconds = args.get(2).and_then(|p| p.parse().ok()).unwrap_or(15);
            rt.block_on(probe_portmap(port, seconds));
        }
        Some(other) => {
            eprintln!("cophyla-net: unknown argument {other}");
            std::process::exit(2);
        }
        None => rt.block_on(serve()),
    }
}
