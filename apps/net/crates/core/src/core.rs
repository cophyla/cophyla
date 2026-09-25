//! The helper's engine: one UDP port bound on every usable address, the peers sharing it,
//! the helper's own STUN rounds for the reflexive address, the router's mapping, and the
//! reports cophylad reads. It runs as one task: requests and frames come in on a channel,
//! datagrams from a reader task per socket, and everything it has to say goes out on
//! another channel, replies in order with the notifications around them, so an answer's
//! SDP always reaches cophylad before the candidates that follow it.

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;
use std::time::{Duration, Instant};

use net_proto::{
    Candidate, Configure, Configured, IceTimeouts, MapPorts, MappedPorts, Mapping, MappingStatus, NetState, PathType, PeerAccept, PeerAnswer, PeerBuffered, PeerCandidate, PeerFrame, PeerOffer, PeerPath, PeerRef, PeerState, PeerStateKind, Sdp,
};
use rtc::peer_connection::transport::{CandidateConfig, CandidateHostConfig, CandidateServerReflexiveConfig, RTCIceCandidate, RTCIceCandidateInit};
use rtc::shared::{TaggedBytesMut, TransportContext, TransportProtocol};
use serde_json::{json, Value};
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, watch};

use crate::gather::{is_global_v6, local_addresses, GatherOptions};
use crate::peer::{bytes, Out, Peer};
use crate::portmap::PortMap;
use crate::route::{Owner, Router};
use crate::stun::{binding_request, mapped_address, parse_server, TxId};

/// A request cophylad makes; each gets exactly one `Output::Reply` with its id.
#[derive(Debug)]
pub enum Request {
    Configure(Configure),
    Offer(PeerOffer),
    Answer(PeerAnswer),
    Accept(PeerAccept),
    Candidate(PeerCandidate),
    Close(PeerRef),
    MapPorts(MapPorts),
}

