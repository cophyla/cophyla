// Spike 15: a PTY host that holds interactive sessions and lets a controller type into them
// as the user, and the thin attach client a terminal window runs.
//
//   ptyhost serve  --port P --token T [--raw DIR]
//   ptyhost attach --port P --token T --id s1
//
// Throwaway: TCP loopback with a token rather than a named pipe, one binary for both halves,
// and the attach client for the Windows console only. Every connection starts with one JSON
// line carrying the token. A control connection then goes on in JSON lines, one reply per
// request. An attach connection gets the screen repainted, then the session's output as it
// comes, and sends frames: [kind u8][len u32 LE][payload], kind 0 input bytes, kind 1 a
// resize (cols u16 LE, rows u16 LE).

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let opt = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let port: u16 = opt("--port").and_then(|p| p.parse().ok()).unwrap_or(4951);
    let token = opt("--token").unwrap_or_default();
    match args.get(1).map(String::as_str) {
        Some("serve") => serve(port, token, opt("--raw").map(PathBuf::from)),
        Some("attach") => {
            if let Err(e) = attach(port, &token, &opt("--id").unwrap_or_else(|| "s1".into())) {
                eprintln!("attach: {e}");
                thread::sleep(Duration::from_secs(5));
            }
        }
        _ => eprintln!("usage: ptyhost serve|attach --port P --token T [--id s1] [--raw DIR]"),
    }
}

// --- host ------------------------------------------------------------------------------------

struct Client {
    id: u64,
    stream: TcpStream,
}

struct Session {
    id: String,
    pid: Option<u32>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    // Lock order: parser, then clients. Output is parsed and sent to clients under the parser
    // lock, so a window that attaches gets a repaint and then exactly the output after it.
    parser: Mutex<vt100::Parser>,
    clients: Mutex<Vec<Client>>,
    exit: Mutex<Option<u32>>,
}

impl Session {
    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        let mut w = self.writer.lock().unwrap();
        w.write_all(bytes).and_then(|_| w.flush()).map_err(|e| e.to_string())
    }

    fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        if let Some(m) = self.master.lock().unwrap().as_ref() {
            m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
        }
        self.parser.lock().unwrap().screen_mut().set_size(rows, cols);
        Ok(())
    }
}

struct Host {
    token: String,
    raw: Option<PathBuf>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    next: AtomicU64,
}

fn serve(port: u16, token: String, raw: Option<PathBuf>) {
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind");
    eprintln!("ptyhost listening on 127.0.0.1:{port}");
    let host = Arc::new(Host { token, raw, sessions: Mutex::new(HashMap::new()), next: AtomicU64::new(1) });
    for conn in listener.incoming() {
        let Ok(stream) = conn else { continue };
        let host = host.clone();
        thread::spawn(move || {
            if let Err(e) = connection(host, stream) {
                eprintln!("connection: {e}");
            }
        });
    }
}

fn bad(e: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}

fn connection(host: Arc<Host>, stream: TcpStream) -> io::Result<()> {
    stream.set_nodelay(true).ok();
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(());
    }
    let mut req: Value = serde_json::from_str(&line).map_err(bad)?;
    if req["token"].as_str() != Some(host.token.as_str()) {
        return Ok(());
    }
    if req["op"] == "attach" {
        return attached(&host, &req, reader, stream);
    }
    let mut out = stream;
    loop {
        let reply = control(&host, &req).unwrap_or_else(|e| json!({ "ok": false, "error": e }));
        writeln!(out, "{reply}")?;
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        req = serde_json::from_str(&line).map_err(bad)?;
    }
}

fn session_of(host: &Host, req: &Value) -> Result<Arc<Session>, String> {
    let id = req["id"].as_str().ok_or("no id")?;
    host.sessions.lock().unwrap().get(id).cloned().ok_or_else(|| format!("no session {id}"))
}

