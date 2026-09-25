//! Just enough STUN (RFC 8489) for the mux: tell a STUN datagram from DTLS, read its class,
//! transaction id and `USERNAME` to route it, and run the helper's own binding requests
//! against STUN servers for the reflexive address. The peers' ICE checks are the `rtc`
//! crate's; nothing here takes part in them.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

const MAGIC: u32 = 0x2112_a442;
const HEADER: usize = 20;
const ATTR_USERNAME: u16 = 0x0006;
const ATTR_MAPPED_ADDRESS: u16 = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;
const BINDING: u16 = 0x0001;

pub type TxId = [u8; 12];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    Request,
    Indication,
    Success,
    Error,
}

/// What routing needs of a STUN datagram.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Peek {
    pub class: Class,
    pub method: u16,
    pub txid: TxId,
    /// The receiver's ufrag: the part of `USERNAME` before the colon, on a request.
    pub target_ufrag: Option<String>,
}

/// Whether a datagram is STUN: the first two bits zero, the magic cookie, a whole length.
pub fn is_stun(b: &[u8]) -> bool {
    b.len() >= HEADER && b[0] & 0xc0 == 0 && u32::from_be_bytes([b[4], b[5], b[6], b[7]]) == MAGIC && (u16::from_be_bytes([b[2], b[3]]) as usize) + HEADER <= b.len()
}

fn class_of(typ: u16) -> Class {
    match typ & 0x0110 {
        0x0000 => Class::Request,
        0x0010 => Class::Indication,
        0x0100 => Class::Success,
        _ => Class::Error,
    }
}

fn method_of(typ: u16) -> u16 {
    (typ & 0x000f) | ((typ & 0x00e0) >> 1) | ((typ & 0x3e00) >> 2)
}

/// The attributes of a STUN message as `(type, value)`, stopping at a malformed one.
fn attributes(b: &[u8]) -> impl Iterator<Item = (u16, &[u8])> {
    let end = HEADER + u16::from_be_bytes([b[2], b[3]]) as usize;
    let mut at = HEADER;
    std::iter::from_fn(move || {
        if at + 4 > end {
            return None;
        }
        let typ = u16::from_be_bytes([b[at], b[at + 1]]);
        let len = u16::from_be_bytes([b[at + 2], b[at + 3]]) as usize;
        let start = at + 4;
        if start + len > end {
            return None;
        }
        at = start + len.div_ceil(4) * 4;
        Some((typ, &b[start..start + len]))
    })
}

/// Reads what routing needs; `None` for anything that is not STUN.
pub fn peek(b: &[u8]) -> Option<Peek> {
    if !is_stun(b) {
        return None;
    }
    let typ = u16::from_be_bytes([b[0], b[1]]);
    let class = class_of(typ);
    let mut txid = [0u8; 12];
    txid.copy_from_slice(&b[8..20]);
    let target_ufrag = if class == Class::Request || class == Class::Indication {
        attributes(b).find(|(t, _)| *t == ATTR_USERNAME).and_then(|(_, v)| std::str::from_utf8(v).ok()).map(|u| u.split(':').next().unwrap_or("").to_string()).filter(|u| !u.is_empty())
    } else {
        None
    };
    Some(Peek { class, method: method_of(typ), txid, target_ufrag })
}

/// A bare binding request with a fresh transaction id.
pub fn binding_request() -> (TxId, Vec<u8>) {
    let txid: TxId = rand::random();
    let mut b = Vec::with_capacity(HEADER);
    b.extend_from_slice(&BINDING.to_be_bytes());
    b.extend_from_slice(&0u16.to_be_bytes());
    b.extend_from_slice(&MAGIC.to_be_bytes());
    b.extend_from_slice(&txid);
    (txid, b)
}

fn read_address(v: &[u8], xor: bool, txid: &TxId) -> Option<SocketAddr> {
    if v.len() < 4 {
        return None;
    }
    let family = v[1];
    let mut port = u16::from_be_bytes([v[2], v[3]]);
    if xor {
        port ^= (MAGIC >> 16) as u16;
    }
    match family {
        0x01 if v.len() >= 8 => {
            let mut a = [v[4], v[5], v[6], v[7]];
            if xor {
                for (i, x) in MAGIC.to_be_bytes().iter().enumerate() {
                    a[i] ^= x;
                }
            }
            Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::from(a)), port))
        }
        0x02 if v.len() >= 20 => {
            let mut a = [0u8; 16];
            a.copy_from_slice(&v[4..20]);
            if xor {
                let mut key = [0u8; 16];
                key[..4].copy_from_slice(&MAGIC.to_be_bytes());
                key[4..].copy_from_slice(txid);
                for i in 0..16 {
                    a[i] ^= key[i];
                }
            }
            Some(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(a)), port))
        }
        _ => None,
    }
}

/// The mapped address a binding success response carries (XOR-MAPPED-ADDRESS, or the old MAPPED-ADDRESS).
pub fn mapped_address(b: &[u8]) -> Option<SocketAddr> {
    let p = peek(b)?;
    if p.class != Class::Success || p.method != BINDING {
        return None;
    }
    let mut plain = None;
    for (t, v) in attributes(b) {
        if t == ATTR_XOR_MAPPED_ADDRESS {
            return read_address(v, true, &p.txid);
        }
        if t == ATTR_MAPPED_ADDRESS {
            plain = read_address(v, false, &p.txid);
        }
    }
    plain
}

