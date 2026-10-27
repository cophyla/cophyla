//! What the shim does when its child exits, decided apart from the processes and the files so
//! it can be tested against a clock the test moves.
//!
//! Exit code 75 (EXIT_UPDATED) means the child made a new version current: it starts again at
//! once. Anything else is a crash, restarted after a backoff of 1 s doubling to 60 s, back to
//! 1 s once a child stayed up ten minutes. A version that crashes CRASH_LIMIT times within
//! CRASH_WINDOW_MS of its first start in this shim's life is given up for `previous`, when the
//! caller found one that differs, is complete and is not marked broken, as the launcher's
//! rollback does for the desktop. A shim stopping never asks.

use std::collections::HashMap;
use std::time::Instant;

use crate::constants::{CRASH_LIMIT, CRASH_WINDOW_MS, EXIT_UPDATED};

/// The first wait after a crash, in milliseconds.
pub const BACKOFF_FIRST_MS: u64 = 1_000;
/// The longest.
pub const BACKOFF_MAX_MS: u64 = 60_000;
/// A child up this long has its next crash waited for from the start again.
pub const STABLE_MS: u64 = 10 * 60 * 1_000;
/// How often a missing or half-installed version is looked for again.
pub const MISSING_RETRY_MS: u64 = 60_000;

/// Milliseconds on some fixed scale; only differences are used.
pub trait Clock {
    fn now_ms(&self) -> u64;
}

/// The real clock: milliseconds since the shim began.
pub struct MonotonicClock(Instant);

impl MonotonicClock {
    pub fn new() -> Self {
        MonotonicClock(Instant::now())
    }
}

impl Default for MonotonicClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for MonotonicClock {
    fn now_ms(&self) -> u64 {
        self.0.elapsed().as_millis() as u64
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Start the child again now.
    Respawn,
    /// Start it again after this many milliseconds.
    Restart { after_ms: u64 },
    /// Mark `bad` broken, make `to` current, remove `previous`, and start again now.
    FallBack { bad: String, to: String },
}

#[derive(Debug, Clone, Copy)]
struct Record {
    first_start: u64,
    crashes: u32,
}

pub struct Policy<C: Clock> {
    clock: C,
    versions: HashMap<String, Record>,
    backoff_ms: u64,
    started_at: Option<u64>,
}

impl<C: Clock> Policy<C> {
    pub fn new(clock: C) -> Self {
        Policy { clock, versions: HashMap::new(), backoff_ms: BACKOFF_FIRST_MS, started_at: None }
    }

    /// A child started. `version` is the one `current` named, or `None` when the command was
    /// given on the command line, where there is nothing to fall back from.
    pub fn started(&mut self, version: Option<&str>) {
        let now = self.clock.now_ms();
        self.started_at = Some(now);
        if let Some(v) = version {
            self.versions.entry(v.to_string()).or_insert(Record { first_start: now, crashes: 0 });
        }
    }

    /// How long the running child has been up, in milliseconds.
    pub fn uptime_ms(&self) -> u64 {
        self.started_at.map_or(0, |s| self.clock.now_ms().saturating_sub(s))
    }

    /// The child exited with `code`, or could not be started (`None`, with no `started`).
    /// `previous` is the version the caller would fall back to, given only when it is complete
    /// and not marked broken; that it differs from `version` is checked here.
    pub fn exited(&mut self, version: Option<&str>, code: Option<i32>, previous: Option<&str>) -> Action {
        let uptime = self.uptime_ms();
        self.started_at = None;
        if code == Some(EXIT_UPDATED as i32) {
            self.backoff_ms = BACKOFF_FIRST_MS;
            return Action::Respawn;
        }
        if uptime >= STABLE_MS {
            self.backoff_ms = BACKOFF_FIRST_MS;
        }
        let now = self.clock.now_ms();
        if let Some(v) = version {
            let record = self.versions.entry(v.to_string()).or_insert(Record { first_start: now, crashes: 0 });
            if now.saturating_sub(record.first_start) <= CRASH_WINDOW_MS as u64 {
                record.crashes += 1;
            }
            if record.crashes >= CRASH_LIMIT {
                if let Some(p) = previous.filter(|p| *p != v) {
                    self.backoff_ms = BACKOFF_FIRST_MS;
                    return Action::FallBack { bad: v.to_string(), to: p.to_string() };
                }
            }
        }
        let after_ms = self.backoff_ms;
        self.backoff_ms = (self.backoff_ms * 2).min(BACKOFF_MAX_MS);
        Action::Restart { after_ms }
    }

