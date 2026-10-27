//! The Bun child: started with no window, its stdio piped, its home as its folder and only the
//! environment `childenv` builds, inside a job object that kills everything it started when
//! the job's handle closes, so a streamer or a helper it ran does not outlive it, nor the shim.
//! Four threads serve it: one writes the lines the door queues to its stdin (the door never
//! blocks on a child that stops reading), one reads its stdout lines into events, one copies
//! its stderr to `child.log` (or the console mode's stderr), and one waits for its exit and
//! reports it after its last stdout line, so `pipe.send`s written just before an exit still
//! reach their client.

use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, TerminateProcess, CREATE_NO_WINDOW};

use super::Handle;
use crate::childenv;
use crate::door::Event;
use crate::log::{Logger, RotatingFile};

/// The longest stdout line read; a longer one is skipped and logged.
const MAX_LINE: usize = 16 * 1024 * 1024;
/// How long the exit waits for the last stdout lines.
const DRAIN: Duration = Duration::from_secs(1);

/// Where the child's stderr goes.
#[derive(Clone)]
pub enum ChildLog {
    File(Arc<Mutex<RotatingFile>>),
    Stderr,
}

/// What to start.
pub struct Launch {
    pub bun: PathBuf,
    pub main: PathBuf,
    /// The version, for the log.
    pub label: String,
    /// The version the supervisor counts crashes against: only one `current` named, whose
    /// runtime and entry point both came from its folder.
    pub counted: Option<String>,
}

/// A child that was started and has not been seen to exit.
pub struct Running {
    pub gen: u64,
    pub label: String,
    pub counted: Option<String>,
    pub pid: u32,
    pub started: Instant,
    stdin: Sender<Vec<u8>>,
    job: Option<Handle>,
    process: Handle,
}

impl Running {
    /// Queues a line for the child's stdin.
    pub fn send(&self, line: Vec<u8>) {
        let _ = self.stdin.send(line);
    }

    /// Kills the child and everything it started.
    pub fn kill(&self) {
        // SAFETY: handles owned by `self`.
        unsafe {
            match &self.job {
                Some(job) => TerminateJobObject(job.raw(), 1),
                None => TerminateProcess(self.process.raw(), 1),
            };
        }
    }
}

