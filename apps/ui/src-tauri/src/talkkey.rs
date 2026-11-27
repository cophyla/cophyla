// The talk key's own timeline: when the user really pressed it and let it go, carried to the
// host page with each `voice:ptt` as `at` (milliseconds since the epoch), so an utterance is
// cut from the user's action and never from when the shell got round to it. On Windows the
// shortcut's press arrives as WM_HOTKEY on the UI thread, and its release from the global-shortcut
// plugin's poller (the key's state read every 50 ms on a thread of its own): a press handled
// late, on a busy UI thread, arrived with its release, and the page heard an utterance of no
// length. So a low-level keyboard hook (WH_KEYBOARD_LL; Raw Input is out, tao already owns the
// process's keyboard registration) runs on a thread of its own, above normal priority, with its
// own message loop, and notes the accelerator's real down and up with the times the system gave
// them. The hotkey stays registered, which keeps the combination from other apps: its press takes
// its time from the hook, or the message's own time (`GetMessageTime`) when the hook saw nothing
// (an elevated window in front, whose keys a hook does not see); its release comes from the hook
// with its time, and the plugin's poller is the fallback, waited past for a moment when the hook
// saw the press. Elsewhere the press and release are timed as the plugin hands them over.
// `Timeline` is the plain logic of the three sources, `Matcher` the hook's reading of the keys;
// both are tested without a keyboard.

use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
use tokio::sync::mpsc;

/// The event the host page hears the talk key on.
pub const EVENT_PTT: &str = "voice:ptt";
/// How far apart the hook's press and the hotkey's may be and still be one press.
const SAME_PRESS_MS: u64 = 1000;
/// How long a release the poller saw waits for the hook's, when the hook saw the press.
const GRACE: Duration = Duration::from_millis(200);

/// What the host page hears: the key down or up, and when the user did it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Ptt {
    pub down: bool,
    pub at: u64,
}

/// One thing heard of the talk key, its time in milliseconds since the epoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Input {
    /// The hook saw the accelerator go down.
    HookDown(u64),
    /// The hook saw its key come up after that.
    HookUp(u64),
    /// The hotkey's press was handled; its message's time.
    Pressed(u64),
    /// The plugin's poller saw the key up.
    Released(u64),
    /// A poller's release has waited long enough for the hook's.
    Settle,
}

/// The talk key's state between its three sources, the hook, the hotkey and the poller.
#[derive(Debug, Default)]
pub struct Timeline {
    /// The hook's last press not yet the hotkey's, and its release when that came first.
    hook_down: Option<u64>,
    hook_up: Option<u64>,
    /// A press told the page and not yet released: whether the hook saw it.
    pressed: Option<bool>,
    /// The poller's release, waiting for the hook's.
    poller_up: Option<u64>,
}

