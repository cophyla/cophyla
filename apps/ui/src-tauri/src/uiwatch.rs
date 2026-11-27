// The UI thread's watchdog. The window's thread runs every window and web view event, every
// IPC request's arrival and answer, and every script the shell evaluates in a page; while it
// is busy the app does not answer, and Windows ends an app that stays so long enough. A thread
// of its own posts a beat to it every 250 ms (`run_on_main_thread`); a beat that has not run a
// second later is logged as `UI thread stalled`, with the last task the shell began there
// (`task`: a command's arrival, a window event, the talk key, a tray click), whether that task
// is still running, and then how long the stall lasted once the beat runs. What the shell does
// not label (a script evaluated, WebView2's own work) shows as the last labelled task having
// ended before the stall.

use std::sync::mpsc;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Runtime};

/// How often a beat is posted, and how late one may run before the stall is logged.
pub const BEAT: Duration = Duration::from_millis(250);
pub const LATE: Duration = Duration::from_secs(1);

/// The last task begun on the UI thread: its label, when it began, and when it ended, if it has.
struct Last {
    what: &'static str,
    name: String,
    began: Option<Instant>,
    ended: Option<Instant>,
}

static LAST: Mutex<Last> = Mutex::new(Last { what: "", name: String::new(), began: None, ended: None });

/// Marks the task's end when dropped.
pub struct Task(());

impl Drop for Task {
    fn drop(&mut self) {
        let mut last = LAST.lock().unwrap_or_else(PoisonError::into_inner);
        last.ended = Some(Instant::now());
    }
}

/// Notes a task beginning on the UI thread; it ends when the guard goes.
pub fn task(what: &'static str) -> Task {
    named(what, "")
}

/// A task with a name beside its label: a command's, a menu item's.
pub fn named(what: &'static str, name: &str) -> Task {
    let mut last = LAST.lock().unwrap_or_else(PoisonError::into_inner);
    last.what = what;
    last.name.clear();
    last.name.push_str(name);
    last.began = Some(Instant::now());
    last.ended = None;
    Task(())
}

/// How the last task reads in a stall's line, at `now`.
fn describe(now: Instant) -> String {
    let last = LAST.lock().unwrap_or_else(PoisonError::into_inner);
    let Some(began) = last.began else { return "none labelled yet".into() };
    let label = if last.name.is_empty() { last.what.to_string() } else { format!("{} {}", last.what, last.name) };
    let ms = |d: Duration| d.as_millis();
    match last.ended {
        None => format!("{label}, running for {} ms", ms(now.saturating_duration_since(began))),
        Some(ended) => format!("{label}, which took {} ms and ended {} ms ago", ms(ended.saturating_duration_since(began)), ms(now.saturating_duration_since(ended))),
    }
}

/// Starts the watchdog's thread; it ends with the event loop.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let started = std::thread::Builder::new().name("ui-watchdog".into()).spawn(move || watch(|beat| app.run_on_main_thread(beat).is_ok()));
    if let Err(e) = started {
        log::warn!("the UI thread's watchdog did not start: {e}");
    }
}

/// Posts beats with `post` until it fails or a beat is dropped unrun (the loop is gone).
fn watch(post: impl Fn(Box<dyn FnOnce() + Send>) -> bool) {
    loop {
        let (tx, rx) = mpsc::sync_channel::<Instant>(1);
        let posted = Instant::now();
        if !post(Box::new(move || {
            let _ = tx.send(Instant::now());
        })) {
            return;
        }
        match rx.recv_timeout(LATE) {
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {
                log::warn!("UI thread stalled: a beat posted {} ms ago has not run; last task there: {}", posted.elapsed().as_millis(), describe(Instant::now()));
                match rx.recv() {
                    Ok(ran) => log::warn!("UI thread back: the beat ran {} ms after it was posted", ran.saturating_duration_since(posted).as_millis()),
                    Err(_) => return,
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        std::thread::sleep(BEAT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn the_last_task_reads_as_running_or_ended() {
        let t = named("command", "view_stage");
        let now = Instant::now() + Duration::from_millis(1500);
        let running = describe(now);
        assert!(running.starts_with("command view_stage, running for 15"), "{running}");
        drop(t);
        let ended = describe(Instant::now() + Duration::from_millis(40));
        assert!(ended.starts_with("command view_stage, which took ") && ended.ends_with(" ms ago"), "{ended}");
        drop(task("window focus"));
        assert!(describe(Instant::now()).starts_with("window focus, which took"));
    }

    #[test]
    fn a_beat_that_never_runs_ends_the_watch_and_one_that_runs_late_is_waited_for() {
        // a loop that runs each beat 1.2 s late, twice, then is gone
        let posts = Arc::new(Mutex::new(0));
        let counted = posts.clone();
        let begun = Instant::now();
        watch(move |beat| {
            let mut n = counted.lock().unwrap();
            *n += 1;
            if *n > 2 {
                drop(beat);
                return true;
            }
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1200));
                beat();
            });
            true
        });
        assert_eq!(*posts.lock().unwrap(), 3);
        assert!(begun.elapsed() >= Duration::from_millis(2400));
        // a post that fails ends it at once
        watch(|_| false);
    }
}
