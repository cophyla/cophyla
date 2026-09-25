// PM4 (U8): does notify-rust's UNUserNotificationCenter backend, from an ad-hoc-signed
// bundle, show an ask's options as buttons and hand the chosen action id back? The same
// calls apps/ui/src-tauri/src/notify.rs makes: check the bundle, ask for permission once,
// show with `<ask>|<option>` actions, wait on a thread while the main run loop spins (the
// response is delivered on the main thread's run loop; in the app Tauri spins it).
// Built and bundled by make-app.sh; prints what happens.

#[cfg(target_os = "macos")]
fn main() {
    use notify_rust::Notification;
    use objc2_foundation::{NSDate, NSRunLoop};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    if let Err(e) = notify_rust::check_bundle() {
        eprintln!("PM4: not running from a bundle ({e}); use make-app.sh");
        std::process::exit(2);
    }
    match notify_rust::request_auth_blocking() {
        Ok(status) => println!("PM4: authorization {status:?}"),
        Err(e) => println!("PM4: authorization request failed: {e}"),
    }
    let mut n = Notification::new();
    n.summary("Cophyla").body("PM4: a permission ask with buttons").appname("Cophyla");
    n.action("ask_01PM4|allow", "Allow").action("ask_01PM4|deny", "Deny").action("default", "Open");
    let handle = match n.show() {
        Ok(h) => h,
        Err(e) => {
            println!("PM4: show failed: {e}");
            std::process::exit(1);
        }
    };
    println!("PM4: shown; hover the notification, Options, pick a button (60 s)");
    let done = Arc::new(AtomicBool::new(false));
    let flag = done.clone();
    std::thread::spawn(move || {
        handle.wait_for_action(|action| println!("PM4: action {action:?} {}", if action.starts_with("ask_01PM4|") { "OK" } else { "(body or closed)" }));
        flag.store(true, Ordering::SeqCst);
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    while !done.load(Ordering::SeqCst) && Instant::now() < deadline {
        unsafe {
            NSRunLoop::mainRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.25));
        }
    }
    if !done.load(Ordering::SeqCst) {
        println!("PM4: no action within 60 s");
    }
}

#[cfg(target_os = "linux")]
fn main() {
    use notify_rust::Notification;
    let mut n = Notification::new();
    n.summary("Cophyla").body("PL3: a permission ask with buttons").appname("Cophyla");
    n.action("ask_01PL3|allow", "Allow").action("ask_01PL3|deny", "Deny").action("default", "Open");
    let handle = n.show().expect("show");
    println!("PL3: shown; pick a button (the notification daemon must support actions)");
    handle.wait_for_action(|action| println!("PL3: action {action:?}"));
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn main() {
    println!("this spike is for macOS and Linux");
}
