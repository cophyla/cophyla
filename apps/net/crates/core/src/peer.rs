//! One peer: an `rtc` peer connection with the one data channel cophylad speaks over, its
//! ICE credentials (which the router routes requests by), the remote candidates it was sent
//! and the ports predicted above them, and what it last reported. It owns no socket: the
//! core feeds it datagrams and sends what it hands back.

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use bytes::BytesMut;
use net_proto::{Candidate, IceTimeouts, PathType, PeerStateKind, CHANNEL_LABEL, MAX_FRAME};
use rand::distr::Alphanumeric;
use rand::Rng;
use rtc::data_channel::{RTCDataChannelId, RTCDataChannelInit};
use rtc::peer_connection::configuration::setting_engine::SettingEngineBuilder;
use rtc::peer_connection::configuration::RTCConfigurationBuilder;
use rtc::peer_connection::event::{RTCDataChannelEvent, RTCPeerConnectionEvent};
use rtc::peer_connection::message::{RTCMessage, TaggedRTCMessage};
use rtc::peer_connection::sdp::RTCSessionDescription;
use rtc::peer_connection::state::{RTCIceConnectionState, RTCPeerConnectionState};
use rtc::peer_connection::transport::RTCIceCandidateInit;
use rtc::peer_connection::{RTCPeerConnection, RTCPeerConnectionBuilder};
use rtc::sansio::Protocol;
use rtc::shared::TaggedBytesMut;
use rtc::statistics::report::RTCStatsReportEntry;
use rtc::statistics::StatsSelector;

use crate::path::{classify, CandidateKind, Ends};
use crate::predict::Predictor;

/// ICE's clocks when neither the peer nor the configuration says.
pub const DEFAULT_DISCONNECTED: Duration = Duration::from_secs(5);
pub const DEFAULT_FAILED: Duration = Duration::from_secs(15);
pub const DEFAULT_KEEPALIVE: Duration = Duration::from_secs(2);
/// Unacknowledged bytes at which the channel reports low again.
pub const BUFFERED_LOW: u32 = 64 * 1024;
/// The most a peer hands SCTP before the far end acknowledged it; the rest waits here. SCTP
/// recovers a burst lost from a large window only by its retransmission timer, whose floor is
/// a second, so the window is kept small enough for fast retransmit to cover a loss.
pub const SEND_WINDOW: usize = 128 * 1024;

pub type Error = Box<dyn std::error::Error + Send + Sync>;

/// What a peer hands the core after it was driven.
pub enum Out {
    Datagram(TaggedBytesMut),
    State(PeerStateKind, Option<String>),
    Open,
    Data(String),
    /// The channel's low-water mark was crossed downward.
    Drained,
}

/// Parses `candidate:… <ip> <port> typ <type> …` into its address and type.
pub fn parse_candidate(c: &str) -> Option<(SocketAddr, &str, &str)> {
    let body = c.strip_prefix("candidate:").unwrap_or(c);
    let f: Vec<&str> = body.split_whitespace().collect();
    if f.len() < 8 || f[6] != "typ" {
        return None;
    }
    let ip: std::net::IpAddr = f[4].parse().ok()?;
    let port: u16 = f[5].parse().ok()?;
    Some((SocketAddr::new(ip, port), f[2], f[7]))
}

fn random(n: usize) -> String {
    rand::rng().sample_iter(&Alphanumeric).take(n).map(char::from).collect()
}

fn to_init(c: &Candidate) -> RTCIceCandidateInit {
    RTCIceCandidateInit { candidate: c.candidate.clone(), sdp_mid: c.sdp_mid.clone(), sdp_mline_index: c.sdp_m_line_index, username_fragment: None, url: None }
}

