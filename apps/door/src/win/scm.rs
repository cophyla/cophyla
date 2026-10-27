//! The service's record in the SCM: created or brought up to date by the install, stopped and
//! deleted by the uninstall, asked about by `status`. The configuration is the security
//! boundary as much as the ACLs are: the service runs as its virtual account
//! `NT SERVICE\CophylaDoor`, with an unrestricted service SID the ACLs can name, and with
//! SeChangeNotifyPrivilege as its only privilege, so it holds no SeImpersonate and is no more
//! powerful than the user it serves. It restarts after 5 s, 30 s and 60 s when it fails, also
//! when it stops itself with an error (the pipe's name taken, `door.json` missing), and counts
//! failures afresh after a day.

use std::ffi::c_void;
use std::io;
use std::ptr::{null, null_mut};
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{ERROR_SERVICE_ALREADY_RUNNING, ERROR_SERVICE_DOES_NOT_EXIST, ERROR_SERVICE_EXISTS, ERROR_SERVICE_NOT_ACTIVE};
use windows_sys::Win32::System::Services::{
    ChangeServiceConfig2W, ChangeServiceConfigW, CloseServiceHandle, ControlService, CreateServiceW, DeleteService, OpenSCManagerW, OpenServiceW, QueryServiceStatusEx, StartServiceW, SC_ACTION,
    SC_ACTION_RESTART, SC_HANDLE, SC_MANAGER_ALL_ACCESS, SC_MANAGER_CONNECT, SC_STATUS_PROCESS_INFO, SERVICE_ALL_ACCESS, SERVICE_AUTO_START, SERVICE_CONFIG_DESCRIPTION, SERVICE_CONFIG_FAILURE_ACTIONS,
    SERVICE_CONFIG_FAILURE_ACTIONS_FLAG, SERVICE_CONFIG_REQUIRED_PRIVILEGES_INFO, SERVICE_CONFIG_SERVICE_SID_INFO, SERVICE_CONTROL_STOP, SERVICE_DESCRIPTIONW, SERVICE_ERROR_NORMAL,
    SERVICE_FAILURE_ACTIONSW, SERVICE_FAILURE_ACTIONS_FLAG, SERVICE_QUERY_STATUS, SERVICE_REQUIRED_PRIVILEGES_INFOW, SERVICE_RUNNING, SERVICE_SID_INFO, SERVICE_SID_TYPE_UNRESTRICTED, SERVICE_STATUS,
    SERVICE_STATUS_PROCESS, SERVICE_STOPPED, SERVICE_STOP_PENDING, SERVICE_WIN32_OWN_PROCESS,
};
use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE};

use super::{wide, Handle};
use crate::constants::{SERVICE_DISPLAY, SERVICE_NAME};
use crate::log::Logger;

pub const DESCRIPTION: &str = "Keeps this machine reachable through Cophyla at its sign-in and lock screens, for the user who set it up. Runs with no privileges beyond that user's.";
/// The only privilege the service keeps.
const PRIVILEGES: &str = "SeChangeNotifyPrivilege";
/// Restart after 5 s, 30 s and 60 s; failures are counted again after a day.
const RESTARTS_MS: [u32; 3] = [5_000, 30_000, 60_000];
const RESET_SECS: u32 = 24 * 60 * 60;
/// `ERROR_SERVICE_CANNOT_ACCEPT_CTRL`: stopping, starting, or not yet able to take a stop.
const ERROR_SERVICE_CANNOT_ACCEPT_CTRL: i32 = 1061;
/// `ERROR_SERVICE_MARKED_FOR_DELETE`
const ERROR_SERVICE_MARKED_FOR_DELETE: i32 = 1072;

/// The virtual account, `NT SERVICE\CophylaDoor`.
pub fn account() -> String {
    format!("NT SERVICE\\{SERVICE_NAME}")
}

/// An SCM handle, closed when dropped.
pub struct Sc(SC_HANDLE);

impl Drop for Sc {
    fn drop(&mut self) {
        // SAFETY: owned and closed once.
        unsafe { CloseServiceHandle(self.0) };
    }
}

pub fn manager(access: u32) -> io::Result<Sc> {
    // SAFETY: the local machine's active database.
    let h = unsafe { OpenSCManagerW(null(), null(), access) };
    if h.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(Sc(h))
}

