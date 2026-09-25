//! Which peer a datagram on the shared port belongs to. Every peer's ICE agent and the
//! helper's own STUN client send from the same sockets, so the replies and the far ends'
//! packets have to be sorted back out:
//!
//! 1. a STUN response goes to whoever sent the request: its transaction id was recorded as
//!    the request left;
//! 2. a STUN request names its receiver in `USERNAME` (`ours:theirs`): the peer with that
//!    local ufrag;
//! 3. anything else (DTLS, SCTP over it) goes to the peer that last exchanged a check with
//!    that remote address on that socket.
//!
//! A remote address a new peer's checks arrive from moves to that peer: a phone that came
//! back with a fresh connection behind the same NAT mapping is the new one.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use crate::stun::{peek, Class, TxId};

/// Who a datagram is for: a peer by id, or the helper's own STUN client.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Owner {
    Peer(String),
    Stun,
}

/// How long a sent request's transaction id is kept for its response.
const TX_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Default)]
pub struct Router {
    by_tx: HashMap<TxId, (Owner, Instant)>,
    by_ufrag: HashMap<String, String>,
    by_addr: HashMap<(SocketAddr, SocketAddr), String>,
}

impl Router {
    pub fn new() -> Self {
        Router::default()
    }

    /// A peer's local ufrag: requests naming it are its.
    pub fn add_peer(&mut self, peer: &str, ufrag: &str) {
        self.by_ufrag.insert(ufrag.to_string(), peer.to_string());
    }

    /// Forgets everything that pointed at a peer.
    pub fn remove_peer(&mut self, peer: &str) {
        self.by_ufrag.retain(|_, p| p != peer);
        self.by_addr.retain(|_, p| p != peer);
        self.by_tx.retain(|_, (o, _)| *o != Owner::Peer(peer.to_string()));
    }

    /// A datagram leaving: a STUN request's transaction id is remembered for its owner, and
    /// the remote address is the peer's from now on.
    pub fn outbound(&mut self, owner: &Owner, local: SocketAddr, remote: SocketAddr, data: &[u8], now: Instant) {
        if let Some(p) = peek(data) {
            if p.class == Class::Request {
                self.by_tx.insert(p.txid, (owner.clone(), now));
            }
        }
        if let Owner::Peer(peer) = owner {
            // the helper's own checks and packets say where this peer is, once it is talking
            if peek(data).is_none() || self.by_addr.get(&(local, remote)).is_none() {
                self.by_addr.insert((local, remote), peer.clone());
            }
        }
    }

    /// Who an arriving datagram is for; `None` when nobody claims it.
    pub fn inbound(&mut self, local: SocketAddr, remote: SocketAddr, data: &[u8]) -> Option<Owner> {
        match peek(data) {
            Some(p) if p.class == Class::Success || p.class == Class::Error => {
                let (owner, _) = self.by_tx.remove(&p.txid)?;
                if let Owner::Peer(peer) = &owner {
                    self.by_addr.insert((local, remote), peer.clone());
                }
                Some(owner)
            }
            Some(p) => {
                if let Some(peer) = p.target_ufrag.as_ref().and_then(|u| self.by_ufrag.get(u)).cloned() {
                    self.by_addr.insert((local, remote), peer.clone());
                    return Some(Owner::Peer(peer));
                }
                self.by_addr.get(&(local, remote)).cloned().map(Owner::Peer)
            }
            None => self.by_addr.get(&(local, remote)).cloned().map(Owner::Peer),
        }
    }

    /// Drops transaction ids nobody answered.
    pub fn expire(&mut self, now: Instant) {
        self.by_tx.retain(|_, (_, at)| now.duration_since(*at) < TX_TTL);
    }

