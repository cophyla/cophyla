// The launcher: the fixed entry point of an installed Cophyla (`Cophyla.exe`,
// `Cophyla.app/Contents/MacOS/Cophyla`, `/usr/bin/Cophyla`). It never changes with a release;
// the Start Menu shortcut, the login item and the desktop app's own relaunch all go through
// it. It owns the root (the pointers, `versions/`, `brain/`): on Windows its own directory,
// elsewhere the user's data directory, seeded from the package at every start (`seed.rs`).
// It owns the `current` and `previous` pointers: at every start it rotates a version cophylad
// staged into `current`, starts `versions/<current>/<shell>`, and if that exits with a
// failure within ten seconds moves the pointer back to `previous` and marks the version
// `.broken`. `--wait-pid <n>` waits for a running shell to exit first (the shell relaunches
// through here so the single instance is released before the new version starts);
// `--rollback` is the manual path; anything else is passed to the shell (`--hidden`). The
// shell gets `COPHYLA_LAUNCHER` and the root gets a `launcher` file, both this executable's
// path; on Unix the shell runs in its own process group, since launchd ends a login item's
// group when the item exits. Every step is written to `launcher.log` in the root: the
// launcher has no window.
#![cfg_attr(not(test), windows_subsystem = "windows")]

mod layout;
mod seed;
#[cfg(target_os = "macos")]
mod spawn_mac;

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "macos"))]
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const WAIT_PREVIOUS: Duration = Duration::from_secs(30);
const WATCH_CHILD: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(100);

struct Log {
    file: Option<File>,
}

impl Log {
    fn open(path: &Path) -> Log {
        Log { file: OpenOptions::new().create(true).append(true).open(path).ok() }
    }

    fn line(&mut self, message: &str) {
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        if let Some(f) = self.file.as_mut() {
            let _ = writeln!(f, "{secs} [{}] {message}", std::process::id());
        }
        #[cfg(test)]
        eprintln!("{message}");
    }
}

struct Args {
    wait_pid: Option<u32>,
    rollback: bool,
    passthrough: Vec<String>,
}

fn parse_args(raw: impl Iterator<Item = String>) -> Args {
    let mut args = Args { wait_pid: None, rollback: false, passthrough: Vec::new() };
    let mut raw = raw.peekable();
    while let Some(a) = raw.next() {
        match a.as_str() {
            "--wait-pid" => args.wait_pid = raw.next().and_then(|p| p.parse().ok()),
            "--rollback" => args.rollback = true,
            _ => args.passthrough.push(a),
        }
    }
    args
}

enum Launch {
    /// Running after the watch window, or exited 0 (a single-instance bounce).
    Ok,
    Failed(String),
}

/// Starts the shell of `version` with the passthrough arguments and watches it for a while.
fn launch(dir: &Path, version: &str, passthrough: &[String], launcher: &Path, log: &mut Log) -> Launch {
    let vdir = layout::version_dir(dir, version);
    let shell = vdir.join(layout::SHELL);
    log.line(&format!("starting {} {}", shell.display(), passthrough.join(" ")));
    let mut child = match start(&shell, passthrough, &vdir, dir, launcher) {
        Ok(c) => c,
        Err(e) => return Launch::Failed(format!("spawn failed: {e}")),
    };
    let started = Instant::now();
    while started.elapsed() < WATCH_CHILD {
        match child.try_wait() {
            Ok(Some((true, _))) => {
                log.line(&format!("{version} exited 0 after {:?} (another instance took over)", started.elapsed()));
                return Launch::Ok;
            }
            Ok(Some((false, status))) => return Launch::Failed(format!("{version} exited with {status} after {:?}", started.elapsed())),
            Ok(None) => std::thread::sleep(POLL),
            Err(e) => return Launch::Failed(format!("cannot watch {version}: {e}")),
        }
    }
    log.line(&format!("{version} running (pid {})", child.id()));
    Launch::Ok
}