/// The service, or `None` when it is not installed.
pub fn open(manager: &Sc, access: u32) -> io::Result<Option<Sc>> {
    let name = wide(SERVICE_NAME);
    // SAFETY: a NUL-terminated name.
    let h = unsafe { OpenServiceW(manager.0, name.as_ptr(), access) };
    if h.is_null() {
        let e = io::Error::last_os_error();
        return if e.raw_os_error() == Some(ERROR_SERVICE_DOES_NOT_EXIST as i32) { Ok(None) } else { Err(e) };
    }
    Ok(Some(Sc(h)))
}

pub fn status(service: &Sc) -> io::Result<SERVICE_STATUS_PROCESS> {
    // SAFETY: a struct of the size given.
    unsafe {
        let mut st: SERVICE_STATUS_PROCESS = std::mem::zeroed();
        let mut needed = 0;
        if QueryServiceStatusEx(service.0, SC_STATUS_PROCESS_INFO, (&mut st as *mut SERVICE_STATUS_PROCESS).cast(), std::mem::size_of::<SERVICE_STATUS_PROCESS>() as u32, &mut needed) == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(st)
    }
}

/// `status`'s question, which takes no elevation: the service's status, if it is installed.
pub fn query_installed() -> io::Result<Option<SERVICE_STATUS_PROCESS>> {
    let m = manager(SC_MANAGER_CONNECT)?;
    match open(&m, SERVICE_QUERY_STATUS)? {
        Some(s) => status(&s).map(Some),
        None => Ok(None),
    }
}

/// Stops the service and waits up to `wait` for it; a service process still there after that
/// is ended, so its files can be replaced or removed. Whether it stopped.
pub fn stop(service: &Sc, wait: Duration, log: &Logger) -> io::Result<bool> {
    let st = status(service)?;
    if st.dwCurrentState == SERVICE_STOPPED {
        return Ok(true);
    }
    if st.dwCurrentState != SERVICE_STOP_PENDING {
        // SAFETY: a plain status struct out.
        let mut out: SERVICE_STATUS = unsafe { std::mem::zeroed() };
        if unsafe { ControlService(service.0, SERVICE_CONTROL_STOP, &mut out) } == 0 {
            let e = io::Error::last_os_error();
            let code = e.raw_os_error().unwrap_or(0);
            if code != ERROR_SERVICE_NOT_ACTIVE as i32 && code != ERROR_SERVICE_CANNOT_ACCEPT_CTRL {
                return Err(e);
            }
        }
        log.log("asked the service to stop");
    }
    let until = Instant::now() + wait;
    let mut last = st;
    while Instant::now() < until {
        last = status(service)?;
        if last.dwCurrentState == SERVICE_STOPPED {
            return Ok(true);
        }
        thread::sleep(Duration::from_millis(250));
    }
    if last.dwProcessId != 0 {
        log.log(format!("the service did not stop within {} s: ending its process {}", wait.as_secs(), last.dwProcessId));
        // SAFETY: a process handle owned here.
        unsafe {
            if let Some(p) = Handle::new(OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, last.dwProcessId)) {
                TerminateProcess(p.raw(), 1);
                WaitForSingleObject(p.raw(), 5_000);
            }
        }
    }
    Ok(status(service)?.dwCurrentState == SERVICE_STOPPED)
}

/// Creates the service, or brings an existing one's configuration to this one.
pub fn create_or_update(manager: &Sc, binary: &str) -> io::Result<Sc> {
    let (name, display, bin, acct) = (wide(SERVICE_NAME), wide(SERVICE_DISPLAY), wide(binary), wide(account()));
    // SAFETY: NUL-terminated strings that outlive the calls; no password, as a virtual account takes none.
    unsafe {
        let h = CreateServiceW(
            manager.0,
            name.as_ptr(),
            display.as_ptr(),
            SERVICE_ALL_ACCESS,
            SERVICE_WIN32_OWN_PROCESS,
            SERVICE_AUTO_START,
            SERVICE_ERROR_NORMAL,
            bin.as_ptr(),
            null(),
            null_mut(),
            null(),
            acct.as_ptr(),
            null(),
        );
        if !h.is_null() {
            return Ok(Sc(h));
        }
        let e = io::Error::last_os_error();
        match e.raw_os_error() {
            Some(code) if code == ERROR_SERVICE_EXISTS as i32 => {}
            Some(ERROR_SERVICE_MARKED_FOR_DELETE) => return Err(io::Error::other("the service is marked for deletion: close the Services console and try again")),
            _ => return Err(e),
        }
        let service = open(manager, SERVICE_ALL_ACCESS)?.ok_or_else(|| io::Error::other("the service exists and cannot be opened"))?;
        if ChangeServiceConfigW(service.0, SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL, bin.as_ptr(), null(), null_mut(), null(), acct.as_ptr(), null(), display.as_ptr()) == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(service)
    }
}

