// The host page's link socket: a WebSocket from the host page to the shell's loopback server
// (media.rs upgrades it), which carries the page's side of the link to cophylad so none of it
// passes through the UI thread. Tauri's events and commands both do: each event is a script
// evaluated on it, and each command's request arrives and is answered there. While the socket is
// open, cophylad's frames for the page come over it as they came (one text message each, the
// frames of one read flushed together), and so do the link's state (`["state", snapshot]`) and
// the shell's events that go this way (`["event", name, payload]`, the talk key's); the shell's
// own messages are arrays, which no frame of cophylad's is. The page sends its frames over it as
// it would by `cophylad_send` (checked the same way, refused frames with an id answered with an
// error), and its log lines as `["log", [{ level, message }]]` (applog.rs). The `shell:` and
// `media:` answers and `update.state` stay with the shell (cophylad.rs), as they do without it.
//
// The page opens the socket after `cophylad_attach` gave it the URL; when it opens, the link
// reconnects if it was connected, so cophylad's post-hello snapshot for the page comes over the
// socket; it is told `connecting` meanwhile. When the socket closes the link goes on: cophylad's
// connection is the shell's, not the page's, and what comes next goes to the page as events,
// until a socket opens again. The page's side is apps/ui/host/link.ts.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::cophylad::{check_frame, state_message, Link, LinkState};

/// The most queued messages written before one flush.
const FLUSH_EVERY: usize = 256;

/// Serves one page socket until it closes, or another opens in its place.
pub async fn serve<S: AsyncRead + AsyncWrite + Unpin>(link: &Link, mut ws: WebSocketStream<S>) {
    let (id, mut rx) = link.page_opened();
    log::info!("page socket {id} open");
    let mut first = link.snapshot();
    if first.state == LinkState::Connected {
        link.reattach();
        first.state = LinkState::Connecting;
        first.hello = None;
    }
    let why = match ws.send(Message::text(state_message(&first))).await {
        Err(e) => format!("the state was not taken: {e}"),
        Ok(()) => session(link, &mut ws, &mut rx).await,
    };
    link.page_closed(id);
    log::info!("page socket {id} closed: {why}");
}

