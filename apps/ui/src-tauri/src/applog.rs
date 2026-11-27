// The app's log file. Every line the shell logs, and every line the host page logs (its voice,
// its streams, its notes; they come over the page's link socket, page.rs, or the `app_log`
// command when the socket is not open), goes to `logs/cophyla-ui.log` in the app's local data,
// beside the media cache, as well as to stderr (a console in a dev run; nowhere in a release
// one, which has no console). The file is capped at 5 MB and rotated to `.1` and `.2`, so the
// app keeps 15 MB of log at most. Lines are written by a thread of their own: a thread that logs,
// the UI thread among them, only hands its line over, and never waits on the disk. A panic is
// logged too, and the writer is given a moment to put it on disk before the process goes on.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::OnceLock;
use std::time::Duration;

use serde::Deserialize;

/// How big a log file grows before it is rotated, and how many files are kept in all.
pub const LOG_CAP: u64 = 5 * 1024 * 1024;
pub const LOG_FILES: usize = 3;
/// The folder in the app's local data, and the file's name there: a debug build keeps one of its
/// own, so a dev run beside the installed app never rotates the other's file.
pub const LOG_DIR: &str = "logs";
pub const LOG_NAME: &str = if cfg!(debug_assertions) { "cophyla-ui-dev.log" } else { "cophyla-ui.log" };
/// The lines waiting for the writer; past them a line is dropped and counted.
const QUEUE: usize = 8192;
/// The most lines the host page sends at once, and the longest line it may send.
pub const PAGE_LINES: usize = 200;
pub const PAGE_LINE_CHARS: usize = 4000;
/// How long a panic waits for its line to be on disk.
const PANIC_FLUSH: Duration = Duration::from_millis(500);

/// A file appended to, moved aside to `<name>.1` (and that one to `<name>.2`, and so on up to
/// `files - 1`, the oldest dropped) when the next write would take it past its cap.
pub struct RotatingFile {
    path: PathBuf,
    file: Option<File>,
    size: u64,
    cap: u64,
    files: usize,
}

impl RotatingFile {
    pub fn open(path: &Path, cap: u64, files: usize) -> io::Result<RotatingFile> {
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let size = file.metadata()?.len();
        Ok(RotatingFile { path: path.to_path_buf(), file: Some(file), size, cap, files: files.max(1) })
    }

    pub fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        if self.size > 0 && self.size + bytes.len() as u64 > self.cap {
            self.rotate();
        }
        if self.file.is_none() {
            let file = OpenOptions::new().create(true).append(true).open(&self.path)?;
            self.size = file.metadata()?.len();
            self.file = Some(file);
        }
        let file = self.file.as_mut().expect("opened above");
        file.write_all(bytes)?;
        self.size += bytes.len() as u64;
        Ok(())
    }

    fn aside(&self, n: usize) -> PathBuf {
        let mut p = self.path.clone().into_os_string();
        p.push(format!(".{n}"));
        PathBuf::from(p)
    }

    fn rotate(&mut self) {
        self.file = None;
        if self.files > 1 {
            let _ = fs::remove_file(self.aside(self.files - 1));
            for n in (1..self.files - 1).rev() {
                let _ = fs::rename(self.aside(n), self.aside(n + 1));
            }
            if fs::rename(&self.path, self.aside(1)).is_ok() {
                self.size = 0;
                return;
            }
        }
        // one file kept, or someone holds it open without sharing delete: start it again in place
        let _ = OpenOptions::new().write(true).truncate(true).open(&self.path);
        self.size = 0;
    }
}

enum Line {
    Bytes(Vec<u8>),
    /// Answered once every line before it is written.
    Flush(mpsc::Sender<()>),
}

static QUEUED: OnceLock<SyncSender<Line>> = OnceLock::new();

/// What env_logger writes each record to: the record handed to the writer thread whole.
struct Pipe(SyncSender<Line>);