impl Timeline {
    /// What one input tells the page, and whether a `Settle` should follow after the grace.
    pub fn input(&mut self, input: Input) -> (Vec<Ptt>, bool) {
        let mut out = Vec::new();
        let mut settle = false;
        match input {
            Input::HookDown(at) => {
                self.hook_down = Some(at);
                self.hook_up = None;
            }
            Input::HookUp(at) => {
                if self.pressed.take().is_some() {
                    out.push(Ptt { down: false, at });
                    self.poller_up = None;
                } else if self.hook_down.is_some() {
                    self.hook_up = Some(at);
                }
            }
            Input::Pressed(message_at) => {
                // a press still out lost its release somewhere: it ends where this one begins
                if self.pressed.take().is_some() {
                    out.push(Ptt { down: false, at: self.poller_up.unwrap_or(message_at) });
                }
                let hooked = self.hook_down.take().filter(|d| d.abs_diff(message_at) <= SAME_PRESS_MS);
                out.push(Ptt { down: true, at: hooked.unwrap_or(message_at) });
                match (hooked, self.hook_up.take()) {
                    // handled after the key was already up: the press and its release, as they were
                    (Some(_), Some(up)) => out.push(Ptt { down: false, at: up }),
                    (hooked, _) => self.pressed = Some(hooked.is_some()),
                }
                self.poller_up = None;
            }
            Input::Released(at) => match self.pressed {
                Some(false) => {
                    self.pressed = None;
                    out.push(Ptt { down: false, at });
                }
                Some(true) => {
                    self.poller_up = Some(at);
                    settle = true;
                }
                None => {}
            },
            Input::Settle => {
                if let (Some(_), Some(at)) = (self.pressed, self.poller_up) {
                    self.pressed = None;
                    self.poller_up = None;
                    out.push(Ptt { down: false, at });
                }
            }
        }
        (out, settle)
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A time of the system's tick count (milliseconds since boot, wrapping at 2^32) as milliseconds
/// since the epoch, given both clocks now; one in the future or over an hour old is taken as now.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn epoch_of_tick(tick: u32, now_tick: u32, now_epoch: u64) -> u64 {
    let age = u64::from(now_tick.wrapping_sub(tick));
    if age > 3_600_000 {
        return now_epoch;
    }
    now_epoch.saturating_sub(age)
}

static INPUTS: OnceLock<mpsc::UnboundedSender<Input>> = OnceLock::new();

/// Hands an input to the timeline; nothing before `start`.
pub fn input(input: Input) {
    if let Some(tx) = INPUTS.get() {
        let _ = tx.send(input);
    }
}

/// Runs the timeline on the async runtime: what it says goes to the host page (`page_event`).
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    if INPUTS.set(tx.clone()).is_err() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut timeline = Timeline::default();
        while let Some(i) = rx.recv().await {
            let (out, settle) = timeline.input(i);
            for ptt in out {
                crate::cophylad::page_event(&app, EVENT_PTT, ptt);
            }
            if settle {
                let tx = tx.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(GRACE).await;
                    let _ = tx.send(Input::Settle);
                });
            }
        }
    });
}

/// The time of a press the plugin handed over: on Windows the WM_HOTKEY message's own (the
/// plugin calls its handler while that message is dispatched, on the UI thread).
pub fn press_time() -> u64 {
    #[cfg(windows)]
    {
        use windows::Win32::System::SystemInformation::GetTickCount;
        use windows::Win32::UI::WindowsAndMessaging::GetMessageTime;
        // SAFETY: plain reads of this thread's last message's time and the tick count.
        let (message, now) = unsafe { (GetMessageTime() as u32, GetTickCount()) };
        epoch_of_tick(message, now, now_ms())
    }
    #[cfg(not(windows))]
    now_ms()
}

/// The accelerator as the hook reads keys: its modifiers (`MOD_*` below) and its key's virtual-key code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Accelerator {
    pub mods: u8,
    pub vk: u32,
}

pub const MOD_CONTROL: u8 = 1;
pub const MOD_ALT: u8 = 2;
pub const MOD_SHIFT: u8 = 4;
pub const MOD_WIN: u8 = 8;

impl Accelerator {
    /// The shortcut's modifiers and key, for a key the hotkey registration knows.
    pub fn of(shortcut: &Shortcut) -> Option<Accelerator> {
        let mut mods = 0;
        for (m, bit) in [(Modifiers::CONTROL, MOD_CONTROL), (Modifiers::ALT, MOD_ALT), (Modifiers::SHIFT, MOD_SHIFT)] {
            if shortcut.mods.contains(m) {
                mods |= bit;
            }
        }
        if shortcut.mods.intersects(Modifiers::SUPER | Modifiers::META) {
            mods |= MOD_WIN;
        }
        Some(Accelerator { mods, vk: vk_of(shortcut.key)? })
    }