/// `stun:host:port`, `stun:host` or `host:port` as `(host, port)`; `turn:` and `turns:` URLs are not STUN servers here.
pub fn parse_server(url: &str) -> Option<(String, u16)> {
    let rest = if let Some(r) = url.strip_prefix("stun:") {
        r
    } else if url.contains("://") || url.starts_with("turn:") || url.starts_with("turns:") {
        return None;
    } else {
        url
    };
    let rest = rest.split('?').next().unwrap_or(rest);
    if let Some(v6) = rest.strip_prefix('[') {
        let (host, tail) = v6.split_once(']')?;
        let port = tail.strip_prefix(':').map(|p| p.parse().ok()).unwrap_or(Some(3478))?;
        return Some((host.to_string(), port));
    }
    match rest.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => Some((host.to_string(), port.parse().ok()?)),
        _ if !rest.is_empty() => Some((rest.to_string(), 3478)),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A binding success response for `txid` carrying `addr` as XOR-MAPPED-ADDRESS.
    pub(crate) fn success(txid: TxId, addr: SocketAddr) -> Vec<u8> {
        let mut value = vec![0u8, 0];
        match addr {
            SocketAddr::V4(a) => {
                value[1] = 1;
                value.extend_from_slice(&(a.port() ^ 0x2112).to_be_bytes());
                let mut o = a.ip().octets();
                for (i, x) in MAGIC.to_be_bytes().iter().enumerate() {
                    o[i] ^= x;
                }
                value.extend_from_slice(&o);
            }
            SocketAddr::V6(a) => {
                value[1] = 2;
                value.extend_from_slice(&(a.port() ^ 0x2112).to_be_bytes());
                let mut o = a.ip().octets();
                let mut key = [0u8; 16];
                key[..4].copy_from_slice(&MAGIC.to_be_bytes());
                key[4..].copy_from_slice(&txid);
                for i in 0..16 {
                    o[i] ^= key[i];
                }
                value.extend_from_slice(&o);
            }
        }
        let mut b = Vec::new();
        b.extend_from_slice(&0x0101u16.to_be_bytes());
        b.extend_from_slice(&((4 + value.len()) as u16).to_be_bytes());
        b.extend_from_slice(&MAGIC.to_be_bytes());
        b.extend_from_slice(&txid);
        b.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        b.extend_from_slice(&(value.len() as u16).to_be_bytes());
        b.extend_from_slice(&value);
        b
    }

    /// A binding request from `sender` to `receiver`'s ufrag, as ICE sends one.
    pub(crate) fn check(receiver: &str, sender: &str) -> Vec<u8> {
        let user = format!("{receiver}:{sender}");
        let padded = user.len().div_ceil(4) * 4;
        let mut b = Vec::new();
        b.extend_from_slice(&BINDING.to_be_bytes());
        b.extend_from_slice(&((4 + padded) as u16).to_be_bytes());
        b.extend_from_slice(&MAGIC.to_be_bytes());
        b.extend_from_slice(&[7u8; 12]);
        b.extend_from_slice(&ATTR_USERNAME.to_be_bytes());
        b.extend_from_slice(&(user.len() as u16).to_be_bytes());
        b.extend_from_slice(user.as_bytes());
        b.resize(HEADER + 4 + padded, 0);
        b
    }

    #[test]
    fn request_round_trip() {
        let (txid, req) = binding_request();
        let p = peek(&req).unwrap();
        assert_eq!(p.class, Class::Request);
        assert_eq!(p.method, BINDING);
        assert_eq!(p.txid, txid);
        assert_eq!(p.target_ufrag, None);
    }

    #[test]
    fn mapped_address_v4_and_v6() {
        let txid = [9u8; 12];
        let v4: SocketAddr = "203.0.113.7:40123".parse().unwrap();
        assert_eq!(mapped_address(&success(txid, v4)), Some(v4));
        let v6: SocketAddr = "[2a02:1234::99]:5000".parse().unwrap();
        assert_eq!(mapped_address(&success(txid, v6)), Some(v6));
        assert_eq!(peek(&success(txid, v4)).unwrap().class, Class::Success);
    }

    #[test]
    fn username_names_the_receiver() {
        let p = peek(&check("abcd", "wxyz")).unwrap();
        assert_eq!(p.target_ufrag.as_deref(), Some("abcd"));
    }

    #[test]
    fn dtls_and_garbage_are_not_stun() {
        assert!(!is_stun(&[22, 254, 253, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        assert!(!is_stun(&[0u8; 10]));
        let (_, mut req) = binding_request();
        req[2] = 0;
        req[3] = 40;
        assert!(!is_stun(&req), "a length past the datagram");
    }

    #[test]
    fn server_urls() {
        assert_eq!(parse_server("stun:stun.cloudflare.com:3478"), Some(("stun.cloudflare.com".into(), 3478)));
        assert_eq!(parse_server("stun:stun.l.google.com"), Some(("stun.l.google.com".into(), 3478)));
        assert_eq!(parse_server("1.2.3.4:19302"), Some(("1.2.3.4".into(), 19302)));
        assert_eq!(parse_server("stun:[2001:4860::1]:19302"), Some(("2001:4860::1".into(), 19302)));
        assert_eq!(parse_server("turn:turn.cloudflare.com:3478?transport=udp"), None);
        assert_eq!(parse_server("stun:x.example:53?transport=udp"), Some(("x.example".into(), 53)));
    }
}
