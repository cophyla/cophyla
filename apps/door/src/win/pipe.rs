//! The named pipe the user's daemon attaches to. The first instance is created with
//! FILE_FLAG_FIRST_PIPE_INSTANCE, so a name someone else already holds is an error (the shim
//! exits and the SCM tries again later) rather than a pipe shared with them; from then on one
//! instance is always listening, and a new one is made before a connected one is handed on,
//! so the name is never let go while the shim lives. Up to four instances: with three clients
//! connected and one listening, a fourth client is turned away. Byte mode, 64 KiB buffers,
//! remote clients rejected, and the DACL from `sddl::pipe`.
//!
//! The client writes first. Windows says who a pipe client is only by impersonating it, and
//! will not impersonate one before something it wrote has been read (ERROR_CANNOT_IMPERSONATE),
//! so each connection is taken on a thread of its own, which waits up to 10 s for the client's
//! first bytes, reads its user, lets in only the door's user, and only then tells the door
//! (`pipe.open`), the bytes it read going on as the first `pipe.line`s. Each client gets an
//! increasing `conn`, that reader thread (lines up to 1 MiB, a longer one drops the client) and
//! a writer thread with a bounded queue (a client that stops reading is dropped, not waited
//! on). The handles are overlapped: a synchronous pipe handle serialises a read and a write on
//! it, so a blocked read would hold up every write. A client is closed by closing its handle,
//! not by DisconnectNamedPipe, so what was already written can still be read before the end.

use std::io;
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TrySendError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use windows_sys::Win32::Foundation::{GetLastError, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX};
use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT};
use windows_sys::Win32::System::Threading::{WaitForMultipleObjects, INFINITE};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

use super::security::{self, SecurityDescriptor};
use super::{event, signal, wide, Handle};
use crate::door::Event;
use crate::log::Logger;

pub const MAX_INSTANCES: u32 = 4;
pub const BUFFER: u32 = 64 * 1024;
/// A client's longest line, without its newline.
pub const MAX_LINE: usize = 1024 * 1024;
/// How long a client has to write its first bytes, without which it cannot be identified.
pub const FIRST_WRITE_MS: u32 = 10_000;
/// Lines queued for a client before it counts as not reading.
const QUEUE: usize = 1024;
/// How long one write may wait on a client that is not reading.
const WRITE_TIMEOUT_MS: u32 = 15_000;

/// How an overlapped operation ended other than done.
enum Ended {
    /// The cancel (or stop) event was set.
    Cancelled,
    TimedOut,
    Failed(io::Error),
}

/// Waits for an operation started on `ov`, or for `cancel`, or the timeout; a cancelled or
/// timed-out operation is cancelled and waited for, so `ov` is free when this returns.
///
/// # Safety
/// `ov` must be the OVERLAPPED of an operation started on `pipe`, or of none that is pending.
unsafe fn wait_io(pipe: HANDLE, ov: &mut OVERLAPPED, cancel: HANDLE, timeout_ms: u32) -> Result<u32, Ended> {
    let handles = [ov.hEvent, cancel];
    let woke = WaitForMultipleObjects(2, handles.as_ptr(), 0, timeout_ms);
    let mut n = 0;
    if woke == WAIT_OBJECT_0 {
        if GetOverlappedResult(pipe, ov, &mut n, 0) != 0 {
            return Ok(n);
        }
        return Err(Ended::Failed(io::Error::last_os_error()));
    }
    CancelIoEx(pipe, ov);
    let finished = GetOverlappedResult(pipe, ov, &mut n, 1) != 0;
    match woke {
        w if w == WAIT_OBJECT_0 + 1 => Err(Ended::Cancelled),
        // it may have finished as it was cancelled: then it counts
        WAIT_TIMEOUT if finished => Ok(n),
        WAIT_TIMEOUT => Err(Ended::TimedOut),
        _ => Err(Ended::Failed(io::Error::last_os_error())),
    }
}