#[derive(Debug)]
pub enum Input {
    Request { id: Value, req: Request },
    Send(PeerFrame),
    Shutdown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreError {
    /// A protocol error code cophylad knows: `invalid`, `not_found`, `unavailable`, `conflict`.
    pub code: &'static str,
    pub message: String,
}

impl CoreError {
    fn new(code: &'static str, message: impl Into<String>) -> CoreError {
        CoreError { code, message: message.into() }
    }
}

#[derive(Debug)]
pub enum Output {
    Reply { id: Value, result: Result<Value, CoreError> },
    Candidate(PeerCandidate),
    State(PeerState),
    Open(PeerRef),
    Data(PeerFrame),
    Buffered(PeerBuffered),
    Path(PeerPath),
    Net(NetState),
}

impl Output {
    /// The notification's method and params; `None` for a reply.
    pub fn notification(&self) -> Option<(&'static str, Value)> {
        let v = |x: &dyn erased::Ser| x.value();
        Some(match self {
            Output::Reply { .. } => return None,
            Output::Candidate(c) => ("peer.candidate", v(c)),
            Output::State(s) => ("peer.state", v(s)),
            Output::Open(p) => ("peer.open", v(p)),
            Output::Data(f) => ("peer.data", v(f)),
            Output::Buffered(b) => ("peer.buffered", v(b)),
            Output::Path(p) => ("peer.path", v(p)),
            Output::Net(n) => ("net.state", v(n)),
        })
    }
}

mod erased {
    pub trait Ser {
        fn value(&self) -> serde_json::Value;
    }
    impl<T: serde::Serialize> Ser for T {
        fn value(&self) -> serde_json::Value {
            serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
        }
    }
}

/// One line on stderr, as JSON: what cophylad keeps as the helper's log.
pub fn log(level: &str, msg: &str, fields: Value) {
    let mut line = json!({ "level": level, "msg": msg });
    if let (Value::Object(o), Value::Object(f)) = (&mut line, fields) {
        o.extend(f);
    }
    eprintln!("{line}");
}

struct Sock {
    addr: SocketAddr,
    socket: Arc<UdpSocket>,
    reader: tokio::task::JoinHandle<()>,
    /// Datagrams the socket would not take yet, in order: a burst larger than its buffer
    /// waits here rather than being lost, which SCTP would read as congestion.
    queued: VecDeque<(Vec<u8>, SocketAddr)>,
}

impl Drop for Sock {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

struct Datagram {
    local: SocketAddr,
    remote: SocketAddr,
    data: Vec<u8>,
    at: Instant,
}

struct StunRound {
    started: Instant,
    next: Instant,
    tries: u8,
}

/// How long a peer lives on after it failed, for cophylad to read why before it closes it.
const FAILED_LINGER: Duration = Duration::from_secs(30);
/// A reflexive address older than this is asked for again when a peer comes.
const STUN_FRESH: Duration = Duration::from_secs(20);
const STUN_PERIOD: Duration = Duration::from_secs(300);
const STUN_ROUND: Duration = Duration::from_secs(3);
const IFACE_PERIOD: Duration = Duration::from_secs(30);
const MAPPING_WAIT: Duration = Duration::from_secs(15);
const PATH_EARLY: Duration = Duration::from_secs(2);
const PATH_PERIOD: Duration = Duration::from_secs(10);
const BUFFERED_TICK: Duration = Duration::from_millis(100);
const BUFFERED_STEP: u64 = 64 * 1024;
/// Datagrams a socket may hold back before more are dropped.
const SEND_QUEUE_MAX: usize = 4096;
/// The sockets' own buffers: room for a congestion window's burst, and for a burst arriving.
const SEND_BUFFER: usize = 2 << 20;
const RECV_BUFFER: usize = 4 << 20;

/// A non-blocking UDP socket at `addr` with large buffers; IPv6 ones take IPv6 alone.
fn udp_socket(addr: SocketAddr) -> std::io::Result<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let s = Socket::new(Domain::for_address(addr), Type::DGRAM, Some(Protocol::UDP))?;
    if addr.is_ipv6() {
        s.set_only_v6(true)?;
    }
    // best effort: a system that caps the buffers keeps its own sizes
    let _ = s.set_send_buffer_size(SEND_BUFFER);
    let _ = s.set_recv_buffer_size(RECV_BUFFER);
    s.set_nonblocking(true)?;
    s.bind(&addr.into())?;
    UdpSocket::from_std(s.into())
}

struct Live {
    peer: Peer,
    failed_at: Option<Instant>,
    buffered_dirty: bool,
    next_buffered_at: Instant,
    path_reported_at: Option<Instant>,
}

pub struct Core {
    cfg: Configure,
    configured: bool,
    port: u16,
    socks: Vec<Sock>,
    dgrams: mpsc::Sender<Datagram>,
    peers: HashMap<String, Live>,
    router: Router,
    servers: Vec<SocketAddr>,
    reflexive: HashMap<SocketAddr, SocketAddr>,
    stun_tx: HashMap<TxId, SocketAddr>,
    stun_round: Option<StunRound>,
    stun_ok_at: Option<Instant>,
    next_stun_at: Option<Instant>,
    portmap: Option<PortMap>,
    map_rx: Option<watch::Receiver<Option<std::net::SocketAddrV4>>>,
    mapping: Mapping,
    mapping_since: Option<Instant>,
    out: mpsc::UnboundedSender<Output>,
    last_net: Option<NetState>,
    next_iface_at: Instant,
    next_expire_at: Instant,
}

fn host_init(addr: SocketAddr) -> Option<RTCIceCandidateInit> {
    let c = CandidateHostConfig { base_config: CandidateConfig { network: "udp".into(), address: addr.ip().to_string(), port: addr.port(), component: 1, ..Default::default() }, ..Default::default() }.new_candidate_host().ok()?;
    RTCIceCandidate::from(&c).to_json().ok()
}

fn srflx_init(external: SocketAddr, base: SocketAddr) -> Option<RTCIceCandidateInit> {
    let c = CandidateServerReflexiveConfig {
        base_config: CandidateConfig { network: "udp".into(), address: external.ip().to_string(), port: external.port(), component: 1, ..Default::default() },
        rel_addr: base.ip().to_string(),
        rel_port: base.port(),
        url: None,
    }
    .new_candidate_server_reflexive()
    .ok()?;
    RTCIceCandidate::from(&c).to_json().ok()
}

impl Core {
    fn new(out: mpsc::UnboundedSender<Output>, dgrams: mpsc::Sender<Datagram>) -> Core {
        let now = Instant::now();
        Core {
            cfg: Configure::default(),
            configured: false,
            port: 0,
            socks: Vec::new(),
            dgrams,
            peers: HashMap::new(),
            router: Router::new(),
            servers: Vec::new(),
            reflexive: HashMap::new(),
            stun_tx: HashMap::new(),
            stun_round: None,
            stun_ok_at: None,
            next_stun_at: None,
            portmap: None,
            map_rx: None,
            mapping: Mapping { status: MappingStatus::Off, protocols: Vec::new(), external: None },
            mapping_since: None,
            out,
            last_net: None,
            next_iface_at: now + IFACE_PERIOD,
            next_expire_at: now + Duration::from_secs(5),
        }
    }

