//! cophyla-net's stdio protocol: NDJSON JSON-RPC 2.0, cophylad on one end and the helper on the
//! other. cophylad asks (`hello`, `net.configure`, `peer.*`, `map.ports`) and pushes frames
//! (`peer.send`); the helper answers and reports (`peer.candidate`, `peer.state`,
//! `peer.open`, `peer.data`, `peer.buffered`, `peer.path`, `net.state`). The frames a peer
//! carries are opaque strings: cophylad seals them before they get here, so the helper never
//! holds plaintext. Field names are camelCase on the wire, as cophylad's TypeScript has them.

use serde::{Deserialize, Serialize};

/// The protocol this build speaks; `hello` answers it and cophylad refuses another.
pub const PROTOCOL: u32 = 1;

/// The one data channel a peer carries: ordered, reliable, opened by the offering side.
pub const CHANNEL_LABEL: &str = "cophyla";

/// The largest frame a peer takes: cophylad chunks anything bigger before it sends.
pub const MAX_FRAME: usize = 16 * 1024;

/// An ICE candidate as a browser's `RTCIceCandidateInit` has it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub candidate: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdp_mid: Option<String>,
    #[serde(rename = "sdpMLineIndex", default, skip_serializing_if = "Option::is_none")]
    pub sdp_m_line_index: Option<u16>,
}

/// ICE's clocks for a peer, in milliseconds; absent ones keep the helper's defaults.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IceTimeouts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disconnected_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keepalive_ms: Option<u64>,
}

// --- requests ---------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    #[serde(default)]
    pub protocol: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HelloResult {
    pub protocol: u32,
    pub version: String,
}

fn default_predict() -> u16 {
    12
}

fn yes() -> bool {
    true
}

/// Where and how the helper listens. Sent once after `hello`, and again when the network or
/// the settings changed: the sockets are rebound only when the port or the addresses moved.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Configure {
    /// The UDP port on every usable address; 0 lets the system pick one, kept from then on.
    #[serde(default)]
    pub port: u16,
    /// STUN servers as `stun:host:port` (or `host:port`), for the reflexive address.
    #[serde(default)]
    pub stun: Vec<String>,
    /// Remote candidates added above each reflexive one a peer sends: the next `predict` ports.
    #[serde(default = "default_predict")]
    pub predict: u16,
    /// Ask the router for a mapping of the port (UPnP, NAT-PMP, PCP).
    #[serde(default = "yes")]
    pub map: bool,
    /// Use global IPv6 addresses too.
    #[serde(default = "yes")]
    pub ipv6: bool,
    /// Interfaces left out by name, beside the virtual and VPN ones always left out.
    #[serde(default)]
    pub skip_interfaces: Vec<String>,
    /// ICE's clocks for every peer that does not bring its own.
    #[serde(default)]
    pub ice: IceTimeouts,
    /// Listen on loopback too: for tests on one machine, never in a release.
    #[serde(default)]
    pub loopback: bool,
}

impl Default for Configure {
    fn default() -> Self {
        Configure { port: 0, stun: Vec::new(), predict: default_predict(), map: true, ipv6: true, skip_interfaces: Vec::new(), ice: IceTimeouts::default(), loopback: false }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Configured {
    pub port: u16,
    /// Every `ip:port` the helper listens on.
    pub addresses: Vec<String>,
}

/// `peer.offer`: the helper offers (a node linking to its primary); the answer is `peer.accept`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerOffer {
    pub peer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ice: Option<IceTimeouts>,
}

/// `peer.answer`: a remote offer (a phone's, another node's) the helper answers.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerAnswer {
    pub peer: String,
    pub sdp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ice: Option<IceTimeouts>,
}

/// `peer.accept`: the remote answer to the helper's own offer.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerAccept {
    pub peer: String,
    pub sdp: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Sdp {
    pub sdp: String,
}

/// A candidate either way: the remote's to the helper (`peer.candidate` request), the helper's
/// own to cophylad (`peer.candidate` notification). `null` is the end of candidates.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerCandidate {
    pub peer: String,
    pub candidate: Option<Candidate>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerRef {
    pub peer: String,
}