    fn pack(self) -> u64 {
        (u64::from(self.mods) << 32) | u64::from(self.vk)
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    fn unpack(packed: u64) -> Option<Accelerator> {
        (packed != 0).then(|| Accelerator { mods: (packed >> 32) as u8, vk: packed as u32 })
    }
}

/// A key's Windows virtual-key code: the keys the global-shortcut plugin registers on Windows,
/// with the codes it gives them.
pub fn vk_of(code: Code) -> Option<u32> {
    use Code::*;
    let runs: [(&[Code], u32); 4] = [
        (&[KeyA, KeyB, KeyC, KeyD, KeyE, KeyF, KeyG, KeyH, KeyI, KeyJ, KeyK, KeyL, KeyM, KeyN, KeyO, KeyP, KeyQ, KeyR, KeyS, KeyT, KeyU, KeyV, KeyW, KeyX, KeyY, KeyZ], 0x41),
        (&[Digit0, Digit1, Digit2, Digit3, Digit4, Digit5, Digit6, Digit7, Digit8, Digit9], 0x30),
        (&[F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12, F13, F14, F15, F16, F17, F18, F19, F20, F21, F22, F23, F24], 0x70),
        (&[Numpad0, Numpad1, Numpad2, Numpad3, Numpad4, Numpad5, Numpad6, Numpad7, Numpad8, Numpad9], 0x60),
    ];
    for (run, first) in runs {
        if let Some(i) = run.iter().position(|c| *c == code) {
            return Some(first + i as u32);
        }
    }
    Some(match code {
        Equal => 0xBB,
        Comma => 0xBC,
        Minus => 0xBD,
        Period => 0xBE,
        Semicolon => 0xBA,
        Slash => 0xBF,
        Backquote => 0xC0,
        BracketLeft => 0xDB,
        Backslash => 0xDC,
        BracketRight => 0xDD,
        Quote => 0xDE,
        Backspace => 0x08,
        Tab => 0x09,
        Space => 0x20,
        Enter | NumpadEnter => 0x0D,
        CapsLock => 0x14,
        Escape => 0x1B,
        PageUp => 0x21,
        PageDown => 0x22,
        End => 0x23,
        Home => 0x24,
        ArrowLeft => 0x25,
        ArrowUp => 0x26,
        ArrowRight => 0x27,
        ArrowDown => 0x28,
        PrintScreen => 0x2C,
        Insert => 0x2D,
        Delete => 0x2E,
        NumLock => 0x90,
        ScrollLock => 0x91,
        NumpadAdd => 0x6B,
        NumpadDecimal => 0x6E,
        NumpadDivide => 0x6F,
        NumpadMultiply => 0x6A,
        NumpadSubtract => 0x6D,
        // the plugin's own choice for a key Windows has no code of
        NumpadEqual => 0x45,
        AudioVolumeMute => 0xAD,
        AudioVolumeDown => 0xAE,
        AudioVolumeUp => 0xAF,
        MediaTrackNext => 0xB0,
        MediaTrackPrevious => 0xB1,
        MediaStop => 0xB2,
        MediaPlayPause => 0xB3,
        MediaPlay => 0xFA,
        MediaPause | Pause => 0x13,
        _ => return None,
    })
}

/// Each modifier key's side, as a bit: the hook sees the left and right ones apart.
#[cfg_attr(not(windows), allow(dead_code))]
fn side_of(vk: u32) -> Option<u8> {
    Some(match vk {
        0xA2 | 0x11 => 0x01, // left Control, or Control unsided
        0xA3 => 0x02,
        0xA4 | 0x12 => 0x04, // left Alt, or Alt unsided
        0xA5 => 0x08,
        0xA0 | 0x10 => 0x10, // left Shift, or Shift unsided
        0xA1 => 0x20,
        0x5B => 0x40,
        0x5C => 0x80,
        _ => return None,
    })
}

/// The modifiers the sides held make.
#[cfg_attr(not(windows), allow(dead_code))]
fn mods_of(sides: u8) -> u8 {
    let mut mods = 0;
    for (pair, bit) in [(0x03, MOD_CONTROL), (0x0C, MOD_ALT), (0x30, MOD_SHIFT), (0xC0, MOD_WIN)] {
        if sides & pair != 0 {
            mods |= bit;
        }
    }
    mods
}

/// The hook's reading of the keys: the modifiers held, and the accelerator's key going down with
/// exactly its modifiers (as the hotkey registration takes it) and coming up again. A key held
/// repeats its down, which is not a press; a down after a long quiet is one, though the up
/// before it was missed.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Default)]
pub struct Matcher {
    sides: u8,
    accelerator: Option<Accelerator>,
    key_down: Option<u32>,
    active: bool,
}

/// How long a key's downs may be apart and still be its repeats.
#[cfg_attr(not(windows), allow(dead_code))]
const REPEAT_GAP_MS: u32 = 1500;

#[cfg_attr(not(windows), allow(dead_code))]
impl Matcher {
    /// The modifiers held when the hook starts, by their sides' virtual-key codes.
    pub fn held(&mut self, sides: impl IntoIterator<Item = u32>) {
        for vk in sides {
            if let Some(bit) = side_of(vk) {
                self.sides |= bit;
            }
        }
    }

