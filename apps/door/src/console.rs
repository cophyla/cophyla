//! The physical console's state, as the child is told it: `signin` (no one is signed in at the
//! console: the sign-in screen, or the console has no session at all), `locked` (someone is,
//! behind the lock screen) or `active` (someone is using it). The door serves only when it is
//! not `active`, so anything unclear reads as `active`. The service asks Terminal Services
//! (`win::session`); the console mode reads it off stdin. What a WTS answer means is decided
//! here, platform-free.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Console {
    Signin,
    Locked,
    Active,
}

impl Console {
    pub fn as_str(self) -> &'static str {
        match self {
            Console::Signin => "signin",
            Console::Locked => "locked",
            Console::Active => "active",
        }
    }

    pub fn parse(s: &str) -> Option<Console> {
        match s {
            "signin" => Some(Console::Signin),
            "locked" => Some(Console::Locked),
            "active" => Some(Console::Active),
            _ => None,
        }
    }
}

/// What `WTSGetActiveConsoleSessionId` answers when no session is attached to the console.
pub const NO_CONSOLE_SESSION: u32 = 0xFFFF_FFFF;
/// `WTSINFOEX_LEVEL1.SessionFlags` for a locked session. Windows 7 had this and UNLOCK swapped;
/// the door needs Windows 10.
pub const WTS_SESSIONSTATE_LOCK: i32 = 0;

/// The console's state from its session: `None` for no session at the console, otherwise
/// whether a user name is set on it and its `SessionFlags`.
pub fn from_session(session: Option<(bool, i32)>) -> Console {
    match session {
        None => Console::Signin,
        Some((false, _)) => Console::Signin,
        Some((true, WTS_SESSIONSTATE_LOCK)) => Console::Locked,
        Some((true, _)) => Console::Active,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_session_or_no_user_is_the_sign_in_screen() {
        assert_eq!(from_session(None), Console::Signin);
        assert_eq!(from_session(Some((false, 1))), Console::Signin);
        assert_eq!(from_session(Some((false, WTS_SESSIONSTATE_LOCK))), Console::Signin);
        assert_eq!(from_session(Some((false, -1))), Console::Signin);
    }

    #[test]
    fn a_user_is_locked_out_or_active() {
        assert_eq!(from_session(Some((true, WTS_SESSIONSTATE_LOCK))), Console::Locked);
        assert_eq!(from_session(Some((true, 1))), Console::Active);
        // WTS_SESSIONSTATE_UNKNOWN: in doubt the console is in use, and the door does not serve
        assert_eq!(from_session(Some((true, -1))), Console::Active);
    }

    #[test]
    fn names_round_trip() {
        for c in [Console::Signin, Console::Locked, Console::Active] {
            assert_eq!(Console::parse(c.as_str()), Some(c));
        }
        assert_eq!(Console::parse("Active"), None);
    }
}
