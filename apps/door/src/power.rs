//! When the door keeps the machine awake. The child says what it wants (`power.want`: it is
//! ready to serve, or a stream is running); the shim knows the console and the power line, and
//! holds a system-required power request while
//!   streaming || (ready && console != active && on AC)
//! so a running stream is never cut by sleep, and an idle door keeps a plugged-in machine
//! reachable at its sign-in screen without draining a battery. Platform-free; the request
//! itself is `win::session::PowerHold`.

use crate::console::Console;

/// What the child last asked for; both false until it says otherwise, and again once it exits.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Want {
    pub ready: bool,
    pub streaming: bool,
}

/// Whether the system is held awake.
pub fn hold(want: Want, console: Console, ac: bool) -> bool {
    want.streaming || (want.ready && console != Console::Active && ac)
}

/// `ACLineStatus` 1 is AC. 255 is unknown, which with `BatteryFlag` 128 (no system battery) is
/// a desktop, so AC too; anything else is a battery.
pub fn on_ac(ac_line_status: u8, battery_flag: u8) -> bool {
    ac_line_status == 1 || (ac_line_status == 255 && battery_flag & 128 != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDLE: Want = Want { ready: false, streaming: false };
    const READY: Want = Want { ready: true, streaming: false };
    const STREAMING: Want = Want { ready: false, streaming: true };

    #[test]
    fn a_stream_holds_whatever_the_console_or_the_power() {
        for console in [Console::Signin, Console::Locked, Console::Active] {
            for ac in [true, false] {
                assert!(hold(STREAMING, console, ac));
                assert!(hold(Want { ready: true, streaming: true }, console, ac));
            }
        }
    }

    #[test]
    fn a_ready_door_holds_on_ac_while_no_one_is_at_the_console() {
        assert!(hold(READY, Console::Signin, true));
        assert!(hold(READY, Console::Locked, true));
        assert!(!hold(READY, Console::Active, true));
        assert!(!hold(READY, Console::Signin, false));
        assert!(!hold(READY, Console::Locked, false));
    }

    #[test]
    fn an_idle_door_never_holds() {
        for console in [Console::Signin, Console::Locked, Console::Active] {
            assert!(!hold(IDLE, console, true));
            assert!(!hold(IDLE, console, false));
        }
    }

    #[test]
    fn the_power_line() {
        assert!(on_ac(1, 0));
        assert!(on_ac(1, 128));
        assert!(on_ac(255, 128));
        assert!(on_ac(255, 128 | 8));
        assert!(!on_ac(255, 1));
        // every flag but "no system battery"
        assert!(!on_ac(255, 0x7f));
        assert!(!on_ac(0, 1));
        assert!(!on_ac(0, 128));
    }
}