    /// One key event: `Some(true)` when the accelerator went down, `Some(false)` when it came up.
    pub fn key(&mut self, accelerator: Accelerator, vk: u32, down: bool, tick: u32) -> Option<bool> {
        if self.accelerator != Some(accelerator) {
            self.accelerator = Some(accelerator);
            self.key_down = None;
            self.active = false;
        }
        if let Some(bit) = side_of(vk) {
            if down {
                self.sides |= bit;
            } else {
                self.sides &= !bit;
            }
            return None;
        }
        if vk != accelerator.vk {
            return None;
        }
        if down {
            let repeat = self.key_down.is_some_and(|last| tick.wrapping_sub(last) < REPEAT_GAP_MS);
            self.key_down = Some(tick);
            if repeat {
                return None;
            }
            self.active = mods_of(self.sides) == accelerator.mods;
            return self.active.then_some(true);
        }
        self.key_down = None;
        std::mem::take(&mut self.active).then_some(false)
    }
}

/// The accelerator the hook reads keys for, packed; 0 for none.
static ACCELERATOR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The talk key registered now, or none: the hook reads its keys from now on, started once a
/// key is set (Windows only).
pub fn set(shortcut: Option<&Shortcut>) {
    let accelerator = shortcut.and_then(Accelerator::of);
    ACCELERATOR.store(accelerator.map_or(0, Accelerator::pack), std::sync::atomic::Ordering::Relaxed);
    #[cfg(windows)]
    if accelerator.is_some() {
        hook::start();
    }
}

#[cfg(windows)]
mod hook {
    use std::cell::RefCell;
    use std::sync::Once;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_ABOVE_NORMAL};
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    use windows::Win32::UI::WindowsAndMessaging::{CallNextHookEx, GetMessageW, SetWindowsHookExW, HC_ACTION, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP};

    use super::{epoch_of_tick, input, now_ms, Accelerator, Input, Matcher, ACCELERATOR};

    thread_local! {
        static MATCHER: RefCell<Matcher> = RefCell::new(Matcher::default());
    }

    /// Starts the hook's thread, once.
    pub fn start() {
        static STARTED: Once = Once::new();
        STARTED.call_once(|| {
            if let Err(e) = std::thread::Builder::new().name("talk-key-hook".into()).spawn(run) {
                log::warn!("talk key: the hook's thread did not start, the plugin's own timing stays: {e}");
            }
        });
    }