    fn emit(&self, o: Output) {
        let _ = self.out.send(o);
    }

    fn reply(&self, id: Value, result: Result<Value, CoreError>) {
        self.emit(Output::Reply { id, result });
    }

    fn gather_options(&self) -> GatherOptions {
        GatherOptions { ipv6: self.cfg.ipv6, loopback: self.cfg.loopback, skip: self.cfg.skip_interfaces.clone() }
    }

    // --- sockets --------------------------------------------------------------------------------

    fn spawn_reader(&self, socket: Arc<UdpSocket>, addr: SocketAddr) -> tokio::task::JoinHandle<()> {
        let tx = self.dgrams.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 2048];
            loop {
                match socket.recv_from(&mut buf).await {
                    Ok((n, remote)) => {
                        let d = Datagram { local: addr, remote, data: buf[..n].to_vec(), at: Instant::now() };
                        if tx.try_send(d).is_err() && tx.is_closed() {
                            return;
                        }
                    }
                    // Windows reports an ICMP port-unreachable for an earlier send as an error
                    // on the next read (WSAECONNRESET); the socket is fine.
                    Err(_) => tokio::time::sleep(Duration::from_millis(1)).await,
                }
            }
        })
    }

    async fn bind(&mut self, ip: IpAddr, port: u16) -> Option<SocketAddr> {
        let socket = udp_socket(SocketAddr::new(ip, port)).ok()?;
        let addr = socket.local_addr().ok()?;
        let socket = Arc::new(socket);
        let reader = self.spawn_reader(socket.clone(), addr);
        self.socks.push(Sock { addr, socket, reader, queued: VecDeque::new() });
        Some(addr)
    }

    /// Binds the port on every usable address not bound yet, and drops the ones gone. The
    /// first bind picks the port when none is set (or the set one is taken); the others take it.
    async fn rebind(&mut self) -> bool {
        let ips = local_addresses(&self.gather_options()).await;
        let before: Vec<SocketAddr> = self.socks.iter().map(|s| s.addr).collect();
        self.socks.retain(|s| ips.contains(&s.addr.ip()));
        let removed: Vec<SocketAddr> = before.iter().filter(|a| !self.socks.iter().any(|s| s.addr == **a)).copied().collect();
        for a in &removed {
            self.reflexive.remove(a);
        }
        let mut added = Vec::new();
        for ip in ips {
            if self.socks.iter().any(|s| s.addr.ip() == ip) {
                continue;
            }
            let bound = if self.port != 0 { self.bind(ip, self.port).await } else { None };
            let bound = match bound {
                Some(a) => Some(a),
                // the port is free for the taking only while nothing is bound on it yet
                None if self.socks.is_empty() => self.bind(ip, 0).await,
                None => None,
            };
            if let Some(a) = bound {
                self.port = a.port();
                added.push(a);
            } else {
                log("warn", "could not bind the port on an address", json!({ "ip": ip.to_string(), "port": self.port }));
            }
        }
        if !added.is_empty() {
            log("info", "listening", json!({ "addresses": added.iter().map(|a| a.to_string()).collect::<Vec<_>>() }));
        }
        !added.is_empty() || !removed.is_empty()
    }

    fn send_datagram(&mut self, owner: &Owner, d: TaggedBytesMut, now: Instant) {
        let local = d.transport.local_addr;
        let remote = d.transport.peer_addr;
        self.router.outbound(owner, local, remote, &d.message, now);
        self.send_raw(local, &d.message, remote);
    }

    /// Sends on the socket bound at `local`, queueing behind what it would not take yet.
    fn send_raw(&mut self, local: SocketAddr, data: &[u8], remote: SocketAddr) {
        let Some(s) = self.socks.iter_mut().find(|s| s.addr == local) else { return };
        if s.queued.is_empty() {
            match s.socket.try_send_to(data, remote) {
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                _ => return,
            }
        }
        if s.queued.len() < SEND_QUEUE_MAX {
            s.queued.push_back((data.to_vec(), remote));
        }
    }

    /// Sends what the sockets queued, as far as they take it now.
    fn flush_queued(&mut self) {
        for s in &mut self.socks {
            while let Some((data, remote)) = s.queued.front() {
                match s.socket.try_send_to(data, *remote) {
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    _ => {
                        s.queued.pop_front();
                    }
                }
            }
        }
    }

    fn has_queued(&self) -> bool {
        self.socks.iter().any(|s| !s.queued.is_empty())
    }

    // --- candidates -----------------------------------------------------------------------------

    /// Every local candidate there is now, keyed so a peer takes each once.
    fn local_candidates(&self) -> Vec<(String, RTCIceCandidateInit)> {
        let mut out = Vec::new();
        for s in &self.socks {
            if let Some(c) = host_init(s.addr) {
                out.push((format!("host {}", s.addr), c));
            }
        }
        for s in &self.socks {
            if let Some(ext) = self.reflexive.get(&s.addr) {
                if *ext != s.addr {
                    if let Some(c) = srflx_init(*ext, s.addr) {
                        out.push((format!("srflx {ext}"), c));
                    }
                }
            }
        }
        if let Some(ext) = self.mapped() {
            let base = self.socks.iter().find(|s| s.addr.is_ipv4() && !s.addr.ip().is_loopback()).map(|s| s.addr);
            if let Some(base) = base {
                if let Some(c) = srflx_init(ext, base) {
                    out.push((format!("srflx {ext}"), c));
                }
            }
        }
        out
    }

    fn mapped(&self) -> Option<SocketAddr> {
        self.mapping.external.as_ref().and_then(|e| e.parse().ok())
    }

    /// Gives every live peer the candidates it does not have yet, and tells cophylad.
    fn trickle(&mut self) {
        let all = self.local_candidates();
        let mut sent = Vec::new();
        for live in self.peers.values_mut() {
            if live.failed_at.is_some() {
                continue;
            }
            for (key, init) in &all {
                if let Some(c) = live.peer.add_local(key.clone(), init.clone()) {
                    sent.push(PeerCandidate { peer: live.peer.id.clone(), candidate: Some(c) });
                }
            }
        }
        for c in sent {
            self.emit(Output::Candidate(c));
        }
    }

    // --- STUN -----------------------------------------------------------------------------------

    async fn resolve_servers(&mut self) {
        let mut out = Vec::new();
        for url in &self.cfg.stun {
            let Some((host, port)) = parse_server(url) else { continue };
            let found = tokio::time::timeout(Duration::from_secs(3), tokio::net::lookup_host((host.as_str(), port))).await;
            match found {
                Ok(Ok(addrs)) => {
                    let mut v4 = 0;
                    let mut v6 = 0;
                    for a in addrs {
                        let n = if a.is_ipv4() { &mut v4 } else { &mut v6 };
                        if *n < 1 && !out.contains(&a) {
                            *n += 1;
                            out.push(a);
                        }
                    }
                }
                _ => log("warn", "a STUN server did not resolve", json!({ "server": url })),
            }
        }
        self.servers = out;
    }

    fn start_stun(&mut self, now: Instant) {
        if self.servers.is_empty() || self.socks.is_empty() || self.stun_round.is_some() {
            return;
        }
        self.stun_round = Some(StunRound { started: now, next: now, tries: 0 });
    }

    /// One round's sends: every socket to every server of its family, three times at most.
    fn stun_tick(&mut self, now: Instant) {
        let Some(round) = self.stun_round.as_mut() else { return };
        if now.duration_since(round.started) >= STUN_ROUND {
            self.stun_round = None;
            self.next_stun_at = Some(now + STUN_PERIOD);
            self.stun_tx.clear();
            self.publish();
            return;
        }
        if now < round.next || round.tries >= 3 {
            return;
        }
        round.tries += 1;
        round.next = now + Duration::from_millis(if round.tries == 1 { 500 } else { 1000 });
        let socks: Vec<SocketAddr> = self.socks.iter().map(|s| s.addr).filter(|a| !a.ip().is_loopback() && !self.reflexive_is_fresh(a, now)).collect();
        for local in socks {
            for server in self.servers.clone() {
                if server.is_ipv4() != local.is_ipv4() {
                    continue;
                }
                let (txid, req) = binding_request();
                self.stun_tx.insert(txid, local);
                self.router.outbound(&Owner::Stun, local, server, &req, now);
                self.send_raw(local, &req, server);
            }
        }
    }

    fn reflexive_is_fresh(&self, local: &SocketAddr, now: Instant) -> bool {
        // within a round, a socket that got its answer is not asked again
        self.reflexive.contains_key(local) && self.stun_round.as_ref().is_some_and(|r| self.stun_ok_at.is_some_and(|t| t >= r.started && now >= t))
    }

    fn on_stun(&mut self, d: &Datagram) {
        let Some(mapped) = mapped_address(&d.data) else { return };
        let before = self.reflexive.insert(d.local, mapped);
        self.stun_ok_at = Some(d.at);
        if before != Some(mapped) {
            log("info", "reflexive address", json!({ "local": d.local.to_string(), "reflexive": mapped.to_string() }));
            self.trickle();
            self.publish();
        }
    }

    // --- the mapping --------------------------------------------------------------------------

    fn start_mapping(&mut self, now: Instant) {
        if !self.cfg.map || self.port == 0 {
            self.portmap = None;
            self.map_rx = None;
            self.mapping = Mapping { status: MappingStatus::Off, protocols: Vec::new(), external: None };
            return;
        }
        if self.portmap.as_ref().is_some_and(|p| p.port() == self.port) {
            return;
        }
        let pm = PortMap::start(self.port);
        self.map_rx = Some(pm.watch());
        self.portmap = Some(pm);
        self.mapping = Mapping { status: MappingStatus::Probing, protocols: Vec::new(), external: None };
        self.mapping_since = Some(now);
    }

    /// The router's external address for the port changed.
    fn on_mapping(&mut self, external: Option<std::net::SocketAddrV4>) {
        match external {
            Some(ext) => {
                self.mapping.status = MappingStatus::Mapped;
                self.mapping.external = Some(ext.to_string());
                log("info", "port mapped on the router", json!({ "external": ext.to_string(), "port": self.port }));
                self.trickle();
            }
            None => {
                self.mapping.external = None;
                if self.mapping.status == MappingStatus::Mapped {
                    self.mapping.status = MappingStatus::None;
                }
            }
        }
        self.publish();
    }

    fn mapping_tick(&mut self, now: Instant) {
        if self.mapping.status == MappingStatus::Probing && self.mapping_since.is_some_and(|t| now.duration_since(t) >= MAPPING_WAIT) {
            self.mapping.status = MappingStatus::None;
            log("info", "no router mapped the port", json!({ "port": self.port }));
            self.publish();
        }
    }

    // --- reports ------------------------------------------------------------------------------

    fn net_state(&self) -> NetState {
        let mut reflexive: Vec<String> = self.reflexive.values().map(|a| a.to_string()).collect();
        reflexive.sort();
        reflexive.dedup();
        NetState {
            port: self.port,
            addresses: self.socks.iter().map(|s| s.addr.to_string()).collect(),
            reflexive,
            mapping: self.mapping.clone(),
            ipv6: self.socks.iter().any(|s| is_global_v6(s.addr.ip())),
        }
    }

    fn publish(&mut self) {
        if !self.configured {
            return;
        }
        let s = self.net_state();
        if self.last_net.as_ref() != Some(&s) {
            self.last_net = Some(s.clone());
            self.emit(Output::Net(s));
        }
    }

    // --- requests -----------------------------------------------------------------------------

    async fn request(&mut self, id: Value, req: Request) {
        let now = Instant::now();
        match req {
            Request::Configure(c) => {
                let r = self.configure(c).await;
                self.reply(id, r.map(|c| serde_json::to_value(c).unwrap_or(Value::Null)));
                self.start_stun(Instant::now());
                self.publish();
            }
            Request::Offer(p) => {
                let r = self.new_peer(&p.peer, p.ice, now, |peer, now| peer.offer(now));
                let ok = r.is_ok();
                self.reply(id, r.map(|sdp| serde_json::to_value(Sdp { sdp }).unwrap_or(Value::Null)));
                if ok {
                    self.after_new_peer(now);
                }
            }
            Request::Answer(p) => {
                let sdp = p.sdp;
                let r = self.new_peer(&p.peer, p.ice, now, move |peer, now| peer.answer(now, sdp));
                let ok = r.is_ok();
                self.reply(id, r.map(|sdp| serde_json::to_value(Sdp { sdp }).unwrap_or(Value::Null)));
                if ok {
                    self.after_new_peer(now);
                }
            }
            Request::Accept(p) => {
                let r = match self.peers.get_mut(&p.peer) {
                    None => Err(CoreError::new("not_found", format!("no peer {}", p.peer))),
                    Some(live) => match catch_unwind(AssertUnwindSafe(|| live.peer.accept(now, p.sdp))) {
                        Ok(Ok(())) => Ok(json!({})),
                        Ok(Err(e)) => Err(CoreError::new("invalid", format!("the answer was refused: {e}"))),
                        Err(_) => Err(CoreError::new("unavailable", "the peer failed")),
                    },
                };
                self.reply(id, r);
            }
            Request::Candidate(c) => {
                let r = match self.peers.get_mut(&c.peer) {
                    None => Err(CoreError::new("not_found", format!("no peer {}", c.peer))),
                    Some(live) => {
                        let _ = catch_unwind(AssertUnwindSafe(|| live.peer.add_remote(c.candidate)));
                        Ok(json!({}))
                    }
                };
                self.reply(id, r);
            }
            Request::Close(p) => {
                self.remove_peer(&p.peer, now);
                self.reply(id, Ok(json!({})));
            }
            Request::MapPorts(m) => {
                let r = match self.portmap.as_mut() {
                    Some(pm) => Ok(serde_json::to_value(MappedPorts { ports: pm.map_extra(&m.ports) }).unwrap_or(Value::Null)),
                    None => Err(CoreError::new("unavailable", "port mapping is off")),
                };
                self.reply(id, r);
            }
        }
    }

    async fn configure(&mut self, c: Configure) -> Result<Configured, CoreError> {
        let port_changed = self.configured && c.port != 0 && c.port != self.port;
        let addresses_changed = self.configured && (c.ipv6 != self.cfg.ipv6 || c.loopback != self.cfg.loopback || c.skip_interfaces != self.cfg.skip_interfaces);
        let stun_changed = c.stun != self.cfg.stun;
        if !self.configured || port_changed {
            self.port = c.port;
        }
        if port_changed || addresses_changed {
            self.socks.clear();
            self.reflexive.clear();
        }
        self.cfg = c;
        if !self.configured || stun_changed {
            self.resolve_servers().await;
        }
        self.rebind().await;
        if self.socks.is_empty() {
            return Err(CoreError::new("unavailable", "no usable address to listen on"));
        }
        self.configured = true;
        self.start_mapping(Instant::now());
        Ok(Configured { port: self.port, addresses: self.socks.iter().map(|s| s.addr.to_string()).collect() })
    }

    fn new_peer(&mut self, id: &str, ice: Option<IceTimeouts>, now: Instant, start: impl FnOnce(&mut Peer, Instant) -> Result<String, crate::peer::Error>) -> Result<String, CoreError> {
        if !self.configured {
            return Err(CoreError::new("unavailable", "the helper is not configured"));
        }
        if self.peers.contains_key(id) {
            self.remove_peer(id, now);
        }
        let ice = ice.unwrap_or(self.cfg.ice);
        let merged = IceTimeouts { disconnected_ms: ice.disconnected_ms.or(self.cfg.ice.disconnected_ms), failed_ms: ice.failed_ms.or(self.cfg.ice.failed_ms), keepalive_ms: ice.keepalive_ms.or(self.cfg.ice.keepalive_ms) };
        let predict = self.cfg.predict;
        let made = catch_unwind(AssertUnwindSafe(|| -> Result<(Peer, String), crate::peer::Error> {
            let mut peer = Peer::new(id, predict, merged, now)?;
            let sdp = start(&mut peer, now)?;
            Ok((peer, sdp))
        }));
        let (peer, sdp) = match made {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => return Err(CoreError::new("invalid", format!("the session description was refused: {e}"))),
            Err(_) => return Err(CoreError::new("unavailable", "the peer failed to start")),
        };
        self.router.add_peer(id, &peer.ufrag);
        self.peers.insert(id.to_string(), Live { peer, failed_at: None, buffered_dirty: false, next_buffered_at: now, path_reported_at: None });
        log("info", "peer", json!({ "peer": id }));
        Ok(sdp)
    }

    fn after_new_peer(&mut self, now: Instant) {
        self.trickle();
        let stale = self.stun_ok_at.is_none_or(|t| now.duration_since(t) >= STUN_FRESH);
        if stale {
            self.start_stun(now);
        }
    }

    fn remove_peer(&mut self, id: &str, now: Instant) {
        let Some(mut live) = self.peers.remove(id) else { return };
        let mut outs = Vec::new();
        let _ = catch_unwind(AssertUnwindSafe(|| {
            live.peer.close();
            live.peer.drain(&mut outs);
        }));
        let owner = Owner::Peer(id.to_string());
        for o in outs {
            if let Out::Datagram(d) = o {
                self.send_datagram(&owner, d, now);
            }
        }
        self.router.remove_peer(id);
        log("info", "peer closed", json!({ "peer": id }));
    }

    fn send(&mut self, f: PeerFrame) {
        let now = Instant::now();
        let Some(live) = self.peers.get_mut(&f.peer) else { return };
        match catch_unwind(AssertUnwindSafe(|| live.peer.send(now, f.data))) {
            Ok(Ok(())) => live.buffered_dirty = true,
            Ok(Err(e)) => log("debug", "a frame was not sent", json!({ "peer": f.peer, "error": e.to_string() })),
            Err(_) => live.failed_at = Some(now),
        }
    }

    // --- datagrams in -----------------------------------------------------------------------------

    fn inbound(&mut self, d: Datagram) {
        match self.router.inbound(d.local, d.remote, &d.data) {
            Some(Owner::Stun) => self.on_stun(&d),
            Some(Owner::Peer(id)) => {
                let Some(live) = self.peers.get_mut(&id) else { return };
                let msg = TaggedBytesMut { now: d.at, transport: TransportContext { local_addr: d.local, peer_addr: d.remote, ecn: None, transport_protocol: TransportProtocol::UDP }, message: bytes(&d.data) };
                if catch_unwind(AssertUnwindSafe(|| live.peer.handle_read(msg))).is_err() {
                    live.failed_at = Some(d.at);
                }
            }
            None => {}
        }
    }

    // --- the clock -------------------------------------------------------------------------------

    /// Everything due now: the peers' timers and output, the reports, the STUN round, the mapping.
    fn pump(&mut self, now: Instant) {
        self.flush_queued();
        let ids: Vec<String> = self.peers.keys().cloned().collect();
        let mapped = self.mapped();
        let mut dead = Vec::new();
        for id in ids {
            let mut outs = Vec::new();
            let mut panicked = false;
            {
                let live = self.peers.get_mut(&id).unwrap();
                let step = catch_unwind(AssertUnwindSafe(|| {
                    if live.peer.poll_timeout().is_some_and(|t| t <= now) {
                        live.peer.handle_timeout(now);
                    }
                    live.peer.drain(&mut outs);
                }));
                if step.is_err() {
                    panicked = true;
                }
            }
            let owner = Owner::Peer(id.clone());
            for o in outs {
                match o {
                    Out::Datagram(d) => self.send_datagram(&owner, d, now),
                    Out::State(state, reason) => {
                        if state == PeerStateKind::Failed {
                            if let Some(l) = self.peers.get_mut(&id) {
                                l.failed_at.get_or_insert(now);
                            }
                        }
                        if state == PeerStateKind::Closed {
                            dead.push(id.clone());
                        }
                        log("info", "peer state", json!({ "peer": id, "state": state, "reason": reason }));
                        self.emit(Output::State(PeerState { peer: id.clone(), state, reason }));
                    }
                    Out::Open => {
                        log("info", "peer open", json!({ "peer": id }));
                        self.emit(Output::Open(PeerRef { peer: id.clone() }));
                    }
                    Out::Data(data) => self.emit(Output::Data(PeerFrame { peer: id.clone(), data })),
                    Out::Drained => {
                        if let Some(l) = self.peers.get_mut(&id) {
                            l.buffered_dirty = true;
                            l.next_buffered_at = now;
                        }
                    }
                }
            }
            if panicked {
                log("error", "a peer failed inside the WebRTC stack", json!({ "peer": id }));
                self.emit(Output::State(PeerState { peer: id.clone(), state: PeerStateKind::Failed, reason: Some("internal error".into()) }));
                dead.push(id.clone());
                continue;
            }
            let Some(live) = self.peers.get_mut(&id) else { continue };
            if live.failed_at.is_some_and(|t| now.duration_since(t) >= FAILED_LINGER) {
                dead.push(id.clone());
                continue;
            }
            // what is still unacknowledged, at most every 100 ms while it moves
            if live.buffered_dirty && now >= live.next_buffered_at {
                let bytes = live.peer.buffered();
                let before = live.peer.buffered_reported;
                if bytes.abs_diff(before) >= BUFFERED_STEP || (bytes == 0 && before != 0) {
                    live.peer.buffered_reported = bytes;
                    let _ = self.out.send(Output::Buffered(PeerBuffered { peer: id.clone(), bytes }));
                }
                live.buffered_dirty = bytes > 0;
                live.next_buffered_at = now + BUFFERED_TICK;
            }
            // the path once it is up, on a change, and every ten seconds for the round trip
            if live.peer.open && now >= live.peer.next_path_at {
                let path = catch_unwind(AssertUnwindSafe(|| live.peer.path(now, mapped))).ok().flatten();
                let early = now.duration_since(live.peer.created) < Duration::from_secs(12);
                live.peer.next_path_at = now + if early { PATH_EARLY } else { PATH_PERIOD };
                if let Some((kind, local, remote, rtt)) = path {
                    let key = (kind, local.clone(), remote.clone());
                    let changed = live.peer.last_path.as_ref() != Some(&key);
                    let due = live.path_reported_at.is_none_or(|t| now.duration_since(t) >= PATH_PERIOD);
                    if changed || due {
                        if changed {
                            log("info", "peer path", json!({ "peer": id, "type": kind, "local": local, "remote": remote, "rttMs": rtt }));
                        }
                        live.peer.last_path = Some(key);
                        live.path_reported_at = Some(now);
                        let _ = self.out.send(Output::Path(PeerPath { peer: id.clone(), kind, local, remote, rtt_ms: rtt }));
                    }
                }
            }
        }
        for id in dead {
            self.remove_peer(&id, now);
        }
        self.stun_tick(now);
        if self.stun_round.is_none() && self.next_stun_at.is_some_and(|t| now >= t) {
            self.next_stun_at = None;
            self.start_stun(now);
        }
        self.mapping_tick(now);
        if now >= self.next_expire_at {
            self.router.expire(now);
            self.next_expire_at = now + Duration::from_secs(5);
        }
    }

    fn deadline(&mut self, now: Instant) -> Instant {
        let mut t = now + Duration::from_secs(1);
        for live in self.peers.values_mut() {
            if let Some(p) = live.peer.poll_timeout() {
                t = t.min(p);
            }
            if live.peer.open {
                t = t.min(live.peer.next_path_at);
            }
            if live.buffered_dirty {
                t = t.min(live.next_buffered_at);
            }
        }
        if let Some(r) = &self.stun_round {
            t = t.min(r.next).min(r.started + STUN_ROUND);
        }
        if self.has_queued() {
            t = t.min(now + Duration::from_millis(1));
        }
        t.max(now)
    }

    fn shutdown(&mut self) {
        let now = Instant::now();
        let ids: Vec<String> = self.peers.keys().cloned().collect();
        for id in ids {
            self.remove_peer(&id, now);
        }
        if let Some(pm) = self.portmap.as_mut() {
            pm.stop();
        }
        self.socks.clear();
    }
}