    #[cfg(test)]
    pub(crate) fn pending(&self) -> usize {
        self.by_tx.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stun::binding_request;
    use crate::stun::tests::{check, success};

    fn a(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    const L: &str = "192.168.1.44:50000";
    const DTLS: &[u8] = &[22, 254, 253, 0, 0, 0, 0, 0, 0, 0, 1, 0, 5, 1, 2, 3, 4, 5];

    #[test]
    fn responses_go_to_the_requester() {
        let mut r = Router::new();
        let now = Instant::now();
        let (tx, req) = binding_request();
        r.outbound(&Owner::Stun, a(L), a("1.1.1.1:3478"), &req, now);
        let (tx2, req2) = binding_request();
        r.outbound(&Owner::Peer("p1".into()), a(L), a("198.51.100.9:4000"), &req2, now);
        assert_eq!(r.inbound(a(L), a("1.1.1.1:3478"), &success(tx, a("203.0.113.1:9999"))), Some(Owner::Stun));
        assert_eq!(r.inbound(a(L), a("198.51.100.9:4000"), &success(tx2, a("203.0.113.1:9999"))), Some(Owner::Peer("p1".into())));
        // answered once: a duplicate is nobody's
        assert_eq!(r.inbound(a(L), a("1.1.1.1:3478"), &success(tx, a("203.0.113.1:9999"))), None);
    }

    #[test]
    fn requests_go_by_ufrag_and_teach_the_address() {
        let mut r = Router::new();
        r.add_peer("p1", "aaaa");
        r.add_peer("p2", "bbbb");
        let from = a("198.51.100.9:4000");
        assert_eq!(r.inbound(a(L), from, &check("bbbb", "zzzz")), Some(Owner::Peer("p2".into())));
        assert_eq!(r.inbound(a(L), from, DTLS), Some(Owner::Peer("p2".into())));
        assert_eq!(r.inbound(a(L), a("198.51.100.9:4001"), DTLS), None);
        assert_eq!(r.inbound(a(L), from, &check("cccc", "zzzz")), Some(Owner::Peer("p2".into())), "an unknown ufrag falls back to the address");
    }

    #[test]
    fn a_new_peer_takes_the_address_over() {
        let mut r = Router::new();
        r.add_peer("old", "aaaa");
        r.add_peer("new", "bbbb");
        let from = a("198.51.100.9:4000");
        r.inbound(a(L), from, &check("aaaa", "x"));
        r.inbound(a(L), from, &check("bbbb", "y"));
        assert_eq!(r.inbound(a(L), from, DTLS), Some(Owner::Peer("new".into())));
    }

    #[test]
    fn sockets_are_told_apart() {
        let mut r = Router::new();
        r.add_peer("p1", "aaaa");
        let from = a("198.51.100.9:4000");
        r.inbound(a(L), from, &check("aaaa", "x"));
        assert_eq!(r.inbound(a("[2a02::1]:50000"), from, DTLS), None);
    }

    #[test]
    fn removed_peers_and_old_transactions_are_forgotten() {
        let mut r = Router::new();
        r.add_peer("p1", "aaaa");
        let from = a("198.51.100.9:4000");
        r.inbound(a(L), from, &check("aaaa", "x"));
        let (_, req) = binding_request();
        let now = Instant::now();
        r.outbound(&Owner::Peer("p1".into()), a(L), from, &req, now);
        r.remove_peer("p1");
        assert_eq!(r.inbound(a(L), from, DTLS), None);
        assert_eq!(r.inbound(a(L), from, &check("aaaa", "x")), None);
        assert_eq!(r.pending(), 0);
        let (_, req) = binding_request();
        r.outbound(&Owner::Stun, a(L), a("1.1.1.1:3478"), &req, now);
        r.expire(now + Duration::from_secs(31));
        assert_eq!(r.pending(), 0);
    }

    #[test]
    fn outbound_packets_claim_the_address() {
        let mut r = Router::new();
        let to = a("198.51.100.9:4000");
        r.outbound(&Owner::Peer("p1".into()), a(L), to, DTLS, Instant::now());
        assert_eq!(r.inbound(a(L), to, DTLS), Some(Owner::Peer("p1".into())));
    }
}