fn control(host: &Arc<Host>, req: &Value) -> Result<Value, String> {
    match req["op"].as_str().unwrap_or("") {
        "spawn" => spawn(host, req),
        "write" => {
            let s = session_of(host, req)?;
            s.write(req["data"].as_str().ok_or("no data")?.as_bytes())?;
            Ok(json!({ "ok": true }))
        }
        "submit" => {
            // Typed as the user: a bracketed paste, a pause, then Enter on its own.
            let s = session_of(host, req)?;
            let text = req["text"].as_str().ok_or("no text")?;
            let mut paste = b"\x1b[200~".to_vec();
            paste.extend_from_slice(text.as_bytes());
            paste.extend_from_slice(b"\x1b[201~");
            s.write(&paste)?;
            thread::sleep(Duration::from_millis(req["delay_ms"].as_u64().unwrap_or(300)));
            s.write(b"\r")?;
            Ok(json!({ "ok": true }))
        }
        "screen" => {
            let s = session_of(host, req)?;
            let p = s.parser.lock().unwrap();
            let screen = p.screen();
            let (row, col) = screen.cursor_position();
            let (rows, cols) = screen.size();
            let clients = s.clients.lock().unwrap().len();
            Ok(json!({ "ok": true, "text": screen.contents(), "cursor": [row, col], "size": [rows, cols], "clients": clients }))
        }
        "resize" => {
            let s = session_of(host, req)?;
            s.resize(req["rows"].as_u64().unwrap_or(36) as u16, req["cols"].as_u64().unwrap_or(120) as u16)?;
            Ok(json!({ "ok": true }))
        }
        "list" => {
            let sessions = host.sessions.lock().unwrap();
            let list: Vec<Value> = sessions
                .values()
                .map(|s| json!({ "id": s.id, "pid": s.pid, "exit": *s.exit.lock().unwrap(), "clients": s.clients.lock().unwrap().len() }))
                .collect();
            Ok(json!({ "ok": true, "sessions": list }))
        }
        "kill" => {
            let s = session_of(host, req)?;
            s.killer.lock().unwrap().kill().map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        other => Err(format!("unknown op {other:?}")),
    }
}

fn spawn(host: &Arc<Host>, req: &Value) -> Result<Value, String> {
    let argv: Vec<String> = req["argv"].as_array().ok_or("no argv")?.iter().filter_map(|v| v.as_str().map(String::from)).collect();
    if argv.is_empty() {
        return Err("empty argv".into());
    }
    let cols = req["cols"].as_u64().unwrap_or(120) as u16;
    let rows = req["rows"].as_u64().unwrap_or(36) as u16;
    let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(&argv[0]);
    cmd.args(&argv[1..]);
    if let Some(cwd) = req["cwd"].as_str() {
        cmd.cwd(cwd);
    }
    if let Some(env) = req["env"].as_object() {
        for (k, v) in env {
            match v.as_str() {
                Some(v) => cmd.env(k, v),
                None => cmd.env_remove(k),
            }
        }
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let pid = child.process_id();
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = format!("s{}", host.next.fetch_add(1, Ordering::SeqCst));
    let session = Arc::new(Session {
        id: id.clone(),
        pid,
        writer: Mutex::new(writer),
        master: Mutex::new(Some(pair.master)),
        killer: Mutex::new(child.clone_killer()),
        parser: Mutex::new(vt100::Parser::new(rows, cols, 0)),
        clients: Mutex::new(Vec::new()),
        exit: Mutex::new(None),
    });
    host.sessions.lock().unwrap().insert(id.clone(), session.clone());
    eprintln!("session {id} started, pid {pid:?}, {cols}x{rows}");

    let s = session.clone();
    let raw = host.raw.clone();
    thread::spawn(move || pump(s, reader, raw));

    let s = session.clone();
    thread::spawn(move || {
        let code = child.wait().map(|st| st.exit_code()).unwrap_or(u32::MAX);
        *s.exit.lock().unwrap() = Some(code);
        eprintln!("session {} exited with {code}", s.id);
        // ConPTY keeps the output pipe open until the pseudoconsole closes.
        thread::sleep(Duration::from_millis(500));
        s.master.lock().unwrap().take();
    });
    Ok(json!({ "ok": true, "id": id, "pid": pid }))
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// Answers for the terminal queries in `data`, when no window is attached to answer them.
fn query_replies(data: &[u8], screen: &vt100::Screen) -> Vec<u8> {
    let mut out = Vec::new();
    if contains(data, b"\x1b[6n") {
        let (row, col) = screen.cursor_position();
        out.extend_from_slice(format!("\x1b[{};{}R", row + 1, col + 1).as_bytes());
    }
    if contains(data, b"\x1b[c") || contains(data, b"\x1b[0c") {
        out.extend_from_slice(b"\x1b[?1;2c");
    }
    out
}

fn pump(s: Arc<Session>, mut reader: Box<dyn Read + Send>, raw: Option<PathBuf>) {
    let mut log = raw.and_then(|dir| std::fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("{}.raw", s.id))).ok());
    let mut buf = vec![0u8; 16384];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let data = &buf[..n];
        if let Some(f) = log.as_mut() {
            let _ = f.write_all(data);
        }
        let replies = {
            let mut p = s.parser.lock().unwrap();
            p.process(data);
            let mut clients = s.clients.lock().unwrap();
            let replies = if clients.is_empty() { query_replies(data, p.screen()) } else { Vec::new() };
            clients.retain_mut(|c| c.stream.write_all(data).is_ok());
            replies
        };
        if !replies.is_empty() {
            eprintln!("session {} answered {:?} with no window attached", s.id, String::from_utf8_lossy(&replies));
            let _ = s.write(&replies);
        }
    }
    eprintln!("session {} output closed", s.id);
    for c in s.clients.lock().unwrap().drain(..) {
        let _ = c.stream.shutdown(Shutdown::Both);
    }
}