impl Write for Pipe {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        hand_over(&self.0, buf.to_vec());
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Lines dropped because the writer was behind, said in the next line written.
static DROPPED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn hand_over(tx: &SyncSender<Line>, bytes: Vec<u8>) {
    match tx.try_send(Line::Bytes(bytes)) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            DROPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        Err(TrySendError::Disconnected(Line::Bytes(bytes))) => {
            let _ = io::stderr().write_all(&bytes);
        }
        Err(TrySendError::Disconnected(_)) => {}
    }
}

/// Writes what comes to `file` (when it opened) and, with `tee`, to stderr, in order.
fn write_lines(rx: Receiver<Line>, mut file: Option<RotatingFile>, tee: bool) {
    let mut err = io::stderr();
    for line in rx {
        match line {
            Line::Bytes(bytes) => {
                let dropped = DROPPED.swap(0, std::sync::atomic::Ordering::Relaxed);
                if dropped > 0 {
                    let note = format!("[log] {dropped} lines dropped: the writer was behind\n");
                    if tee {
                        let _ = err.write_all(note.as_bytes());
                    }
                    if let Some(f) = file.as_mut() {
                        let _ = f.write(note.as_bytes());
                    }
                }
                if tee {
                    let _ = err.write_all(&bytes);
                }
                if let Some(f) = file.as_mut() {
                    let _ = f.write(&bytes);
                }
            }
            Line::Flush(done) => {
                let _ = done.send(());
            }
        }
    }
}

/// The log's folder: the app's local data (`app_local_data_dir`, which is the system's local data
/// folder and the app's identifier), named before Tauri runs so the first lines are kept too.
pub fn log_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join(crate::notify::AUMID).join(LOG_DIR))
}

/// Starts the logger: `RUST_LOG`'s filter, `info` by default, with milliseconds, to the file and
/// stderr through the writer thread; and a panic logged before the default hook runs.
pub fn init() {
    let (tx, rx) = mpsc::sync_channel(QUEUE);
    let path = log_dir().map(|d| d.join(LOG_NAME));
    let file = path.as_ref().and_then(|p| {
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        RotatingFile::open(p, LOG_CAP, LOG_FILES).map_err(|e| eprintln!("cannot open the log {}: {e}", p.display())).ok()
    });
    let writing = std::thread::Builder::new().name("log-writer".into()).spawn(move || write_lines(rx, file, true));
    let target = match writing {
        Ok(_) => {
            let _ = QUEUED.set(tx.clone());
            env_logger::Target::Pipe(Box::new(Pipe(tx)))
        }
        Err(_) => env_logger::Target::Stderr,
    };
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).format_timestamp_millis().write_style(env_logger::WriteStyle::Never).target(target).init();
    if let Some(p) = &path {
        log::info!("log file {}", p.display());
    }
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}");
        flush(PANIC_FLUSH);
        default(info);
    }));
}

/// Waits, up to `within`, for the lines logged so far to be written.
pub fn flush(within: Duration) {
    let Some(tx) = QUEUED.get() else { return };
    let (done, written) = mpsc::channel();
    if tx.try_send(Line::Flush(done)).is_ok() {
        let _ = written.recv_timeout(within);
    }
}

/// One line of the host page's, as it sends it.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PageLine {
    #[serde(default)]
    pub level: String,
    pub message: String,
}

/// Logs the host page's lines under the target `page`: `error`, `warn` and `debug` as said,
/// anything else as info; `PAGE_LINES` at most, each cut to `PAGE_LINE_CHARS`.
pub fn page_lines(lines: &[PageLine]) {
    for line in lines.iter().take(PAGE_LINES) {
        let (level, message) = page_line(line);
        log::log!(target: "page", level, "{message}");
    }
    if lines.len() > PAGE_LINES {
        log::warn!(target: "page", "{} more lines not kept", lines.len() - PAGE_LINES);
    }
}