fn is_set(event: HANDLE) -> bool {
    // SAFETY: a wait with no timeout on an event handle.
    unsafe { WaitForMultipleObjects(1, &event, 0, 0) == WAIT_OBJECT_0 }
}

fn create_instance(name: &[u16], sd: &SecurityDescriptor, first: bool) -> io::Result<Handle> {
    let sa = sd.attributes();
    let open = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 };
    let mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
    // SAFETY: a NUL-terminated name and attributes that live across the call.
    let h = unsafe { CreateNamedPipeW(name.as_ptr(), open, mode, MAX_INSTANCES, BUFFER, BUFFER, 0, &sa) };
    if h == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Handle::new(h).ok_or_else(io::Error::last_os_error)
}

enum Connect {
    Client,
    Stopped,
    /// A client came and went before it was seen, or the connect failed: try again.
    Again(Option<io::Error>),
}

fn connect(pipe: &Handle, ev: &Handle, stop: &Handle) -> Connect {
    // SAFETY: `ov` is waited for before it goes out of scope.
    unsafe {
        let mut ov: OVERLAPPED = std::mem::zeroed();
        ov.hEvent = ev.raw();
        if ConnectNamedPipe(pipe.raw(), &mut ov) != 0 {
            return Connect::Client;
        }
        match GetLastError() {
            ERROR_PIPE_CONNECTED => Connect::Client,
            ERROR_NO_DATA => Connect::Again(None),
            ERROR_IO_PENDING => match wait_io(pipe.raw(), &mut ov, stop.raw(), INFINITE) {
                Ok(_) => Connect::Client,
                Err(Ended::Cancelled) => Connect::Stopped,
                Err(Ended::Failed(e)) => Connect::Again(Some(e)),
                Err(Ended::TimedOut) => Connect::Again(None),
            },
            e => Connect::Again(Some(io::Error::from_raw_os_error(e as i32))),
        }
    }
}

fn disconnect(pipe: &Handle) {
    // SAFETY: a server instance handle.
    unsafe { DisconnectNamedPipe(pipe.raw()) };
}

fn wait_stop(stop: &Handle, ms: u32) -> bool {
    let h = stop.raw();
    // SAFETY: a wait on an event handle.
    unsafe { WaitForMultipleObjects(1, &h, 0, ms) == WAIT_OBJECT_0 }
}

/// The listening side, run on a thread of its own until stopped.
pub struct Server {
    stop: Arc<Handle>,
    thread: Option<JoinHandle<()>>,
}

impl Server {
    /// Creates the first instance here, so a name that cannot be had is the caller's error,
    /// then listens on a thread.
    pub fn start(name: &str, sddl: &str, user_sid: &str, tx: Sender<Event>, log: Logger) -> io::Result<Server> {
        let sd = SecurityDescriptor::from_sddl(sddl)?;
        let name_w = wide(name);
        let first = create_instance(&name_w, &sd, true)?;
        let stop = Arc::new(event()?);
        let ev = event()?;
        let admit = Admit { user: user_sid.to_string(), tx, log };
        let stopping = Arc::clone(&stop);
        let thread = thread::Builder::new().name("door-pipe-accept".into()).spawn(move || accept_loop(&name_w, &sd, first, &ev, &stopping, &admit))?;
        Ok(Server { stop, thread: Some(thread) })
    }