/// The shell started with the launcher's variables: on macOS as its own responsible process
/// (`spawn_mac.rs`), elsewhere through `Command`; on Unix in its own process group.
#[cfg(target_os = "macos")]
fn start(shell: &Path, passthrough: &[String], vdir: &Path, dir: &Path, launcher: &Path) -> std::io::Result<spawn_mac::Spawned> {
    spawn_mac::spawn(shell, passthrough, vdir, &[("COPHYLA_INSTALL_DIR", dir.as_os_str()), ("COPHYLA_PLATFORM_DIR", vdir.as_os_str()), ("COPHYLA_LAUNCHER", launcher.as_os_str())])
}

#[cfg(not(target_os = "macos"))]
struct Started(std::process::Child);

#[cfg(not(target_os = "macos"))]
impl Started {
    fn id(&self) -> u32 {
        self.0.id()
    }

    fn try_wait(&mut self) -> std::io::Result<Option<(bool, String)>> {
        Ok(self.0.try_wait()?.map(|s| (s.success(), s.to_string())))
    }
}

#[cfg(not(target_os = "macos"))]
fn start(shell: &Path, passthrough: &[String], vdir: &Path, dir: &Path, launcher: &Path) -> std::io::Result<Started> {
    let mut command = Command::new(shell);
    command
        .args(passthrough)
        .current_dir(vdir)
        .env("COPHYLA_INSTALL_DIR", dir)
        .env("COPHYLA_PLATFORM_DIR", vdir)
        .env("COPHYLA_LAUNCHER", launcher)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn().map(Started)
}

#[cfg(windows)]
fn wait_for_exit(pid: u32, timeout: Duration, log: &mut Log) {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
    // PROCESS_SYNCHRONIZE: the access right SYNCHRONIZE (0x00100000), which windows-sys files under the file system.
    const SYNCHRONIZE: u32 = 0x0010_0000;
    let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        log.line(&format!("pid {pid} is already gone"));
        return;
    }
    let started = Instant::now();
    let result = unsafe { WaitForSingleObject(handle, timeout.as_millis() as u32) };
    unsafe { CloseHandle(handle) };
    if result == WAIT_OBJECT_0 {
        log.line(&format!("pid {pid} exited after {:?}", started.elapsed()));
    } else {
        log.line(&format!("pid {pid} still running after {:?}; going on", timeout));
    }
}

/// `kill(pid, 0)`: alive on success or EPERM (another user's process), gone on ESRCH.
#[cfg(unix)]
fn alive(pid: u32) -> bool {
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(unix)]
fn wait_for_exit(pid: u32, timeout: Duration, log: &mut Log) {
    let started = Instant::now();
    if !alive(pid) {
        log.line(&format!("pid {pid} is already gone"));
        return;
    }
    while started.elapsed() < timeout && alive(pid) {
        std::thread::sleep(POLL);
    }
    if alive(pid) {
        log.line(&format!("pid {pid} still running after {:?}; going on", timeout));
    } else {
        log.line(&format!("pid {pid} exited after {:?}", started.elapsed()));
    }
}

/// Where the root and the seed are on this OS. `COPHYLA_INSTALL_DIR` overrides the root.
struct Places {
    /// The pointers, `versions/`, `brain/`, `launcher.log`, the `launcher` file.
    root: PathBuf,
    /// The package's read-only first contents; none on Windows, where the installer writes the root.
    seed: Option<PathBuf>,
}

fn places(exe: &Path, env_root: Option<PathBuf>) -> Places {
    let exe_dir = exe.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    #[cfg(windows)]
    let (root, seed) = (exe_dir, None::<PathBuf>);
    #[cfg(target_os = "macos")]
    let (root, seed) = (
        dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("Cophyla"),
        // Cophyla.app/Contents/MacOS/Cophyla -> Cophyla.app/Contents/Resources/seed
        Some(exe_dir.parent().map(|c| c.join("Resources").join("seed")).unwrap_or_default()),
    );
    #[cfg(all(unix, not(target_os = "macos")))]
    let (root, seed) = (
        dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("cophyla"),
        // /usr/bin/Cophyla -> /usr/lib/Cophyla/seed; the same relative place inside an AppImage's usr/
        Some(exe_dir.parent().map(|p| p.join("lib").join("Cophyla").join("seed")).unwrap_or_default()),
    );
    Places { root: env_root.filter(|p| !p.as_os_str().is_empty()).unwrap_or(root), seed }
}

