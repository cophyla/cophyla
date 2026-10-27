//! The built shim in its console mode, as a test kit runs it: temporary folders, a pipe name of
//! the test's own, and `examples/door-echo` as the child. A client connects as the user running
//! the test, which is the door's user unless `--user-sid` says otherwise, and drives the whole
//! path: its line through the shim to the child and back, the console's state from stdin to the
//! child, a child's update exit closing its clients and the next child taking them again, a
//! client of another user refused, a line too long, a pipe name already taken, a door with no
//! version to run, and `stop`. Nothing here needs elevation; the service mode, the install and
//! the uninstall do, and are not run.

#![cfg(windows)]

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

const WAIT: Duration = Duration::from_secs(20);
/// Past this a door still running is killed, so a blocked read in a test ends.
const WATCHDOG: Duration = Duration::from_secs(90);

/// A temporary folder of the test's own, removed when it ends.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("cophyla-door-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("program")).unwrap();
        Scratch(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn pipe_name(name: &str) -> String {
    format!(r"\\.\pipe\cophyla-door-test-{}-{name}", std::process::id())
}

fn echo_exe() -> PathBuf {
    let exe = Path::new(env!("CARGO_BIN_EXE_cophyla-door")).parent().unwrap().join("examples").join("door-echo.exe");
    assert!(exe.is_file(), "{} is not built: run the whole `cargo test`, which builds the examples", exe.display());
    exe
}

/// The shim, running, with its stderr gathered. Killed when dropped, and by a watchdog.
struct Door {
    child: Arc<Mutex<Child>>,
    stdin: Option<ChildStdin>,
    log: Arc<Mutex<String>>,
    cancel: Sender<()>,
}

impl Door {
    fn start(scratch: &Scratch, pipe: &str, extra: &[&str]) -> Door {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_cophyla-door"));
        cmd.args(["run", "--console", "--no-power", "--pipe", pipe])
            .arg("--data")
            .arg(scratch.0.join("data"))
            .arg("--home")
            .arg(scratch.0.join("home"))
            .arg("--program")
            .arg(scratch.0.join("program"))
            .args(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().unwrap();
        let stdin = child.stdin.take();
        let stderr = child.stderr.take().unwrap();
        let log = Arc::new(Mutex::new(String::new()));
        let sink = Arc::clone(&log);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                let mut log = sink.lock().unwrap();
                log.push_str(&line);
                log.push('\n');
            }
        });
        let child = Arc::new(Mutex::new(child));
        let (cancel, cancelled) = mpsc::channel::<()>();
        let watched = Arc::clone(&child);
        thread::spawn(move || {
            if cancelled.recv_timeout(WATCHDOG).is_err() {
                let _ = watched.lock().unwrap().kill();
            }
        });
        Door { child, stdin, log, cancel }
    }

    fn with_echo(scratch: &Scratch, pipe: &str, extra: &[&str]) -> Door {
        let echo = echo_exe();
        let mut args = vec!["--bun", echo.to_str().unwrap(), "--main", "door-main.ts"];
        args.extend_from_slice(extra);
        Door::start(scratch, pipe, &args)
    }

    fn say(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(format!("{line}\n").as_bytes()).unwrap();
        stdin.flush().unwrap();
    }

    fn log(&self) -> String {
        self.log.lock().unwrap().clone()
    }

    fn wait_log(&self, needle: &str) {
        let until = Instant::now() + WAIT;
        while Instant::now() < until {
            if self.log().contains(needle) {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("the door never logged {needle:?}; it logged:\n{}", self.log());
    }

    fn wait_exit(&self) -> ExitStatus {
        let until = Instant::now() + WAIT;
        while Instant::now() < until {
            if let Some(status) = self.child.lock().unwrap().try_wait().unwrap() {
                return status;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("the door did not exit; it logged:\n{}", self.log());
    }
}

impl Drop for Door {
    fn drop(&mut self) {
        let _ = self.cancel.send(());
        let mut child = self.child.lock().unwrap();
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// A pipe client: one thread writes and reads in turn, which a synchronous handle needs.
struct Client {
    reader: BufReader<File>,
    writer: File,
}

const ERROR_PIPE_BUSY: i32 = 231;

fn connect(pipe: &str) -> Client {
    let until = Instant::now() + WAIT;
    loop {
        match OpenOptions::new().read(true).write(true).open(pipe) {
            Ok(file) => return Client { reader: BufReader::new(file.try_clone().unwrap()), writer: file },
            Err(e) if Instant::now() < until && (e.kind() == std::io::ErrorKind::NotFound || e.raw_os_error() == Some(ERROR_PIPE_BUSY)) => thread::sleep(Duration::from_millis(50)),
            Err(e) => panic!("cannot connect to {pipe}: {e}"),
        }
    }
}

impl Client {
    fn write(&mut self, line: &str) {
        self.writer.write_all(format!("{line}\n").as_bytes()).unwrap();
        self.writer.flush().unwrap();
    }

    /// The next line, or `None` once the shim has closed the client.
    fn line(&mut self) -> Option<String> {
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(line.trim_end_matches(['\r', '\n']).to_string()),
        }
    }

    fn json(&mut self) -> Value {
        let line = self.line().expect("a line, not the end");
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("not JSON ({e}): {line}"))
    }
}

/// Connects and writes first, as the daemon must (the shim can tell who a client is only once
/// it has read something from it); the child's report of its start comes back, then the first
/// line, echoed.
fn attach(pipe: &str) -> (Client, Value) {
    let mut client = connect(pipe);
    client.write("attach");
    let report = client.json();
    assert_eq!(client.line().as_deref(), Some("attach"));
    (client, report)
}

#[test]
fn a_line_goes_round_and_the_console_reaches_the_child() {
    let scratch = Scratch::new("round");
    let pipe = pipe_name("round");
    let mut door = Door::with_echo(&scratch, &pipe, &[]);
    let (mut client, report) = attach(&pipe);

    // the child's report of what it was started with
    let hello = &report["hello"];
    assert_eq!(hello["protocol"], 1);
    assert_eq!(hello["console"], "active");
    assert_eq!(hello["ac"], true);
    let user = hello["userSid"].as_str().unwrap().to_string();
    assert!(user.starts_with("S-1-"), "{user}");
    assert_eq!(report["open"]["sid"], user.as_str());
    assert!(report["open"]["conn"].as_u64().is_some());
    let home = scratch.0.join("home");
    let args: Vec<&str> = report["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
    assert_eq!(args[1..4], ["door", "--home", home.to_str().unwrap()]);
    assert_eq!(args[4..], ["--program", scratch.0.join("program").to_str().unwrap()]);
    assert!(args[0].ends_with("door-main.ts"), "{args:?}");
    assert_eq!(report["cwd"].as_str().unwrap().to_lowercase(), home.to_str().unwrap().to_lowercase());
    assert_eq!(report["env"]["COPHYLA_DOOR"], "1");
    assert_eq!(report["env"]["TEMP"], home.join("tmp").to_str().unwrap());
    assert_eq!(report["env"]["USERPROFILE"], home.to_str().unwrap());
    assert!(report["env"]["PATH"].as_str().unwrap().to_lowercase().ends_with(r"\system32\windowspowershell\v1.0"));
    let names: Vec<String> = report["envNames"].as_array().unwrap().iter().map(|n| n.as_str().unwrap().to_uppercase()).collect();
    for absent in ["USERNAME", "APPDATA", "HOMEPATH", "CARGO", "RUST_TEST_THREADS"] {
        assert!(!names.contains(&absent.to_string()), "{absent} leaked into the child: {names:?}");
    }
    for dir in ["tmp", "bun-cache", "appdata"] {
        assert!(home.join(dir).is_dir(), "{dir}");
    }

    client.write("ping 1");
    assert_eq!(client.line().as_deref(), Some("ping 1"));
    client.write(r#"{"jsonrpc":"2.0","id":7,"method":"door.attach","params":{"quote":"\"","tab":"\t"}}"#);
    assert_eq!(client.line().as_deref(), Some(r#"{"jsonrpc":"2.0","id":7,"method":"door.attach","params":{"quote":"\"","tab":"\t"}}"#));

    door.say("signin");
    let got = client.json();
    assert_eq!(got["got"], "console.state");
    assert_eq!(got["params"]["console"], "signin");
    door.say("ac off");
    let got = client.json();
    assert_eq!(got["got"], "power.state");
    assert_eq!(got["params"]["ac"], false);
    // a state that did not change is not sent again
    door.say("ac off");
    door.say("locked");
    let got = client.json();
    assert_eq!(got["params"]["console"], "locked");
    door.say("active");
    assert_eq!(client.json()["params"]["console"], "active");

    door.say("stop");
    assert!(door.wait_exit().success(), "{}", door.log());
    assert_eq!(client.line(), None);
    let log = door.log();
    assert!(log.contains("shim.stop to child 1"), "{log}");
    assert!(log.contains("door-echo: stopping"), "{log}");
    assert!(!log.contains("killing it"), "{log}");
}

#[test]
fn an_update_exit_restarts_the_child_and_closes_its_clients() {
    let scratch = Scratch::new("update");
    let pipe = pipe_name("update");
    let mut door = Door::with_echo(&scratch, &pipe, &[]);
    let (mut client, report) = attach(&pipe);
    assert_eq!(report["hello"]["console"], "active");
    door.say("locked");
    assert_eq!(client.json()["params"]["console"], "locked");

    client.write("exit 75");
    assert_eq!(client.line(), None, "the child's exit closes its clients");
    door.wait_log("child 2 (dev) started");

    // the next child is told the state as it is now, and takes the daemon again
    let (mut again, report) = attach(&pipe);
    assert_eq!(report["hello"]["console"], "locked");
    again.write("still here");
    assert_eq!(again.line().as_deref(), Some("still here"));

    // a crash is restarted after the first backoff
    again.write("exit 3");
    assert_eq!(again.line(), None);
    door.wait_log("exited with 3");
    door.wait_log("again in 1 s");
    door.wait_log("child 3 (dev) started");

    door.say("stop");
    assert!(door.wait_exit().success());
    let log = door.log();
    assert!(log.contains("a new version is current: starting again"), "{log}");
}

#[test]
fn the_child_drops_a_client_and_its_power_wants_are_followed() {
    let scratch = Scratch::new("drop");
    let pipe = pipe_name("drop");
    let mut door = Door::with_echo(&scratch, &pipe, &[]);
    let (mut client, _) = attach(&pipe);

    client.write("noise");
    assert_eq!(client.line().as_deref(), Some("noise made"));
    door.wait_log("child: door-echo: not JSON");

    // ready while the console is active: no hold; at the sign-in screen: a hold
    client.write("want true false");
    assert_eq!(client.line().as_deref(), Some("wanted"));
    door.say("signin");
    assert_eq!(client.json()["params"]["console"], "signin");
    door.wait_log("power: would set the system-required request");
    door.say("ac off");
    client.json();
    door.wait_log("power: would clear the system-required request");

    client.write("drop");
    assert_eq!(client.line(), None);
    door.wait_log("pipe: client 1 left");
    let (_next, report) = attach(&pipe);
    assert_eq!(report["open"]["conn"], 2);

    door.say("stop");
    assert!(door.wait_exit().success());
}

#[test]
fn a_client_of_another_user_is_refused() {
    let scratch = Scratch::new("refuse");
    let pipe = pipe_name("refuse");
    // the door is SYSTEM's: the test's user may open the pipe (it is the shim's own account)
    // but is not the door's user
    let mut door = Door::with_echo(&scratch, &pipe, &["--user-sid", "S-1-5-18"]);
    let mut client = connect(&pipe);
    client.write("attach");
    assert_eq!(client.line(), None);
    door.wait_log("pipe: refused a client of S-1-");
    assert!(!door.log().contains("attached"));
    door.say("stop");
    assert!(door.wait_exit().success());
}

#[test]
fn a_line_over_a_mebibyte_drops_the_client() {
    let scratch = Scratch::new("long");
    let pipe = pipe_name("long");
    let mut door = Door::with_echo(&scratch, &pipe, &[]);
    let (mut client, _) = attach(&pipe);
    let long = "x".repeat(1024 * 1024 + 1);
    // the write may fail once the shim has closed its end
    let _ = client.writer.write_all(long.as_bytes()).and_then(|_| client.writer.write_all(b"\n"));
    assert_eq!(client.line(), None);
    door.wait_log("wrote a line over 1 MiB: dropped");
    door.say("stop");
    assert!(door.wait_exit().success());
}

#[test]
fn the_pipe_name_cannot_be_had_twice() {
    let scratch = Scratch::new("twice");
    let pipe = pipe_name("twice");
    let mut first = Door::with_echo(&scratch, &pipe, &[]);
    let (mut client, _) = attach(&pipe);
    let second = Door::with_echo(&scratch, &pipe, &[]);
    let status = second.wait_exit();
    assert_eq!(status.code(), Some(1), "{}", second.log());
    assert!(second.log().contains("cannot create the pipe"), "{}", second.log());
    // the first is untouched
    client.write("ping");
    assert_eq!(client.line().as_deref(), Some("ping"));
    first.say("stop");
    assert!(first.wait_exit().success());
}

#[test]
fn with_no_version_to_run_the_door_waits_and_still_stops() {
    let scratch = Scratch::new("missing");
    let pipe = pipe_name("missing");
    let mut door = Door::start(&scratch, &pipe, &[]);
    door.wait_log("names no version; looking again in 60 s");
    // a client is closed at once: there is no child to attach it to
    let mut client = connect(&pipe);
    client.write("attach");
    assert_eq!(client.line(), None);
    door.wait_log("no child is running");
    door.say("stop");
    assert!(door.wait_exit().success(), "{}", door.log());
}

#[test]
fn a_version_from_the_program_folder_is_run_and_stdin_s_end_stops_it() {
    let scratch = Scratch::new("version");
    let pipe = pipe_name("version");
    let version = scratch.0.join("program").join("versions").join("0.21.0");
    let main = version.join("cophylad").join("apps").join("cophylad").join("src");
    fs::create_dir_all(&main).unwrap();
    fs::copy(echo_exe(), version.join("bun.exe")).unwrap();
    fs::write(main.join("main.ts"), "// the echo ignores its script").unwrap();
    fs::write(scratch.0.join("program").join("current"), "0.21.0\n").unwrap();
    let mut door = Door::start(&scratch, &pipe, &[]);
    let (mut client, report) = attach(&pipe);
    assert!(report["args"][0].as_str().unwrap().ends_with(r"versions\0.21.0\cophylad\apps\cophylad\src\main.ts"), "{report}");
    door.wait_log("child 1 (0.21.0) started");
    // the kit going away is a stop
    drop(door.stdin.take());
    assert!(door.wait_exit().success(), "{}", door.log());
    assert_eq!(client.line(), None);
}

#[test]
fn a_client_that_writes_nothing_is_closed() {
    let scratch = Scratch::new("silent");
    let pipe = pipe_name("silent");
    let mut door = Door::with_echo(&scratch, &pipe, &[]);
    let mut silent = connect(&pipe);
    // another client is let in meanwhile: the silent one holds only its own instance
    let (mut other, report) = attach(&pipe);
    assert_eq!(report["open"]["conn"], 2);
    other.write("ping");
    assert_eq!(other.line().as_deref(), Some("ping"));
    assert_eq!(silent.line(), None);
    door.wait_log("client 1 wrote nothing within 10 s: closed");
    assert!(!door.log().contains("client 1 attached"));
    door.say("stop");
    assert!(door.wait_exit().success());
}