pub struct Peer {
    pub id: String,
    pub ufrag: String,
    pc: RTCPeerConnection,
    channel: Option<RTCDataChannelId>,
    pub open: bool,
    remote_set: bool,
    /// Remote candidates that came before the remote description.
    early: Vec<RTCIceCandidateInit>,
    /// Local candidates added before the remote description: they go into the pc once it has one.
    local_early: Vec<RTCIceCandidateInit>,
    predictor: Predictor,
    pub predicted: HashSet<SocketAddr>,
    /// What each remote candidate the far end sent said it was: a pair that came up through an
    /// early check names its remote peer-reflexive even when the candidate arrived later.
    remote_kinds: HashMap<SocketAddr, CandidateKind>,
    /// The local candidates added so far, by kind and address, so a re-gather adds only new ones.
    pub local: HashSet<String>,
    pub ended_local: bool,
    pub state: PeerStateKind,
    pub last_path: Option<(PathType, String, String)>,
    pub next_path_at: Instant,
    pub buffered_reported: u64,
    pub created: Instant,
    mid: Option<String>,
    /// Frames waiting for room in the send window, and their bytes.
    waiting: VecDeque<String>,
    waiting_bytes: usize,
}

impl Peer {
    pub fn new(id: &str, predict: u16, ice: IceTimeouts, now: Instant) -> Result<Peer, Error> {
        let ufrag = random(8);
        let pwd = random(24);
        let ms = |v: Option<u64>, d: Duration| v.map(Duration::from_millis).unwrap_or(d);
        let setting = SettingEngineBuilder::new()
            .with_ice_credentials(ufrag.clone(), pwd)
            .with_ice_timeouts(Some(ms(ice.disconnected_ms, DEFAULT_DISCONNECTED)), Some(ms(ice.failed_ms, DEFAULT_FAILED)), Some(ms(ice.keepalive_ms, DEFAULT_KEEPALIVE)))
            .build();
        let pc = RTCPeerConnectionBuilder::new().with_configuration(RTCConfigurationBuilder::new().build()).with_setting_engine(setting).build(now)?;
        Ok(Peer {
            id: id.to_string(),
            ufrag,
            pc,
            channel: None,
            open: false,
            remote_set: false,
            early: Vec::new(),
            local_early: Vec::new(),
            predictor: Predictor::new(predict),
            predicted: HashSet::new(),
            remote_kinds: HashMap::new(),
            local: HashSet::new(),
            ended_local: false,
            state: PeerStateKind::New,
            last_path: None,
            next_path_at: now + Duration::from_secs(1),
            buffered_reported: 0,
            created: now,
            mid: None,
            waiting: VecDeque::new(),
            waiting_bytes: 0,
        })
    }

    /// This side offers: the channel is made here, so the SDP carries the data section.
    pub fn offer(&mut self, now: Instant) -> Result<String, Error> {
        let init = RTCDataChannelInit { ordered: true, ..Default::default() };
        let id = self.pc.create_data_channel(CHANNEL_LABEL, Some(init))?.id();
        self.channel = Some(id);
        let offer = self.pc.create_offer(None)?;
        self.pc.set_local_description(now, offer.clone())?;
        self.mid = mid_of(&offer.sdp);
        Ok(offer.sdp)
    }

    /// The far end offered: answer it.
    pub fn answer(&mut self, now: Instant, sdp: String) -> Result<String, Error> {
        self.pc.set_remote_description(now, RTCSessionDescription::offer(sdp)?)?;
        let answer = self.pc.create_answer(None)?;
        self.pc.set_local_description(now, answer.clone())?;
        self.mid = mid_of(&answer.sdp);
        self.remote_ready()?;
        Ok(answer.sdp)
    }

    /// The far end's answer to this side's offer.
    pub fn accept(&mut self, now: Instant, sdp: String) -> Result<(), Error> {
        self.pc.set_remote_description(now, RTCSessionDescription::answer(sdp)?)?;
        self.remote_ready()
    }

    fn remote_ready(&mut self) -> Result<(), Error> {
        self.remote_set = true;
        for c in std::mem::take(&mut self.local_early) {
            let _ = self.pc.add_local_candidate(c);
        }
        for c in std::mem::take(&mut self.early) {
            let _ = self.pc.add_remote_candidate(c);
        }
        Ok(())
    }