/// macOS: where an app is run from that it must not be installed from. An app first opened from
/// the disk image is on a read-only volume under `/Volumes` (an app kept on a drive of its own
/// is on a writable one); one opened where it was downloaded, still quarantined, is run by
/// macOS from a random read-only copy under `…/AppTranslocation/`. Either path would be
/// written to the `launcher` file and the login item, and gone by the next start.
fn not_installed_place(exe: &Path, writable: impl Fn(&Path) -> bool) -> bool {
    let s = exe.to_string_lossy();
    // …/Cophyla.app/Contents/MacOS/Cophyla -> the folder the app is in
    let folder = exe.ancestors().nth(4).unwrap_or(exe);
    cfg!(target_os = "macos") && (s.contains("/AppTranslocation/") || (s.starts_with("/Volumes/") && !writable(folder)))
}

#[cfg(unix)]
fn writable(dir: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(dir.as_os_str().as_bytes()).is_ok_and(|c| unsafe { libc::access(c.as_ptr(), libc::W_OK) } == 0)
}

#[cfg(not(unix))]
fn writable(_dir: &Path) -> bool {
    true
}

/// Tells the user to move the app, in a dialog of the system's: the launcher has no window.
#[cfg(target_os = "macos")]
fn ask_to_move() {
    let script = "display alert \"Move Cophyla to Applications\" message \"Cophyla runs from your Applications folder. Drag it there from the disk image or the Downloads folder, then open it from Applications.\" as warning buttons {\"OK\"} default button \"OK\"";
    let _ = std::process::Command::new("/usr/bin/osascript").args(["-e", script]).status();
}

#[cfg(not(target_os = "macos"))]
fn ask_to_move() {}

