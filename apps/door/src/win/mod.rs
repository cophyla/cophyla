//! The Windows side: the mode dispatch, and what every module here shares (owned handles,
//! wide strings, the machine's folders). `service` is the SCM's entry, `door::run` the
//! machinery it and the console mode share, `pipe` the named pipe, `child` the Bun child,
//! `session` the console and the power line, `security` SIDs and descriptors, `scm` the
//! service's configuration, and `install` the elevated install and uninstall.

pub mod child;
pub mod install;
pub mod pipe;
pub mod scm;
pub mod security;
pub mod service;
pub mod session;

use std::env;
use std::ffi::{OsStr, OsString};
use std::io::{self, BufRead};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent};

use crate::args::{self, Mode, RunArgs, USAGE};
use crate::constants::PIPE_NAME;
use crate::door::{self, ChildLog, Event, Sensors};
use crate::layout::Layout;
use crate::log::Logger;
use crate::proto::{self, Command};
use crate::status;

pub fn main() -> i32 {
    let argv: Vec<OsString> = env::args_os().skip(1).collect();
    let mode = match args::parse(&argv) {
        Ok(mode) => mode,
        Err(e) => {
            eprintln!("cophyla-door: {e}\n{USAGE}");
            if let Some(path) = args::result_path(&argv) {
                install::write_result(&path, Err(&e), None);
            }
            return 2;
        }
    };
    match mode {
        Mode::Service => service::run(),
        Mode::Run(a) => run_console(a),
        Mode::Install(a) => install::install(a),
        Mode::Uninstall { result } => install::uninstall(result),
        Mode::Status => print_status(),
    }
}

/// An owned kernel handle, closed when dropped.
pub struct Handle(HANDLE);

// SAFETY: a kernel handle is a process-wide value; the calls made on one from several threads
// here (waits, overlapped I/O, SetEvent) are all thread-safe in the kernel.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}

impl Handle {
    /// Takes ownership of `h`, or `None` for a null or invalid one.
    pub fn new(h: HANDLE) -> Option<Handle> {
        (!h.is_null() && h != INVALID_HANDLE_VALUE).then_some(Handle(h))
    }

    pub fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the handle is owned and closed once.
        unsafe { CloseHandle(self.0) };
    }
}

/// A manual-reset event, not signalled.
pub fn event() -> io::Result<Handle> {
    // SAFETY: no attributes, no name.
    Handle::new(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) }).ok_or_else(io::Error::last_os_error)
}

pub fn signal(event: &Handle) {
    // SAFETY: an event handle owned by the caller.
    unsafe { SetEvent(event.raw()) };
}

/// NUL-terminated UTF-16, for the W APIs.
pub fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}

/// A NUL-terminated UTF-16 string the system returned.
///
/// # Safety
/// `p` must be null or point to a NUL-terminated UTF-16 string.
pub unsafe fn from_wide_ptr(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut len = 0;
    while *p.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
}

fn env_dir(name: &str, fallback: &str) -> PathBuf {
    env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| PathBuf::from(fallback))
}

pub fn system_root() -> PathBuf {
    env_dir("SystemRoot", r"C:\Windows")
}

/// A program in System32, by its full path: an elevated install never searches PATH.
pub fn system32(exe: &str) -> PathBuf {
    system_root().join("System32").join(exe)
}

/// The door's folders on this machine, from `%ProgramFiles%` and `%ProgramData%`.
pub fn machine_layout() -> Layout {
    Layout::new(&env_dir("ProgramFiles", r"C:\Program Files"), &env_dir("ProgramData", r"C:\ProgramData"))
}

fn print_status() -> i32 {
    let layout = machine_layout();
    let version = crate::layout::read_pointer(&layout.program, "current");
    match scm::query_installed() {
        Ok(Some(st)) => {
            println!("{}", status::line(true, Some(st.dwCurrentState), Some(st.dwProcessId), version.as_deref()));
            0
        }
        Ok(None) => {
            println!("{}", status::line(false, None, None, version.as_deref()));
            0
        }
        Err(e) => {
            eprintln!("cophyla-door: cannot ask the SCM: {e}");
            println!("{}", status::line(false, None, None, version.as_deref()));
            1
        }
    }
}

/// A bare program name (`bun`) looked up on the shim's own PATH, since the child's PATH is the
/// system's alone; anything with a folder in it is made absolute against the current folder,
/// since the child runs in its home.
fn resolve_program(p: PathBuf) -> PathBuf {
    let bare = p.components().count() == 1 && !p.to_string_lossy().contains(['\\', '/', ':']);
    if bare {
        let names: Vec<OsString> = if p.extension().is_some() { vec![p.clone().into_os_string()] } else { vec![p.with_extension("exe").into_os_string(), p.clone().into_os_string()] };
        if let Some(path) = env::var_os("PATH") {
            for dir in env::split_paths(&path) {
                for name in &names {
                    let candidate = dir.join(name);
                    if candidate.is_file() {
                        return candidate;
                    }
                }
            }
        }
        return p;
    }
    std::path::absolute(&p).unwrap_or(p)
}

fn run_console(a: RunArgs) -> i32 {
    let log = Logger::stderr();
    let data = a.data.unwrap_or_else(|| machine_layout().data);
    let absolute = |p: PathBuf| std::path::absolute(&p).unwrap_or(p);
    let home = absolute(a.home.unwrap_or_else(|| data.join("home")));
    let program = absolute(a.program.unwrap_or_else(|| machine_layout().program));
    let user_sid = match a.user_sid {
        Some(s) => match security::canonical_sid(&s) {
            Some(c) => c,
            None => {
                log.log(format!("--user-sid {s} is not a SID Windows knows the form of"));
                return 2;
            }
        },
        None => match security::process_user_sid() {
            Ok(s) => s,
            Err(e) => {
                log.log(format!("cannot read this process's own user: {e}"));
                return 1;
            }
        },
    };
    let (tx, rx) = mpsc::channel();
    let input = tx.clone();
    let stdin_log = log.clone();
    let _ = thread::Builder::new().name("door-stdin".into()).spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let event = match proto::command(&line) {
                Some(Command::Stop) => Event::Stop,
                Some(Command::Console(c)) => Event::Console(c),
                Some(Command::Ac(on)) => Event::Ac(on),
                None => {
                    if !line.trim().is_empty() {
                        stdin_log.log(format!("stdin: not a command: {}", line.trim()));
                    }
                    continue;
                }
            };
            if input.send(event).is_err() {
                return;
            }
        }
        // stdin's end is the kit's: the door goes with it
        let _ = input.send(Event::Stop);
    });
    let options = door::Options {
        program,
        home,
        pipe: a.pipe.unwrap_or_else(|| PIPE_NAME.to_string()),
        user_sid,
        bun: a.bun.map(resolve_program),
        main: a.main.map(absolute),
        power: !a.no_power,
        sensors: Sensors::Stdin,
        child_log: ChildLog::Stderr,
    };
    match door::run(options, log.clone(), tx, rx, || {}) {
        Ok(()) => 0,
        Err(e) => {
            log.log(e);
            1
        }
    }
}

/// Whether `inner` is `outer` or below it, comparing without case as Windows does.
pub fn is_within(inner: &Path, outer: &Path) -> bool {
    let lower = |p: &Path| p.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect::<Vec<_>>();
    let (i, o) = (lower(inner), lower(outer));
    i.len() >= o.len() && i[..o.len()] == o[..]
}
