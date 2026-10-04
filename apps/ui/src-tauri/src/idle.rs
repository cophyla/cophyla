// How long since the last keyboard or mouse input on this machine, for whether anyone is at
// it: an ask is toasted only where someone is (packages/viewhost/src/notify.ts). None where
// the system cannot tell, and the host then toasts as it always did.
//
// Windows: `GetLastInputInfo` against `GetTickCount`, both 32-bit milliseconds since boot, so
// the difference wraps with them. macOS: `CGEventSourceSecondsSinceLastEventType` over the
// combined session state and every input event type. Linux has no one answer across X11 and
// the Wayland compositors, so it says nothing yet.

#[cfg(windows)]
pub fn idle_ms() -> Option<u64> {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    // SAFETY: `info` is a valid LASTINPUTINFO with its size set, as the call requires.
    if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        return None;
    }
    // SAFETY: no arguments, no state.
    let now = unsafe { GetTickCount() };
    Some(u64::from(now.wrapping_sub(info.dwTime)))
}

#[cfg(target_os = "macos")]
pub fn idle_ms() -> Option<u64> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(source: i32, event_type: u32) -> f64;
    }
    /// kCGEventSourceStateCombinedSessionState
    const COMBINED_SESSION_STATE: i32 = 0;
    /// kCGAnyInputEventType
    const ANY_INPUT_EVENT: u32 = !0;
    // SAFETY: a pure query on two plain values.
    let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT) };
    (seconds.is_finite() && seconds >= 0.0).then(|| (seconds * 1000.0) as u64)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn idle_ms() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn windows_tells_how_long_since_input_within_a_tick_count() {
        // a CI runner's session may have no input to tell of; where there is an answer it is
        // a 32-bit tick difference
        if let Some(ms) = super::idle_ms() {
            assert!(ms <= u64::from(u32::MAX));
        }
    }
}
