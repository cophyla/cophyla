//! What the SCM runs: `cophyla-door.exe service`. The dispatcher calls `service_main` on a
//! thread of its own, which registers the control handler, reads who the door is for from
//! `door.json`, and runs the door's machinery until a stop. The handler takes STOP and
//! SHUTDOWN (both a graceful stop: `shim.stop`, the grace, then a kill), SESSIONCHANGE (the
//! console is asked again) and POWEREVENT (the power line is read again on a power status
//! change), and passes them to the door as events. The program folder is the one beside this
//! exe; the data root is `%ProgramData%\Cophyla Door`, its `shim.log` the log. A door that
//! cannot start (no `door.json`, the pipe's name taken) stops with a service-specific error,
//! which the failure actions answer with a restart.

use std::ffi::c_void;
use std::fs;
use std::io;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};

use windows_sys::core::PWSTR;
use windows_sys::Win32::Foundation::{ERROR_CALL_NOT_IMPLEMENTED, ERROR_SERVICE_SPECIFIC_ERROR, NO_ERROR};
use windows_sys::Win32::System::Services::{
    RegisterServiceCtrlHandlerExW, SetServiceStatus, StartServiceCtrlDispatcherW, SERVICE_ACCEPT_POWEREVENT, SERVICE_ACCEPT_SESSIONCHANGE, SERVICE_ACCEPT_SHUTDOWN, SERVICE_ACCEPT_STOP,
    SERVICE_CONTROL_INTERROGATE, SERVICE_CONTROL_POWEREVENT, SERVICE_CONTROL_SESSIONCHANGE, SERVICE_CONTROL_SHUTDOWN, SERVICE_CONTROL_STOP, SERVICE_RUNNING, SERVICE_START_PENDING, SERVICE_STATUS,
    SERVICE_STATUS_HANDLE, SERVICE_STOPPED, SERVICE_STOP_PENDING, SERVICE_TABLE_ENTRYW, SERVICE_WIN32_OWN_PROCESS,
};

use super::{machine_layout, wide};
use crate::constants::{SERVICE_NAME, STOP_GRACE_MS};
use crate::door::{self, ChildLog, Event, Sensors};
use crate::layout::{DoorConfig, DOOR_JSON};
use crate::log::{Logger, RotatingFile, LOG_CAP};

/// `PBT_APMPOWERSTATUSCHANGE`, which windows-sys keeps with the window messages.
const PBT_APMPOWERSTATUSCHANGE: u32 = 10;
/// The service-specific code a door that could not start stops with.
const FAILED: u32 = 1;

struct Status {
    handle: SERVICE_STATUS_HANDLE,
    checkpoint: u32,
}

// SAFETY: the status handle is a token the SCM gave this process; SetServiceStatus may be
// called with it from any thread, and the mutex orders the calls.
unsafe impl Send for Status {}

/// What the control handler needs, set once `service_main` has it.
struct Service {
    events: Sender<Event>,
    status: Mutex<Status>,
}

static SERVICE: OnceLock<Service> = OnceLock::new();
static EXIT: AtomicI32 = AtomicI32::new(0);

/// Hands the process to the SCM's dispatcher until the service has stopped.
pub fn run() -> i32 {
    let mut name = wide(SERVICE_NAME);
    let table = [
        SERVICE_TABLE_ENTRYW { lpServiceName: name.as_mut_ptr(), lpServiceProc: Some(service_main) },
        SERVICE_TABLE_ENTRYW { lpServiceName: std::ptr::null_mut(), lpServiceProc: None },
    ];
    // SAFETY: the table and its name live until the dispatcher returns.
    if unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) } == 0 {
        eprintln!("cophyla-door: `service` is what the SCM runs ({}); for a console, use `run --console`", io::Error::last_os_error());
        return 1;
    }
    EXIT.load(Ordering::SeqCst)
}

fn report(state: u32, exit: u32, wait_hint: u32) {
    let Some(service) = SERVICE.get() else { return };
    let mut status = service.status.lock().unwrap_or_else(|e| e.into_inner());
    let pending = state == SERVICE_START_PENDING || state == SERVICE_STOP_PENDING;
    status.checkpoint = if pending { status.checkpoint + 1 } else { 0 };
    let accepts = if state == SERVICE_RUNNING { SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN | SERVICE_ACCEPT_SESSIONCHANGE | SERVICE_ACCEPT_POWEREVENT } else { 0 };
    let st = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: accepts,
        dwWin32ExitCode: if exit == 0 { NO_ERROR } else { ERROR_SERVICE_SPECIFIC_ERROR },
        dwServiceSpecificExitCode: exit,
        dwCheckPoint: status.checkpoint,
        dwWaitHint: wait_hint,
    };
    // SAFETY: the handle RegisterServiceCtrlHandlerExW gave.
    unsafe { SetServiceStatus(status.handle, &st) };
}

