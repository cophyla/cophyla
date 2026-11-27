// Streamed media for the document frame's player page: a range server on this machine's loopback
// (`http://127.0.0.1:<port>/<secret>/media/<id>/<name>`) that a video or a sound element streams
// from, seeks in, and plays a second time without downloading again, in place of a blob of the
// whole file read first. A socket of its own, not the `doc` scheme: WebView2 never shows the shell
// a media request from a frame of an opaque origin, which the player's is (it is inside a view's
// sandboxed frame), and sends it to the network instead. The server listens on 127.0.0.1 alone, on
// a port the system picks, and answers only a path under a secret made for the run and a request
// that names it `127.0.0.1:<port>` (a page that points a name of its own at loopback sends that
// name): GET and HEAD, one request a connection, no CORS header, so nothing that does not hold a
// stream's URL finds it, and no page reads one. The document frame's policy lets media in from its
// origin (docframe.rs). The bytes still come over Cophyla's link, the one path to another machine,
// but never through the page, which pieces crossing it twice as base64 fill and hold up: the shell
// reads each piece of 1.5 MiB it lacks itself, over its own link to cophylad (cophylad.rs hands it
// the answers to its `media:<n>` requests), with the read the host page named at the open
// (`session.file` or `terminal.file` and the file's place), and takes it only of the file opened,
// its size and modified time the same. A stream is what the host page opened (`media_open`: an id
// of its own, a key naming the file's version, its size and modified time, its type, the read,
// whether to keep it on disk, and its name, answered with its URL) and is gone when the page
// closes it (`media_close`); `media_stats` says how its requests went, and why the last read
// failed. An answer carries two pieces at most, from the byte asked for, and the media element
// asks again for the rest; after it, the next three pieces are fetched in the background. Requests
// waiting for one piece share one read, and a stream has four reads out at most. Pieces are kept
// in memory (the sixteen used last, across every stream) and, for a file on another machine, on
// disk in the app's own folder (`media-cache` in its local data): per key, named by its SHA-256,
// one sparse data file with each piece at its offset and one map of the pieces there, a piece's
// bytes written before the map says it is there, 2 GiB in all, the keys used longest ago and not
// open evicted first. The host page's side is viewhost's MediaHost
// (packages/viewhost/src/media.ts). The HTTP, the reads and the cache are plain code here, which
// the tests below drive without a web view or a daemon, the server over a real loopback socket.
//
// The same server carries the host page's link socket (page.rs): a WebSocket at
// `ws://127.0.0.1:<port>/<link secret>/link`, under a secret of its own that no view is ever
// given, upgraded before the one-request-a-connection path by a 101 written here, and only for a
// request that names the server's host and comes from the host page's origin (`Origin`).

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, SystemTime};

use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine as _;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::http::{header, HeaderValue, Method, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{oneshot, Semaphore};
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::WebSocketStream;

use crate::cophylad::Link;

/// A piece's length: the daemon's `WHOLE_CHUNK`, what one read of a whole file carries.
pub const PIECE: u64 = 1_572_864;
/// The ids of the shell's reads of pieces (`media:<n>`), whose answers cophylad.rs hands here.
pub const RPC_PREFIX: &str = "media:";
/// Where the streams are under the server's secret: `/media/<id>/<name>`.
pub const PATH_PREFIX: &str = "/media/";
/// Where the host page's link socket is under the link's secret.
pub const LINK_PATH: &str = "/link";
/// The disk cache's folder in the app's local data.
pub const CACHE_DIR: &str = "media-cache";
/// The most the disk cache holds, counted as the pieces there.
pub const DISK_CAP: u64 = 2 << 30;
/// How long a need waits for its piece.
pub const NEED_TIMEOUT: Duration = Duration::from_secs(60);
/// The most needs a stream has out at once.
const IN_FLIGHT: usize = 4;
/// How many pieces past an answer are fetched in the background.
const READAHEAD: u64 = 3;
/// How many pieces are kept in memory, across every stream.
const MEMORY_PIECES: usize = 16;
/// The most pieces a file kept on disk has (≈1.5 TiB): its map is a byte per piece.
const MAP_MAX: u64 = 1 << 20;
/// The longest key and type the host page may give, and the longest error a 502 says.
const KEY_MAX: usize = 65_536;
const MIME_MAX: usize = 255;
const ERROR_MAX: usize = 500;
/// A media answer is no document: one opened as a page runs nothing and reaches nothing.
const MEDIA_CSP: &str = "sandbox; default-src 'none'";
/// The longest request head the server reads, and how long a client has to send it.
const HEAD_MAX: usize = 16 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
/// How long an answer has to be taken before its connection is let go.
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
/// The most connections served at once; one past them is closed unanswered.
const CONNECTIONS: usize = 64;
/// The longest file name a stream's URL carries, for show.
const NAME_MAX: usize = 255;
/// What a file's name is percent-encoded from in a URL: all but letters, digits and `-._~`.
const NAME_SET: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');
/// The reads a stream's pieces come from, and what their params may name.
const READ_METHODS: [&str; 2] = ["session.file", "terminal.file"];
const READ_KEYS: [&str; 4] = ["id", "terminal", "node", "path"];
/// Why a piece did not come, as a 502 and `media_stats` say it.
const CHANGED: &str = "the file changed";
const SENDS_NONE: &str = "that computer sends none of it: update Cophyla there";
const NO_BYTES: &str = "cophylad sent no bytes";
const SHORT: &str = "the file came short";
const TIMED_OUT: &str = "the piece did not come in time";
const LINK_LOST: &str = "the link to cophylad went";

/// What a stream's HTTP requests came to: requests answered, pieces read from cophylad, pieces
/// served from memory or disk without a read, and why the last read failed, until one comes after it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Stats {
    pub requests: u64,
    pub fetched: u64,
    pub cached: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Where a stream's pieces are read: the read the host page named, `session.file` or
/// `terminal.file` with the file's place (`id`, `terminal`, `node`, `path`), each piece asked for
/// whole from its offset, as a player that streams it asks.
#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    method: String,
    params: Map<String, Value>,
}

impl Source {
    /// The read the host page sent, `{ method, params }`: one of the two reads, its params text
    /// under the four names, nothing else.
    pub fn from_value(read: &Value) -> Result<Self, String> {
        let method = read.get("method").and_then(Value::as_str).filter(|m| READ_METHODS.contains(m)).ok_or("invalid: a media read is session.file or terminal.file")?;
        let params = read.get("params").and_then(Value::as_object).ok_or("invalid: a media read's params are an object")?;
        if let Some((key, _)) = params.iter().find(|(k, v)| !READ_KEYS.contains(&k.as_str()) || !v.is_string()) {
            return Err(format!("invalid: a media read's params are id, terminal, node and path, as text, not {key}"));
        }
        Ok(Self { method: method.to_string(), params: params.clone() })
    }

    /// Read `req`: the file's bytes from `at`, a piece of the node's at most.
    fn frame(&self, req: u64, at: u64) -> String {
        let mut params = self.params.clone();
        for flag in ["whole", "image", "stream"] {
            params.insert(flag.into(), Value::Bool(true));
        }
        params.insert("at".into(), at.into());
        json!({ "jsonrpc": "2.0", "id": format!("{RPC_PREFIX}{req}"), "method": self.method, "params": params }).to_string()
    }
}

/// Why a piece did not come.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fail {
    /// cophylad said why, or could not be asked (502).
    Error(String),
    /// No answer in time (504).
    Timeout,
    /// The stream closed (410).
    Closed,
}

type Piece = Arc<Vec<u8>>;
type Waiter = oneshot::Sender<Result<Piece, Fail>>;

/// How a read reaches cophylad: the shell's link, or a test's daemon.
pub type Out = Box<dyn Fn(String) -> Result<(), String> + Send + Sync>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How many pieces a file of `size` bytes has.
pub fn pieces(size: u64) -> u64 {
    size.div_ceil(PIECE)
}

/// Piece `index`'s length in a file of `size` bytes: `PIECE` but for the last, none past the end.
pub fn piece_len(size: u64, index: u64) -> u64 {
    size.saturating_sub(index.saturating_mul(PIECE)).min(PIECE)
}

/// A stream id as the host page makes them: `[A-Za-z0-9_-]`, 64 at most.
fn stream_id(id: &str) -> Result<&str, String> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err("invalid: bad media stream id".into());
    }
    Ok(id)
}

/// The id in a request's path, `/media/<id>/<name>`; the name is the file's, for show.
fn path_id(path: &str) -> Option<&str> {
    let id = path.strip_prefix(PATH_PREFIX)?.split('/').next()?;
    stream_id(id).ok()
}

/// A key's name on disk: its SHA-256, in hex.
fn hex_key(key: &str) -> String {
    Sha256::digest(key.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn is_hex(name: &str) -> bool {
    name.len() == 64 && name.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// What a request asks for of a stream, from its `Range` header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Asked {
    /// Bytes `start..=end`, `end` within the file.
    Bytes(u64, u64),
    /// A start past the end, or a suffix of nothing: 416.
    Unsatisfiable,
}

/// A run of decimal digits; one too large for 64 bits reads as the largest.
fn number(s: &str) -> Option<u64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(s.parse().unwrap_or(u64::MAX))
}

/// Reads a `Range` header against a stream of `size` bytes: `bytes=a-b`, `bytes=a-` and
/// `bytes=-n`, the first of several, its end clamped to the file's and a suffix longer than
/// the file the whole file. No header asks for the whole file, and so does one that is not a
/// byte range HTTP knows (another unit, no dash, a letter, an end before its start), which HTTP
/// has a server ignore. A start at or past the end, a suffix of nothing, and anything of an
/// empty file are unsatisfiable.
pub fn parse_range(header: Option<&str>, size: u64) -> Asked {
    if size == 0 {
        return Asked::Unsatisfiable;
    }
    let whole = Asked::Bytes(0, size - 1);
    let Some((unit, set)) = header.and_then(|h| h.split_once('=')) else { return whole };
    if !unit.trim().eq_ignore_ascii_case("bytes") {
        return whole;
    }
    let first = set.split(',').next().unwrap_or_default().trim();
    let Some((a, b)) = first.split_once('-') else { return whole };
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        return match number(b) {
            None => whole,
            Some(0) => Asked::Unsatisfiable,
            Some(n) => Asked::Bytes(size.saturating_sub(n), size - 1),
        };
    }
    let Some(start) = number(a) else { return whole };
    let end = if b.is_empty() {
        size - 1
    } else {
        match number(b) {
            Some(end) if end >= start => end.min(size - 1),
            _ => return whole,
        }
    };
    if start >= size {
        return Asked::Unsatisfiable;
    }
    Asked::Bytes(start, end)
}

/// The bytes one answer carries of an ask for `start..=end` in a file of `size` bytes: no
/// further than the end of the piece after the one `start` is in, so two pieces at most, nor
/// past the file's last byte. The media element asks again for the rest.
pub fn bounds(start: u64, end: u64, size: u64) -> (u64, u64) {
    let limit = (start / PIECE + 2).saturating_mul(PIECE) - 1;
    (start, end.min(limit).min(size.saturating_sub(1)))
}

/// The pieces used last, across every stream, by key and index: the most recent at the back.
struct Memory {
    cap: usize,
    pieces: VecDeque<(String, u64, Piece)>,
}

impl Memory {
    fn new(cap: usize) -> Self {
        Self { cap, pieces: VecDeque::with_capacity(cap + 1) }
    }

    fn position(&self, key: &str, index: u64) -> Option<usize> {
        self.pieces.iter().position(|(k, i, _)| *i == index && k == key)
    }

    fn has(&self, key: &str, index: u64) -> bool {
        self.position(key, index).is_some()
    }

    /// The piece, now the most recent.
    fn get(&mut self, key: &str, index: u64) -> Option<Piece> {
        let entry = self.pieces.remove(self.position(key, index)?)?;
        let piece = entry.2.clone();
        self.pieces.push_back(entry);
        Some(piece)
    }

    /// Keeps the piece as the most recent; the oldest beyond the cap go.
    fn put(&mut self, key: &str, index: u64, piece: Piece) {
        if let Some(at) = self.position(key, index) {
            self.pieces.remove(at);
        }
        self.pieces.push_back((key.to_string(), index, piece));
        while self.pieces.len() > self.cap {
            self.pieces.pop_front();
        }
    }
}

/// One key on disk: which pieces are there, for the size its map was made for.
struct Kept {
    size: u64,
    /// A byte per piece, 1 where it is there.
    map: Vec<u8>,
    /// The pieces there, in bytes.
    bytes: u64,
    /// When it was last opened, read or written, on the cache's own clock.
    used: u64,
    /// Whether its files are on disk yet.
    written: bool,
}

/// The disk cache, a folder of the app's: per key `<hex>.data`, the file's size with each piece
/// kept at its offset and nothing in between (sparse), and `<hex>.map`, the size it was made for
/// (8 bytes, little-endian) and a byte per piece, 1 when it is there. A map that is not whole, or
/// whose key is opened with another size, is thrown away with its data. Its own work is blocking
/// file work: the callers run it off the async threads.
pub struct Disk {
    dir: PathBuf,
    cap: u64,
    scanned: bool,
    keys: HashMap<String, Kept>,
    total: u64,
    clock: u64,
    /// Off for the run: the folder's file system makes no sparse file.
    off: bool,
}