    /// Stops listening and lets the name go. Attached clients are the caller's.
    pub fn stop(mut self) {
        signal(&self.stop);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// What a connection's thread needs to let a client in.
#[derive(Clone)]
struct Admit {
    user: String,
    tx: Sender<Event>,
    log: Logger,
}

fn accept_loop(name: &[u16], sd: &SecurityDescriptor, first: Handle, ev: &Handle, stop: &Handle, admit: &Admit) {
    let mut listening = first;
    let mut next_conn: u64 = 1;
    loop {
        match connect(&listening, ev, stop) {
            Connect::Stopped => return,
            Connect::Again(err) => {
                if let Some(e) = err {
                    admit.log.log(format!("pipe: a connect failed: {e}"));
                    // not to spin on a pipe that keeps failing
                    if wait_stop(stop, 1_000) {
                        return;
                    }
                }
                disconnect(&listening);
                continue;
            }
            Connect::Client => {}
        }
        // the next instance first, so the name is never without one
        let next = match create_instance(name, sd, false) {
            Ok(next) => next,
            Err(e) => {
                admit.log.log(format!("pipe: turned a client away: no instance to listen on after it ({e})"));
                disconnect(&listening);
                continue;
            }
        };
        let conn = next_conn;
        next_conn += 1;
        let pipe = std::mem::replace(&mut listening, next);
        let job = {
            let admit = admit.clone();
            move || admit_and_read(conn, pipe, &admit)
        };
        if let Err(e) = thread::Builder::new().name(format!("door-pipe-in-{conn}")).spawn(job) {
            admit.log.log(format!("pipe: cannot serve client {conn}: {e}"));
        }
    }
}

/// A connected instance, shared by its reader, its writer and the door.
struct Conn {
    pipe: Handle,
    /// Set to end both threads; the handle closes once they and the door are done with it.
    cancel: Handle,
}

impl Conn {
    fn cancel(&self) {
        signal(&self.cancel);
    }
}

enum Out {
    Line(Vec<u8>),
    /// After what is queued, close.
    Close,
}

/// The door's hold on a client. Dropping it closes the client once what was queued is written.
pub struct Client {
    conn: Arc<Conn>,
    out: SyncSender<Out>,
}

impl Client {
    /// Queues a line; `false` when the client is not reading, which drops it.
    pub fn send(&self, line: &str) -> bool {
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        match self.out.try_send(Out::Line(bytes)) {
            Ok(()) | Err(TrySendError::Disconnected(_)) => true,
            Err(TrySendError::Full(_)) => {
                self.conn.cancel();
                false
            }
        }
    }

    /// Closes the client after what is queued.
    pub fn close(&self) {
        if self.out.try_send(Out::Close).is_err() {
            self.conn.cancel();
        }
    }
}

/// Splits what was read into lines, sending each as `pipe.line`; `false` once the client
/// must go (a line too long, or the door gone).
fn feed(id: u64, line: &mut Vec<u8>, mut chunk: &[u8], admit: &Admit) -> bool {
    while let Some(i) = chunk.iter().position(|b| *b == b'\n') {
        if line.len() + i > MAX_LINE {
            admit.log.log(format!("pipe: client {id} wrote a line over 1 MiB: dropped"));
            return false;
        }
        line.extend_from_slice(&chunk[..i]);
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if !line.is_empty() {
            let text = String::from_utf8_lossy(line).into_owned();
            if admit.tx.send(Event::PipeLine { conn: id, line: text }).is_err() {
                return false;
            }
        }
        line.clear();
        chunk = &chunk[i + 1..];
    }
    if line.len() + chunk.len() > MAX_LINE {
        admit.log.log(format!("pipe: client {id} wrote a line over 1 MiB: dropped"));
        return false;
    }
    line.extend_from_slice(chunk);
    true
}

/// A connection's own thread: the first bytes, who wrote them, `pipe.open`, then every line
/// until the client goes or is closed, then `pipe.close`.
fn admit_and_read(id: u64, pipe: Handle, admit: &Admit) {
    let (Ok(cancel), Ok(ev)) = (event(), event()) else {
        admit.log.log(format!("pipe: no events for client {id}"));
        return;
    };
    let conn = Arc::new(Conn { pipe, cancel });
    let mut buf = vec![0u8; BUFFER as usize];
    let first = match read(&conn, &mut buf, &ev, FIRST_WRITE_MS) {
        Ok(n) => n as usize,
        Err(Ended::TimedOut) => {
            admit.log.log(format!("pipe: client {id} wrote nothing within {} s: closed", FIRST_WRITE_MS / 1000));
            return;
        }
        Err(_) => return,
    };
    let sid = match security::pipe_client_sid(conn.pipe.raw()) {
        Ok(sid) => sid,
        Err(e) => {
            admit.log.log(format!("pipe: refused client {id}, whose user could not be read: {e}"));
            return;
        }
    };
    if sid != admit.user {
        admit.log.log(format!("pipe: refused a client of {sid}: the door is {}'s", admit.user));
        return;
    }
    let (out, queue) = mpsc::sync_channel(QUEUE);
    let writer = Arc::clone(&conn);
    let writer_log = admit.log.clone();
    if let Err(e) = thread::Builder::new().name(format!("door-pipe-out-{id}")).spawn(move || write_loop(id, &writer, queue, &writer_log)) {
        admit.log.log(format!("pipe: cannot serve client {id}: {e}"));
        return;
    }
    if admit.tx.send(Event::PipeOpen { conn: id, sid, client: Client { conn: Arc::clone(&conn), out } }).is_err() {
        conn.cancel();
        return;
    }

    let mut line: Vec<u8> = Vec::new();
    let mut more = feed(id, &mut line, &buf[..first], admit);
    while more && !is_set(conn.cancel.raw()) {
        match read(&conn, &mut buf, &ev, INFINITE) {
            Ok(n) => more = feed(id, &mut line, &buf[..n as usize], admit),
            Err(Ended::Failed(e)) => {
                let code = e.raw_os_error().unwrap_or(0) as u32;
                if code != ERROR_BROKEN_PIPE && code != ERROR_PIPE_NOT_CONNECTED {
                    admit.log.log(format!("pipe: client {id}: {e}"));
                }
                break;
            }
            Err(_) => break,
        }
    }
    conn.cancel();
    let _ = admit.tx.send(Event::PipeClose { conn: id });
}

fn read(conn: &Conn, buf: &mut [u8], ev: &Handle, timeout_ms: u32) -> Result<u32, Ended> {
    // SAFETY: `ov` and `buf` outlive the operation: wait_io returns only once it is over.
    unsafe {
        let mut ov: OVERLAPPED = std::mem::zeroed();
        ov.hEvent = ev.raw();
        if ReadFile(conn.pipe.raw(), buf.as_mut_ptr(), buf.len() as u32, std::ptr::null_mut(), &mut ov) == 0 {
            let err = GetLastError();
            if err != ERROR_IO_PENDING {
                return Err(Ended::Failed(io::Error::from_raw_os_error(err as i32)));
            }
        }
        wait_io(conn.pipe.raw(), &mut ov, conn.cancel.raw(), timeout_ms)
    }
}

fn write_all(conn: &Conn, bytes: &[u8], ev: &Handle) -> Result<(), Ended> {
    let mut done = 0;
    while done < bytes.len() {
        let chunk = &bytes[done..];
        let len = chunk.len().min(u32::MAX as usize) as u32;
        // SAFETY: as in `read`.
        let n = unsafe {
            let mut ov: OVERLAPPED = std::mem::zeroed();
            ov.hEvent = ev.raw();
            if WriteFile(conn.pipe.raw(), chunk.as_ptr(), len, std::ptr::null_mut(), &mut ov) == 0 {
                let err = GetLastError();
                if err != ERROR_IO_PENDING {
                    return Err(Ended::Failed(io::Error::from_raw_os_error(err as i32)));
                }
            }
            wait_io(conn.pipe.raw(), &mut ov, conn.cancel.raw(), WRITE_TIMEOUT_MS)?
        };
        if n == 0 {
            return Err(Ended::Failed(io::Error::from(io::ErrorKind::WriteZero)));
        }
        done += n as usize;
    }
    Ok(())
}

fn write_loop(id: u64, conn: &Conn, queue: Receiver<Out>, log: &Logger) {
    if let Ok(ev) = event() {
        while let Ok(Out::Line(bytes)) = queue.recv() {
            match write_all(conn, &bytes, &ev) {
                Ok(()) => {}
                Err(Ended::TimedOut) => {
                    log.log(format!("pipe: client {id} has not read for {} s: dropped", WRITE_TIMEOUT_MS / 1000));
                    break;
                }
                Err(_) => break,
            }
        }
    }
    conn.cancel();
}
