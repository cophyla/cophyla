//! The shim's logs: `shim.log` under the service, stderr in a console, `install.log` for an
//! install, and `child.log` for the child's stderr as it wrote it. Each file is capped at about
//! 5 MB and rotated to `<name>.1`, so a door left running for months takes 10 MB a log. An
//! install's lines are held in memory until its data root is known to be its own, then written
//! there; nothing is written into a folder a user may have made.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const LOG_CAP: u64 = 5 * 1024 * 1024;

/// A file appended to, moved aside to `<name>.1` (replacing the last one) when the next write
/// would take it past its cap.
pub struct RotatingFile {
    path: PathBuf,
    file: Option<File>,
    size: u64,
    cap: u64,
}

impl RotatingFile {
    pub fn open(path: &Path, cap: u64) -> io::Result<RotatingFile> {
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let size = file.metadata()?.len();
        Ok(RotatingFile { path: path.to_path_buf(), file: Some(file), size, cap })
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

    fn rotate(&mut self) {
        self.file = None;
        let mut aside = self.path.clone().into_os_string();
        aside.push(".1");
        let aside = PathBuf::from(aside);
        let _ = fs::remove_file(&aside);
        if fs::rename(&self.path, &aside).is_err() {
            // someone holds it open without sharing delete: start it again in place
            let _ = OpenOptions::new().write(true).truncate(true).open(&self.path);
        }
        self.size = 0;
    }
}

enum Sink {
    Stderr,
    File(RotatingFile),
    /// Held until `to_file`.
    Buffer(Vec<String>),
}

struct Inner {
    sink: Sink,
    /// Also to stderr, for an install run by hand from an elevated console.
    tee: bool,
}

/// A log line goes out whole: the lock is held for it.
#[derive(Clone)]
pub struct Logger(Arc<Mutex<Inner>>);

impl Logger {
    pub fn stderr() -> Logger {
        Logger::with(Sink::Stderr, false)
    }

    /// A rotating file, or stderr when it cannot be opened (a service has nowhere else).
    pub fn file(path: &Path) -> Logger {
        match RotatingFile::open(path, LOG_CAP) {
            Ok(f) => Logger::with(Sink::File(f), false),
            Err(e) => {
                let log = Logger::stderr();
                log.log(format!("cannot open {}: {e}", path.display()));
                log
            }
        }
    }

    /// Lines held in memory until `to_file`.
    pub fn buffer(tee: bool) -> Logger {
        Logger::with(Sink::Buffer(Vec::new()), tee)
    }

    fn with(sink: Sink, tee: bool) -> Logger {
        Logger(Arc::new(Mutex::new(Inner { sink, tee })))
    }

    /// From now on to `path`, with what was held written first.
    pub fn to_file(&self, path: &Path) -> io::Result<()> {
        let mut file = RotatingFile::open(path, LOG_CAP)?;
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Sink::Buffer(held) = &inner.sink {
            for line in held {
                file.write(line.as_bytes())?;
            }
        }
        inner.sink = Sink::File(file);
        Ok(())
    }

    pub fn log(&self, message: impl AsRef<str>) {
        let line = format!("{} {}\n", timestamp(SystemTime::now()), message.as_ref());
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if inner.tee {
            let _ = io::stderr().write_all(line.as_bytes());
        }
        match &mut inner.sink {
            Sink::Stderr => {
                let _ = io::stderr().write_all(line.as_bytes());
            }
            Sink::File(f) => {
                let _ = f.write(line.as_bytes());
            }
            Sink::Buffer(held) => held.push(line),
        }
    }
}

/// `2026-10-26T12:34:56.789Z`, from the system clock without a date crate.
pub fn timestamp(t: SystemTime) -> String {
    let since = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs();
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, since.subsec_millis())
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("cophyla-door-log-{}-{name}", std::process::id()));
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
    fn timestamps_are_utc_iso() {
        assert_eq!(timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(timestamp(UNIX_EPOCH + Duration::from_millis(951_782_400_123)), "2000-02-29T00:00:00.123Z");
        assert_eq!(timestamp(UNIX_EPOCH + Duration::from_secs(1_793_016_896)), "2026-10-26T12:14:56.000Z");
        assert_eq!(timestamp(UNIX_EPOCH + Duration::from_secs(4_102_444_799)), "2099-12-31T23:59:59.000Z");
    }

    #[test]
    fn a_file_rotates_to_dot_one_at_its_cap() {
        let s = Scratch::new("rotate");
        let path = s.0.join("child.log");
        let mut f = RotatingFile::open(&path, 10).unwrap();
        f.write(b"12345\n").unwrap();
        f.write(b"678\n").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"12345\n678\n");
        f.write(b"abc\n").unwrap();
        assert_eq!(fs::read(s.0.join("child.log.1")).unwrap(), b"12345\n678\n");
        assert_eq!(fs::read(&path).unwrap(), b"abc\n");
        // a line longer than the cap still goes in whole, in a file of its own
        f.write(b"0123456789abcdef\n").unwrap();
        f.write(b"x\n").unwrap();
        assert_eq!(fs::read(s.0.join("child.log.1")).unwrap(), b"0123456789abcdef\n");
        assert_eq!(fs::read(&path).unwrap(), b"x\n");
        drop(f);
        // reopened, it counts what is there
        let mut f = RotatingFile::open(&path, 10).unwrap();
        f.write(b"123456789\n").unwrap();
        assert_eq!(fs::read(s.0.join("child.log.1")).unwrap(), b"x\n");
    }

    #[test]
    fn held_lines_land_in_the_file_first() {
        let s = Scratch::new("held");
        let log = Logger::buffer(false);
        log.log("one");
        log.log("two");
        let path = s.0.join("install.log");
        log.to_file(&path).unwrap();
        log.log("three");
        let text = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().map(|l| l.split_once(' ').unwrap().1).collect();
        assert_eq!(lines, ["one", "two", "three"]);
    }
}