/// A map file's key entry, if it is whole: its size, and a 0 or a 1 for each of its pieces.
fn read_map(path: &Path) -> Option<Kept> {
    let bytes = fs::read(path).ok()?;
    let size = u64::from_le_bytes(bytes.get(..8)?.try_into().ok()?);
    let map = bytes[8..].to_vec();
    if map.len() as u64 != pieces(size) || pieces(size) > MAP_MAX || map.iter().any(|&b| b > 1) {
        return None;
    }
    let bytes = (0..map.len() as u64).filter(|&i| map[i as usize] == 1).map(|i| piece_len(size, i)).sum();
    Some(Kept { size, map, bytes, used: 0, written: true })
}

fn write_at(path: &Path, at: u64, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).open(path)?;
    file.seek(SeekFrom::Start(at))?;
    file.write_all(bytes)
}

/// Makes a new data file sparse, so a piece far into it takes no room before it: NTFS writes
/// zeros up to it otherwise. macOS and Linux leave a hole where nothing was written.
#[cfg(windows)]
fn sparse(file: &File) -> bool {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Ioctl::FSCTL_SET_SPARSE;
    use windows::Win32::System::IO::DeviceIoControl;
    let mut returned = 0u32;
    // SAFETY: the handle is the open file's; FSCTL_SET_SPARSE with no buffer sets the flag, and
    // `returned` outlives the call.
    unsafe { DeviceIoControl(HANDLE(file.as_raw_handle()), FSCTL_SET_SPARSE, None, 0, None, 0, Some(&raw mut returned), None) }.is_ok()
}

#[cfg(not(windows))]
fn sparse(_: &File) -> bool {
    true
}

impl Disk {
    pub fn new(dir: PathBuf, cap: u64) -> Self {
        Self { dir, cap, scanned: false, keys: HashMap::new(), total: 0, clock: 0, off: false }
    }

    fn paths(&self, hex: &str) -> (PathBuf, PathBuf) {
        (self.dir.join(format!("{hex}.data")), self.dir.join(format!("{hex}.map")))
    }

    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    /// Reads what the folder holds, once: each whole map with its data file, in the order they
    /// were last used (the map's time), and throws the rest away.
    fn scan(&mut self) {
        if self.scanned {
            return;
        }
        self.scanned = true;
        let Ok(entries) = fs::read_dir(&self.dir) else { return };
        let (mut found, mut data) = (Vec::new(), Vec::new());
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if let Some(hex) = name.strip_suffix(".map").filter(|h| is_hex(h)) {
                let (data_path, _) = self.paths(hex);
                match read_map(&entry.path()).filter(|_| data_path.is_file()) {
                    Some(kept) => {
                        // the file's own, not the folder listing's, which Windows may hold stale
                        let time = fs::metadata(entry.path()).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
                        found.push((time, hex.to_string(), kept));
                    }
                    None => {
                        let _ = fs::remove_file(entry.path());
                        let _ = fs::remove_file(data_path);
                    }
                }
            } else if let Some(hex) = name.strip_suffix(".data").filter(|h| is_hex(h)) {
                data.push(hex.to_string());
            }
        }
        found.sort_by_key(|(time, ..)| *time);
        for (_, hex, mut kept) in found {
            kept.used = self.tick();
            self.total += kept.bytes;
            self.keys.insert(hex, kept);
        }
        // a data file whose map is not there: written before its first piece was marked
        for hex in data.into_iter().filter(|h| !self.keys.contains_key(h)) {
            let _ = fs::remove_file(self.paths(&hex).0);
        }
    }

    /// The key's entry for a file of `size` bytes; one made for another size is thrown away. None
    /// for a file too large to keep.
    fn entry(&mut self, hex: &str, size: u64) -> Option<&mut Kept> {
        self.scan();
        if pieces(size) > MAP_MAX || size == 0 {
            return None;
        }
        if self.keys.get(hex).is_some_and(|k| k.size != size) {
            self.discard(hex);
        }
        Some(self.keys.entry(hex.to_string()).or_insert_with(|| Kept { size, map: vec![0; pieces(size) as usize], bytes: 0, used: 0, written: false }))
    }

    /// Throws a key's pieces away: the map first, since a data file without one goes at the next scan.
    fn discard(&mut self, hex: &str) {
        if let Some(kept) = self.keys.remove(hex) {
            self.total = self.total.saturating_sub(kept.bytes);
        }
        let (data, map) = self.paths(hex);
        let _ = fs::remove_file(map);
        let _ = fs::remove_file(data);
    }

    /// Marks a key used now, on disk too (its map's time) for the next run's order.
    fn touch(&mut self, hex: &str) {
        let used = self.tick();
        let (_, map) = self.paths(hex);
        if let Some(kept) = self.keys.get_mut(hex) {
            kept.used = used;
            if kept.written {
                let _ = OpenOptions::new().write(true).open(map).and_then(|f| f.set_modified(SystemTime::now()));
            }
        }
    }

    /// A key opened: used now, and its map checked against the size it is opened with.
    pub fn opened(&mut self, hex: &str, size: u64) {
        if self.entry(hex, size).is_some() {
            self.touch(hex);
        }
    }

    /// Whether piece `index` of the key is on disk.
    pub fn has(&mut self, hex: &str, size: u64, index: u64) -> bool {
        self.entry(hex, size).is_some_and(|k| k.map.get(index as usize) == Some(&1))
    }

    /// Piece `index` of the key, if it is on disk; one that cannot be read is marked gone.
    pub fn read(&mut self, hex: &str, size: u64, index: u64) -> Option<Vec<u8>> {
        if !self.has(hex, size, index) {
            return None;
        }
        let (data, map) = self.paths(hex);
        let len = piece_len(size, index);
        let read = (|| -> io::Result<Vec<u8>> {
            let mut file = File::open(&data)?;
            file.seek(SeekFrom::Start(index * PIECE))?;
            let mut buf = vec![0; len as usize];
            file.read_exact(&mut buf)?;
            Ok(buf)
        })();
        match read {
            Ok(buf) => {
                self.touch(hex);
                Some(buf)
            }
            Err(e) => {
                log::warn!("media cache: piece {index} of {hex} unreadable, dropped: {e}");
                if let Some(kept) = self.keys.get_mut(hex) {
                    kept.map[index as usize] = 0;
                    kept.bytes = kept.bytes.saturating_sub(len);
                    self.total = self.total.saturating_sub(len);
                    let _ = write_at(&map, 8 + index, &[0]);
                }
                None
            }
        }
    }

    /// Keeps piece `index` of the key, its bytes written (and synced) before its map says it is
    /// there. Past the cap, whole keys go first, the one used longest ago first, never one in
    /// `open` nor this one; when only those are left the piece is not kept. Answers whether it is.
    pub fn put(&mut self, hex: &str, size: u64, index: u64, piece: &[u8], open: &HashSet<String>) -> io::Result<bool> {
        let len = piece.len() as u64;
        if self.off || len == 0 || len != piece_len(size, index) || len > self.cap {
            return Ok(false);
        }
        let Some(kept) = self.entry(hex, size) else { return Ok(false) };
        let (there, written) = (kept.map[index as usize] == 1, kept.written);
        if there {
            self.touch(hex);
            return Ok(true);
        }
        while self.total + len > self.cap {
            let victim = self.keys.iter().filter(|(k, v)| k.as_str() != hex && v.written && !open.contains(k.as_str())).min_by_key(|(_, v)| v.used).map(|(k, _)| k.clone());
            match victim {
                Some(k) => self.discard(&k),
                None => return Ok(false),
            }
        }
        fs::create_dir_all(&self.dir)?;
        let (data_path, map_path) = self.paths(hex);
        let mut data = OpenOptions::new().write(true).create(true).truncate(false).open(&data_path)?;
        if !written {
            if !sparse(&data) {
                log::warn!("media cache: {} makes no sparse files; nothing is kept on disk", self.dir.display());
                drop(data);
                let _ = fs::remove_file(&data_path);
                self.off = true;
                return Ok(false);
            }
            data.set_len(size)?;
        }
        data.seek(SeekFrom::Start(index * PIECE))?;
        data.write_all(piece)?;
        data.sync_data()?;
        drop(data);
        let kept = self.keys.get_mut(hex).expect("the entry made above");
        if written {
            write_at(&map_path, 8 + index, &[1])?;
        } else {
            let mut map = Vec::with_capacity(8 + kept.map.len());
            map.extend_from_slice(&size.to_le_bytes());
            map.extend_from_slice(&kept.map);
            map[8 + index as usize] = 1;
            fs::write(&map_path, &map)?;
        }
        kept.map[index as usize] = 1;
        kept.bytes += len;
        kept.written = true;
        self.total += len;
        self.touch(hex);
        Ok(true)
    }
}

/// What cophylad sent for a read from `at` of the file opened (`size` bytes, last modified at
/// `modified`): its bytes, or why there are none: the error it sent, a file that is no longer the
/// one opened, or a computer that sends none of it.
fn read_answer(frame: &Value, size: u64, modified: u64, at: u64) -> Result<Vec<u8>, String> {
    let text = |s: &str| s.chars().take(ERROR_MAX).collect::<String>();
    if let Some(error) = frame.get("error") {
        return Err(text(error.pointer("/data/message").or_else(|| error.get("message")).and_then(Value::as_str).unwrap_or("the read failed")));
    }
    let Some(file) = frame.get("result") else { return Err(NO_BYTES.into()) };
    if file.get("size").and_then(Value::as_u64) != Some(size) || file.get("modified").and_then(Value::as_u64) != Some(modified) {
        return Err(CHANGED.into());
    }
    let Some(base64) = file.get("base64").and_then(Value::as_str) else {
        if file.get("binary").and_then(Value::as_bool) == Some(true) {
            return Err(file.get("note").and_then(Value::as_str).filter(|n| !n.is_empty()).map_or(SENDS_NONE.to_string(), text));
        }
        return Err(NO_BYTES.into());
    };
    if file.get("at").and_then(Value::as_u64).is_some_and(|a| a != at) {
        return Err("cophylad answered for another place in the file".into());
    }
    BASE64.decode(base64.as_bytes()).map_err(|_| "the piece was not base64".to_string())
}

/// A piece being fetched: its read once it is out (`req`, the same for each part when an answer
/// short of the piece asks again), what has come of it, the requests waiting for it, and the timer
/// that fails it.
struct Pending {
    req: Option<u64>,
    got: Vec<u8>,
    waiters: Vec<Waiter>,
    timer: Option<AbortHandle>,
}

struct Stream {
    /// Which open this is, so a request of a stream closed and opened again under its id ends.
    serial: u64,
    hex: String,
    size: u64,
    modified: u64,
    mime: String,
    keep: bool,
    source: Source,
    stats: Stats,
    pending: HashMap<u64, Pending>,
    /// Pieces waiting for one of the stream's reads to come back.
    queue: VecDeque<u64>,
    /// Reads out.
    out: usize,
}

struct Shared {
    streams: HashMap<String, Stream>,
    /// Each read out: its stream and piece.
    reqs: HashMap<u64, (String, u64)>,
    next_req: u64,
    next_serial: u64,
    memory: Memory,
}

struct Inner {
    shared: Mutex<Shared>,
    disk: Option<Arc<Mutex<Disk>>>,
    out: Out,
    timeout: Duration,
    server: OnceLock<Server>,
    page: OnceLock<PageSocket>,
}

/// The loopback server the media elements fetch from: its port, and this run's secret, the first
/// segment of every path it serves (128 random bits, in hex); and the link socket's own secret.
struct Server {
    port: u16,
    secret: String,
    link_secret: String,
}

/// The session run over each link socket upgraded (page.rs).
type ServePage = Box<dyn Fn(WebSocketStream<TcpStream>) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// What serves the host page's link socket: the origins it may come from, and its session.
struct PageSocket {
    origins: Vec<String>,
    serve: ServePage,
}

impl Server {
    /// The `Host` a request to it names, and its origin past `http://`.
    fn host(&self) -> String {
        format!("127.0.0.1:{}", self.port)
    }
}

/// What `media_open` answers: where the player page finds the stream.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Opened {
    pub url: String,
}

/// The streams the host page opened, their reads, and the pieces kept: the state the commands,
/// the link (cophylad.rs) and the media server share.
#[derive(Clone)]
pub struct Media(Arc<Inner>);

/// A read to send to cophylad: its number and its frame.
type Ask = (u64, String);

/// What a change leaves to do once the lock is let go: reads to send, and a piece to keep on disk.
#[derive(Default)]
struct After {
    asks: Vec<Ask>,
    write: Option<(String, u64, u64, Piece)>,
    open: HashSet<String>,
}

/// Where a request for a piece stands.
enum Step {
    Ready(Piece),
    Wait(oneshot::Receiver<Result<Piece, Fail>>, Option<Ask>),
    Disk(String, u64),
    Gone,
}

/// What an answer leaves to do: read again from where it stopped, or end the fetch.
enum Answer {
    Again(String),
    Done(Result<Piece, Fail>),
}

/// Runs disk work on the runtime's blocking threads, off the thread that asked.
fn blocking(work: impl FnOnce() + Send + 'static) {
    match tokio::runtime::Handle::try_current() {
        Ok(rt) => drop(rt.spawn_blocking(work)),
        Err(_) => work(),
    }
}

fn plain(status: StatusCode, text: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(text.as_bytes().to_vec())
        .expect("plain response")
}