    /// Adds a local candidate once per `key` (its kind and address); returns it as it goes to
    /// the far end, or `None` when it was known.
    pub fn add_local(&mut self, key: String, init: RTCIceCandidateInit) -> Option<Candidate> {
        if !self.local.insert(key) {
            return None;
        }
        let out = Candidate { candidate: format!("candidate:{}", init.candidate.trim_start_matches("candidate:")), sdp_mid: self.mid.clone().or(Some("0".into())), sdp_m_line_index: Some(0) };
        if self.remote_set {
            let _ = self.pc.add_local_candidate(init);
        } else {
            self.local_early.push(init);
        }
        Some(out)
    }

    /// The end of this side's candidates.
    pub fn end_local(&mut self) {
        if self.ended_local {
            return;
        }
        self.ended_local = true;
        let end = RTCIceCandidateInit::default();
        if self.remote_set {
            let _ = self.pc.add_local_candidate(end);
        } else {
            self.local_early.push(end);
        }
    }

    /// A remote candidate, and the ports predicted above it when it is a reflexive one.
    /// Candidates this side cannot use (mDNS names, TCP) are dropped quietly.
    pub fn add_remote(&mut self, c: Option<Candidate>) {
        let Some(c) = c else { return };
        let text = c.candidate.trim();
        if text.is_empty() {
            return;
        }
        let Some((addr, transport, typ)) = parse_candidate(text) else { return };
        if !transport.eq_ignore_ascii_case("udp") {
            return;
        }
        if let Some(kind) = CandidateKind::parse(typ) {
            self.remote_kinds.entry(addr).or_insert(kind);
        }
        let mut all = vec![to_init(&c)];
        if typ == "srflx" {
            for port in self.predictor.predict(addr.ip(), addr.port()) {
                let predicted = SocketAddr::new(addr.ip(), port);
                if self.predicted.insert(predicted) {
                    let prio = 1_677_729_535u32.saturating_sub(u32::from(port - addr.port()));
                    all.push(RTCIceCandidateInit {
                        candidate: format!("candidate:9{port} 1 udp {prio} {} {port} typ srflx raddr 0.0.0.0 rport 0", addr.ip()),
                        sdp_mid: c.sdp_mid.clone(),
                        sdp_mline_index: c.sdp_m_line_index,
                        username_fragment: None,
                        url: None,
                    });
                }
            }
        }
        for init in all {
            if self.remote_set {
                let _ = self.pc.add_remote_candidate(init);
            } else {
                self.early.push(init);
            }
        }
    }

    pub fn handle_read(&mut self, msg: TaggedBytesMut) {
        let _ = self.pc.handle_read(msg);
    }

    pub fn poll_timeout(&mut self) -> Option<Instant> {
        self.pc.poll_timeout()
    }

    pub fn handle_timeout(&mut self, now: Instant) {
        let _ = self.pc.handle_timeout(now);
    }

    /// Sends one frame on the channel, in order behind any waiting for the window; refused
    /// when the channel is not open or the frame is too big.
    pub fn send(&mut self, now: Instant, data: String) -> Result<(), Error> {
        if data.len() > MAX_FRAME {
            return Err(format!("frame of {} bytes exceeds {MAX_FRAME}", data.len()).into());
        }
        self.channel.filter(|_| self.open).ok_or("the channel is not open")?;
        self.waiting_bytes += data.len();
        self.waiting.push_back(data);
        self.flush(now);
        Ok(())
    }

    /// Hands SCTP the waiting frames while the window has room.
    pub fn flush(&mut self, now: Instant) {
        let Some(id) = self.channel.filter(|_| self.open) else { return };
        let Some(mut dc) = self.pc.data_channel(id) else { return };
        while let Some(front) = self.waiting.front() {
            if dc.outstanding_bytes() + front.len() > SEND_WINDOW && dc.outstanding_bytes() > 0 {
                break;
            }
            let data = self.waiting.pop_front().unwrap();
            self.waiting_bytes -= data.len();
            if dc.send_text(now, data).is_err() {
                self.waiting.clear();
                self.waiting_bytes = 0;
                break;
            }
        }
    }

    /// Bytes waiting here and handed to the channel that the far end has not acknowledged.
    pub fn buffered(&mut self) -> u64 {
        let outstanding = match self.channel {
            Some(id) => self.pc.data_channel(id).map(|dc| dc.outstanding_bytes() as u64).unwrap_or(0),
            None => 0,
        };
        outstanding + self.waiting_bytes as u64
    }