/// Runs the helper until `inputs` ends or says `Shutdown`.
pub async fn run(mut inputs: mpsc::UnboundedReceiver<Input>, out: mpsc::UnboundedSender<Output>) {
    let (dtx, mut drx) = mpsc::channel::<Datagram>(8192);
    let mut core = Core::new(out, dtx);
    let mut map_rx: Option<watch::Receiver<Option<std::net::SocketAddrV4>>> = None;
    loop {
        let now = Instant::now();
        core.pump(now);
        if let Some(rx) = core.map_rx.take() {
            map_rx = Some(rx);
        }
        let deadline = core.deadline(now);
        let iface_at = core.next_iface_at;
        let mapping = async {
            match map_rx.as_mut() {
                Some(rx) => rx.changed().await.ok().map(|_| *rx.borrow_and_update()),
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            biased;
            input = inputs.recv() => match input {
                None | Some(Input::Shutdown) => break,
                Some(Input::Request { id, req }) => core.request(id, req).await,
                Some(Input::Send(f)) => core.send(f),
            },
            Some(d) = drx.recv() => {
                core.inbound(d);
                for _ in 0..256 {
                    match drx.try_recv() {
                        Ok(d) => core.inbound(d),
                        Err(_) => break,
                    }
                }
            }
            changed = mapping => match changed {
                Some(ext) => core.on_mapping(ext),
                None => map_rx = None,
            },
            _ = tokio::time::sleep_until(iface_at.into()), if core.configured => {
                core.next_iface_at = Instant::now() + IFACE_PERIOD;
                if core.rebind().await {
                    core.reflexive.retain(|a, _| core.socks.iter().any(|s| s.addr == *a));
                    core.trickle();
                    core.start_stun(Instant::now());
                    core.publish();
                }
            }
            _ = tokio::time::sleep_until(deadline.into()) => {}
        }
    }
    core.shutdown();
}

/// A candidate as `peer.candidate` carries it, from the text alone: for the tests.
pub fn candidate(text: &str) -> Candidate {
    Candidate { candidate: text.to_string(), sdp_mid: Some("0".into()), sdp_m_line_index: Some(0) }
}

#[allow(dead_code)]
fn _assert_send() {
    fn is_send<T: Send>() {}
    is_send::<Input>();
    is_send::<Output>();
    let _ = PathType::Host;
}