async fn session<S: AsyncRead + AsyncWrite + Unpin>(link: &Link, ws: &mut WebSocketStream<S>, rx: &mut tokio::sync::mpsc::Receiver<String>) -> String {
    loop {
        tokio::select! {
            out = rx.recv() => {
                let Some(text) = out else { return "another page socket opened, or this one fell behind".into() };
                let mut sent = ws.feed(Message::text(text)).await;
                let mut n = 1;
                while sent.is_ok() && n < FLUSH_EVERY {
                    let Ok(text) = rx.try_recv() else { break };
                    sent = ws.feed(Message::text(text)).await;
                    n += 1;
                }
                if let Err(e) = sent.and(ws.flush().await) {
                    return format!("send failed: {e}");
                }
            }
            msg = ws.next() => match msg {
                Some(Ok(Message::Text(text))) => {
                    if let Some(answer) = from_page(link, text.as_str()) {
                        if let Err(e) = ws.send(Message::text(answer)).await {
                            return format!("send failed: {e}");
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None => return "the page closed it".into(),
                Some(Ok(_)) => {}
                Some(Err(e)) => return e.to_string(),
            },
        }
    }
}

/// One message from the page: a frame for cophylad, sent on as the page wrote it, or the shell's
/// own (`["log", lines]`). Answers the error response for a refused frame that has an id.
fn from_page(link: &Link, text: &str) -> Option<String> {
    if text.starts_with('[') {
        match serde_json::from_str::<(String, Value)>(text) {
            Ok((kind, lines)) if kind == "log" => match serde_json::from_value::<Vec<crate::applog::PageLine>>(lines) {
                Ok(lines) => crate::applog::page_lines(&lines),
                Err(e) => log::debug!("page socket: log lines unread: {e}"),
            },
            _ => log::debug!("page socket: a message of the shell's unread"),
        }
        return None;
    }
    let frame: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            log::debug!("page socket: a frame that is not JSON");
            return None;
        }
    };
    let sent = check_frame(&frame).and_then(|()| link.send(text.to_string()));
    match (sent, frame.get("id")) {
        (Ok(()), _) => None,
        (Err(e), Some(id)) if !id.is_null() => Some(error_response(id, &e)),
        (Err(e), _) => {
            log::debug!("page socket: a notification not sent: {e}");
            None
        }
    }
}

/// The error response a frame refused by the shell gets: the protocol's error for the code its
/// message starts with (`denied`, `invalid`, else `unavailable`), the message whole, as the
/// command's error string reads to the page.
fn error_response(id: &Value, error: &str) -> String {
    let (code, number, retryable) = match error.split(':').next().map(str::trim) {
        Some("denied") => ("denied", -32001, false),
        Some("invalid") => ("invalid", -32602, false),
        _ => ("unavailable", -32003, true),
    };
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": number, "message": error, "data": { "code": code, "message": error, "retryable": retryable } } }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tokio::net::TcpListener;
    use tokio::sync::mpsc;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    use crate::cophylad::{attempt, Attempt, LinkSnapshot, Shell};
    use crate::media::Media;

    const ORIGIN: &str = "http://tauri.localhost";
    const WAIT: Duration = Duration::from_secs(10);

    /// The app's side, as a test sees it: the events the page would have heard.
    #[derive(Default)]
    struct Heard {
        frames: Mutex<Vec<Vec<String>>>,
        states: Mutex<Vec<LinkState>>,
    }

    impl Shell for Heard {
        fn emit_frames(&self, frames: Vec<String>) {
            self.frames.lock().unwrap().push(frames);
        }
        fn emit_state(&self, snapshot: &LinkSnapshot) {
            self.states.lock().unwrap().push(snapshot.state);
        }
        fn media_answered(&self, _: &str, _: &Value) {}
        fn update_staged(&self, _: Option<&str>) {}
    }

    /// A daemon on the loopback: each connection's hello answered, then what the test hands
    /// `say` sent to the newest connection, and every frame it gets told to `got`, with the
    /// connection's number.
    struct Daemon {
        url: String,
        say: Arc<Mutex<Option<mpsc::UnboundedSender<Vec<String>>>>>,
        got: mpsc::UnboundedReceiver<(usize, String)>,
        connections: Arc<Mutex<usize>>,
    }

    async fn daemon() -> Daemon {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let url = format!("ws://127.0.0.1:{}/ws/client", listener.local_addr().unwrap().port());
        let say: Arc<Mutex<Option<mpsc::UnboundedSender<Vec<String>>>>> = Arc::default();
        let connections: Arc<Mutex<usize>> = Arc::default();
        let (got_tx, got) = mpsc::unbounded_channel();
        let (say_slot, count) = (say.clone(), connections.clone());
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { continue };
                let n = {
                    let mut c = count.lock().unwrap();
                    *c += 1;
                    *c
                };
                let (tx, mut rx) = mpsc::unbounded_channel::<Vec<String>>();
                *say_slot.lock().unwrap() = Some(tx);
                let got_tx = got_tx.clone();
                tokio::spawn(async move {
                    loop {
                        tokio::select! {
                            said = rx.recv() => {
                                let Some(frames) = said else { return };
                                for f in frames {
                                    if ws.feed(Message::text(f)).await.is_err() { return }
                                }
                                if ws.flush().await.is_err() { return }
                            }
                            msg = ws.next() => match msg {
                                Some(Ok(Message::Text(t))) => {
                                    let v: Value = serde_json::from_str(t.as_str()).unwrap();
                                    if v["method"] == "hello" {
                                        let ok = json!({ "jsonrpc": "2.0", "id": "hello", "result": { "node": "desk", "connection": n } });
                                        if ws.send(Message::text(ok.to_string())).await.is_err() { return }
                                    } else {
                                        let _ = got_tx.send((n, t.as_str().to_owned()));
                                    }
                                }
                                Some(Ok(_)) => {}
                                _ => return,
                            },
                        }
                    }
                });
            }
        });
        Daemon { url, say, got, connections }
    }

    impl Daemon {
        fn say(&self, frames: &[String]) {
            let tx = self.say.lock().unwrap().clone().expect("a connection");
            tx.send(frames.to_vec()).unwrap();
        }
        fn connections(&self) -> usize {
            *self.connections.lock().unwrap()
        }
    }

    fn note(conn: usize, n: usize) -> String {
        json!({ "jsonrpc": "2.0", "method": "test.note", "params": { "conn": conn, "n": n } }).to_string()
    }

    async fn until(what: &str, mut ok: impl FnMut() -> bool) {
        let deadline = tokio::time::Instant::now() + WAIT;
        while !ok() {
            assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    type PageWs = WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

    async fn open_page(url: &str, origin: Option<&str>) -> Result<PageWs, u16> {
        let mut request = url.into_client_request().unwrap();
        if let Some(o) = origin {
            request.headers_mut().insert("origin", o.parse().unwrap());
        }
        match tokio_tungstenite::connect_async(request).await {
            Ok((ws, _)) => Ok(ws),
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => Err(response.status().as_u16()),
            Err(e) => panic!("{e}"),
        }
    }

    /// The next text message the page gets.
    async fn next_text(ws: &mut PageWs) -> String {
        loop {
            match tokio::time::timeout(WAIT, ws.next()).await.expect("a message in time") {
                Some(Ok(Message::Text(t))) => return t.as_str().to_owned(),
                Some(Ok(_)) => continue,
                other => panic!("the page socket ended: {other:?}"),
            }
        }
    }

    /// The link states the page gets until one is `want`.
    async fn states_until(ws: &mut PageWs, want: &str) -> Vec<String> {
        let mut seen = Vec::new();
        loop {
            let text = next_text(ws).await;
            let v: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(v[0], "state", "{text}");
            let state = v[1]["state"].as_str().unwrap().to_string();
            seen.push(state.clone());
            if state == want {
                return seen;
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_page_socket_carries_the_link_in_order_and_its_close_leaves_the_link_up() {
        let mut daemon = daemon().await;
        let link: &'static Link = Box::leak(Box::new(Link::new()));
        let heard: &'static Heard = Box::leak(Box::default());
        // the link task, as run_link drives it, for as long as the test runs
        let url = daemon.url.clone();
        let mut rx = link.take_outbound().unwrap();
        let dropped = Arc::new(Mutex::new(Vec::<String>::new()));
        let drops = dropped.clone();
        tokio::spawn(async move {
            loop {
                link.set(heard, LinkState::Connecting, None, None, &url);
                match attempt(heard, link, &url, "t".repeat(40).as_str(), &mut rx, None).await {
                    Attempt::Dropped(why) => {
                        drops.lock().unwrap().push(why.clone());
                        link.set(heard, LinkState::Disconnected, None, Some(why), &url);
                    }
                    _ => panic!("the fake daemon refused"),
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        });
        until("connected", || link.is_connected()).await;

        // no page socket: a burst comes as events, in order, in few of them
        let burst: Vec<String> = (0..60).map(|n| note(1, n)).collect();
        daemon.say(&burst);
        until("the burst", || heard.frames.lock().unwrap().iter().map(Vec::len).sum::<usize>() == 60).await;
        let events = heard.frames.lock().unwrap().clone();
        assert_eq!(events.concat(), burst);
        assert!(events.len() < 60, "one event a frame: {}", events.len());

        // the media server serves the socket to the host page's origin alone
        let media = Media::new(None, Box::new(|_| Ok(())));
        media.serve_page(vec![ORIGIN.into()], move |ws| Box::pin(async move { serve(link, ws).await }));
        media.listen().unwrap();
        let socket = media.link_url().unwrap();
        assert!(socket.starts_with("ws://127.0.0.1:") && socket.ends_with("/link"), "{socket}");
        assert_eq!(open_page(&socket, None).await.err(), Some(403));
        assert_eq!(open_page(&socket, Some("http://view.localhost")).await.err(), Some(403));
        assert_eq!(open_page(&socket, Some("null")).await.err(), Some(403));
        let wrong = socket.replace("/link", "x/link");
        assert_eq!(open_page(&wrong, Some(ORIGIN)).await.err(), Some(404));
        assert_eq!(daemon.connections(), 1);

        // opened: told connecting, the link reconnects, and the new connection's state and
        // frames all come over the socket, in order
        let mut page = open_page(&socket, Some(ORIGIN)).await.unwrap();
        let states = states_until(&mut page, "connected").await;
        assert_eq!(states.first().map(String::as_str), Some("connecting"));
        assert!(states.contains(&"disconnected".to_string()), "{states:?}");
        until("the second connection", || daemon.connections() == 2).await;
        assert_eq!(dropped.lock().unwrap().as_slice(), ["reattaching"]);
        let states_heard = heard.states.lock().unwrap().len();
        let events_heard = heard.frames.lock().unwrap().len();
        let burst: Vec<String> = (0..60).map(|n| note(2, n)).collect();
        daemon.say(&burst);
        let mut got = Vec::new();
        while got.len() < 60 {
            got.push(next_text(&mut page).await);
        }
        assert_eq!(got, burst);
        assert_eq!((heard.states.lock().unwrap().len(), heard.frames.lock().unwrap().len()), (states_heard, events_heard), "nothing went as events meanwhile");

        // the page's frames go on to cophylad as it wrote them; a hello is refused with its id
        let request = r#"{"jsonrpc":"2.0","id":"h1","method":"session.list"}"#;
        page.send(Message::text(request)).await.unwrap();
        let (conn, text) = tokio::time::timeout(WAIT, daemon.got.recv()).await.unwrap().unwrap();
        assert_eq!((conn, text.as_str()), (2, request));
        page.send(Message::text(r#"{"jsonrpc":"2.0","id":"h2","method":"hello","params":{}}"#)).await.unwrap();
        let refused: Value = serde_json::from_str(&next_text(&mut page).await).unwrap();
        assert_eq!(refused["id"], "h2");
        assert_eq!(refused["error"]["data"]["code"], "denied");
        assert_eq!(refused["error"]["code"], -32001);
        page.send(Message::text(r#"["log",[{"level":"warn","message":"from the page"}]]"#)).await.unwrap();
        page.send(Message::text("[1,2]")).await.unwrap();

        // closed: the link stays up, on the same connection, and the page hears it as events again
        page.close(None).await.unwrap();
        drop(page);
        until("the socket let go", || link.to_page(Vec::new()).is_err()).await;
        let after = note(2, 99);
        daemon.say(std::slice::from_ref(&after));
        until("the frame as an event", || heard.frames.lock().unwrap().last().is_some_and(|b| b.contains(&after))).await;
        assert!(link.is_connected());
        assert_eq!(daemon.connections(), 2);
        assert_eq!(dropped.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_refused_frame_is_answered_as_the_command_would_have_failed() {
        let link = Link::new();
        // not connected
        let answer: Value = serde_json::from_str(&from_page(&link, r#"{"jsonrpc":"2.0","id":7,"method":"chat.send"}"#).unwrap()).unwrap();
        assert_eq!(answer["id"], 7);
        assert_eq!(answer["error"]["data"], json!({ "code": "unavailable", "message": "unavailable: not connected to cophylad", "retryable": true }));
        assert_eq!(answer["error"]["code"], -32003);
        // a notification refused, or anything not a frame, is answered with nothing
        assert!(from_page(&link, r#"{"jsonrpc":"2.0","method":"voice.audio"}"#).is_none());
        assert!(from_page(&link, "not json").is_none());
        assert!(from_page(&link, r#"["log",[{"message":"m"}]]"#).is_none());
        let invalid: Value = serde_json::from_str(&error_response(&json!("h9"), "invalid: frame must be a JSON object")).unwrap();
        assert_eq!((invalid["error"]["code"].as_i64(), invalid["error"]["data"]["retryable"].as_bool()), (Some(-32602), Some(false)));
    }
}