    /// Drains what the connection produced: datagrams to send, state changes, frames.
    pub fn drain(&mut self, out: &mut Vec<Out>) {
        while let Some(event) = self.pc.poll_event() {
            match event {
                RTCPeerConnectionEvent::OnConnectionStateChangeEvent(s) => {
                    let (state, reason) = match s {
                        RTCPeerConnectionState::New => (PeerStateKind::New, None),
                        RTCPeerConnectionState::Connecting => (PeerStateKind::Connecting, None),
                        RTCPeerConnectionState::Connected => (PeerStateKind::Connected, None),
                        RTCPeerConnectionState::Disconnected => (PeerStateKind::Disconnected, Some("ICE disconnected".to_string())),
                        RTCPeerConnectionState::Failed => (PeerStateKind::Failed, Some("ICE failed".to_string())),
                        RTCPeerConnectionState::Closed => (PeerStateKind::Closed, None),
                        _ => continue,
                    };
                    if state != self.state {
                        self.state = state;
                        out.push(Out::State(state, reason));
                    }
                }
                RTCPeerConnectionEvent::OnIceConnectionStateChangeEvent(s) => {
                    // ICE says disconnected before the connection does; the path is re-read then.
                    if s == RTCIceConnectionState::Connected || s == RTCIceConnectionState::Completed {
                        self.next_path_at = Instant::now();
                    }
                }
                RTCPeerConnectionEvent::OnDataChannel(RTCDataChannelEvent::OnOpen(id)) => {
                    let mine = match self.channel {
                        Some(c) => c == id,
                        None => self.pc.data_channel(id).map(|dc| dc.label() == CHANNEL_LABEL).unwrap_or(false),
                    };
                    if !mine {
                        if let Some(mut dc) = self.pc.data_channel(id) {
                            let _ = dc.close();
                        }
                        continue;
                    }
                    self.channel = Some(id);
                    if let Some(mut dc) = self.pc.data_channel(id) {
                        dc.set_buffered_amount_low_threshold(BUFFERED_LOW);
                    }
                    if !self.open {
                        self.open = true;
                        self.next_path_at = Instant::now();
                        out.push(Out::Open);
                    }
                }
                RTCPeerConnectionEvent::OnDataChannel(RTCDataChannelEvent::OnClose(id)) if Some(id) == self.channel => {
                    if self.open || self.state != PeerStateKind::Closed {
                        self.open = false;
                        self.state = PeerStateKind::Closed;
                        out.push(Out::State(PeerStateKind::Closed, Some("the channel closed".into())));
                    }
                }
                RTCPeerConnectionEvent::OnDataChannel(RTCDataChannelEvent::OnBufferedAmountLow(id)) if Some(id) == self.channel => out.push(Out::Drained),
                _ => {}
            }
        }
        while let Some(TaggedRTCMessage { message, .. }) = self.pc.poll_read() {
            if let RTCMessage::DataChannelMessage(id, m) = message {
                if Some(id) != self.channel {
                    continue;
                }
                match String::from_utf8(m.data.to_vec()) {
                    Ok(text) => out.push(Out::Data(text)),
                    Err(_) => continue,
                }
            }
        }
        if !self.waiting.is_empty() {
            self.flush(Instant::now());
        }
        while let Some(d) = self.pc.poll_write() {
            out.push(Out::Datagram(d));
        }
    }