    fn run() {
        // SAFETY: plain calls on this thread: its priority, the modifiers' state, the hook set
        // with a procedure of this module, and the message loop the hook is called from.
        unsafe {
            if let Err(e) = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL) {
                log::debug!("talk key: the hook's thread keeps its priority: {e}");
            }
            let held: Vec<u32> = [0xA0u32, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C].into_iter().filter(|vk| GetAsyncKeyState(*vk as i32) as u16 & 0x8000 != 0).collect();
            MATCHER.with(|m| m.borrow_mut().held(held));
            let module = GetModuleHandleW(PCWSTR::null()).ok().map(HINSTANCE::from);
            if let Err(e) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keys), module, 0) {
                log::warn!("talk key: no keyboard hook, the plugin's own timing stays: {e}");
                return;
            }
            log::info!("talk key: the keyboard hook is set");
            let mut msg = MSG::default();
            // -1 is an error, 0 the loop told to end
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {}
        }
    }

    /// Every key on the desktop passes here, so it does only what it must: the accelerator's
    /// edges noted with their times and handed to the timeline, and the key passed on.
    unsafe extern "system" fn keys(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            if let Some(accelerator) = Accelerator::unpack(ACCELERATOR.load(std::sync::atomic::Ordering::Relaxed)) {
                let message = wparam.0 as u32;
                let down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
                if down || message == WM_KEYUP || message == WM_SYSKEYUP {
                    // SAFETY: for HC_ACTION the system passes a KBDLLHOOKSTRUCT for the call.
                    let key = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
                    if let Some(edge) = MATCHER.with(|m| m.borrow_mut().key(accelerator, key.vkCode, down, key.time)) {
                        // SAFETY: a plain read of the tick count.
                        let at = epoch_of_tick(key.time, unsafe { GetTickCount() }, now_ms());
                        input(if edge { Input::HookDown(at) } else { Input::HookUp(at) });
                    }
                }
            }
        }
        // SAFETY: the hook chain's next, with what this hook was given.
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(inputs: &[Input]) -> Vec<(bool, u64)> {
        let mut t = Timeline::default();
        inputs.iter().flat_map(|i| t.input(*i).0).map(|p| (p.down, p.at)).collect()
    }

    #[test]
    fn a_press_handled_late_keeps_the_times_the_hook_saw() {
        // the UI thread was busy: the hotkey's press came after the key was up again
        assert_eq!(run(&[Input::HookDown(1000), Input::HookUp(2500), Input::Pressed(1000), Input::Released(4000)]), [(true, 1000), (false, 2500)]);
        // in time: the press from the hook, the release from the hook, the poller's after it ignored
        assert_eq!(run(&[Input::HookDown(1000), Input::Pressed(1001), Input::HookUp(3000), Input::Released(3040), Input::Settle]), [(true, 1000), (false, 3000)]);
    }

    #[test]
    fn without_the_hook_the_press_is_the_messages_time_and_the_release_the_pollers() {
        assert_eq!(run(&[Input::Pressed(5000), Input::Released(6000)]), [(true, 5000), (false, 6000)]);
        // a hook press far from the hotkey's is another press, and not this one's
        assert_eq!(run(&[Input::HookDown(100), Input::Pressed(5000), Input::Released(6000)]), [(true, 5000), (false, 6000)]);
    }

    #[test]
    fn a_hook_that_misses_the_release_is_covered_by_the_poller_after_the_grace() {
        let mut t = Timeline::default();
        assert_eq!(t.input(Input::HookDown(1000)).0, []);
        assert_eq!(t.input(Input::Pressed(1000)).0, [Ptt { down: true, at: 1000 }]);
        let (out, settle) = t.input(Input::Released(2000));
        assert!(out.is_empty() && settle);
        assert_eq!(t.input(Input::Settle).0, [Ptt { down: false, at: 2000 }]);
        // nothing more: a late hook release, and another settle, say nothing
        assert_eq!(t.input(Input::HookUp(2100)).0, []);
        assert_eq!(t.input(Input::Settle).0, []);
    }

    #[test]
    fn a_press_while_one_is_out_ends_that_one_first() {
        assert_eq!(run(&[Input::Pressed(1000), Input::Pressed(9000), Input::Released(9500)]), [(true, 1000), (false, 9000), (true, 9000), (false, 9500)]);
    }

    #[test]
    fn tick_times_become_epoch_times_across_the_wrap() {
        assert_eq!(epoch_of_tick(900, 1000, 1_700_000_000_000), 1_699_999_999_900);
        // the tick count wrapped since the key went down
        assert_eq!(epoch_of_tick(u32::MAX - 49, 50, 1_700_000_000_000), 1_699_999_999_900);
        // a time ahead of now, or absurdly old, is now
        assert_eq!(epoch_of_tick(1001, 1000, 1_700_000_000_000), 1_700_000_000_000);
    }

    fn shortcut(text: &str) -> Accelerator {
        Accelerator::of(&text.parse::<Shortcut>().unwrap()).unwrap()
    }

    #[test]
    fn the_talk_keys_the_page_offers_read_as_their_modifiers_and_key() {
        assert_eq!(shortcut("Ctrl+Alt+Space"), Accelerator { mods: MOD_CONTROL | MOD_ALT, vk: 0x20 });
        assert_eq!(shortcut("Ctrl+Shift+Space"), Accelerator { mods: MOD_CONTROL | MOD_SHIFT, vk: 0x20 });
        assert_eq!(shortcut("Ctrl+Shift+F9"), Accelerator { mods: MOD_CONTROL | MOD_SHIFT, vk: 0x78 });
        assert_eq!(shortcut("Super+K"), Accelerator { mods: MOD_WIN, vk: 0x4B });
        assert_eq!(shortcut("Alt+7").vk, 0x37);
        let packed = shortcut("Ctrl+Alt+Space").pack();
        assert_eq!(Accelerator::unpack(packed), Some(shortcut("Ctrl+Alt+Space")));
        assert_eq!(Accelerator::unpack(0), None);
    }

    #[test]
    fn the_matcher_takes_the_accelerator_with_exactly_its_modifiers_and_not_its_repeats() {
        let ctrl_alt_space = shortcut("Ctrl+Alt+Space");
        let mut m = Matcher::default();
        let mut key = |vk: u32, down: bool, tick: u32| m.key(ctrl_alt_space, vk, down, tick);
        // left Control, right Alt (AltGr), Space: down; its repeats say nothing; up
        assert_eq!(key(0xA2, true, 0), None);
        assert_eq!(key(0xA5, true, 5), None);
        assert_eq!(key(0x20, true, 10), Some(true));
        assert_eq!(key(0x20, true, 510), None);
        assert_eq!(key(0x20, true, 540), None);
        assert_eq!(key(0x20, false, 900), Some(false));
        // a modifier let go first: the key's up still ends it
        assert_eq!(key(0x20, true, 3000), Some(true));
        assert_eq!(key(0xA5, false, 3100), None);
        assert_eq!(key(0x20, false, 3200), Some(false));
        // Space with Control alone, or with Shift as well, is not the talk key
        assert_eq!(key(0x20, true, 5000), None);
        assert_eq!(key(0x20, false, 5100), None);
        assert_eq!(key(0xA0, true, 5200), None);
        assert_eq!(key(0xA4, true, 5300), None);
        assert_eq!(key(0x20, true, 5400), None);
        assert_eq!(key(0x20, false, 5500), None);
        assert_eq!(key(0xA0, false, 5600), None);
        // an up missed: a down after a long quiet is a press again
        assert_eq!(key(0x20, true, 8000), Some(true));
        assert_eq!(key(0x20, true, 20000), Some(true));
        // other keys pass
        assert_eq!(key(0x41, true, 20100), None);
    }

    #[test]
    fn modifiers_held_when_the_hook_starts_count() {
        let ctrl_shift_f9 = shortcut("Ctrl+Shift+F9");
        let mut m = Matcher::default();
        m.held([0xA3, 0xA1]);
        assert_eq!(m.key(ctrl_shift_f9, 0x78, true, 0), Some(true));
        // a new accelerator starts the key's state again
        assert_eq!(m.key(shortcut("Ctrl+Shift+F8"), 0x77, true, 10), Some(true));
    }
}