fn main() {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("Cophyla"));
    let Places { root: dir, seed } = places(&exe, std::env::var_os("COPHYLA_INSTALL_DIR").map(PathBuf::from));
    let _ = std::fs::create_dir_all(&dir);
    let mut log = Log::open(&dir.join("launcher.log"));
    let args = parse_args(std::env::args().skip(1));
    log.line(&format!("launcher {} in {}", env!("CARGO_PKG_VERSION"), dir.display()));
    if not_installed_place(&exe, writable) {
        log.line(&format!("not started from {}: the app must be moved to Applications first", exe.display()));
        ask_to_move();
        std::process::exit(0);
    }
    if let Err(e) = layout::write_text(&dir.join(layout::LAUNCHER_FILE), &format!("{}\n", exe.display())) {
        log.line(&format!("cannot write {}: {e}", layout::LAUNCHER_FILE));
    }

    if let Some(pid) = args.wait_pid {
        wait_for_exit(pid, WAIT_PREVIOUS, &mut log);
    }

    match seed::sync(&dir, seed.as_deref(), &mut |m| log.line(m)) {
        Ok(seed::Seeded::NoSeed) | Ok(seed::Seeded::UpToDate) => {}
        Ok(seed::Seeded::First(v)) => log.line(&format!("seeded {v}")),
        Ok(seed::Seeded::Reinstalled(v)) => log.line(&format!("seeded {v} from a reinstalled package")),
        Err(e) => log.line(&format!("seed failed: {e}")),
    }

    if args.rollback {
        match layout::rollback(&dir, "requested with --rollback") {
            Ok(v) => log.line(&format!("rolled back to {v} on request")),
            Err(e) => log.line(&format!("rollback refused: {e}")),
        }
    } else {
        match layout::rotate(&dir) {
            Ok(layout::Rotation::Nothing) => {}
            Ok(layout::Rotation::Rotated { from, to }) => log.line(&format!("rotated: current {to}, previous {}", from.as_deref().unwrap_or("none"))),
            Ok(layout::Rotation::AlreadyCurrent(v)) => log.line(&format!("staged {v} was already current; pointer removed")),
            Ok(layout::Rotation::Incomplete(v)) => log.line(&format!("staged {v} is not complete; pointer removed")),
            Err(e) => log.line(&format!("rotation failed: {e}")),
        }
    }

    let Some(current) = layout::read_pointer(&dir, "current") else {
        log.line("no current pointer: nothing to start");
        std::process::exit(1);
    };
    match launch(&dir, &current, &args.passthrough, &exe, &mut log) {
        Launch::Ok => std::process::exit(0),
        Launch::Failed(reason) => {
            log.line(&format!("start failed: {reason}"));
            match layout::rollback(&dir, &reason) {
                Ok(previous) => {
                    log.line(&format!("rolled back to {previous}; {current} marked broken"));
                    match launch(&dir, &previous, &args.passthrough, &exe, &mut log) {
                        Launch::Ok => std::process::exit(0),
                        Launch::Failed(again) => {
                            log.line(&format!("start of {previous} failed too: {again}"));
                            std::process::exit(1);
                        }
                    }
                }
                Err(e) => {
                    log.line(&format!("no rollback: {e}"));
                    std::process::exit(1);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_disk_image_or_a_translocated_copy_is_not_an_installed_place() {
        let translocated = Path::new("/private/var/folders/xy/abc/T/AppTranslocation/0A1B2C/d/Cophyla.app/Contents/MacOS/Cophyla");
        let mounted = Path::new("/Volumes/Cophyla/Cophyla.app/Contents/MacOS/Cophyla");
        let installed = Path::new("/Applications/Cophyla.app/Contents/MacOS/Cophyla");
        let read_only = |_: &Path| false;
        assert_eq!(not_installed_place(translocated, |_| true), cfg!(target_os = "macos"));
        assert_eq!(not_installed_place(mounted, read_only), cfg!(target_os = "macos"));
        // an app kept on a drive of its own runs where it is
        assert!(!not_installed_place(mounted, |d| d == Path::new("/Volumes/Cophyla")));
        assert!(!not_installed_place(installed, read_only));
    }

    #[test]
    fn args_split_the_launcher_flags_from_the_shells() {
        let a = parse_args(["--wait-pid", "1234", "--hidden", "--rollback", "x"].into_iter().map(String::from));
        assert_eq!(a.wait_pid, Some(1234));
        assert!(a.rollback);
        assert_eq!(a.passthrough, vec!["--hidden".to_string(), "x".to_string()]);
        let b = parse_args(["--wait-pid", "nope"].into_iter().map(String::from));
        assert_eq!(b.wait_pid, None);
        assert!(b.passthrough.is_empty());
    }

    #[test]
    fn the_root_is_the_launchers_directory_on_windows_and_the_data_directory_elsewhere_unless_overridden() {
        let exe = if cfg!(windows) {
            PathBuf::from(r"C:\Users\me\AppData\Local\Cophyla\Cophyla.exe")
        } else if cfg!(target_os = "macos") {
            PathBuf::from("/Applications/Cophyla.app/Contents/MacOS/Cophyla")
        } else {
            PathBuf::from("/usr/bin/Cophyla")
        };
        let p = places(&exe, None);
        if cfg!(windows) {
            assert_eq!(p.root, exe.parent().unwrap());
            assert!(p.seed.is_none());
        } else if cfg!(target_os = "macos") {
            assert!(p.root.ends_with("Library/Application Support/Cophyla"), "{}", p.root.display());
            assert_eq!(p.seed.as_deref(), Some(Path::new("/Applications/Cophyla.app/Contents/Resources/seed")));
        } else {
            assert!(p.root.ends_with("cophyla"), "{}", p.root.display());
            assert_eq!(p.seed.as_deref(), Some(Path::new("/usr/lib/Cophyla/seed")));
        }
        let over = places(&exe, Some(PathBuf::from("/tmp/cophyla-root")));
        assert_eq!(over.root, PathBuf::from("/tmp/cophyla-root"));
        assert_eq!(places(&exe, Some(PathBuf::new())).root, p.root);
    }
}
