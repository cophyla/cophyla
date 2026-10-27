//! `cophyla-door status`, as the one JSON line it prints, platform-free: whether the service is
//! installed, its state as the SCM says it in snake case, its pid while it has one, the version
//! `program\current` names, and this shim's own version. The user's daemon runs it without
//! elevation to show and decide on the door.

use serde_json::Value;

/// The SCM's `dwCurrentState`, named.
pub fn state_name(state: u32) -> &'static str {
    match state {
        1 => "stopped",
        2 => "start_pending",
        3 => "stop_pending",
        4 => "running",
        5 => "continue_pending",
        6 => "pause_pending",
        7 => "paused",
        _ => "unknown",
    }
}

/// The line, keys in the order the contract lists them. A service that is not installed is
/// `stopped`, so a reader that only asks whether it runs needs nothing else.
pub fn line(installed: bool, state: Option<u32>, pid: Option<u32>, version: Option<&str>) -> String {
    let state = if installed { state.map_or("unknown", state_name) } else { "stopped" };
    let mut out = format!("{{\"installed\":{installed},\"state\":\"{state}\"");
    if let Some(pid) = pid.filter(|p| *p != 0) {
        out.push_str(&format!(",\"pid\":{pid}"));
    }
    if let Some(v) = version {
        out.push_str(&format!(",\"version\":{}", Value::from(v)));
    }
    out.push_str(&format!(",\"shim\":{}}}", Value::from(env!("CARGO_PKG_VERSION"))));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_running_service() {
        let text = line(true, Some(4), Some(4242), Some("0.21.0"));
        assert_eq!(text, format!("{{\"installed\":true,\"state\":\"running\",\"pid\":4242,\"version\":\"0.21.0\",\"shim\":\"{}\"}}", env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn a_stopped_or_missing_service() {
        let v: Value = serde_json::from_str(&line(true, Some(1), Some(0), Some("0.21.0"))).unwrap();
        assert_eq!(v, json!({ "installed": true, "state": "stopped", "version": "0.21.0", "shim": env!("CARGO_PKG_VERSION") }));
        let v: Value = serde_json::from_str(&line(false, None, None, None)).unwrap();
        assert_eq!(v, json!({ "installed": false, "state": "stopped", "shim": env!("CARGO_PKG_VERSION") }));
    }

    #[test]
    fn every_state_has_a_name() {
        let names: Vec<&str> = (1..=7).map(state_name).collect();
        assert_eq!(names, ["stopped", "start_pending", "stop_pending", "running", "continue_pending", "pause_pending", "paused"]);
        assert_eq!(state_name(0), "unknown");
    }
}
