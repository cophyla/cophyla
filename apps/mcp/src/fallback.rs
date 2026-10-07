//! What the shim answers on its own when cophylad cannot: the handshake, the tool list it was
//! built with, and a tool error for a call. A harness lists a server's tools once, at its
//! start; a session started while the daemon is down would otherwise go without them for its
//! whole life, where this way its tools are there and work once the daemon is back.

use serde_json::{json, Value};

/// The tools and the instructions, as `packages/protocol` declares them for cophylad too.
const AGENT_TOOLS: &str = include_str!("../../../packages/protocol/agent-tools.json");
/// The MCP revision answered when the client names none.
const PROTOCOL: &str = "2025-06-18";
const NOT_RUNNING: &str = "Cophyla isn't running on this machine; nothing was sent.";
const NO_ANSWER: &str = "Cophyla took the call but gave no answer in time, so the message may have been sent: don't send it again; tell the user if it matters.";

/// The answer to a call cophylad took and never answered: a tool error that does not say it was not sent.
pub fn lost(message: &Value) -> Option<Value> {
    let id = message.get("id").filter(|id| !id.is_null())?;
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": NO_ANSWER }], "isError": true } }))
}

/// The answer to one message, or nothing for a notification.
pub fn answer(message: &Value) -> Option<Value> {
    let id = message.get("id").filter(|id| !id.is_null())?;
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let declared: Value = serde_json::from_str(AGENT_TOOLS).unwrap_or(Value::Null);
    let outcome = match method {
        "initialize" => {
            let asked = message.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL);
            let mut result = json!({
                "protocolVersion": asked,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": declared.get("server").and_then(Value::as_str).unwrap_or("cophyla-agents"), "version": env!("CARGO_PKG_VERSION") },
            });
            if let Some(instructions) = declared.get("instructions").and_then(Value::as_str) {
                result["instructions"] = Value::from(instructions);
            }
            Ok(result)
        }
        "tools/list" => Ok(json!({ "tools": declared.get("tools").cloned().unwrap_or_else(|| json!([])) })),
        "tools/call" => Ok(json!({ "content": [{ "type": "text", "text": NOT_RUNNING }], "isError": true })),
        "ping" => Ok(json!({})),
        _ => Err(json!({ "code": -32601, "message": format!("method not found: {method}") })),
    };
    Some(match outcome {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_declared_tools_parse_and_name_the_server() {
        let declared: Value = serde_json::from_str(AGENT_TOOLS).unwrap();
        assert_eq!(declared["server"], "cophyla-agents");
        assert!(declared["instructions"].as_str().is_some_and(|s| !s.is_empty()));
        assert!(declared["tools"].as_array().is_some_and(|t| !t.is_empty()));
    }

    #[test]
    fn a_notification_has_no_answer() {
        assert_eq!(answer(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })), None);
        assert_eq!(answer(&json!({ "jsonrpc": "2.0", "id": null, "method": "ping" })), None);
    }
}
