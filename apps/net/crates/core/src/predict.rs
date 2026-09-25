//! Port prediction, spike 16's rule. A NAT that hands its ports out in sequence maps the
//! peer's socket toward this node to one just above the ports STUN saw for it; so for every
//! reflexive candidate the peer sends, the next `n` ports on the same address become remote
//! candidates too. This side's checks to them open its own router for the one the peer's
//! NAT picked, and the pair comes up. A random-port NAT defeats it; the checks then cost a
//! few dozen STUN packets and nothing else.

use std::collections::HashMap;
use std::net::IpAddr;

/// The most ports predicted for one peer, whatever it sends.
pub const MAX_PREDICTED: usize = 64;

#[derive(Debug, Default)]
pub struct Predictor {
    n: u16,
    /// Per public address, the highest port predicted so far.
    high: HashMap<IpAddr, u16>,
    count: usize,
}

impl Predictor {
    pub fn new(n: u16) -> Self {
        Predictor { n, high: HashMap::new(), count: 0 }
    }

    /// The ports to add for a reflexive candidate at `ip:port`: above both it and what was
    /// predicted for the address before, `n` of them, none past 65535 or the peer's cap.
    pub fn predict(&mut self, ip: IpAddr, port: u16) -> Vec<u16> {
        if self.n == 0 || self.count >= MAX_PREDICTED {
            return Vec::new();
        }
        let before = self.high.get(&ip).copied();
        let top = port.max(before.unwrap_or(0));
        let from = before.unwrap_or(port).max(port).saturating_add(1);
        let to = top.saturating_add(self.n);
        self.high.insert(ip, to);
        let room = MAX_PREDICTED - self.count;
        let out: Vec<u16> = (from..=to).filter(|p| *p > port).take(room).collect();
        self.count += out.len();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip() -> IpAddr {
        "198.51.100.9".parse().unwrap()
    }

    #[test]
    fn the_next_n_ports() {
        let mut p = Predictor::new(4);
        assert_eq!(p.predict(ip(), 55387), vec![55388, 55389, 55390, 55391]);
    }

    #[test]
    fn a_second_candidate_extends_above_the_high_water_mark() {
        let mut p = Predictor::new(4);
        p.predict(ip(), 100);
        // a lower port than predicted before: continue above the mark, not over it
        assert_eq!(p.predict(ip(), 102), vec![105, 106, 107, 108]);
        // a higher one than everything: above it
        assert_eq!(p.predict(ip(), 200), vec![201, 202, 203, 204]);
    }

    #[test]
    fn addresses_are_predicted_apart() {
        let mut p = Predictor::new(2);
        p.predict(ip(), 100);
        assert_eq!(p.predict("198.51.100.10".parse().unwrap(), 100), vec![101, 102]);
    }

    #[test]
    fn never_past_65535_or_the_cap() {
        let mut p = Predictor::new(12);
        assert_eq!(p.predict(ip(), 65530), vec![65531, 65532, 65533, 65534, 65535]);
        let mut q = Predictor::new(40);
        assert_eq!(q.predict(ip(), 1000).len(), 40);
        assert_eq!(q.predict(ip(), 3000).len(), MAX_PREDICTED - 40);
        assert!(q.predict(ip(), 9000).is_empty());
    }

    #[test]
    fn zero_predicts_nothing() {
        assert!(Predictor::new(0).predict(ip(), 100).is_empty());
    }
}