/// The answer to a request whose piece did not come.
fn failed(fail: Fail) -> Response<Vec<u8>> {
    match fail {
        Fail::Error(e) => plain(StatusCode::BAD_GATEWAY, &e),
        Fail::Timeout => plain(StatusCode::GATEWAY_TIMEOUT, TIMED_OUT),
        Fail::Closed => plain(StatusCode::GONE, "the stream closed"),
    }
}

impl Media {
    /// Reads sent by `out`, pieces kept on disk under `dir` (none: in memory only).
    pub fn new(dir: Option<PathBuf>, out: Out) -> Self {
        Self::with(dir, DISK_CAP, NEED_TIMEOUT, out)
    }

    fn with(dir: Option<PathBuf>, cap: u64, timeout: Duration, out: Out) -> Self {
        let shared = Shared { streams: HashMap::new(), reqs: HashMap::new(), next_req: 1, next_serial: 1, memory: Memory::new(MEMORY_PIECES) };
        Media(Arc::new(Inner { shared: Mutex::new(shared), disk: dir.map(|d| Arc::new(Mutex::new(Disk::new(d, cap)))), out, timeout, server: OnceLock::new(), page: OnceLock::new() }))
    }

    /// The app's: pieces read over the shell's link to cophylad, the disk cache in the app's local
    /// data, and the media server listening from now on, served on the async runtime.
    pub fn for_app<R: Runtime>(app: &AppHandle<R>) -> Self {
        let dir = match app.path().app_local_data_dir() {
            Ok(dir) => Some(dir.join(CACHE_DIR)),
            Err(e) => {
                log::warn!("media: no folder for the cache, pieces are kept in memory only: {e}");
                None
            }
        };
        let reads = app.clone();
        let out: Out = Box::new(move |frame| match reads.try_state::<Link>() {
            Some(link) => link.send(frame),
            None => Err("unavailable: no link to cophylad".into()),
        });
        let media = Self::new(dir, out);
        // the host page's link socket, from the host page alone (or `tauri dev`'s server)
        let origins = std::iter::once(crate::views::HOST_ORIGIN.to_string()).chain(crate::views::dev_origin(app)).collect();
        let page_app = app.clone();
        media.serve_page(origins, move |ws| {
            let app = page_app.clone();
            Box::pin(async move {
                let link = app.state::<Link>();
                crate::page::serve(&link, ws).await;
            })
        });
        match media.bind() {
            Ok(listener) => drop(tauri::async_runtime::spawn(media.clone().run(listener))),
            Err(e) => log::warn!("media: the media server did not start, so no stream opens: {e}"),
        }
        media
    }

    /// The media server's origin, `http://127.0.0.1:<port>`, once it listens.
    pub fn origin(&self) -> Option<String> {
        self.0.server.get().map(|s| format!("http://{}", s.host()))
    }

    /// Stream `id`'s URL on the media server, the file's `name` in it for show; none before it listens.
    pub fn url(&self, id: &str, name: &str) -> Option<String> {
        let server = self.0.server.get()?;
        let name: String = name.chars().take(NAME_MAX).collect();
        Some(format!("http://{}/{}{PATH_PREFIX}{id}/{}", server.host(), server.secret, utf8_percent_encode(&name, NAME_SET)))
    }

    /// Where the host page's link socket is, once the server listens and serves it.
    pub fn link_url(&self) -> Option<String> {
        let server = self.0.server.get()?;
        self.0.page.get()?;
        Some(format!("ws://{}/{}{LINK_PATH}", server.host(), server.link_secret))
    }

    /// Serves the host page's link socket from now on: a socket from one of `origins`, upgraded,
    /// is handed to `serve`, and the connection lasts as long as what it returns runs. Once.
    pub fn serve_page(&self, origins: Vec<String>, serve: impl Fn(WebSocketStream<TcpStream>) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync + 'static) {
        let _ = self.0.page.set(PageSocket { origins, serve: Box::new(serve) });
    }