/// `map.ports`: more ports mapped on the router beside the helper's own (the desktop stream's).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MapPorts {
    pub ports: Vec<u16>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MappedPorts {
    /// The ports a mapping is being kept for.
    pub ports: Vec<u16>,
}

// --- notifications ------------------------------------------------------------------------------

/// `peer.send` from cophylad, `peer.data` from the helper: one frame, as cophylad sealed it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerFrame {
    pub peer: String,
    pub data: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum PeerStateKind {
    New,
    Connecting,
    Connected,
    Disconnected,
    Failed,
    Closed,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerState {
    pub peer: String,
    pub state: PeerStateKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Bytes handed to the channel that the far end has not acknowledged yet.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerBuffered {
    pub peer: String,
    pub bytes: u64,
}

/// How a peer's selected pair reaches it.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum PathType {
    /// Both ends' own addresses: the same network, or public ones.
    Host,
    /// Through a NAT's reflexive address STUN saw.
    Srflx,
    /// Through an address learned from the peer's own checks.
    Prflx,
    /// Through a port the helper predicted for a sequential NAT.
    Predicted,
    /// Through the mapping the router keeps for the helper's port.
    Mapped,
    /// Through a TURN server the far end uses.
    Relay,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeerPath {
    pub peer: String,
    #[serde(rename = "type")]
    pub kind: PathType,
    pub local: String,
    pub remote: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtt_ms: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MappingStatus {
    /// Not asked for.
    Off,
    /// Looking for a router that maps.
    Probing,
    /// No router answered any of the protocols.
    None,
    /// The router keeps a mapping for the port.
    Mapped,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Mapping {
    pub status: MappingStatus,
    /// The protocols the router answered: `upnp`, `pcp`, `nat-pmp`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub protocols: Vec<String>,
    /// The router's public address and port for the mapping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external: Option<String>,
}

/// What the helper has to offer now: its port, its addresses, what STUN saw, the mapping.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetState {
    pub port: u16,
    pub addresses: Vec<String>,
    /// The reflexive addresses STUN saw for the port, one per local address that got an answer.
    pub reflexive: Vec<String>,
    pub mapping: Mapping,
    /// A global IPv6 address is among the addresses.
    pub ipv6: bool,
}

/// A JSON-RPC error's `data`, as cophylad's protocol errors carry it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ErrorData {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_uses_browser_field_names() {
        let c = Candidate { candidate: "candidate:1 1 udp 1 10.0.0.1 5000 typ host".into(), sdp_mid: Some("0".into()), sdp_m_line_index: Some(0) };
        let text = serde_json::to_string(&c).unwrap();
        assert_eq!(text, r#"{"candidate":"candidate:1 1 udp 1 10.0.0.1 5000 typ host","sdpMid":"0","sdpMLineIndex":0}"#);
        let back: Candidate = serde_json::from_str(r#"{"candidate":"x"}"#).unwrap();
        assert_eq!(back.sdp_mid, None);
    }

    #[test]
    fn configure_defaults() {
        let c: Configure = serde_json::from_str("{}").unwrap();
        assert_eq!(c, Configure::default());
        assert_eq!(c.predict, 12);
        assert!(c.map && c.ipv6 && !c.loopback);
    }

    #[test]
    fn path_type_is_lowercase_under_type() {
        let p = PeerPath { peer: "p".into(), kind: PathType::Predicted, local: "a".into(), remote: "b".into(), rtt_ms: Some(10.5) };
        assert_eq!(serde_json::to_string(&p).unwrap(), r#"{"peer":"p","type":"predicted","local":"a","remote":"b","rttMs":10.5}"#);
    }

    #[test]
    fn end_of_candidates_is_null() {
        let c = PeerCandidate { peer: "p".into(), candidate: None };
        assert_eq!(serde_json::to_string(&c).unwrap(), r#"{"peer":"p","candidate":null}"#);
    }
}