    /// The crashes counted against `version` so far.
    pub fn crashes(&self, version: &str) -> u32 {
        self.versions.get(version).map_or(0, |r| r.crashes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    #[derive(Clone)]
    struct TestClock(Rc<Cell<u64>>);

    impl TestClock {
        fn advance(&self, ms: u64) {
            self.0.set(self.0.get() + ms);
        }
    }

    impl Clock for TestClock {
        fn now_ms(&self) -> u64 {
            self.0.get()
        }
    }

    fn policy() -> (Policy<TestClock>, TestClock) {
        let clock = TestClock(Rc::new(Cell::new(1_000_000)));
        (Policy::new(clock.clone()), clock)
    }

    const UPDATED: Option<i32> = Some(EXIT_UPDATED as i32);

    #[test]
    fn an_update_starts_again_at_once_and_is_no_crash() {
        let (mut p, clock) = policy();
        for _ in 0..10 {
            p.started(Some("0.21.0"));
            clock.advance(100);
            assert_eq!(p.exited(Some("0.21.0"), UPDATED, Some("0.20.0")), Action::Respawn);
        }
        assert_eq!(p.crashes("0.21.0"), 0);
    }

    #[test]
    fn crashes_back_off_doubling_to_a_minute() {
        let (mut p, clock) = policy();
        let mut waits = Vec::new();
        for _ in 0..9 {
            p.started(None);
            clock.advance(500);
            match p.exited(None, Some(1), None) {
                Action::Restart { after_ms } => {
                    waits.push(after_ms);
                    clock.advance(after_ms);
                }
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(waits, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    }

    #[test]
    fn ten_minutes_up_resets_the_backoff_and_an_update_does_too() {
        let (mut p, clock) = policy();
        for _ in 0..4 {
            p.started(None);
            clock.advance(10);
            p.exited(None, Some(3), None);
        }
        p.started(None);
        clock.advance(STABLE_MS);
        assert_eq!(p.exited(None, Some(3), None), Action::Restart { after_ms: 1_000 });
        p.started(None);
        assert_eq!(p.exited(None, Some(3), None), Action::Restart { after_ms: 2_000 });
        p.started(None);
        assert_eq!(p.exited(None, UPDATED, None), Action::Respawn);
        p.started(None);
        assert_eq!(p.exited(None, Some(3), None), Action::Restart { after_ms: 1_000 });
    }

    #[test]
    fn a_version_crashing_five_times_in_its_window_falls_back() {
        let (mut p, clock) = policy();
        for n in 1..CRASH_LIMIT {
            p.started(Some("0.21.0"));
            clock.advance(2_000);
            assert!(matches!(p.exited(Some("0.21.0"), Some(1), Some("0.20.0")), Action::Restart { .. }), "crash {n}");
        }
        p.started(Some("0.21.0"));
        clock.advance(2_000);
        assert_eq!(p.exited(Some("0.21.0"), Some(1), Some("0.20.0")), Action::FallBack { bad: "0.21.0".into(), to: "0.20.0".into() });
        // the version fallen back to starts with a clean record and the first backoff
        p.started(Some("0.20.0"));
        clock.advance(10);
        assert_eq!(p.exited(Some("0.20.0"), Some(1), None), Action::Restart { after_ms: 1_000 });
        assert_eq!(p.crashes("0.20.0"), 1);
    }

    #[test]
    fn no_fallback_without_a_different_previous() {
        let (mut p, clock) = policy();
        for _ in 0..CRASH_LIMIT + 3 {
            p.started(Some("0.21.0"));
            clock.advance(10);
            assert!(matches!(p.exited(Some("0.21.0"), Some(1), None), Action::Restart { .. }));
        }
        let (mut p, clock) = policy();
        for _ in 0..CRASH_LIMIT + 3 {
            p.started(Some("0.21.0"));
            clock.advance(10);
            assert!(matches!(p.exited(Some("0.21.0"), Some(1), Some("0.21.0")), Action::Restart { .. }));
        }
    }

    #[test]
    fn crashes_after_the_window_from_the_first_start_do_not_count() {
        let (mut p, clock) = policy();
        p.started(Some("0.21.0"));
        clock.advance(10);
        p.exited(Some("0.21.0"), Some(1), Some("0.20.0"));
        // the window runs from the first start, not from each crash
        clock.advance(CRASH_WINDOW_MS as u64);
        for _ in 0..CRASH_LIMIT * 2 {
            p.started(Some("0.21.0"));
            clock.advance(10);
            assert!(matches!(p.exited(Some("0.21.0"), Some(1), Some("0.20.0")), Action::Restart { .. }));
        }
        assert_eq!(p.crashes("0.21.0"), 1);
    }

    #[test]
    fn a_command_line_child_never_falls_back() {
        let (mut p, clock) = policy();
        for _ in 0..CRASH_LIMIT * 2 {
            p.started(None);
            clock.advance(10);
            assert!(matches!(p.exited(None, Some(1), Some("0.20.0")), Action::Restart { .. }));
        }
    }

    #[test]
    fn a_failed_spawn_counts_as_a_crash() {
        let (mut p, _clock) = policy();
        for _ in 0..CRASH_LIMIT - 1 {
            assert!(matches!(p.exited(Some("0.21.0"), None, Some("0.20.0")), Action::Restart { .. }));
        }
        assert!(matches!(p.exited(Some("0.21.0"), None, Some("0.20.0")), Action::FallBack { .. }));
    }
}
