//! Two helper cores in one process, signalled through their channels as cophylad would: one
//! offers, the other answers, candidates cross, the channel opens, a megabyte goes over in
//! frames of the largest size, and both ends report a host path.

use std::collections::VecDeque;
use std::time::Duration;

use net_core::{run, Input, Output, Request};
use net_proto::{Configure, PathType, PeerAccept, PeerAnswer, PeerCandidate, PeerFrame, PeerOffer, PeerRef, MAX_FRAME};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::time::timeout;

struct Side {
    tx: mpsc::UnboundedSender<Input>,
    rx: mpsc::UnboundedReceiver<Output>,
    next: u64,
    queue: VecDeque<Output>,
}

impl Side {
    fn start() -> Side {
        let (tx, in_rx) = mpsc::unbounded_channel();
        let (out_tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(run(in_rx, out_tx));
        Side { tx, rx, next: 1, queue: VecDeque::new() }
    }

    async fn call(&mut self, req: Request) -> Value {
        let id = self.next;
        self.next += 1;
        self.tx.send(Input::Request { id: json!(id), req }).unwrap();
        loop {
            let o = timeout(Duration::from_secs(10), self.rx.recv()).await.expect("a reply in time").expect("the core is running");
            match o {
                Output::Reply { id: rid, result } if rid == json!(id) => return result.expect("the request succeeded"),
                other => self.queue.push_back(other),
            }
        }
    }

    fn take(&mut self) -> Option<Output> {
        self.queue.pop_front().or_else(|| self.rx.try_recv().ok())
    }
}

fn loopback_only() -> Configure {
    // every real interface left out: loopback alone keeps the test off the machine's networks
    Configure { loopback: true, map: false, ipv6: false, skip_interfaces: vec!["*".into()], ..Configure::default() }
}

#[tokio::test(flavor = "current_thread")]
async fn two_cores_open_a_channel_and_move_a_megabyte() {
    let mut a = Side::start();
    let mut b = Side::start();
    let ca = a.call(Request::Configure(loopback_only())).await;
    let cb = b.call(Request::Configure(loopback_only())).await;
    assert!(ca["port"].as_u64().unwrap() > 0, "{ca}");
    assert_ne!(ca["port"], cb["port"]);

    let offer = a.call(Request::Offer(PeerOffer { peer: "to-b".into(), ice: None })).await;
    let answer = b.call(Request::Answer(PeerAnswer { peer: "to-a".into(), sdp: offer["sdp"].as_str().unwrap().into(), ice: None })).await;
    a.call(Request::Accept(PeerAccept { peer: "to-b".into(), sdp: answer["sdp"].as_str().unwrap().into() })).await;

    let (mut open_a, mut open_b) = (false, false);
    let (mut path_a, mut path_b) = (None, None);
    let mut received = 0usize;
    let mut frames_in = 0usize;
    let mut sent = false;
    let total = 1024 * 1024;
    let frame = "x".repeat(MAX_FRAME);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        let mut idle = true;
        while let Some(o) = a.take() {
            idle = false;
            match o {
                Output::Candidate(c) => {
                    b.call(Request::Candidate(PeerCandidate { peer: "to-a".into(), candidate: c.candidate })).await;
                }
                Output::Open(PeerRef { peer }) => {
                    assert_eq!(peer, "to-b");
                    open_a = true;
                }
                Output::Path(p) => path_a = Some(p.kind),
                _ => {}
            }
        }
        while let Some(o) = b.take() {
            idle = false;
            match o {
                Output::Candidate(c) => {
                    a.call(Request::Candidate(PeerCandidate { peer: "to-b".into(), candidate: c.candidate })).await;
                }
                Output::Open(_) => open_b = true,
                Output::Data(PeerFrame { peer, data }) => {
                    assert_eq!(peer, "to-a");
                    received += data.len();
                    frames_in += 1;
                }
                Output::Path(p) => path_b = Some(p.kind),
                _ => {}
            }
        }
        if open_a && open_b && !sent {
            sent = true;
            for _ in 0..total / MAX_FRAME {
                a.tx.send(Input::Send(PeerFrame { peer: "to-b".into(), data: frame.clone() })).unwrap();
            }
        }
        if received >= total && path_a.is_some() && path_b.is_some() {
            break;
        }
        if idle {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    assert!(open_a && open_b, "both ends open");
    assert_eq!(received, total, "every byte arrived");
    assert_eq!(frames_in, total / MAX_FRAME, "frame for frame");
    assert_eq!(path_a, Some(PathType::Host));
    assert_eq!(path_b, Some(PathType::Host));

    // a close on one end is a closed peer on the other
    a.call(Request::Close(PeerRef { peer: "to-b".into() })).await;
    let mut closed = false;
    let end = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < end && !closed {
        match timeout(Duration::from_millis(200), b.rx.recv()).await {
            Ok(Some(Output::State(s))) if matches!(s.state, net_proto::PeerStateKind::Closed | net_proto::PeerStateKind::Failed | net_proto::PeerStateKind::Disconnected) => closed = true,
            _ => {}
        }
    }
    assert!(closed, "the far end heard the close");
    a.tx.send(Input::Shutdown).unwrap();
    b.tx.send(Input::Shutdown).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn requests_before_configure_and_for_unknown_peers_fail() {
    let mut a = Side::start();
    a.tx.send(Input::Request { id: json!(1), req: Request::Offer(PeerOffer { peer: "p".into(), ice: None }) }).unwrap();
    match timeout(Duration::from_secs(5), a.rx.recv()).await.unwrap().unwrap() {
        Output::Reply { result: Err(e), .. } => assert_eq!(e.code, "unavailable"),
        _ => panic!("expected a failure"),
    }
    a.call(Request::Configure(loopback_only())).await;
    a.tx.send(Input::Request { id: json!(9), req: Request::Accept(PeerAccept { peer: "nobody".into(), sdp: "v=0".into() }) }).unwrap();
    loop {
        match timeout(Duration::from_secs(5), a.rx.recv()).await.unwrap().unwrap() {
            Output::Reply { id, result: Err(e) } if id == json!(9) => {
                assert_eq!(e.code, "not_found");
                break;
            }
            _ => continue,
        }
    }
    a.tx.send(Input::Request { id: json!(10), req: Request::Answer(PeerAnswer { peer: "p".into(), sdp: "not sdp".into(), ice: None }) }).unwrap();
    loop {
        match timeout(Duration::from_secs(5), a.rx.recv()).await.unwrap().unwrap() {
            Output::Reply { id, result: Err(e) } if id == json!(10) => {
                assert_eq!(e.code, "invalid");
                break;
            }
            _ => continue,
        }
    }
}
