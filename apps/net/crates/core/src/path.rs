//! What a peer's selected pair says about the path, in the words `peer.path` and the daily
//! counters use. The far end's candidate decides first: a TURN relay is `relay`, a port the
//! helper predicted is `predicted`, an address its own checks taught is `prflx`. Then this
//! end's: the router's mapping is `mapped`, a reflexive address on either side is `srflx`,
//! and two plain addresses are `host`.

use std::collections::HashSet;
use std::net::SocketAddr;

use net_proto::PathType;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CandidateKind {
    Host,
    Srflx,
    Prflx,
    Relay,
}

impl CandidateKind {
    pub fn parse(s: &str) -> Option<CandidateKind> {
        match s {
            "host" => Some(CandidateKind::Host),
            "srflx" => Some(CandidateKind::Srflx),
            "prflx" => Some(CandidateKind::Prflx),
            "relay" => Some(CandidateKind::Relay),
            _ => None,
        }
    }
}

pub struct Ends<'a> {
    pub local: (CandidateKind, SocketAddr),
    pub remote: (CandidateKind, SocketAddr),
    pub predicted: &'a HashSet<SocketAddr>,
    pub mapped: Option<SocketAddr>,
}

pub fn classify(e: &Ends<'_>) -> PathType {
    let (lk, la) = e.local;
    let (rk, ra) = e.remote;
    if rk == CandidateKind::Relay || lk == CandidateKind::Relay {
        return PathType::Relay;
    }
    if e.predicted.contains(&ra) {
        return PathType::Predicted;
    }
    if rk == CandidateKind::Prflx {
        return PathType::Prflx;
    }
    if e.mapped == Some(la) {
        return PathType::Mapped;
    }
    if rk == CandidateKind::Srflx || lk == CandidateKind::Srflx || lk == CandidateKind::Prflx {
        return PathType::Srflx;
    }
    PathType::Host
}

#[cfg(test)]
mod tests {
    use super::*;
    use CandidateKind::*;

    fn a(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    fn classify_with(local: (CandidateKind, &str), remote: (CandidateKind, &str), predicted: &[&str], mapped: Option<&str>) -> PathType {
        let predicted: HashSet<SocketAddr> = predicted.iter().map(|s| a(s)).collect();
        classify(&Ends { local: (local.0, a(local.1)), remote: (remote.0, a(remote.1)), predicted: &predicted, mapped: mapped.map(a) })
    }

    #[test]
    fn the_table() {
        let l = "192.168.1.44:50000";
        let pub_l = "81.2.69.160:50000";
        let r = "198.51.100.9:4000";
        assert_eq!(classify_with((Host, l), (Host, "192.168.1.50:5000"), &[], None), PathType::Host);
        assert_eq!(classify_with((Host, l), (Srflx, r), &[], None), PathType::Srflx);
        assert_eq!(classify_with((Srflx, pub_l), (Host, r), &[], None), PathType::Srflx);
        assert_eq!(classify_with((Host, l), (Prflx, r), &[], None), PathType::Prflx);
        assert_eq!(classify_with((Host, l), (Srflx, r), &[r], None), PathType::Predicted);
        assert_eq!(classify_with((Host, l), (Relay, r), &[], None), PathType::Relay);
        assert_eq!(classify_with((Srflx, pub_l), (Srflx, r), &[], Some(pub_l)), PathType::Mapped);
        assert_eq!(classify_with((Srflx, pub_l), (Relay, r), &[], Some(pub_l)), PathType::Relay, "the far end's relay wins");
    }

    #[test]
    fn kinds_parse() {
        assert_eq!(CandidateKind::parse("prflx"), Some(Prflx));
        assert_eq!(CandidateKind::parse("x"), None);
    }
}