    /// Binds the media server on a loopback port the system picks, with a secret of its own for
    /// the run and another for the link socket; `run` serves it. Once a run.
    fn bind(&self) -> io::Result<std::net::TcpListener> {
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let secret = || -> io::Result<String> {
            let mut bytes = [0u8; 16];
            getrandom::fill(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
            Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
        };
        self.0.server.set(Server { port, secret: secret()?, link_secret: secret()? }).map_err(|_| io::Error::other("the media server listens already"))?;
        Ok(listener)
    }

    /// Binds the server and serves it on the app's async runtime, for another module's tests.
    #[cfg(test)]
    pub fn listen(&self) -> io::Result<()> {
        let listener = self.bind()?;
        drop(tauri::async_runtime::spawn(self.clone().run(listener)));
        Ok(())
    }

    /// Serves the media server's connections, each in a task of its own, `CONNECTIONS` at most.
    async fn run(self, listener: std::net::TcpListener) {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(e) => {
                log::warn!("media server: {e}");
                return;
            }
        };
        let room = Arc::new(Semaphore::new(CONNECTIONS));
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let Ok(permit) = room.clone().try_acquire_owned() else { continue };
                    let media = self.clone();
                    tokio::spawn(async move {
                        media.connection(stream).await;
                        drop(permit);
                    });
                }
                Err(e) => {
                    log::debug!("media server: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }

    /// One connection: its request read, answered, and the connection closed; or, for the host
    /// page's link socket, upgraded and served for as long as the socket is open.
    async fn connection(&self, mut stream: TcpStream) {
        let Some(server) = self.0.server.get() else { return };
        let (response, head_only) = match tokio::time::timeout(HEAD_TIMEOUT, read_head(&mut stream)).await {
            Err(_) => (plain(StatusCode::REQUEST_TIMEOUT, "the request did not come in time"), false),
            Ok(Err(status)) => (plain(status, "bad request"), false),
            Ok(Ok(bytes)) => match parse_head(&bytes) {
                Err(why) => (plain(StatusCode::BAD_REQUEST, why), false),
                Ok(head) => match upgrade(&head, server, self.0.page.get().map(|p| p.origins.as_slice())) {
                    Some(Ok(accept)) => {
                        let switching = format!("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: {accept}\r\n\r\n");
                        if let Err(e) = stream.write_all(switching.as_bytes()).await {
                            log::debug!("page socket: the upgrade not taken: {e}");
                            return;
                        }
                        let Some(page) = self.0.page.get() else { return };
                        let ws = WebSocketStream::from_raw_socket(stream, Role::Server, None).await;
                        (page.serve)(ws).await;
                        return;
                    }
                    Some(Err(refused)) => (refused, false),
                    None => {
                        let response = match route(&head, &server.secret, server.port) {
                            Ok(path) => self.serve(&head.method, path, head.range.as_deref()).await,
                            Err(refused) => refused,
                        };
                        (response, head.method == Method::HEAD)
                    }
                },
            },
        };
        let write = async {
            stream.write_all(&head_bytes(&response)).await?;
            if !head_only {
                stream.write_all(response.body()).await?;
            }
            stream.shutdown().await
        };
        match tokio::time::timeout(WRITE_TIMEOUT, write).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => log::debug!("media server: an answer not taken: {e}"),
            Err(_) => log::debug!("media server: an answer not taken in time"),
        }
    }

    /// Opens stream `id`: the file of `size` bytes last modified at `modified`, named by `key`, read
    /// from `source`, answered as `mime`, its pieces kept on disk when `keep`.
    #[allow(clippy::too_many_arguments)]
    pub fn open(&self, id: &str, key: &str, size: u64, modified: u64, mime: &str, keep: bool, source: Source) -> Result<(), String> {
        stream_id(id)?;
        if key.is_empty() || key.len() > KEY_MAX {
            return Err("invalid: bad media key".into());
        }
        if mime.is_empty() || mime.len() > MIME_MAX || !mime.contains('/') || HeaderValue::from_str(mime).is_err() {
            return Err("invalid: bad media type".into());
        }
        let hex = hex_key(key);
        let keep = keep && self.0.disk.is_some();
        let mut shared = lock(&self.0.shared);
        if shared.streams.contains_key(id) {
            return Err("invalid: that media stream is open already".into());
        }
        let serial = shared.next_serial;
        shared.next_serial += 1;
        let stream = Stream { serial, hex: hex.clone(), size, modified, mime: mime.to_string(), keep, source, stats: Stats::default(), pending: HashMap::new(), queue: VecDeque::new(), out: 0 };
        shared.streams.insert(id.to_string(), stream);
        drop(shared);
        if let (true, Some(disk)) = (keep, self.0.disk.clone()) {
            blocking(move || {
                lock(&disk).opened(&hex, size);
            });
        }
        Ok(())
    }

    /// Closes stream `id`: requests waiting on it end (410), and its pieces on disk stay.
    pub fn close(&self, id: &str) {
        let mut shared = lock(&self.0.shared);
        let Some(stream) = shared.streams.remove(id) else { return };
        for pending in stream.pending.into_values() {
            if let Some(req) = pending.req {
                shared.reqs.remove(&req);
            }
            if let Some(timer) = pending.timer {
                timer.abort();
            }
            for waiter in pending.waiters {
                let _ = waiter.send(Err(Fail::Closed));
            }
        }
    }

    /// How stream `id`'s requests went, while it is open.
    pub fn stats(&self, id: &str) -> Option<Stats> {
        lock(&self.0.shared).streams.get(id).map(|s| s.stats.clone())
    }

    /// The link to cophylad went, and the answers to the reads out with it: their pieces fail now,
    /// not at their timeout.
    pub fn link_lost(&self) {
        let mut shared = lock(&self.0.shared);
        let out: Vec<u64> = shared.reqs.keys().copied().collect();
        let mut asks = Vec::new();
        for req in out {
            if let Some((id, index)) = shared.reqs.remove(&req) {
                asks.extend(self.settle(&mut shared, &id, index, Err(Fail::Error(LINK_LOST.into()))).asks);
            }
        }
        drop(shared);
        self.send(asks);
    }

    /// cophylad's answer to read `media:<n>`, as cophylad.rs parsed it: a piece's bytes, joined to
    /// what came before when an answer carries less than the piece and read again from where it
    /// stopped, or why there are none. One for a read no longer out is let go.
    pub fn answered(&self, id: &str, frame: &Value) {
        let Some(req) = id.strip_prefix(RPC_PREFIX).and_then(|n| n.parse::<u64>().ok()) else { return };
        let mut shared = lock(&self.0.shared);
        let Some((sid, index)) = shared.reqs.get(&req).cloned() else { return };
        let next = {
            let Some(stream) = shared.streams.get_mut(&sid) else { return };
            let (size, modified, want) = (stream.size, stream.modified, piece_len(stream.size, index) as usize);
            let Some(pending) = stream.pending.get_mut(&index) else { return };
            let at = index * PIECE + pending.got.len() as u64;
            match read_answer(frame, size, modified, at) {
                Err(e) => Answer::Done(Err(Fail::Error(e))),
                Ok(bytes) if bytes.is_empty() => Answer::Done(Err(Fail::Error(SHORT.into()))),
                Ok(bytes) => {
                    let room = want - pending.got.len();
                    pending.got.extend_from_slice(&bytes[..bytes.len().min(room)]);
                    if pending.got.len() < want {
                        Answer::Again(stream.source.frame(req, index * PIECE + pending.got.len() as u64))
                    } else {
                        Answer::Done(Ok(Arc::new(std::mem::take(&mut pending.got))))
                    }
                }
            }
        };
        match next {
            Answer::Again(frame) => {
                drop(shared);
                self.send(vec![(req, frame)]);
            }
            Answer::Done(result) => {
                shared.reqs.remove(&req);
                let after = self.settle(&mut shared, &sid, index, result);
                drop(shared);
                self.after(after);
            }
        }
    }

    /// Read `req` had no answer in time.
    fn expire(&self, req: u64) {
        let mut shared = lock(&self.0.shared);
        let Some((id, index)) = shared.reqs.remove(&req) else { return };
        let after = self.settle(&mut shared, &id, index, Err(Fail::Timeout));
        drop(shared);
        self.after(after);
    }

    /// Ends the fetch of a stream's piece: its waiters hear how it went, a piece that came is
    /// kept (in memory, and on disk for a stream that keeps), the stream's stats say why one did
    /// not, and the next pieces queued go out.
    fn settle(&self, shared: &mut Shared, id: &str, index: u64, result: Result<Piece, Fail>) -> After {
        let Shared { streams, reqs, next_req, memory, .. } = shared;
        let mut after = After::default();
        let Some(stream) = streams.get_mut(id) else { return after };
        if let Some(pending) = stream.pending.remove(&index) {
            if pending.req.is_some() {
                stream.out -= 1;
            }
            if let Some(timer) = pending.timer {
                timer.abort();
            }
            match &result {
                Ok(piece) => {
                    stream.stats.fetched += 1;
                    stream.stats.error = None;
                    memory.put(&stream.hex, index, piece.clone());
                    if stream.keep {
                        after.write = Some((stream.hex.clone(), stream.size, index, piece.clone()));
                    }
                }
                Err(Fail::Error(e)) => stream.stats.error = Some(e.clone()),
                Err(Fail::Timeout) => stream.stats.error = Some(TIMED_OUT.into()),
                Err(Fail::Closed) => {}
            }
            for waiter in pending.waiters {
                let _ = waiter.send(result.clone());
            }
        }
        while stream.out < IN_FLIGHT {
            let Some(next) = stream.queue.pop_front() else { break };
            if stream.pending.contains_key(&next) {
                after.asks.push(self.send_out(stream, reqs, next_req, id, next));
            }
        }
        if after.write.is_some() {
            after.open = streams.values().map(|s| s.hex.clone()).collect();
        }
        after
    }

    /// A pending piece's read, out now: numbered, counted, and timed.
    fn send_out(&self, stream: &mut Stream, reqs: &mut HashMap<u64, (String, u64)>, next_req: &mut u64, id: &str, index: u64) -> Ask {
        let req = *next_req;
        *next_req += 1;
        reqs.insert(req, (id.to_string(), index));
        stream.out += 1;
        let timer = tokio::runtime::Handle::try_current().ok().map(|rt| {
            let inner = Arc::downgrade(&self.0);
            let timeout = self.0.timeout;
            rt.spawn(async move {
                tokio::time::sleep(timeout).await;
                if let Some(inner) = inner.upgrade() {
                    Media(inner).expire(req);
                }
            })
            .abort_handle()
        });
        if let Some(pending) = stream.pending.get_mut(&index) {
            pending.req = Some(req);
            pending.timer = timer;
        }
        (req, stream.source.frame(req, index * PIECE))
    }

    /// A piece to fetch: its read out now if the stream has room, else queued.
    fn enqueue(&self, stream: &mut Stream, reqs: &mut HashMap<u64, (String, u64)>, next_req: &mut u64, id: &str, index: u64, waiter: Option<Waiter>) -> Option<Ask> {
        stream.pending.insert(index, Pending { req: None, got: Vec::new(), waiters: waiter.into_iter().collect(), timer: None });
        if stream.out < IN_FLIGHT {
            Some(self.send_out(stream, reqs, next_req, id, index))
        } else {
            stream.queue.push_back(index);
            None
        }
    }

    fn after(&self, after: After) {
        if let (Some((hex, size, index, piece)), Some(disk)) = (after.write, self.0.disk.clone()) {
            let open = after.open;
            blocking(move || {
                let kept = lock(&disk).put(&hex, size, index, &piece, &open);
                if let Err(e) = kept {
                    log::warn!("media cache: piece {index} of {hex} not kept: {e}");
                }
            });
        }
        self.send(after.asks);
    }

    /// Sends reads to cophylad; one that cannot be sent (the link is down) fails its piece at once,
    /// which may send the next.
    fn send(&self, asks: Vec<Ask>) {
        let mut asks = VecDeque::from(asks);
        while let Some((req, frame)) = asks.pop_front() {
            let Err(e) = (self.0.out)(frame) else { continue };
            let mut shared = lock(&self.0.shared);
            if let Some((id, index)) = shared.reqs.remove(&req) {
                asks.extend(self.settle(&mut shared, &id, index, Err(Fail::Error(e))).asks);
            }
        }
    }

    fn step(&self, id: &str, serial: u64, index: u64, disk_read: bool) -> Step {
        let mut shared = lock(&self.0.shared);
        let Shared { streams, reqs, next_req, memory, .. } = &mut *shared;
        let Some(stream) = streams.get_mut(id).filter(|s| s.serial == serial) else { return Step::Gone };
        if let Some(piece) = memory.get(&stream.hex, index) {
            stream.stats.cached += 1;
            return Step::Ready(piece);
        }
        let (tx, rx) = oneshot::channel();
        if let Some(pending) = stream.pending.get_mut(&index) {
            pending.waiters.push(tx);
            return Step::Wait(rx, None);
        }
        if stream.keep && !disk_read {
            return Step::Disk(stream.hex.clone(), stream.size);
        }
        let ask = self.enqueue(stream, reqs, next_req, id, index, Some(tx));
        Step::Wait(rx, ask)
    }

    /// Piece `index` of a stream: from memory, from disk, or read from cophylad, one read for
    /// every request waiting on it.
    async fn piece(&self, id: &str, serial: u64, index: u64) -> Result<Piece, Fail> {
        let mut disk_read = false;
        loop {
            match self.step(id, serial, index, disk_read) {
                Step::Gone => return Err(Fail::Closed),
                Step::Ready(piece) => return Ok(piece),
                Step::Wait(rx, ask) => {
                    self.send(ask.into_iter().collect());
                    return rx.await.unwrap_or(Err(Fail::Closed));
                }
                Step::Disk(hex, size) => {
                    disk_read = true;
                    let Some(disk) = self.0.disk.clone() else { continue };
                    let key = hex.clone();
                    let read = tokio::task::spawn_blocking(move || {
                        let read = lock(&disk).read(&key, size, index);
                        read
                    });
                    let Some(bytes) = read.await.ok().flatten() else { continue };
                    let piece = Arc::new(bytes);
                    let mut shared = lock(&self.0.shared);
                    let Shared { streams, memory, .. } = &mut *shared;
                    let Some(stream) = streams.get_mut(id).filter(|s| s.serial == serial) else { return Err(Fail::Closed) };
                    stream.stats.cached += 1;
                    memory.put(&hex, index, piece.clone());
                    return Ok(piece);
                }
            }
        }
    }

    /// Makes sure piece `index` of a stream is kept or on its way, with no request waiting for it.
    async fn prefetch(&self, id: &str, serial: u64, index: u64) {
        let mut disk_checked = false;
        loop {
            let (hex, size) = {
                let mut shared = lock(&self.0.shared);
                let Shared { streams, reqs, next_req, memory, .. } = &mut *shared;
                let Some(stream) = streams.get_mut(id).filter(|s| s.serial == serial) else { return };
                if index >= pieces(stream.size) || memory.has(&stream.hex, index) || stream.pending.contains_key(&index) {
                    return;
                }
                if !stream.keep || disk_checked {
                    let ask = self.enqueue(stream, reqs, next_req, id, index, None);
                    drop(shared);
                    self.send(ask.into_iter().collect());
                    return;
                }
                (stream.hex.clone(), stream.size)
            };
            let Some(disk) = self.0.disk.clone() else { return };
            let there = tokio::task::spawn_blocking(move || {
                let there = lock(&disk).has(&hex, size, index);
                there
            });
            if there.await.unwrap_or(false) {
                return;
            }
            disk_checked = true;
        }
    }

    /// The pieces after `last` kept or on their way, in the background.
    fn readahead(&self, id: &str, serial: u64, last: u64) {
        let (media, id) = (self.clone(), id.to_string());
        tokio::spawn(async move {
            for index in last + 1..=last + READAHEAD {
                media.prefetch(&id, serial, index).await;
            }
        });
    }

    fn is_open(&self, id: &str, serial: u64) -> bool {
        lock(&self.0.shared).streams.get(id).is_some_and(|s| s.serial == serial)
    }

    /// Answers a request for a stream, its path past the server's secret: `GET` (or `HEAD`, the
    /// same with no body) of `/media/<id>/<name>` with the request's `Range` header. 206 with two pieces at
    /// most; 416 for a range past the end; 200 and nothing for an empty file; 404 for a stream
    /// not open, 410 for one closed while the request waited, 502 when the host page could not
    /// get a piece and 504 when it did not answer in time.
    pub async fn serve(&self, method: &Method, path: &str, range: Option<&str>) -> Response<Vec<u8>> {
        if *method != Method::GET && *method != Method::HEAD {
            let mut response = plain(StatusCode::METHOD_NOT_ALLOWED, "only GET");
            response.headers_mut().insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
            return response;
        }
        let Some(id) = path_id(path) else { return plain(StatusCode::NOT_FOUND, "no such stream") };
        let (serial, size, mime) = {
            let mut shared = lock(&self.0.shared);
            let Some(stream) = shared.streams.get_mut(id) else { return plain(StatusCode::NOT_FOUND, "no such stream") };
            stream.stats.requests += 1;
            (stream.serial, stream.size, stream.mime.clone())
        };
        let media = |status: StatusCode, length: u64| {
            Response::builder()
                .status(status)
                .header(header::CONTENT_TYPE, mime.as_str())
                .header(header::CONTENT_LENGTH, length)
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CACHE_CONTROL, "no-store")
                .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                .header(header::CONTENT_SECURITY_POLICY, MEDIA_CSP)
        };
        if size == 0 {
            return media(StatusCode::OK, 0).body(Vec::new()).expect("media response");
        }
        let (start, end) = match parse_range(range, size) {
            Asked::Bytes(start, end) => bounds(start, end, size),
            Asked::Unsatisfiable => {
                let mut response = plain(StatusCode::RANGE_NOT_SATISFIABLE, "the range is past the end");
                response.headers_mut().insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes */{size}")).expect("a number"));
                return response;
            }
        };
        let length = end - start + 1;
        let partial = |body: Vec<u8>| media(StatusCode::PARTIAL_CONTENT, length).header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}")).body(body).expect("media response");
        if *method == Method::HEAD {
            return partial(Vec::new());
        }
        let (first, last) = (start / PIECE, end / PIECE);
        let got = futures_util::future::try_join_all((first..=last).map(|index| self.piece(id, serial, index))).await;
        let got = match got {
            Ok(got) => got,
            Err(fail) => return failed(fail),
        };
        if !self.is_open(id, serial) {
            return failed(Fail::Closed);
        }
        let mut body = Vec::with_capacity(length as usize);
        for (index, piece) in (first..=last).zip(&got) {
            let base = index * PIECE;
            let from = start.max(base) - base;
            let to = (end + 1).min(base + piece.len() as u64) - base;
            body.extend_from_slice(&piece[from as usize..to as usize]);
        }
        self.readahead(id, serial, last);
        partial(body)
    }
}

/// A request's head as the media server reads it: its method and target, and of its fields the
/// `Host`, the first `Range`, and what a WebSocket upgrade says (the first of each).
#[derive(Debug, Default, PartialEq, Eq)]
struct Head {
    method: Method,
    target: String,
    host: Option<String>,
    range: Option<String>,
    origin: Option<String>,
    upgrade: Option<String>,
    connection: Option<String>,
    ws_key: Option<String>,
    ws_version: Option<String>,
}

/// Reads a request's head off a connection: the bytes before its blank line, `HEAD_MAX` at most.
async fn read_head<S: AsyncRead + Unpin>(stream: &mut S) -> Result<Vec<u8>, StatusCode> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream.read(&mut chunk).await.map_err(|_| StatusCode::BAD_REQUEST)?;
        if n == 0 {
            return Err(StatusCode::BAD_REQUEST);
        }
        let from = buf.len().saturating_sub(3);
        buf.extend_from_slice(&chunk[..n]);
        if let Some(at) = buf[from..].windows(4).position(|w| w == b"\r\n\r\n") {
            if from + at > HEAD_MAX {
                return Err(StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE);
            }
            buf.truncate(from + at);
            return Ok(buf);
        }
        if buf.len() > HEAD_MAX {
            return Err(StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE);
        }
    }
}

/// Reads a request head: the request line of an HTTP/1 request in origin form, and its fields,
/// one per line, none folded, with one `Host` at most.
fn parse_head(bytes: &[u8]) -> Result<Head, &'static str> {
    let text = std::str::from_utf8(bytes).map_err(|_| "the request is not text")?;
    let mut lines = text.split("\r\n");
    let mut parts = lines.next().unwrap_or_default().split(' ');
    let (Some(method), Some(target), Some(version), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err("a bad request line");
    };
    if !matches!(version, "HTTP/1.1" | "HTTP/1.0") {
        return Err("not HTTP/1");
    }
    let method = Method::from_bytes(method.as_bytes()).map_err(|_| "a bad method")?;
    if !target.starts_with('/') {
        return Err("a bad target");
    }
    let mut head = Head { method, target: target.to_string(), ..Head::default() };
    for field in lines {
        let Some((name, value)) = field.split_once(':') else { return Err("a bad field") };
        if name.is_empty() || name.contains([' ', '\t']) {
            return Err("a bad field name");
        }
        let value = value.trim_matches([' ', '\t']).to_string();
        if name.eq_ignore_ascii_case("host") {
            if head.host.replace(value).is_some() {
                return Err("two hosts");
            }
            continue;
        }
        let slot = match name.to_ascii_lowercase().as_str() {
            "range" => &mut head.range,
            "origin" => &mut head.origin,
            "upgrade" => &mut head.upgrade,
            "connection" => &mut head.connection,
            "sec-websocket-key" => &mut head.ws_key,
            "sec-websocket-version" => &mut head.ws_version,
            _ => continue,
        };
        if slot.is_none() {
            *slot = Some(value);
        }
    }
    Ok(head)
}