fn job_for(process: &Handle) -> io::Result<Handle> {
    // SAFETY: an unnamed job; the limits struct is plain data of the size given.
    unsafe {
        let job = Handle::new(CreateJobObjectW(std::ptr::null(), std::ptr::null())).ok_or_else(io::Error::last_os_error)?;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(job.raw(), JobObjectExtendedLimitInformation, (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) == 0 {
            return Err(io::Error::last_os_error());
        }
        if AssignProcessToJobObject(job.raw(), process.raw()) == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }
}

/// Reads one line of at most `limit` bytes into `buf`, without its line break. `Ok(None)` at
/// the end; `Ok(Some(false))` for a longer line, whose rest is skipped.
fn read_line<R: BufRead>(r: &mut R, buf: &mut Vec<u8>, limit: usize) -> io::Result<Option<bool>> {
    buf.clear();
    let n = r.by_ref().take(limit as u64 + 1).read_until(b'\n', buf)?;
    if n == 0 {
        return Ok(None);
    }
    if buf.last() == Some(&b'\n') {
        buf.pop();
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
        return Ok(Some(true));
    }
    if buf.len() <= limit {
        // the last line, with no break after it
        return Ok(Some(true));
    }
    let mut skip = Vec::new();
    loop {
        skip.clear();
        let m = r.by_ref().take(64 * 1024).read_until(b'\n', &mut skip)?;
        if m == 0 || skip.last() == Some(&b'\n') {
            return Ok(Some(false));
        }
    }
}

/// Starts the child of generation `gen`; its lines and its exit come to the door as events.
pub fn spawn(launch: &Launch, home: &Path, program: &Path, gen: u64, tx: &Sender<Event>, child_log: &ChildLog, log: &Logger) -> io::Result<Running> {
    for dir in childenv::HOME_DIRS {
        fs::create_dir_all(home.join(dir))?;
    }
    let mut cmd = Command::new(&launch.bun);
    cmd.arg(&launch.main)
        .arg("door")
        .arg("--home")
        .arg(home)
        .arg("--program")
        .arg(program)
        .env_clear()
        .envs(childenv::build(|name| env::var_os(name), home))
        .current_dir(home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn()?;
    let pid = child.id();

    let mut dup = std::ptr::null_mut();
    // SAFETY: the child's process handle, duplicated into one owned here for kill().
    let process = unsafe {
        let me = GetCurrentProcess();
        (DuplicateHandle(me, child.as_raw_handle(), me, &mut dup, 0, 0, DUPLICATE_SAME_ACCESS) != 0).then(|| Handle::new(dup)).flatten()
    };
    let Some(process) = process else {
        let e = io::Error::last_os_error();
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    };
    let job = match job_for(&process) {
        Ok(job) => Some(job),
        Err(e) => {
            log.log(format!("child {gen}: no job object ({e}); what it starts may outlive it"));
            None
        }
    };

    let (stdin, stdout, stderr) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let (in_tx, in_rx) = mpsc::channel::<Vec<u8>>();
    if let Some(mut stdin) = stdin {
        let _ = thread::Builder::new().name(format!("door-child-in-{gen}")).spawn(move || {
            for line in in_rx {
                if stdin.write_all(&line).and_then(|_| stdin.flush()).is_err() {
                    break;
                }
            }
        });
    }

    let (drained_tx, drained_rx) = mpsc::channel::<()>();
    if let Some(stdout) = stdout {
        let tx = tx.clone();
        let log = log.clone();
        let _ = thread::Builder::new().name(format!("door-child-out-{gen}")).spawn(move || {
            let mut reader = BufReader::with_capacity(64 * 1024, stdout);
            let mut buf = Vec::new();
            loop {
                match read_line(&mut reader, &mut buf, MAX_LINE) {
                    Ok(Some(true)) if buf.is_empty() => {}
                    Ok(Some(true)) => {
                        if tx.send(Event::ChildLine { gen, line: std::mem::take(&mut buf) }).is_err() {
                            break;
                        }
                    }
                    Ok(Some(false)) => log.log(format!("child {gen} wrote a line over {} MiB on stdout: skipped", MAX_LINE >> 20)),
                    Ok(None) | Err(_) => break,
                }
            }
            let _ = drained_tx.send(());
        });
    } else {
        drop(drained_tx);
    }

    if let Some(stderr) = stderr {
        let sink = child_log.clone();
        let _ = thread::Builder::new().name(format!("door-child-err-{gen}")).spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.by_ref().take(MAX_LINE as u64).read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if buf.last() != Some(&b'\n') {
                            buf.push(b'\n');
                        }
                        match &sink {
                            ChildLog::File(file) => {
                                let mut f = file.lock().unwrap_or_else(|e| e.into_inner());
                                let _ = f.write(&buf);
                            }
                            ChildLog::Stderr => {
                                let _ = io::stderr().write_all(&buf);
                            }
                        }
                    }
                }
            }
        });
    }

    let exit_tx = tx.clone();
    thread::Builder::new().name(format!("door-child-wait-{gen}")).spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        let _ = drained_rx.recv_timeout(DRAIN);
        let _ = exit_tx.send(Event::ChildExit { gen, code });
    })?;

    Ok(Running { gen, label: launch.label.clone(), counted: launch.counted.clone(), pid, started: Instant::now(), stdin: in_tx, job, process })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn lines_are_read_bounded() {
        let mut r = Cursor::new(b"one\r\ntwo\n\n0123456789abc\nlast".to_vec());
        let mut buf = Vec::new();
        assert_eq!(read_line(&mut r, &mut buf, 10).unwrap(), Some(true));
        assert_eq!(buf, b"one");
        assert_eq!(read_line(&mut r, &mut buf, 10).unwrap(), Some(true));
        assert_eq!(buf, b"two");
        assert_eq!(read_line(&mut r, &mut buf, 10).unwrap(), Some(true));
        assert_eq!(buf, b"");
        assert_eq!(read_line(&mut r, &mut buf, 10).unwrap(), Some(false));
        assert_eq!(read_line(&mut r, &mut buf, 10).unwrap(), Some(true));
        assert_eq!(buf, b"last");
        assert_eq!(read_line(&mut r, &mut buf, 10).unwrap(), None);
    }
}