fn attached(host: &Host, req: &Value, mut reader: BufReader<TcpStream>, stream: TcpStream) -> io::Result<()> {
    let Ok(s) = session_of(host, req) else { return Ok(()) };
    let cid = host.next.fetch_add(1, Ordering::SeqCst);
    if let (Some(cols), Some(rows)) = (req["cols"].as_u64(), req["rows"].as_u64()) {
        let _ = s.resize(rows as u16, cols as u16);
    }
    {
        let p = s.parser.lock().unwrap();
        let mut clients = s.clients.lock().unwrap();
        let mut w = stream.try_clone()?;
        let mut repaint = b"\x1b[H\x1b[2J".to_vec();
        repaint.extend(p.screen().state_formatted());
        w.write_all(&repaint)?;
        clients.push(Client { id: cid, stream: w });
    }
    eprintln!("session {} attached client {cid}", s.id);
    let mut head = [0u8; 5];
    loop {
        if reader.read_exact(&mut head).is_err() {
            break;
        }
        let len = u32::from_le_bytes([head[1], head[2], head[3], head[4]]) as usize;
        let mut payload = vec![0u8; len];
        if reader.read_exact(&mut payload).is_err() {
            break;
        }
        match head[0] {
            0 => {
                let _ = s.write(&payload);
            }
            1 if len == 4 => {
                let cols = u16::from_le_bytes([payload[0], payload[1]]);
                let rows = u16::from_le_bytes([payload[2], payload[3]]);
                let _ = s.resize(rows, cols);
            }
            _ => {}
        }
    }
    s.clients.lock().unwrap().retain(|c| c.id != cid);
    eprintln!("session {} detached client {cid}", s.id);
    Ok(())
}

// --- attach client ---------------------------------------------------------------------------

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut f = vec![kind];
    f.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    f.extend_from_slice(payload);
    f
}

fn attach(port: u16, token: &str, id: &str) -> io::Result<()> {
    let restore = console::raw()?;
    let (cols, rows) = console::size();
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_nodelay(true).ok();
    writeln!(stream, "{}", json!({ "op": "attach", "token": token, "id": id, "cols": cols, "rows": rows }))?;

    let mut from_host = stream.try_clone()?;
    let output = thread::spawn(move || {
        let mut buf = vec![0u8; 16384];
        let mut out = io::stdout().lock();
        loop {
            match from_host.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out.write_all(&buf[..n]).and_then(|_| out.flush()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut sizes = stream.try_clone()?;
    thread::spawn(move || {
        let mut last = (cols, rows);
        loop {
            thread::sleep(Duration::from_millis(200));
            let now = console::size();
            if now != last {
                last = now;
                let mut p = now.0.to_le_bytes().to_vec();
                p.extend_from_slice(&now.1.to_le_bytes());
                if sizes.write_all(&frame(1, &p)).is_err() {
                    break;
                }
            }
        }
    });

    let mut keys = stream.try_clone()?;
    thread::spawn(move || {
        let mut buf = vec![0u8; 4096];
        let mut stdin = io::stdin().lock();
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if keys.write_all(&frame(0, &buf[..n])).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let _ = output.join();
    drop(restore);
    std::process::exit(0);
}

#[cfg(windows)]
mod console {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::Console::*;

    pub struct Restore {
        input: HANDLE,
        in_mode: u32,
        output: HANDLE,
        out_mode: u32,
        cp_in: u32,
        cp_out: u32,
    }

    /// Raw mode with VT input: keys arrive as the sequences a Unix terminal sends, Ctrl+C as a byte.
    pub fn raw() -> std::io::Result<Restore> {
        unsafe {
            let input = GetStdHandle(STD_INPUT_HANDLE);
            let output = GetStdHandle(STD_OUTPUT_HANDLE);
            let (mut in_mode, mut out_mode) = (0u32, 0u32);
            if GetConsoleMode(input, &mut in_mode) == 0 || GetConsoleMode(output, &mut out_mode) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            let restore = Restore { input, in_mode, output, out_mode, cp_in: GetConsoleCP(), cp_out: GetConsoleOutputCP() };
            SetConsoleMode(input, (in_mode & !(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT)) | ENABLE_VIRTUAL_TERMINAL_INPUT);
            SetConsoleMode(output, out_mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN);
            SetConsoleCP(65001);
            SetConsoleOutputCP(65001);
            Ok(restore)
        }
    }

    impl Drop for Restore {
        fn drop(&mut self) {
            unsafe {
                SetConsoleMode(self.input, self.in_mode);
                SetConsoleMode(self.output, self.out_mode);
                SetConsoleCP(self.cp_in);
                SetConsoleOutputCP(self.cp_out);
            }
        }
    }

    /// The window's visible size as (cols, rows).
    pub fn size() -> (u16, u16) {
        unsafe {
            let mut info: CONSOLE_SCREEN_BUFFER_INFO = std::mem::zeroed();
            if GetConsoleScreenBufferInfo(GetStdHandle(STD_OUTPUT_HANDLE), &mut info) == 0 {
                return (120, 36);
            }
            ((info.srWindow.Right - info.srWindow.Left + 1) as u16, (info.srWindow.Bottom - info.srWindow.Top + 1) as u16)
        }
    }
}

#[cfg(not(windows))]
mod console {
    pub struct Restore;
    pub fn raw() -> std::io::Result<Restore> {
        Err(std::io::Error::other("the spike's attach client is Windows only"))
    }
    pub fn size() -> (u16, u16) {
        (120, 36)
    }
}