/// Whether a request is for the host page's link socket, and how it is answered: none for a
/// request that is not (it is served as a media request, and refused there); the key's accept for
/// an upgrade of one at `/<link secret>/link` that names the server's host, comes from one of
/// `origins` (none while nothing serves the socket) and asks a WebSocket of version 13; a refusal
/// otherwise (421 for another host, 403 for another origin, 400 for anything that is no upgrade).
fn upgrade(head: &Head, server: &Server, origins: Option<&[String]>) -> Option<Result<String, Response<Vec<u8>>>> {
    let path = head.target.split('?').next().unwrap_or_default();
    let rest = path.strip_prefix('/').and_then(|p| past_secret(p, &server.link_secret))?;
    if rest != LINK_PATH {
        return None;
    }
    if head.host.as_deref() != Some(server.host().as_str()) {
        return Some(Err(plain(StatusCode::MISDIRECTED_REQUEST, "not this server's host")));
    }
    let Some(origins) = origins else { return Some(Err(plain(StatusCode::NOT_FOUND, "not found"))) };
    if !head.origin.as_deref().is_some_and(|o| origins.iter().any(|allowed| allowed == o)) {
        return Some(Err(plain(StatusCode::FORBIDDEN, "not the host page")));
    }
    let token = |field: &Option<String>, want: &str| field.as_deref().is_some_and(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case(want)));
    let Some(key) = head.ws_key.as_deref().filter(|k| !k.is_empty()) else { return Some(Err(plain(StatusCode::BAD_REQUEST, "no websocket key"))) };
    if head.method != Method::GET || !token(&head.upgrade, "websocket") || !token(&head.connection, "upgrade") || head.ws_version.as_deref() != Some("13") {
        return Some(Err(plain(StatusCode::BAD_REQUEST, "not a websocket upgrade")));
    }
    Some(Ok(derive_accept_key(key.as_bytes())))
}

/// The rest of `path` past `secret`, compared in a time that does not tell how much of it matched.
fn past_secret<'a>(path: &'a str, secret: &str) -> Option<&'a str> {
    let given = path.get(..secret.len())?;
    let differ = given.bytes().zip(secret.bytes()).fold(0u8, |d, (a, b)| d | (a ^ b));
    (differ == 0).then(|| &path[secret.len()..])
}

/// Where a request to the media server is served (`/media/<id>/<name>`), or its refusal: 421 for
/// a `Host` that is not the server's own (another name for loopback, as a page that points a
/// name of its own at it sends), 404 for a path not under this run's secret.
fn route<'a>(head: &'a Head, secret: &str, port: u16) -> Result<&'a str, Response<Vec<u8>>> {
    if head.host.as_deref() != Some(format!("127.0.0.1:{port}").as_str()) {
        return Err(plain(StatusCode::MISDIRECTED_REQUEST, "not this server's host"));
    }
    let path = head.target.split('?').next().unwrap_or_default();
    match path.strip_prefix('/').and_then(|p| past_secret(p, secret)) {
        Some(rest) if rest.starts_with(PATH_PREFIX) => Ok(rest),
        _ => Err(plain(StatusCode::NOT_FOUND, "not found")),
    }
}