fn config2(service: &Sc, level: u32, info: *const c_void, what: &str) -> io::Result<()> {
    // SAFETY: `info` points to the struct `level` names, alive across the call.
    if unsafe { ChangeServiceConfig2W(service.0, level, info) } == 0 {
        let e = io::Error::last_os_error();
        return Err(io::Error::new(e.kind(), format!("{what}: {e}")));
    }
    Ok(())
}

/// The description, the failure actions, the privileges and the service SID.
pub fn configure(service: &Sc) -> io::Result<()> {
    let mut description = wide(DESCRIPTION);
    let d = SERVICE_DESCRIPTIONW { lpDescription: description.as_mut_ptr() };
    config2(service, SERVICE_CONFIG_DESCRIPTION, (&d as *const SERVICE_DESCRIPTIONW).cast(), "description")?;

    let mut actions = RESTARTS_MS.map(|delay| SC_ACTION { Type: SC_ACTION_RESTART, Delay: delay });
    let fa = SERVICE_FAILURE_ACTIONSW { dwResetPeriod: RESET_SECS, lpRebootMsg: null_mut(), lpCommand: null_mut(), cActions: actions.len() as u32, lpsaActions: actions.as_mut_ptr() };
    config2(service, SERVICE_CONFIG_FAILURE_ACTIONS, (&fa as *const SERVICE_FAILURE_ACTIONSW).cast(), "failure actions")?;
    let flag = SERVICE_FAILURE_ACTIONS_FLAG { fFailureActionsOnNonCrashFailures: 1 };
    config2(service, SERVICE_CONFIG_FAILURE_ACTIONS_FLAG, (&flag as *const SERVICE_FAILURE_ACTIONS_FLAG).cast(), "failure actions on errors")?;

    // a multi-string: the one name, its NUL, and the list's NUL
    let mut privileges = wide(PRIVILEGES);
    privileges.push(0);
    let p = SERVICE_REQUIRED_PRIVILEGES_INFOW { pmszRequiredPrivileges: privileges.as_mut_ptr() };
    config2(service, SERVICE_CONFIG_REQUIRED_PRIVILEGES_INFO, (&p as *const SERVICE_REQUIRED_PRIVILEGES_INFOW).cast(), "required privileges")?;

    let sid = SERVICE_SID_INFO { dwServiceSidType: SERVICE_SID_TYPE_UNRESTRICTED };
    config2(service, SERVICE_CONFIG_SERVICE_SID_INFO, (&sid as *const SERVICE_SID_INFO).cast(), "service SID")
}

/// Starts the service and waits up to `wait` for it to run; an error says how it ended.
pub fn start(service: &Sc, wait: Duration) -> io::Result<SERVICE_STATUS_PROCESS> {
    // SAFETY: no arguments.
    if unsafe { StartServiceW(service.0, 0, null()) } == 0 {
        let e = io::Error::last_os_error();
        if e.raw_os_error() != Some(ERROR_SERVICE_ALREADY_RUNNING as i32) {
            return Err(e);
        }
    }
    let until = Instant::now() + wait;
    loop {
        let st = status(service)?;
        if st.dwCurrentState == SERVICE_RUNNING {
            return Ok(st);
        }
        if st.dwCurrentState == SERVICE_STOPPED {
            return Err(io::Error::other(format!("the service stopped as it started (exit {}, its own code {})", st.dwWin32ExitCode, st.dwServiceSpecificExitCode)));
        }
        if Instant::now() >= until {
            return Err(io::Error::other(format!("the service did not reach running within {} s", wait.as_secs())));
        }
        thread::sleep(Duration::from_millis(250));
    }
}

/// Marks the service for deletion; the SCM removes it once every handle to it is closed.
pub fn delete(service: &Sc) -> io::Result<()> {
    // SAFETY: an open service handle with DELETE access.
    if unsafe { DeleteService(service.0) } == 0 {
        let e = io::Error::last_os_error();
        if e.raw_os_error() != Some(ERROR_SERVICE_MARKED_FOR_DELETE) {
            return Err(e);
        }
    }
    Ok(())
}

/// The full access the install and the uninstall open the SCM with.
pub const MANAGER_ALL: u32 = SC_MANAGER_ALL_ACCESS;
pub const SERVICE_ALL: u32 = SERVICE_ALL_ACCESS;