fn page_line(line: &PageLine) -> (log::Level, String) {
    let level = match line.level.as_str() {
        "error" => log::Level::Error,
        "warn" => log::Level::Warn,
        "debug" => log::Level::Debug,
        _ => log::Level::Info,
    };
    let message = if line.message.chars().count() > PAGE_LINE_CHARS { format!("{}…", line.message.chars().take(PAGE_LINE_CHARS).collect::<String>()) } else { line.message.clone() };
    (level, message)
}

/// The host page's lines, when its link socket is not open.
#[tauri::command]
pub async fn app_log(lines: Vec<PageLine>) -> Result<(), String> {
    page_lines(&lines);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("cophyla-test-applog-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_file_rotates_through_its_kept_files_and_the_oldest_goes() {
        let s = Scratch::new("rotate");
        let path = s.0.join("ui.log");
        let read = |name: &str| fs::read_to_string(s.0.join(name)).unwrap_or_default();
        let mut f = RotatingFile::open(&path, 10, 3).unwrap();
        f.write(b"12345\n").unwrap();
        f.write(b"678\n").unwrap();
        assert_eq!(read("ui.log"), "12345\n678\n");
        f.write(b"abc\n").unwrap();
        assert_eq!((read("ui.log"), read("ui.log.1")), ("abc\n".into(), "12345\n678\n".into()));
        f.write(b"defghij\n").unwrap();
        assert_eq!((read("ui.log"), read("ui.log.1"), read("ui.log.2")), ("defghij\n".into(), "abc\n".into(), "12345\n678\n".into()));
        // three files kept: the oldest goes
        f.write(b"klmnopq\n").unwrap();
        assert_eq!((read("ui.log"), read("ui.log.1"), read("ui.log.2")), ("klmnopq\n".into(), "defghij\n".into(), "abc\n".into()));
        assert!(!s.0.join("ui.log.3").exists());
        // a line longer than the cap still goes in whole, in a file of its own
        f.write(b"0123456789abcdef\n").unwrap();
        assert_eq!(read("ui.log"), "0123456789abcdef\n");
        drop(f);
        // reopened, it counts what is there
        let mut f = RotatingFile::open(&path, 10, 3).unwrap();
        f.write(b"x\n").unwrap();
        assert_eq!((read("ui.log"), read("ui.log.1")), ("x\n".into(), "0123456789abcdef\n".into()));
    }

    #[test]
    fn the_writer_keeps_the_order_and_answers_a_flush_after_the_lines_before_it() {
        let s = Scratch::new("writer");
        let path = s.0.join("ui.log");
        let (tx, rx) = mpsc::sync_channel(16);
        let file = RotatingFile::open(&path, LOG_CAP, LOG_FILES).unwrap();
        let writer = std::thread::spawn(move || write_lines(rx, Some(file), false));
        for n in 0..10 {
            hand_over(&tx, format!("line {n}\n").into_bytes());
        }
        let (done, written) = mpsc::channel();
        tx.send(Line::Flush(done)).unwrap();
        written.recv_timeout(Duration::from_secs(5)).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().collect::<Vec<_>>(), (0..10).map(|n| format!("line {n}")).collect::<Vec<_>>());
        drop(tx);
        writer.join().unwrap();
    }

    #[test]
    fn a_page_line_is_read_at_its_level_and_cut_to_its_length() {
        let line = |level: &str, message: &str| PageLine { level: level.into(), message: message.into() };
        assert_eq!(page_line(&line("warn", "w")), (log::Level::Warn, "w".into()));
        assert_eq!(page_line(&line("error", "e")).0, log::Level::Error);
        assert_eq!(page_line(&line("debug", "d")).0, log::Level::Debug);
        assert_eq!(page_line(&line("loud", "x")).0, log::Level::Info);
        let (_, long) = page_line(&line("info", &"é".repeat(PAGE_LINE_CHARS + 10)));
        assert_eq!(long.chars().count(), PAGE_LINE_CHARS + 1);
        assert!(long.ends_with('…'));
        let read: PageLine = serde_json::from_str(r#"{"message":"m"}"#).unwrap();
        assert_eq!(read, line("", "m"));
    }
}