/// A response's head as HTTP/1.1 sends it: the status line, its fields with its length, and
/// `Connection: close`, since a connection carries one request. The body follows it, but for a HEAD.
fn head_bytes(response: &Response<Vec<u8>>) -> Vec<u8> {
    let status = response.status();
    let mut out = format!("HTTP/1.1 {} {}\r\n", status.as_u16(), status.canonical_reason().unwrap_or("")).into_bytes();
    for (name, value) in response.headers() {
        out.extend_from_slice(name.as_str().as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(value.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    if !response.headers().contains_key(header::CONTENT_LENGTH) {
        out.extend_from_slice(format!("content-length: {}\r\n", response.body().len()).as_bytes());
    }
    out.extend_from_slice(b"connection: close\r\n\r\n");
    out
}

/// Base64 as the host page sends it, padded or not.
const BASE64: GeneralPurpose = GeneralPurpose::new(&base64::alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent));

/// Opens a stream and answers its URL on the media server, where the player page finds it: the
/// file of `size` bytes last modified at `modified` (as cophylad says it, in milliseconds) whose
/// version `key` names, read with `read` (`{ method, params }`: `session.file` or `terminal.file`
/// and the file's place), answered as `mime`, its pieces kept on disk when `keep` (the file is on
/// another machine), its `name` in the URL for show.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn media_open(media: State<'_, Media>, id: String, key: String, size: u64, modified: u64, mime: String, keep: bool, read: Value, name: String) -> Result<Opened, String> {
    let source = Source::from_value(&read)?;
    let url = media.url(stream_id(&id)?, &name).ok_or_else(|| "unavailable: the media server is not listening".to_string())?;
    media.open(&id, &key, size, modified, &mime, keep, source)?;
    Ok(Opened { url })
}

/// Closes a stream: requests waiting on it end, and its pieces on disk stay.
#[tauri::command]
pub async fn media_close(media: State<'_, Media>, id: String) -> Result<(), String> {
    media.close(stream_id(&id)?);
    Ok(())
}

/// How a stream's requests went: `{ requests, fetched, cached, error? }`, `error` why the last
/// read failed.
#[tauri::command]
pub async fn media_stats(media: State<'_, Media>, id: String) -> Result<Stats, String> {
    media.stats(stream_id(&id)?).ok_or_else(|| "not_found: no such media stream".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder for one test, gone after it.
    struct Folder(PathBuf);

    impl Folder {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("cophyla-test-media-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Folder(dir)
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// The bytes of a file whose byte `i` is `i` as a byte, so a piece read at a wrong offset shows.
    fn bytes(at: u64, len: u64) -> Vec<u8> {
        (at..at + len).map(|i| (i % 251) as u8).collect()
    }

    fn file_piece(size: u64, index: u64) -> Vec<u8> {
        bytes(index * PIECE, piece_len(size, index))
    }

    /// When the files the tests read were last modified, as cophylad says it.
    const MODIFIED: u64 = 1_700_000_000_000;

    /// A media whose reads are kept for the test to answer, as cophylad would.
    fn media(dir: Option<PathBuf>, timeout: Duration) -> (Media, Arc<Mutex<Vec<Value>>>) {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let kept = sent.clone();
        let media = Media::with(dir, DISK_CAP, timeout, Box::new(move |frame: String| {
            kept.lock().unwrap().push(serde_json::from_str::<Value>(&frame).unwrap());
            Ok(())
        }));
        (media, sent)
    }

    fn source() -> Source {
        Source::from_value(&json!({ "method": "session.file", "params": { "id": "ses_1", "path": "clip.mp4" } })).unwrap()
    }

    /// Opens a stream of a test file, read from `source()`.
    fn open(media: &Media, id: &str, key: &str, size: u64, keep: bool) {
        media.open(id, key, size, MODIFIED, "video/mp4", keep, source()).unwrap();
    }

    /// Where a read starts.
    fn at(frame: &Value) -> u64 {
        frame["params"]["at"].as_u64().unwrap()
    }

    fn sent_at(sent: &Mutex<Vec<Value>>) -> Vec<u64> {
        sent.lock().unwrap().iter().map(at).collect()
    }

    fn nth(sent: &Mutex<Vec<Value>>, i: usize) -> Value {
        sent.lock().unwrap()[i].clone()
    }

    fn count(sent: &Mutex<Vec<Value>>) -> usize {
        sent.lock().unwrap().len()
    }

    /// What cophylad answers a read of a test file of `size` bytes: `chunk` bytes from where it starts, at most.
    fn reply(frame: &Value, size: u64, chunk: u64) -> Value {
        let from = at(frame);
        let piece = bytes(from, chunk.min(size - from));
        json!({ "jsonrpc": "2.0", "id": frame["id"], "result": { "path": "clip.mp4", "size": size, "modified": MODIFIED, "mime": "video/mp4", "base64": BASE64.encode(piece), "at": from, "total": size } })
    }

    /// Answers a read as cophylad does, with a piece of 1.5 MiB.
    fn answer(media: &Media, frame: &Value, size: u64) {
        media.answered(frame["id"].as_str().unwrap(), &reply(frame, size, PIECE));
    }

    async fn until(what: &str, mut ok: impl FnMut() -> bool) {
        for _ in 0..400 {
            if ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("timed out waiting: {what}");
    }

    fn field<'a>(response: &'a Response<Vec<u8>>, name: header::HeaderName) -> &'a str {
        response.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or_default()
    }

    #[test]
    fn a_range_is_read_in_every_form() {
        let size = 1000;
        assert_eq!(parse_range(None, size), Asked::Bytes(0, 999));
        assert_eq!(parse_range(Some("bytes=0-"), size), Asked::Bytes(0, 999));
        assert_eq!(parse_range(Some("bytes=10-19"), size), Asked::Bytes(10, 19));
        assert_eq!(parse_range(Some("bytes=10-"), size), Asked::Bytes(10, 999));
        assert_eq!(parse_range(Some("bytes=-100"), size), Asked::Bytes(900, 999));
        assert_eq!(parse_range(Some("bytes=5-5"), size), Asked::Bytes(5, 5));
        // the end past the file's is the file's; a suffix longer than the file is the file
        assert_eq!(parse_range(Some("bytes=10-5000"), size), Asked::Bytes(10, 999));
        assert_eq!(parse_range(Some("bytes=-5000"), size), Asked::Bytes(0, 999));
        assert_eq!(parse_range(Some("bytes=0-99999999999999999999999"), size), Asked::Bytes(0, 999));
        // several: the first
        assert_eq!(parse_range(Some("bytes=10-19, 30-39"), size), Asked::Bytes(10, 19));
        assert_eq!(parse_range(Some("bytes=-10,0-1"), size), Asked::Bytes(990, 999));
        // the unit in any case, spaces around the parts
        assert_eq!(parse_range(Some("Bytes= 10 - 19 "), size), Asked::Bytes(10, 19));
    }

    #[test]
    fn a_range_past_the_end_is_unsatisfiable_and_a_bad_one_is_the_whole_file() {
        let size = 1000;
        assert_eq!(parse_range(Some("bytes=1000-"), size), Asked::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=1000-2000"), size), Asked::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=5000-"), size), Asked::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=99999999999999999999999-"), size), Asked::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-0"), size), Asked::Unsatisfiable);
        assert_eq!(parse_range(None, 0), Asked::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-"), 0), Asked::Unsatisfiable);
        for bad in ["", "bytes", "bytes=", "bytes=-", "bytes=abc", "bytes=a-9", "bytes=1-b", "bytes=1-2-3", "bytes=20-10", "items=0-9", "0-9", "bytes=+1-2", "bytes=0x10-"] {
            assert_eq!(parse_range(Some(bad), size), Asked::Bytes(0, 999), "{bad:?}");
        }
    }

    #[test]
    fn an_answer_is_two_pieces_at_most_and_within_the_file() {
        let size = 10 * PIECE;
        assert_eq!(bounds(0, size - 1, size), (0, 2 * PIECE - 1));
        assert_eq!(bounds(0, 99, size), (0, 99));
        assert_eq!(bounds(PIECE - 1, size - 1, size), (PIECE - 1, 2 * PIECE - 1));
        assert_eq!(bounds(PIECE, size - 1, size), (PIECE, 3 * PIECE - 1));
        assert_eq!(bounds(PIECE + 5, size - 1, size), (PIECE + 5, 3 * PIECE - 1));
        // the end of the file comes first
        let short = PIECE + 10;
        assert_eq!(bounds(0, short - 1, short), (0, short - 1));
        assert_eq!(bounds(PIECE + 3, u64::MAX, short), (PIECE + 3, short - 1));
        for start in [0, 1, PIECE - 1, PIECE, 3 * PIECE + 7] {
            let (a, e) = bounds(start, size - 1, size);
            assert!(a == start && e - a < 2 * PIECE && e < size);
        }
    }

    #[test]
    fn pieces_are_counted_and_sized() {
        assert_eq!(pieces(0), 0);
        assert_eq!(pieces(1), 1);
        assert_eq!(pieces(PIECE), 1);
        assert_eq!(pieces(PIECE + 1), 2);
        assert_eq!(piece_len(PIECE + 10, 0), PIECE);
        assert_eq!(piece_len(PIECE + 10, 1), 10);
        assert_eq!(piece_len(PIECE + 10, 2), 0);
        // past 4 GiB
        let big = 5 << 30;
        assert_eq!(pieces(big), (big).div_ceil(PIECE));
        assert_eq!(piece_len(big, pieces(big) - 1), big - (pieces(big) - 1) * PIECE);
    }

    #[test]
    fn ids_and_paths() {
        assert!(stream_id("a-Z_09").is_ok());
        assert!(stream_id(&"x".repeat(64)).is_ok());
        for bad in ["", "a b", "a/b", "a.b", "é", &"x".repeat(65)] {
            assert!(stream_id(bad).is_err(), "{bad:?}");
        }
        assert_eq!(path_id("/media/abc/clip%20one.mp4"), Some("abc"));
        assert_eq!(path_id("/media/abc"), Some("abc"));
        assert_eq!(path_id("/media/a.b/x"), None);
        assert_eq!(path_id("/doc/frame.html"), None);
        assert_eq!(hex_key("k").len(), 64);
        assert!(is_hex(&hex_key("k")));
        assert_ne!(hex_key("k"), hex_key("k2"));
    }

    #[test]
    fn memory_keeps_the_sixteen_used_last() {
        let mut memory = Memory::new(MEMORY_PIECES);
        for i in 0..MEMORY_PIECES as u64 {
            memory.put("a", i, Arc::new(vec![i as u8]));
        }
        // 0 used again: 1 is now the oldest
        assert!(memory.get("a", 0).is_some());
        memory.put("b", 0, Arc::new(vec![9]));
        assert!(memory.has("a", 0) && !memory.has("a", 1) && memory.has("b", 0));
        assert_eq!(memory.pieces.len(), MEMORY_PIECES);
        assert!(memory.get("b", 1).is_none());
    }

    #[test]
    fn a_map_survives_a_restart_and_one_of_another_size_is_thrown_away() {
        let folder = Folder::new("map");
        let size = PIECE + 10;
        let hex = hex_key("machine:/v.mp4:size:mtime");
        let none = HashSet::new();
        {
            let mut disk = Disk::new(folder.0.clone(), DISK_CAP);
            assert!(!disk.has(&hex, size, 1));
            assert!(disk.put(&hex, size, 1, &file_piece(size, 1), &none).unwrap());
            // a piece of the wrong length is not kept
            assert!(!disk.put(&hex, size, 0, &[1, 2, 3], &none).unwrap());
        }
        let (data, map) = (folder.0.join(format!("{hex}.data")), folder.0.join(format!("{hex}.map")));
        assert_eq!(fs::metadata(&data).unwrap().len(), size);
        assert_eq!(fs::read(&map).unwrap(), [&size.to_le_bytes()[..], &[0, 1]].concat());
        {
            let mut disk = Disk::new(folder.0.clone(), DISK_CAP);
            assert!(disk.has(&hex, size, 1) && !disk.has(&hex, size, 0));
            assert_eq!(disk.read(&hex, size, 1), Some(file_piece(size, 1)));
            assert_eq!(disk.read(&hex, size, 0), None);
            assert_eq!(disk.total, 10);
        }
        {
            // the same key with another size: its map does not match, and both files go
            let mut disk = Disk::new(folder.0.clone(), DISK_CAP);
            assert!(!disk.has(&hex, size + 1, 1));
            assert!(!map.exists() && !data.exists());
            assert_eq!(disk.total, 0);
        }
    }

    #[test]
    fn a_map_that_is_not_whole_is_thrown_away_at_the_scan() {
        let folder = Folder::new("broken");
        let size = PIECE + 10;
        let (good, short, orphan) = (hex_key("good"), hex_key("short"), hex_key("orphan"));
        {
            let mut disk = Disk::new(folder.0.clone(), DISK_CAP);
            assert!(disk.put(&good, size, 1, &file_piece(size, 1), &HashSet::new()).unwrap());
            assert!(disk.put(&short, size, 1, &file_piece(size, 1), &HashSet::new()).unwrap());
        }
        // one map cut short, and a data file with no map
        let short_map = folder.0.join(format!("{short}.map"));
        let len = fs::metadata(&short_map).unwrap().len();
        OpenOptions::new().write(true).open(&short_map).unwrap().set_len(len - 1).unwrap();
        fs::write(folder.0.join(format!("{orphan}.data")), b"x").unwrap();
        fs::write(folder.0.join("not-ours.txt"), b"x").unwrap();
        let mut disk = Disk::new(folder.0.clone(), DISK_CAP);
        assert!(disk.has(&good, size, 1));
        assert!(!short_map.exists() && !folder.0.join(format!("{short}.data")).exists());
        assert!(!folder.0.join(format!("{orphan}.data")).exists());
        assert!(folder.0.join("not-ours.txt").exists());
        assert_eq!(disk.total, 10);
    }

    #[test]
    fn past_the_cap_the_keys_used_longest_ago_go_first_never_an_open_one() {
        let folder = Folder::new("evict");
        let mut disk = Disk::new(folder.0.clone(), 250);
        let size = 100;
        let [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map(hex_key);
        let none = HashSet::new();
        let piece = bytes(0, size);
        assert!(disk.put(&a, size, 0, &piece, &none).unwrap());
        assert!(disk.put(&b, size, 0, &piece, &none).unwrap());
        assert_eq!(disk.total, 200);
        // c: a, used longest ago, goes
        assert!(disk.put(&c, size, 0, &piece, &none).unwrap());
        assert!(!disk.has(&a, size, 0) && disk.has(&b, size, 0) && disk.has(&c, size, 0));
        assert!(!folder.0.join(format!("{a}.map")).exists() && !folder.0.join(format!("{a}.data")).exists());
        assert_eq!(disk.total, 200);
        // b read again: c is now the oldest
        assert!(disk.read(&b, size, 0).is_some());
        assert!(disk.put(&d, size, 0, &piece, &none).unwrap());
        assert!(disk.has(&b, size, 0) && !disk.has(&c, size, 0) && disk.has(&d, size, 0));
        // b and d open: nothing may go, and e is not kept
        let open: HashSet<String> = [b.clone(), d.clone()].into();
        assert!(!disk.put(&e, size, 0, &piece, &open).unwrap());
        assert!(disk.has(&b, size, 0) && disk.has(&d, size, 0) && !disk.has(&e, size, 0));
        // only d open: b goes for e
        let open: HashSet<String> = [d.clone()].into();
        assert!(disk.put(&e, size, 0, &piece, &open).unwrap());
        assert!(!disk.has(&b, size, 0) && disk.has(&d, size, 0) && disk.has(&e, size, 0));
        assert_eq!(disk.total, 200);
        // the order is kept across a restart (the maps' times)
        let mut again = Disk::new(folder.0.clone(), 250);
        assert!(again.put(&a, size, 0, &piece, &none).unwrap());
        assert!(!again.has(&d, size, 0) && again.has(&e, size, 0));
    }

    #[test]
    fn a_key_alone_past_the_cap_stops_being_kept() {
        let folder = Folder::new("alone");
        let size = 3 * PIECE;
        let hex = hex_key("alone");
        let open: HashSet<String> = [hex.clone()].into();
        let mut disk = Disk::new(folder.0.clone(), 2 * PIECE);
        assert!(disk.put(&hex, size, 0, &file_piece(size, 0), &open).unwrap());
        assert!(disk.put(&hex, size, 1, &file_piece(size, 1), &open).unwrap());
        assert!(!disk.put(&hex, size, 2, &file_piece(size, 2), &open).unwrap());
        assert!(disk.has(&hex, size, 0) && disk.has(&hex, size, 1) && !disk.has(&hex, size, 2));
        assert_eq!(disk.total, 2 * PIECE);
        assert_eq!(disk.read(&hex, size, 1), Some(file_piece(size, 1)));
    }

    #[test]
    fn a_read_is_one_of_the_two_with_the_files_place_as_text() {
        let read = Source::from_value(&json!({ "method": "terminal.file", "params": { "terminal": "t1", "node": "n1", "path": "/x/y.mp3" } })).unwrap();
        let frame: Value = serde_json::from_str(&read.frame(7, 3 * PIECE)).unwrap();
        assert_eq!(frame, json!({ "jsonrpc": "2.0", "id": "media:7", "method": "terminal.file", "params": { "terminal": "t1", "node": "n1", "path": "/x/y.mp3", "whole": true, "image": true, "stream": true, "at": 3 * PIECE } }));
        assert!(Source::from_value(&json!({ "method": "session.file", "params": { "id": "s", "path": "a" } })).is_ok());
        for bad in [
            json!({}),
            json!({ "method": "session.read", "params": {} }),
            json!({ "method": "fs.write", "params": { "path": "a" } }),
            json!({ "method": "session.file" }),
            json!({ "method": "session.file", "params": ["a"] }),
            json!({ "method": "session.file", "params": { "path": 1 } }),
            json!({ "method": "session.file", "params": { "path": "a", "whole": false } }),
            json!({ "method": "session.file", "params": { "path": "a", "at": "5" } }),
        ] {
            assert!(Source::from_value(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_bytes_of_the_file_opened_are_taken() {
        let size = 5000;
        let file = |extra: Value| {
            let mut result = json!({ "path": "clip.mp4", "size": size, "modified": MODIFIED });
            for (k, v) in extra.as_object().unwrap() {
                result[k] = v.clone();
            }
            json!({ "jsonrpc": "2.0", "id": "media:1", "result": result })
        };
        let read = |frame: &Value, at: u64| read_answer(frame, size, MODIFIED, at);
        assert_eq!(read(&file(json!({ "base64": BASE64.encode(bytes(0, 10)), "at": 0, "mime": "video/mp4", "total": size })), 0), Ok(bytes(0, 10)));
        // `at` may be left out
        assert_eq!(read(&file(json!({ "base64": BASE64.encode(b"abc") })), 7), Ok(b"abc".to_vec()));
        // another file now: its size, its time, or no time
        for changed in [json!({ "size": size + 1 }), json!({ "modified": MODIFIED + 1 }), json!({ "modified": null })] {
            let mut frame = file(json!({ "base64": "" }));
            for (k, v) in changed.as_object().unwrap() {
                frame["result"][k] = v.clone();
            }
            assert_eq!(read(&frame, 0), Err(CHANGED.into()), "{changed}");
        }
        // a computer that sends none of it
        assert_eq!(read(&file(json!({ "binary": true })), 0), Err(SENDS_NONE.into()));
        assert_eq!(read(&file(json!({ "binary": true, "note": "no codec for this" })), 0), Err("no codec for this".into()));
        assert_eq!(read(&file(json!({})), 0), Err(NO_BYTES.into()));
        assert_eq!(read(&json!({ "jsonrpc": "2.0", "id": "media:1" }), 0), Err(NO_BYTES.into()));
        // the error cophylad sent: its data's message, else its own
        assert_eq!(read(&json!({ "id": "media:1", "error": { "code": -32602, "message": "invalid", "data": { "message": "clip.mp4: not found" } } }), 0), Err("clip.mp4: not found".into()));
        assert_eq!(read(&json!({ "id": "media:1", "error": { "code": -32000, "message": "failed" } }), 0), Err("failed".into()));
        // bytes of another place, or no base64
        assert!(read(&file(json!({ "base64": "AAAA", "at": 3 })), 0).is_err());
        assert!(read(&file(json!({ "base64": "!!" })), 0).is_err());
    }

    #[tokio::test]
    async fn two_waits_for_one_piece_send_one_read() {
        let (media, sent) = media(None, NEED_TIMEOUT);
        let size = 3 * PIECE;
        open(&media, "s1", "key", size, false);
        let (m1, m2) = (media.clone(), media.clone());
        let one = tokio::spawn(async move { m1.piece("s1", 1, 0).await });
        let two = tokio::spawn(async move { m2.piece("s1", 1, 0).await });
        until("a read", || count(&sent) == 1).await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(count(&sent), 1);
        let frame = nth(&sent, 0);
        let id = frame["id"].as_str().unwrap().to_string();
        assert!(id.starts_with(RPC_PREFIX), "{id}");
        assert_eq!(frame, json!({ "jsonrpc": "2.0", "id": id, "method": "session.file", "params": { "id": "ses_1", "path": "clip.mp4", "whole": true, "image": true, "stream": true, "at": 0 } }));
        answer(&media, &frame, size);
        assert_eq!(*one.await.unwrap().unwrap(), file_piece(size, 0));
        assert_eq!(*two.await.unwrap().unwrap(), file_piece(size, 0));
        // a third, later, from memory
        assert_eq!(*media.piece("s1", 1, 0).await.unwrap(), file_piece(size, 0));
        assert_eq!(count(&sent), 1);
        assert_eq!(media.stats("s1"), Some(Stats { requests: 0, fetched: 1, cached: 1, error: None }));
        // an answer to a read no longer out, or to none, is let go
        answer(&media, &frame, size);
        media.answered("media:nope", &json!({}));
        media.answered("media:999", &reply(&frame, size, PIECE));
        assert_eq!(media.stats("s1").unwrap().fetched, 1);
    }

    #[tokio::test]
    async fn a_stream_has_four_reads_out_at_most() {
        let (media, sent) = media(None, NEED_TIMEOUT);
        let size = 8 * PIECE;
        open(&media, "s", "key", size, false);
        let waits: Vec<_> = (0..6)
            .map(|i| {
                let media = media.clone();
                tokio::spawn(async move { media.piece("s", 1, i).await })
            })
            .collect();
        until("four reads", || count(&sent) == 4).await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(sent_at(&sent), [0, PIECE, 2 * PIECE, 3 * PIECE]);
        answer(&media, &nth(&sent, 0), size);
        until("a fifth read", || count(&sent) == 5).await;
        for i in 1..5 {
            answer(&media, &nth(&sent, i), size);
        }
        until("the sixth read", || count(&sent) == 6).await;
        answer(&media, &nth(&sent, 5), size);
        let ids: HashSet<String> = sent.lock().unwrap().iter().map(|f| f["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids.len(), 6);
        for (i, wait) in waits.into_iter().enumerate() {
            assert_eq!(*wait.await.unwrap().unwrap(), file_piece(size, i as u64));
        }
    }

    #[tokio::test]
    async fn a_request_is_answered_with_two_pieces_and_the_next_three_are_fetched() {
        let (media, sent) = media(None, NEED_TIMEOUT);
        let size = 6 * PIECE + 100;
        open(&media, "s", "key", size, false);
        let m = media.clone();
        let request = tokio::spawn(async move { m.serve(&Method::GET, "/media/s/clip.mp4", Some("bytes=0-")).await });
        until("two reads", || count(&sent) == 2).await;
        assert_eq!(sent_at(&sent), [0, PIECE]);
        for i in 0..2 {
            answer(&media, &nth(&sent, i), size);
        }
        let response = request.await.unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(field(&response, header::CONTENT_RANGE), format!("bytes 0-{}/{size}", 2 * PIECE - 1));
        assert_eq!(field(&response, header::CONTENT_LENGTH), (2 * PIECE).to_string());
        assert_eq!(field(&response, header::CONTENT_TYPE), "video/mp4");
        assert_eq!(field(&response, header::ACCEPT_RANGES), "bytes");
        assert_eq!(field(&response, header::CACHE_CONTROL), "no-store");
        assert_eq!(field(&response, header::X_CONTENT_TYPE_OPTIONS), "nosniff");
        assert_eq!(*response.body(), bytes(0, 2 * PIECE));
        // readahead: 2, 3 and 4
        until("three more reads", || count(&sent) == 5).await;
        assert_eq!(sent_at(&sent)[2..], [2 * PIECE, 3 * PIECE, 4 * PIECE]);
        for i in 2..5 {
            answer(&media, &nth(&sent, i), size);
        }
        // across a boundary, from memory: no read
        let response = media.serve(&Method::GET, "/media/s/clip.mp4", Some(&format!("bytes={}-{}", 3 * PIECE - 10, 3 * PIECE + 9))).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(*response.body(), bytes(3 * PIECE - 10, 20));
        // the next readahead is 4 (fetched), 5 and 6, the last piece, of 100 bytes
        until("the last two reads", || count(&sent) == 7).await;
        assert_eq!(sent_at(&sent)[5..], [5 * PIECE, 6 * PIECE]);
        answer(&media, &nth(&sent, 6), size);
        let response = media.serve(&Method::GET, "/media/s/clip.mp4", Some("bytes=-100")).await;
        assert_eq!(*response.body(), bytes(6 * PIECE, 100));
        assert_eq!(media.stats("s"), Some(Stats { requests: 3, fetched: 6, cached: 3, error: None }));
    }

    #[tokio::test]
    async fn the_answers_that_are_not_bytes() {
        let (media, sent) = media(None, NEED_TIMEOUT);
        let size = 4 * PIECE;
        media.open("s", "key", size, MODIFIED, "audio/mpeg", false, source()).unwrap();
        media.open("empty", "key0", 0, MODIFIED, "audio/mpeg", false, source()).unwrap();
        let response = media.serve(&Method::GET, "/media/s/a.mp3", Some(&format!("bytes={size}-"))).await;
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(field(&response, header::CONTENT_RANGE), format!("bytes */{size}"));
        let response = media.serve(&Method::GET, "/media/empty/a.mp3", Some("bytes=0-")).await;
        assert_eq!((response.status(), field(&response, header::CONTENT_LENGTH), response.body().len()), (StatusCode::OK, "0", 0));
        assert_eq!(media.serve(&Method::GET, "/media/nope/a.mp3", None).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(media.serve(&Method::GET, "/media/", None).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(media.serve(&Method::POST, "/media/s/a.mp3", None).await.status(), StatusCode::METHOD_NOT_ALLOWED);
        // HEAD: the same fields, no body, nothing read
        let response = media.serve(&Method::HEAD, "/media/s/a.mp3", Some("bytes=10-")).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(field(&response, header::CONTENT_RANGE), format!("bytes 10-{}/{size}", 2 * PIECE - 1));
        assert!(response.body().is_empty() && count(&sent) == 0);
        // an error from cophylad: 502 with what it said, and the stats say it too
        let m = media.clone();
        let request = tokio::spawn(async move { m.serve(&Method::GET, "/media/s/a.mp3", Some("bytes=0-99")).await });
        until("a read", || count(&sent) == 1).await;
        let frame = nth(&sent, 0);
        media.answered(frame["id"].as_str().unwrap(), &json!({ "jsonrpc": "2.0", "id": frame["id"], "error": { "code": -32000, "message": "failed", "data": { "message": "clip.mp4: no such file" } } }));
        let response = request.await.unwrap();
        assert_eq!((response.status(), response.body().as_slice()), (StatusCode::BAD_GATEWAY, &b"clip.mp4: no such file"[..]));
        assert_eq!(media.stats("s").unwrap().error.as_deref(), Some("clip.mp4: no such file"));
        // the file changed since it was opened: 502
        let m = media.clone();
        let request = tokio::spawn(async move { m.serve(&Method::GET, "/media/s/a.mp3", Some("bytes=0-99")).await });
        until("a second read", || count(&sent) == 2).await;
        let frame = nth(&sent, 1);
        let mut changed = reply(&frame, size, PIECE);
        changed["result"]["modified"] = json!(MODIFIED + 1);
        media.answered(frame["id"].as_str().unwrap(), &changed);
        let response = request.await.unwrap();
        assert_eq!((response.status(), response.body().as_slice()), (StatusCode::BAD_GATEWAY, CHANGED.as_bytes()));
        assert_eq!(media.stats("s"), Some(Stats { requests: 4, fetched: 0, cached: 0, error: Some(CHANGED.into()) }));
    }

    #[tokio::test]
    async fn an_answer_short_of_the_piece_is_joined_to_one_read_from_where_it_stopped() {
        let (media, sent) = media(None, NEED_TIMEOUT);
        let size = PIECE + 10;
        open(&media, "s", "key", size, false);
        let m = media.clone();
        let request = tokio::spawn(async move { m.serve(&Method::GET, "/media/s/v.mp4", Some("bytes=0-99")).await });
        // a node that sends 600 KiB at a time: three answers to the piece, under one read's id
        let chunk = 600 * 1024;
        for (i, from) in [0, chunk, 2 * chunk].into_iter().enumerate() {
            until("a read", || count(&sent) == i + 1).await;
            let frame = nth(&sent, i);
            assert_eq!((at(&frame), &frame["id"]), (from, &nth(&sent, 0)["id"]));
            media.answered(frame["id"].as_str().unwrap(), &reply(&frame, size, chunk));
        }
        let response = request.await.unwrap();
        assert_eq!((response.status(), response.body().clone()), (StatusCode::PARTIAL_CONTENT, bytes(0, 100)));
        // the piece is whole: its end is served from memory
        let response = media.serve(&Method::GET, "/media/s/v.mp4", Some(&format!("bytes={}-{}", PIECE - 10, PIECE - 1))).await;
        assert_eq!(*response.body(), bytes(PIECE - 10, 10));
        // the readahead read piece 1; a request for it waits on that read, and an empty answer
        // short of the piece's end fails it
        until("the readahead", || count(&sent) == 4).await;
        let frame = nth(&sent, 3);
        assert_eq!(at(&frame), PIECE);
        let (m, range) = (media.clone(), format!("bytes={PIECE}-"));
        let request = tokio::spawn(async move { m.serve(&Method::GET, "/media/s/v.mp4", Some(&range)).await });
        tokio::time::sleep(Duration::from_millis(30)).await;
        media.answered(frame["id"].as_str().unwrap(), &reply(&frame, size, 0));
        let response = request.await.unwrap();
        assert_eq!((response.status(), response.body().as_slice()), (StatusCode::BAD_GATEWAY, SHORT.as_bytes()));
        assert_eq!(count(&sent), 4);
        assert_eq!(media.stats("s"), Some(Stats { requests: 3, fetched: 1, cached: 1, error: Some(SHORT.into()) }));
        // more than the piece: the piece's own bytes are taken
        open(&media, "t", "key-t", 3 * PIECE, false);
        let m = media.clone();
        let request = tokio::spawn(async move { m.serve(&Method::GET, "/media/t/v.mp4", Some("bytes=0-9")).await });
        until("a read of t", || count(&sent) == 5).await;
        let frame = nth(&sent, 4);
        media.answered(frame["id"].as_str().unwrap(), &reply(&frame, 3 * PIECE, 2 * PIECE));
        assert_eq!(*request.await.unwrap().body(), bytes(0, 10));
        let response = media.serve(&Method::GET, "/media/t/v.mp4", Some(&format!("bytes={0}-{0}", PIECE - 1))).await;
        assert_eq!(*response.body(), bytes(PIECE - 1, 1));
    }

    #[tokio::test]
    async fn a_read_with_no_answer_in_time_is_a_504() {
        let (media, sent) = media(None, Duration::from_millis(200));
        open(&media, "s", "key", PIECE, false);
        let response = media.serve(&Method::GET, "/media/s/v.webm", None).await;
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(media.stats("s").unwrap().error.as_deref(), Some(TIMED_OUT));
        // too late: let go, nothing kept
        answer(&media, &nth(&sent, 0), PIECE);
        assert_eq!(media.stats("s").unwrap().fetched, 0);
        // asked again, it is read again, and the error goes with it
        let m = media.clone();
        let request = tokio::spawn(async move { m.serve(&Method::GET, "/media/s/v.webm", None).await });
        until("a second read", || count(&sent) == 2).await;
        answer(&media, &nth(&sent, 1), PIECE);
        assert_eq!(request.await.unwrap().status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(media.stats("s"), Some(Stats { requests: 2, fetched: 1, cached: 0, error: None }));
    }

    #[tokio::test]
    async fn a_read_that_cannot_be_sent_fails_at_once() {
        let down = "unavailable: not connected to cophylad";
        let media = Media::with(None, DISK_CAP, NEED_TIMEOUT, Box::new(move |_| Err(down.into())));
        open(&media, "s", "key", PIECE, false);
        let response = media.serve(&Method::GET, "/media/s/v.mp4", None).await;
        assert_eq!((response.status(), response.body().as_slice()), (StatusCode::BAD_GATEWAY, down.as_bytes()));
        assert_eq!(media.stats("s").unwrap().error.as_deref(), Some(down));
    }

    #[tokio::test]
    async fn the_reads_out_fail_when_the_link_goes() {
        let (media, sent) = media(None, NEED_TIMEOUT);
        open(&media, "s", "key", 2 * PIECE, false);
        let m = media.clone();
        let request = tokio::spawn(async move { m.serve(&Method::GET, "/media/s/v.mp4", None).await });
        until("two reads", || count(&sent) == 2).await;
        media.link_lost();
        let response = request.await.unwrap();
        assert_eq!((response.status(), response.body().as_slice()), (StatusCode::BAD_GATEWAY, LINK_LOST.as_bytes()));
        // an answer that comes after all is let go
        answer(&media, &nth(&sent, 0), 2 * PIECE);
        assert_eq!(media.stats("s").unwrap().fetched, 0);
    }

    #[tokio::test]
    async fn a_close_ends_the_requests_waiting_with_410() {
        let (media, sent) = media(None, NEED_TIMEOUT);
        open(&media, "s", "key", 2 * PIECE, false);
        let m = media.clone();
        let request = tokio::spawn(async move { m.serve(&Method::GET, "/media/s/v.mp4", None).await });
        until("reads", || count(&sent) == 2).await;
        media.close("s");
        assert_eq!(request.await.unwrap().status(), StatusCode::GONE);
        assert_eq!(media.stats("s"), None);
        assert_eq!(media.serve(&Method::GET, "/media/s/v.mp4", None).await.status(), StatusCode::NOT_FOUND);
        answer(&media, &nth(&sent, 0), 2 * PIECE);
    }

    #[tokio::test]
    async fn a_kept_stream_plays_again_from_disk_after_a_restart() {
        let folder = Folder::new("replay");
        let size = PIECE + 500;
        let key = "machine|src|/v.mp4|size|mtime";
        let (media1, sent) = media(Some(folder.0.clone()), NEED_TIMEOUT);
        open(&media1, "first", key, size, true);
        let m = media1.clone();
        let request = tokio::spawn(async move { m.serve(&Method::GET, "/media/first/v.mp4", None).await });
        until("two reads", || count(&sent) == 2).await;
        for i in 0..2 {
            answer(&media1, &nth(&sent, i), size);
        }
        assert_eq!(*request.await.unwrap().body(), bytes(0, size));
        let map = folder.0.join(format!("{}.map", hex_key(key)));
        until("both pieces on disk", || fs::read(&map).is_ok_and(|m| m.ends_with(&[1, 1]))).await;
        media1.close("first");
        // another run: the same key under another id is served from disk
        let (media2, sent2) = media(Some(folder.0.clone()), NEED_TIMEOUT);
        open(&media2, "second", key, size, true);
        let response = media2.serve(&Method::GET, "/media/second/v.mp4", Some("bytes=100-")).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(*response.body(), bytes(100, size - 100));
        assert_eq!(count(&sent2), 0);
        assert_eq!(media2.stats("second"), Some(Stats { requests: 1, fetched: 0, cached: 2, error: None }));
        // a stream that does not keep writes nothing
        let (media3, sent3) = media(Some(folder.0.clone()), NEED_TIMEOUT);
        media3.open("local", "local-key", 10, MODIFIED, "audio/wav", false, source()).unwrap();
        let m = media3.clone();
        let request = tokio::spawn(async move { m.serve(&Method::GET, "/media/local/a.wav", None).await });
        until("a read", || count(&sent3) == 1).await;
        answer(&media3, &nth(&sent3, 0), 10);
        assert_eq!(request.await.unwrap().status(), StatusCode::PARTIAL_CONTENT);
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!folder.0.join(format!("{}.map", hex_key("local-key"))).exists());
    }

    #[test]
    fn open_checks_what_it_is_given() {
        let media = Media::with(None, DISK_CAP, NEED_TIMEOUT, Box::new(|_| Ok(())));
        let open = |id: &str, key: &str, mime: &str| media.open(id, key, 1, MODIFIED, mime, false, source());
        assert!(open("bad id", "k", "video/mp4").is_err());
        assert!(open("s", "", "video/mp4").is_err());
        assert!(open("s", "k", "").is_err());
        assert!(open("s", "k", "mp4").is_err());
        assert!(open("s", "k", "video/mp4\r\nX-Evil: 1").is_err());
        assert!(open("s", "k", "video/mp4").is_ok());
        assert!(open("s", "k", "video/mp4").is_err());
        assert_eq!(media.stats("s"), Some(Stats::default()));
        // no server yet: no URL
        assert_eq!(media.url("s", "a.mp4"), None);
        assert_eq!(media.origin(), None);
    }

    fn head(target: &str, host: Option<&str>) -> Head {
        Head { method: Method::GET, target: target.into(), host: host.map(str::to_string), ..Head::default() }
    }

    #[test]
    fn a_request_head_is_read() {
        let got = parse_head(b"GET /s3cret/media/a/b.mp4 HTTP/1.1\r\nhost: 127.0.0.1:5000\r\nAccept: */*\r\nRANGE:bytes=0-\r\nRange: bytes=5-\r\nUser-Agent: x : y").unwrap();
        assert_eq!(got, Head { method: Method::GET, target: "/s3cret/media/a/b.mp4".into(), host: Some("127.0.0.1:5000".into()), range: Some("bytes=0-".into()), ..Head::default() });
        let got = parse_head(b"GET /k/link HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nOrigin: http://tauri.localhost\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://other").unwrap();
        assert_eq!(got.origin.as_deref(), Some("http://tauri.localhost"));
        assert_eq!((got.upgrade.as_deref(), got.connection.as_deref()), (Some("websocket"), Some("keep-alive, Upgrade")));
        assert_eq!((got.ws_key.as_deref(), got.ws_version.as_deref()), (Some("dGhlIHNhbXBsZSBub25jZQ=="), Some("13")));
        let got = parse_head(b"HEAD / HTTP/1.0").unwrap();
        assert_eq!((got.method, got.host, got.range), (Method::HEAD, None, None));
        for bad in [
            &b"GET /\r\nHost: x"[..],
            b"GET  / HTTP/1.1",
            b"GET / HTTP/1.1 extra",
            b"GET / HTTP/2.0",
            b"GET http://127.0.0.1:5000/ HTTP/1.1",
            b"G(T / HTTP/1.1",
            b"GET / HTTP/1.1\r\nno colon",
            b"GET / HTTP/1.1\r\nHost : x",
            b"GET / HTTP/1.1\r\nHost: x\r\n folded",
            b"GET / HTTP/1.1\r\nHost: a\r\nhost: b",
            b"GET / HTTP/1.1\r\nHost: \xff",
        ] {
            assert!(parse_head(bad).is_err(), "{:?}", String::from_utf8_lossy(bad));
        }
    }

    #[test]
    fn only_the_servers_host_and_secret_are_served() {
        let (secret, port) = ("0123456789abcdef0123456789abcdef", 5000);
        let host = Some("127.0.0.1:5000");
        let path = format!("/{secret}/media/a/b%20c.mp4");
        assert_eq!(route(&head(&path, host), secret, port).ok(), Some("/media/a/b%20c.mp4"));
        assert_eq!(route(&head(&format!("{path}?x=1"), host), secret, port).ok(), Some("/media/a/b%20c.mp4"));
        for other in [None, Some("localhost:5000"), Some("127.0.0.1:5001"), Some("127.0.0.1"), Some("evil.example:5000"), Some("[::1]:5000")] {
            assert_eq!(route(&head(&path, other), secret, port).unwrap_err().status(), StatusCode::MISDIRECTED_REQUEST, "{other:?}");
        }
        for target in ["/media/a/b.mp4", "/0123456789abcdef0123456789abcdee/media/a/b.mp4", &format!("/{secret}x/media/a/b.mp4"), &format!("/{secret}/other"), &format!("/{secret}"), "/", "/0123"] {
            assert_eq!(route(&head(target, host), secret, port).unwrap_err().status(), StatusCode::NOT_FOUND, "{target}");
        }
        assert_eq!(past_secret("abc/x", "abc"), Some("/x"));
        assert_eq!(past_secret("abd/x", "abc"), None);
        assert_eq!(past_secret("ab", "abc"), None);
    }

    #[test]
    fn only_the_host_pages_upgrade_at_the_links_secret_is_taken() {
        let server = Server { port: 5000, secret: "0123456789abcdef0123456789abcdef".into(), link_secret: "fedcba9876543210fedcba9876543210".into() };
        let origins = vec!["http://tauri.localhost".to_string()];
        let ws = |target: &str, origin: Option<&str>| Head {
            method: Method::GET,
            target: target.into(),
            host: Some("127.0.0.1:5000".into()),
            origin: origin.map(str::to_string),
            upgrade: Some("websocket".into()),
            connection: Some("Upgrade".into()),
            ws_key: Some("dGhlIHNhbXBsZSBub25jZQ==".into()),
            ws_version: Some("13".into()),
            ..Head::default()
        };
        let link = "/fedcba9876543210fedcba9876543210/link";
        // RFC 6455's own example of a key and its accept
        assert_eq!(upgrade(&ws(link, Some("http://tauri.localhost")), &server, Some(&origins)).unwrap().unwrap(), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
        let status = |head: &Head, origins: Option<&[String]>| upgrade(head, &server, origins).map(|r| r.map(|_| StatusCode::SWITCHING_PROTOCOLS).unwrap_or_else(|e| e.status()));
        for origin in [None, Some("null"), Some("http://view.localhost"), Some("http://127.0.0.1:5000"), Some("http://tauri.localhost.example.com")] {
            assert_eq!(status(&ws(link, origin), Some(&origins)), Some(StatusCode::FORBIDDEN), "{origin:?}");
        }
        let mut other_host = ws(link, Some("http://tauri.localhost"));
        other_host.host = Some("localhost:5000".into());
        assert_eq!(status(&other_host, Some(&origins)), Some(StatusCode::MISDIRECTED_REQUEST));
        let mut plain_get = ws(link, Some("http://tauri.localhost"));
        plain_get.upgrade = None;
        assert_eq!(status(&plain_get, Some(&origins)), Some(StatusCode::BAD_REQUEST));
        let mut old = ws(link, Some("http://tauri.localhost"));
        old.ws_version = Some("8".into());
        assert_eq!(status(&old, Some(&origins)), Some(StatusCode::BAD_REQUEST));
        // nothing serves it yet
        assert_eq!(status(&ws(link, Some("http://tauri.localhost")), None), Some(StatusCode::NOT_FOUND));
        // the media secret, another path, or a wrong secret: no link request, left to the media route
        for target in ["/0123456789abcdef0123456789abcdef/link", "/fedcba9876543210fedcba9876543210/media/a/b", "/fedcba9876543210fedcba9876543211/link", "/link"] {
            assert_eq!(status(&ws(target, Some("http://tauri.localhost")), Some(&origins)), None, "{target}");
        }
    }

    #[test]
    fn a_response_is_written_with_its_length_and_closes() {
        let bytes = String::from_utf8(head_bytes(&plain(StatusCode::NOT_FOUND, "not found"))).unwrap();
        assert!(bytes.starts_with("HTTP/1.1 404 Not Found\r\n"), "{bytes}");
        assert!(bytes.contains("\r\ncontent-length: 9\r\n") && bytes.contains("\r\ncontent-type: text/plain; charset=utf-8\r\n"), "{bytes}");
        assert!(bytes.ends_with("\r\nconnection: close\r\n\r\n"), "{bytes}");
        // a length given is the length sent (a HEAD's), not the body's
        let response = Response::builder().status(StatusCode::PARTIAL_CONTENT).header(header::CONTENT_LENGTH, 100).body(Vec::new()).unwrap();
        let bytes = String::from_utf8(head_bytes(&response)).unwrap();
        assert_eq!(bytes, "HTTP/1.1 206 Partial Content\r\ncontent-length: 100\r\nconnection: close\r\n\r\n");
    }

    #[tokio::test]
    async fn a_head_is_read_to_its_blank_line_and_no_further_than_16_kib() {
        let mut sent: &[u8] = b"GET / HTTP/1.1\r\nHost: x\r\n\r\nleft over";
        assert_eq!(read_head(&mut sent).await.unwrap(), b"GET / HTTP/1.1\r\nHost: x");
        let mut cut: &[u8] = b"GET / HTTP/1.1\r\nHost: x\r\n";
        assert_eq!(read_head(&mut cut).await, Err(StatusCode::BAD_REQUEST));
        let long = format!("GET / HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(HEAD_MAX));
        assert_eq!(read_head(&mut long.as_bytes()).await, Err(StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE));
        let endless = "a".repeat(4 * HEAD_MAX);
        assert_eq!(read_head(&mut endless.as_bytes()).await, Err(StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE));
    }

    /// One request to the server over a real socket: the answer's status, fields and body.
    async fn ask(port: u16, request: &str) -> (u16, HashMap<String, String>, Vec<u8>) {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut reply = Vec::new();
        stream.read_to_end(&mut reply).await.unwrap();
        let end = reply.windows(4).position(|w| w == b"\r\n\r\n").expect("a head");
        let head = String::from_utf8(reply[..end].to_vec()).unwrap();
        let mut lines = head.split("\r\n");
        let status = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
        let fields = lines.map(|l| l.split_once(": ").map(|(n, v)| (n.to_string(), v.to_string())).unwrap()).collect();
        (status, fields, reply[end + 4..].to_vec())
    }

    #[tokio::test]
    async fn the_loopback_server_answers_a_range_and_refuses_a_wrong_secret_or_host() {
        let (media, sent) = media(None, NEED_TIMEOUT);
        let listener = media.bind().unwrap();
        assert!(media.bind().is_err());
        let serving = tokio::spawn(media.clone().run(listener));
        let (port, secret) = media.0.server.get().map(|s| (s.port, s.secret.clone())).unwrap();
        assert!(secret.len() == 32 && secret.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(media.origin(), Some(format!("http://127.0.0.1:{port}")));
        let size = PIECE + 1000;
        open(&media, "s", "key", size, false);
        let url = media.url("s", "my clip #1/é.mp4").unwrap();
        assert_eq!(url, format!("http://127.0.0.1:{port}/{secret}/media/s/my%20clip%20%231%2F%C3%A9.mp4"));
        // cophylad: every read answered, as it comes
        let answering = {
            let (media, sent) = (media.clone(), sent.clone());
            tokio::spawn(async move {
                let mut done = 0;
                loop {
                    let todo: Vec<Value> = sent.lock().unwrap()[done..].to_vec();
                    done += todo.len();
                    for frame in todo {
                        answer(&media, &frame, size);
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
        };
        let path = url.strip_prefix(&format!("http://127.0.0.1:{port}")).unwrap();
        let host = format!("127.0.0.1:{port}");
        let (status, fields, body) = ask(port, &format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nRange: bytes=10-1009\r\n\r\n")).await;
        assert_eq!(status, 206);
        assert_eq!(fields["content-range"], format!("bytes 10-1009/{size}"));
        assert_eq!((fields["content-length"].as_str(), fields["content-type"].as_str(), fields["accept-ranges"].as_str()), ("1000", "video/mp4", "bytes"));
        assert_eq!(fields["connection"], "close");
        assert!(!fields.keys().any(|k| k.starts_with("access-control")));
        assert_eq!(body, bytes(10, 1000));
        // across the pieces' boundary, to the end
        let (status, fields, body) = ask(port, &format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nRange: bytes={}-\r\n\r\n", PIECE - 5)).await;
        assert_eq!((status, fields["content-range"].clone()), (206, format!("bytes {}-{}/{size}", PIECE - 5, size - 1)));
        assert_eq!(body, bytes(PIECE - 5, 1005));
        // HEAD: the fields, no body
        let (status, fields, body) = ask(port, &format!("HEAD {path} HTTP/1.1\r\nHost: {host}\r\n\r\n")).await;
        assert_eq!((status, fields["content-length"].clone(), body.len()), (206, (size).to_string(), 0));
        // refused
        let wrong_secret = path.replacen(&secret, &"0".repeat(32), 1);
        assert_eq!(ask(port, &format!("GET {wrong_secret} HTTP/1.1\r\nHost: {host}\r\n\r\n")).await.0, 404);
        assert_eq!(ask(port, &format!("GET /media/s/x HTTP/1.1\r\nHost: {host}\r\n\r\n")).await.0, 404);
        assert_eq!(ask(port, &format!("GET /{secret}/media/nope/x HTTP/1.1\r\nHost: {host}\r\n\r\n")).await.0, 404);
        assert_eq!(ask(port, &format!("GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n")).await.0, 421);
        assert_eq!(ask(port, &format!("GET {path} HTTP/1.1\r\nHost: attacker.example:{port}\r\n\r\n")).await.0, 421);
        assert_eq!(ask(port, &format!("GET {path} HTTP/1.1\r\n\r\n")).await.0, 421);
        assert_eq!(ask(port, &format!("POST {path} HTTP/1.1\r\nHost: {host}\r\n\r\n")).await.0, 405);
        assert_eq!(ask(port, "hello\r\n\r\n").await.0, 400);
        // three answered; each piece fetched once (the second by the readahead or by the request
        // that joined it), piece 0 the second time from memory
        let stats = media.stats("s").unwrap();
        assert_eq!((stats.requests, stats.fetched), (3, 2), "{stats:?}");
        assert!(stats.cached >= 1, "{stats:?}");
        answering.abort();
        serving.abort();
    }
}