unsafe extern "system" fn handler(control: u32, event_type: u32, _data: *mut c_void, _context: *mut c_void) -> u32 {
    let Some(service) = SERVICE.get() else { return ERROR_CALL_NOT_IMPLEMENTED };
    match control {
        SERVICE_CONTROL_STOP | SERVICE_CONTROL_SHUTDOWN => {
            report(SERVICE_STOP_PENDING, 0, STOP_GRACE_MS + 10_000);
            let _ = service.events.send(Event::Stop);
            NO_ERROR
        }
        SERVICE_CONTROL_SESSIONCHANGE => {
            let _ = service.events.send(Event::SessionChanged);
            NO_ERROR
        }
        SERVICE_CONTROL_POWEREVENT => {
            if event_type == PBT_APMPOWERSTATUSCHANGE {
                let _ = service.events.send(Event::PowerChanged);
            }
            NO_ERROR
        }
        SERVICE_CONTROL_INTERROGATE => NO_ERROR,
        _ => ERROR_CALL_NOT_IMPLEMENTED,
    }
}

unsafe extern "system" fn service_main(_argc: u32, _argv: *mut PWSTR) {
    let (tx, rx) = mpsc::channel();
    let name = wide(SERVICE_NAME);
    let handle = RegisterServiceCtrlHandlerExW(name.as_ptr(), Some(handler), std::ptr::null());
    if handle.is_null() {
        EXIT.store(1, Ordering::SeqCst);
        return;
    }
    if SERVICE.set(Service { events: tx.clone(), status: Mutex::new(Status { handle, checkpoint: 0 }) }).is_err() {
        return;
    }
    report(SERVICE_START_PENDING, 0, 10_000);
    let code = match serve(tx, rx) {
        Ok(()) => 0,
        Err(()) => FAILED,
    };
    EXIT.store(code as i32, Ordering::SeqCst);
    report(SERVICE_STOPPED, code, 0);
}

fn serve(tx: Sender<Event>, rx: mpsc::Receiver<Event>) -> Result<(), ()> {
    let layout = machine_layout();
    // the install made the data root; one the service made itself would be refused by the next
    // install as not SYSTEM's or Administrators', so a missing one is only reported
    let log = Logger::file(&layout.data.join("shim.log"));
    log.log(format!("cophyla-door {} starting as a service, pid {}", env!("CARGO_PKG_VERSION"), std::process::id()));
    let program = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|d| d.join("program"))).unwrap_or_else(|| layout.program.clone());
    let config = match fs::read(layout.data.join(DOOR_JSON)).map_err(|e| e.to_string()).and_then(|bytes| DoorConfig::decode(&bytes)) {
        Ok(c) => c,
        Err(e) => {
            log.log(format!("cannot read {}: {e}; stopping", layout.data.join(DOOR_JSON).display()));
            return Err(());
        }
    };
    let user_sid = match super::security::canonical_sid(&config.user_sid) {
        Some(s) => s,
        None => {
            log.log(format!("door.json's userSid {} is no SID; stopping", config.user_sid));
            return Err(());
        }
    };
    let child_log = match RotatingFile::open(&layout.data.join("child.log"), LOG_CAP) {
        Ok(f) => ChildLog::File(Arc::new(Mutex::new(f))),
        Err(e) => {
            log.log(format!("cannot open child.log ({e}); the child's stderr goes nowhere"));
            ChildLog::Stderr
        }
    };
    let options = door::Options {
        program,
        home: layout.home(),
        pipe: crate::constants::PIPE_NAME.to_string(),
        user_sid,
        bun: None,
        main: None,
        power: true,
        sensors: Sensors::Live,
        child_log,
    };
    let result = door::run(options, log.clone(), tx, rx, || report(SERVICE_RUNNING, 0, 0));
    match result {
        Ok(()) => {
            log.log("stopped");
            Ok(())
        }
        Err(e) => {
            log.log(format!("{e}; stopping with an error, for the SCM to try again"));
            Err(())
        }
    }
}