    /// The selected pair, classified: `(type, local, remote, rtt ms)`. The pair comes from the
    /// ICE transport (the stats leave out a peer-reflexive remote learned from an early check),
    /// the round trip from the stats.
    pub fn path(&mut self, now: Instant, mapped: Option<SocketAddr>) -> Option<(PathType, String, String, Option<f64>)> {
        let pair = self.pc.sctp()?.transport().ice_transport().get_selected_candidate_pair()?;
        let (l, r) = (pair.local(), pair.remote());
        let la = SocketAddr::new(l.address.parse().ok()?, l.port);
        let ra = SocketAddr::new(r.address.parse().ok()?, r.port);
        let lk = CandidateKind::parse(&l.typ.to_string())?;
        let mut rk = CandidateKind::parse(&r.typ.to_string())?;
        if rk == CandidateKind::Prflx {
            rk = self.remote_kinds.get(&ra).copied().unwrap_or(rk);
        }
        let kind = classify(&Ends { local: (lk, la), remote: (rk, ra), predicted: &self.predicted, mapped });
        let report = self.pc.get_stats(now, StatsSelector::None);
        let rtt = report
            .transport()
            .and_then(|t| report.get(&t.selected_candidate_pair_id))
            .and_then(|e| match e {
                RTCStatsReportEntry::IceCandidatePair(p) => Some(p.current_round_trip_time),
                _ => None,
            })
            .filter(|v| *v > 0.0)
            .map(|v| (v * 10_000.0).round() / 10.0);
        Some((kind, la.to_string(), ra.to_string(), rtt))
    }

    pub fn close(&mut self) {
        let _ = self.pc.close();
        self.open = false;
    }
}

/// The `a=mid:` of the first media section, which candidates name.
fn mid_of(sdp: &str) -> Option<String> {
    sdp.lines().find_map(|l| l.trim().strip_prefix("a=mid:").map(|m| m.trim().to_string()))
}

/// Keeps the core's `Out::Datagram` buffers small: a copy of a received slice.
pub fn bytes(b: &[u8]) -> BytesMut {
    BytesMut::from(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_text() {
        let (addr, transport, typ) = parse_candidate("candidate:842163049 1 udp 1677729535 198.51.100.9 55387 typ srflx raddr 0.0.0.0 rport 0 generation 0").unwrap();
        assert_eq!(addr, "198.51.100.9:55387".parse::<SocketAddr>().unwrap());
        assert_eq!(transport, "udp");
        assert_eq!(typ, "srflx");
        assert!(parse_candidate("candidate:1 1 udp 2122260223 abcd-1234.local 5000 typ host").is_none(), "mDNS names are not addresses");
        assert!(parse_candidate("garbage").is_none());
    }

    #[test]
    fn predicted_candidates_follow_a_reflexive_one() {
        let now = Instant::now();
        let mut p = Peer::new("p", 3, IceTimeouts::default(), now).unwrap();
        p.add_remote(Some(Candidate { candidate: "candidate:1 1 udp 1677729535 198.51.100.9 5000 typ srflx raddr 0.0.0.0 rport 0".into(), sdp_mid: Some("0".into()), sdp_m_line_index: Some(0) }));
        assert_eq!(p.predicted.len(), 3);
        assert!(p.predicted.contains(&"198.51.100.9:5003".parse().unwrap()));
        assert_eq!(p.early.len(), 4, "held until the remote description");
        p.add_remote(Some(Candidate { candidate: "candidate:2 1 udp 2122260223 192.168.0.5 5000 typ host".into(), sdp_mid: None, sdp_m_line_index: None }));
        assert_eq!(p.predicted.len(), 3, "a host candidate predicts nothing");
        p.add_remote(Some(Candidate { candidate: "candidate:3 1 tcp 1518280447 192.168.0.5 9 typ host tcptype active".into(), sdp_mid: None, sdp_m_line_index: None }));
        assert_eq!(p.early.len(), 5, "TCP is dropped");
    }

    #[test]
    fn frames_are_capped_and_need_an_open_channel() {
        let now = Instant::now();
        let mut p = Peer::new("p", 0, IceTimeouts::default(), now).unwrap();
        assert!(p.send(now, "x".repeat(MAX_FRAME + 1)).is_err());
        assert!(p.send(now, "x".into()).is_err());
    }

    #[test]
    fn an_offer_carries_a_data_section_and_the_ufrag() {
        let now = Instant::now();
        let mut p = Peer::new("p", 0, IceTimeouts::default(), now).unwrap();
        let sdp = p.offer(now).unwrap();
        assert!(sdp.contains("m=application"), "{sdp}");
        assert!(sdp.contains(&format!("a=ice-ufrag:{}", p.ufrag)), "{sdp}");
    }
}
