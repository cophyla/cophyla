//! The console and the power line as Windows tells the service, and the power request the
//! door holds. The console comes from Terminal Services: the session attached to the physical
//! console, its user name and its lock flag, mapped by `console::from_session`. A virtual
//! account may not be allowed to ask; then the console counts as `active`, which keeps the
//! door from serving, and that is logged once. The power line comes from
//! GetSystemPowerStatus, read through `power::on_ac`.

use std::io;
use std::ptr::null_mut;

use windows_sys::Win32::System::Power::{GetSystemPowerStatus, PowerClearRequest, PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest, SYSTEM_POWER_STATUS};
use windows_sys::Win32::System::RemoteDesktop::{WTSFreeMemory, WTSGetActiveConsoleSessionId, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW, WTS_CURRENT_SERVER_HANDLE};
use windows_sys::Win32::System::Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0};

use super::{wide, Handle};
use crate::console::{self, Console, NO_CONSOLE_SESSION};
use crate::log::Logger;
use crate::power;

/// `POWER_REQUEST_CONTEXT_VERSION`, which windows-sys keeps under SystemServices.
const POWER_REQUEST_CONTEXT_VERSION: u32 = 0;
/// What `powercfg /requests` shows for the door.
const REASON: &str = "Cophyla keeps this machine reachable at its sign-in screen";

fn query_console() -> io::Result<Console> {
    // SAFETY: the buffer WTS allocates is read within its size and freed once.
    unsafe {
        let id = WTSGetActiveConsoleSessionId();
        if id == NO_CONSOLE_SESSION {
            return Ok(console::from_session(None));
        }
        let mut buf = null_mut();
        let mut bytes = 0u32;
        if WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, id, WTSSessionInfoEx, &mut buf, &mut bytes) == 0 {
            return Err(io::Error::last_os_error());
        }
        let read = if buf.is_null() || (bytes as usize) < std::mem::size_of::<WTSINFOEXW>() {
            Err(io::Error::other("a short WTSSessionInfoEx answer"))
        } else {
            let info = &*(buf as *const WTSINFOEXW);
            if info.Level != 1 {
                Err(io::Error::other(format!("WTSSessionInfoEx level {}", info.Level)))
            } else {
                let level1 = info.Data.WTSInfoExLevel1;
                Ok(console::from_session(Some((level1.UserName[0] != 0, level1.SessionFlags))))
            }
        };
        if !buf.is_null() {
            WTSFreeMemory(buf.cast());
        }
        read
    }
}

/// The console's state, or `active` when Windows will not say; `warned` keeps the log to one line.
pub fn console_state(warned: &mut bool, log: &Logger) -> Console {
    match query_console() {
        Ok(c) => c,
        Err(e) => {
            if !*warned {
                *warned = true;
                log.log(format!("console: Terminal Services did not answer ({e}); taking the console as active, so the door does not serve"));
            }
            Console::Active
        }
    }
}

/// Whether the machine is on AC, or `None` when Windows will not say.
pub fn ac() -> Option<bool> {
    // SAFETY: a plain struct filled by the call.
    unsafe {
        let mut status: SYSTEM_POWER_STATUS = std::mem::zeroed();
        (GetSystemPowerStatus(&mut status) != 0).then(|| power::on_ac(status.ACLineStatus, status.BatteryFlag))
    }
}

/// The system-required power request, created the first time it is needed and set or
/// cleared as the rule turns. With `real` false (`--no-power`) it only logs.
pub struct PowerHold {
    real: bool,
    held: bool,
    request: Option<Handle>,
    /// The reason string the request was made with, kept for the request's life.
    reason: Vec<u16>,
}

impl PowerHold {
    pub fn new(real: bool) -> PowerHold {
        PowerHold { real, held: false, request: None, reason: wide(REASON) }
    }

    pub fn set(&mut self, hold: bool, why: &str, log: &Logger) {
        if hold == self.held {
            return;
        }
        self.held = hold;
        if !self.real {
            log.log(format!("power: would {} the system-required request ({why}; --no-power)", if hold { "set" } else { "clear" }));
            return;
        }
        if hold {
            if self.request.is_none() {
                let context = REASON_CONTEXT {
                    Version: POWER_REQUEST_CONTEXT_VERSION,
                    Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
                    Reason: REASON_CONTEXT_0 { SimpleReasonString: self.reason.as_mut_ptr() },
                };
                // SAFETY: the context and its string live across the call.
                match Handle::new(unsafe { PowerCreateRequest(&context) }) {
                    Some(h) => self.request = Some(h),
                    None => {
                        log.log(format!("power: cannot create a power request: {}", io::Error::last_os_error()));
                        return;
                    }
                }
            }
            let request = self.request.as_ref().expect("made above");
            // SAFETY: a power request handle owned here.
            if unsafe { PowerSetRequest(request.raw(), PowerRequestSystemRequired) } == 0 {
                log.log(format!("power: cannot hold the system awake: {}", io::Error::last_os_error()));
            } else {
                log.log(format!("power: holding the system awake ({why})"));
            }
        } else if let Some(request) = &self.request {
            // SAFETY: as above.
            unsafe { PowerClearRequest(request.raw(), PowerRequestSystemRequired) };
            log.log(format!("power: letting the system sleep ({why})"));
        }
    }
}

impl Drop for PowerHold {
    fn drop(&mut self) {
        if let (true, Some(request)) = (self.held, &self.request) {
            // SAFETY: as above; the handle is closed after.
            unsafe { PowerClearRequest(request.raw(), PowerRequestSystemRequired) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_console_and_the_power_line_can_be_asked() {
        // what they answer depends on the machine (a CI runner may have no console user, and
        // may not be let ask); that they answer without failing the process is what is tested
        let log = Logger::buffer(false);
        let mut warned = false;
        let state = console_state(&mut warned, &log);
        assert!(!warned || state == Console::Active);
        assert!(ac().is_some());
        let mut hold = PowerHold::new(false);
        hold.set(true, "test", &log);
        hold.set(true, "test", &log);
        hold.set(false, "test", &log);
    }
}
