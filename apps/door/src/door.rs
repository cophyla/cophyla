//! The door's machinery, the same under the SCM and in a console: one thread owns all the
//! state and takes events from the others (the control handler or stdin, the child's stdout
//! and exit, the pipe's clients) in the order they came, with timers for a respawn, a stop's
//! grace, and the 10 s poll of the console and the power line that backs up the service's
//! notifications.
//!
//! The child is started from `program\versions\<current>` (or `--bun`/`--main`), told
//! `shim.hello` first and every change after; its `pipe.send`, `pipe.drop` and `power.want`
//! act on the clients and the power request. When it exits, for whatever reason, every client
//! is closed, so the daemon attaches again to the next child, and its wants are forgotten. A
//! client that connects while no child runs, or while the door stops, is closed at once. On a
//! stop the child gets `shim.stop` and STOP_GRACE_MS to exit 0, then it and everything it
//! started are killed; the power request is let go either way.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

pub use crate::win::child::ChildLog;

use crate::console::Console;
use crate::constants::STOP_GRACE_MS;
use crate::layout;
use crate::log::Logger;
use crate::power::{self, Want};
use crate::proto::{self, FromChild};
use crate::sddl;
use crate::supervisor::{Action, MonotonicClock, Policy, MISSING_RETRY_MS};
use crate::win::child::{self, Launch, Running};
use crate::win::pipe::{self, Client};
use crate::win::security;
use crate::win::session::{self, PowerHold};

/// How often the console and the power line are asked when nothing said they changed.
const POLL: Duration = Duration::from_secs(10);
/// How long a killed child has to be seen gone before the door stops waiting for it.
const KILL_WAIT: Duration = Duration::from_secs(5);
/// How much of a stray stdout line goes into the log.
const TEXT_LOG: usize = 2_000;

pub enum Event {
    /// Stop: the SCM, `stop` on stdin, or stdin's end.
    Stop,
    /// The console mode's stdin.
    Console(Console),
    Ac(bool),
    /// The service's notifications: ask again.
    SessionChanged,
    PowerChanged,
    /// A line on the stdout of child `gen`, without its line break.
    ChildLine { gen: u64, line: Vec<u8> },
    ChildExit { gen: u64, code: Option<i32> },
    PipeOpen { conn: u64, sid: String, client: Client },
    PipeLine { conn: u64, line: String },
    PipeClose { conn: u64 },
}

/// Where the console's state and the power line come from.
pub enum Sensors {
    /// Terminal Services and GetSystemPowerStatus, under the service.
    Live,
    /// stdin, in a console: `active` and AC until told otherwise.
    Stdin,
}

pub struct Options {
    pub program: PathBuf,
    pub home: PathBuf,
    pub pipe: String,
    pub user_sid: String,
    pub bun: Option<PathBuf>,
    pub main: Option<PathBuf>,
    /// false with `--no-power`: requests are logged, not made.
    pub power: bool,
    pub sensors: Sensors,
    pub child_log: ChildLog,
}

/// Runs the door until a stop. `up` is called once the pipe is there, for the service to say
/// it runs. An error is a door that could not start: the pipe's name taken, or no account.
pub fn run(options: Options, log: Logger, tx: Sender<Event>, rx: Receiver<Event>, up: impl FnOnce()) -> Result<(), String> {
    let own = security::process_user_sid().map_err(|e| format!("cannot read the shim's own account: {e}"))?;
    let descriptor = sddl::pipe(&own, &options.user_sid)?;
    let server = pipe::Server::start(&options.pipe, &descriptor, &options.user_sid, tx.clone(), log.clone()).map_err(|e| format!("cannot create the pipe {}: {e}", options.pipe))?;
    log.log(format!(
        "door {}: pipe {} for {}, the shim as {own}, program {}, home {}",
        env!("CARGO_PKG_VERSION"),
        options.pipe,
        options.user_sid,
        options.program.display(),
        options.home.display()
    ));
    up();
    let mut door = Door::new(options, log, tx);
    door.sense();
    door.spawn();
    door.serve(&rx);
    door.finish();
    server.stop();
    door.log.log("door stopped");
    Ok(())
}

struct Door {
    opts: Options,
    log: Logger,
    tx: Sender<Event>,
    console: Console,
    ac: bool,
    want: Want,
    power: PowerHold,
    child: Option<Running>,
    gen: u64,
    clients: HashMap<u64, Client>,
    policy: Policy<MonotonicClock>,
    stopping: bool,
    next_spawn: Option<Instant>,
    kill_at: Option<Instant>,
    give_up_at: Option<Instant>,
    next_poll: Option<Instant>,
    wts_warned: bool,
}

impl Door {
    fn new(opts: Options, log: Logger, tx: Sender<Event>) -> Door {
        let live = matches!(opts.sensors, Sensors::Live);
        let power = PowerHold::new(opts.power);
        Door {
            opts,
            log,
            tx,
            console: Console::Active,
            ac: true,
            want: Want::default(),
            power,
            child: None,
            gen: 0,
            clients: HashMap::new(),
            policy: Policy::new(MonotonicClock::new()),
            stopping: false,
            next_spawn: None,
            kill_at: None,
            give_up_at: None,
            next_poll: live.then(|| Instant::now() + POLL),
            wts_warned: false,
        }
    }

    fn serve(&mut self, rx: &Receiver<Event>) {
        loop {
            if self.stopping && self.child.is_none() {
                return;
            }
            let now = Instant::now();
            let deadline = [self.next_spawn, self.kill_at, self.give_up_at, self.next_poll].into_iter().flatten().min();
            let event = match deadline {
                Some(d) if d <= now => None,
                Some(d) => match rx.recv_timeout(d - now) {
                    Ok(e) => Some(e),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => Some(Event::Stop),
                },
                None => Some(rx.recv().unwrap_or(Event::Stop)),
            };
            if let Some(event) = event {
                self.handle(event);
            }
            self.timers();
        }
    }

    fn handle(&mut self, event: Event) {
        match event {
            Event::Stop => self.stop(),
            Event::Console(c) => self.set_console(c),
            Event::Ac(on) => self.set_ac(on),
            Event::SessionChanged => self.sense_console(),
            Event::PowerChanged => self.sense_ac(),
            Event::ChildLine { gen, line } => {
                if self.child.as_ref().is_some_and(|c| c.gen == gen) {
                    self.child_said(&line);
                }
            }
            Event::ChildExit { gen, code } => {
                if self.child.as_ref().is_some_and(|c| c.gen == gen) {
                    self.exited(code);
                }
            }
            Event::PipeOpen { conn, sid, client } => {
                if self.child.is_none() || self.stopping {
                    self.log.log(format!("pipe: client {conn} closed: no child is running"));
                    client.close();
                    return;
                }
                self.log.log(format!("pipe: client {conn} attached ({sid})"));
                self.clients.insert(conn, client);
                self.to_child(proto::pipe_open(conn, &sid));
            }
            Event::PipeLine { conn, line } => {
                if self.clients.contains_key(&conn) {
                    self.to_child(proto::pipe_line(conn, &line));
                }
            }
            Event::PipeClose { conn } => {
                if self.clients.remove(&conn).is_some() {
                    self.log.log(format!("pipe: client {conn} left"));
                    self.to_child(proto::pipe_close(conn));
                }
            }
        }
    }

    fn timers(&mut self) {
        let now = Instant::now();
        if self.next_spawn.is_some_and(|t| t <= now) {
            self.next_spawn = None;
            if !self.stopping && self.child.is_none() {
                self.spawn();
            }
        }
        if self.kill_at.is_some_and(|t| t <= now) {
            self.kill_at = None;
            if let Some(child) = &self.child {
                self.log.log(format!("child {} did not exit within {} s of shim.stop: killing it", child.gen, STOP_GRACE_MS / 1000));
                child.kill();
                self.give_up_at = Some(now + KILL_WAIT);
            }
        }
        if self.give_up_at.is_some_and(|t| t <= now) {
            self.give_up_at = None;
            if let Some(child) = self.child.take() {
                self.log.log(format!("child {} was not seen to exit after a kill; going on without it", child.gen));
            }
        }
        if self.next_poll.is_some_and(|t| t <= now) {
            self.next_poll = Some(now + POLL);
            self.sense();
        }
    }

    fn to_child(&self, line: Vec<u8>) {
        if let Some(child) = &self.child {
            child.send(line);
        }
    }

    /// What to start, or why nothing can be.
    fn launch(&self) -> Result<Launch, String> {
        let program = &self.opts.program;
        let current = layout::read_pointer(program, "current");
        if let (Some(bun), Some(main)) = (&self.opts.bun, &self.opts.main) {
            return Ok(Launch { bun: bun.clone(), main: main.clone(), label: current.unwrap_or_else(|| "dev".into()), counted: None });
        }
        let version = current.ok_or_else(|| format!("{} names no version", program.join("current").display()))?;
        let (bun, main) = layout::launch_paths(program, &version);
        let counted = (self.opts.bun.is_none() && self.opts.main.is_none()).then(|| version.clone());
        let bun = self.opts.bun.clone().unwrap_or(bun);
        let main = self.opts.main.clone().unwrap_or(main);
        for file in [&bun, &main] {
            if !file.is_file() {
                return Err(format!("{} is missing", file.display()));
            }
        }
        Ok(Launch { bun, main, label: version, counted })
    }

    fn spawn(&mut self) {
        let launch = match self.launch() {
            Ok(l) => l,
            Err(why) => {
                self.log.log(format!("cannot start the door's child: {why}; looking again in {} s", MISSING_RETRY_MS / 1000));
                self.next_spawn = Some(Instant::now() + Duration::from_millis(MISSING_RETRY_MS));
                return;
            }
        };
        self.gen += 1;
        match child::spawn(&launch, &self.opts.home, &self.opts.program, self.gen, &self.tx, &self.opts.child_log, &self.log) {
            Ok(running) => {
                self.policy.started(running.counted.as_deref());
                self.log.log(format!("child {} ({}) started, pid {}: {} {}", running.gen, running.label, running.pid, launch.bun.display(), launch.main.display()));
                running.send(proto::hello(self.console, self.ac, &self.opts.user_sid));
                self.child = Some(running);
            }
            Err(e) => {
                self.log.log(format!("cannot start {}: {e}", launch.bun.display()));
                self.after_exit(launch.counted, &launch.label, None);
            }
        }
    }

    fn exited(&mut self, code: Option<i32>) {
        let Some(child) = self.child.take() else { return };
        let up = child.started.elapsed();
        if !self.clients.is_empty() {
            self.log.log(format!("pipe: closing {} client(s) with child {}", self.clients.len(), child.gen));
        }
        // each closes once what was queued for it is written
        self.clients.clear();
        self.want = Want::default();
        self.apply_power();
        let code_text = code.map_or("no code".to_string(), |c| c.to_string());
        let (gen, label, counted) = (child.gen, child.label.clone(), child.counted.clone());
        // its job's handle closes with it: what it started goes too
        drop(child);
        if self.stopping {
            self.log.log(format!("child {gen} exited with {code_text}"));
            return;
        }
        self.log.log(format!("child {gen} ({label}) exited with {code_text} after {:.1} s", up.as_secs_f64()));
        self.after_exit(counted, &label, code);
    }

    /// What the supervisor says after an exit or a failed start, done.
    fn after_exit(&mut self, counted: Option<String>, label: &str, code: Option<i32>) {
        let program = self.opts.program.clone();
        let previous = counted.as_ref().and_then(|_| layout::read_pointer(&program, "previous")).filter(|p| layout::is_launchable(&program, p));
        let now = Instant::now();
        match self.policy.exited(counted.as_deref(), code, previous.as_deref()) {
            Action::Respawn => {
                self.log.log("a new version is current: starting again");
                self.next_spawn = Some(now);
            }
            Action::Restart { after_ms } => {
                self.log.log(format!("starting {label} again in {} s", after_ms as f64 / 1000.0));
                self.next_spawn = Some(now + Duration::from_millis(after_ms));
            }
            Action::FallBack { bad, to } => {
                let reason = format!("crashed {} times within {} s of its first start", self.policy.crashes(&bad), crate::constants::CRASH_WINDOW_MS / 1000);
                match layout::fall_back(&program, &bad, &to, &reason) {
                    Ok(()) => {
                        self.log.log(format!("{bad} {reason}: marked broken, falling back to {to}"));
                        self.next_spawn = Some(now);
                    }
                    Err(e) => {
                        self.log.log(format!("{bad} {reason}, and falling back to {to} failed: {e}; trying {bad} again in {} s", MISSING_RETRY_MS / 1000));
                        self.next_spawn = Some(now + Duration::from_millis(MISSING_RETRY_MS));
                    }
                }
            }
        }
    }

    fn child_said(&mut self, line: &[u8]) {
        match proto::from_child(line) {
            FromChild::Send { conn, line } => match self.clients.get(&conn) {
                Some(client) => {
                    if !client.send(&line) {
                        self.log.log(format!("pipe: client {conn} is not reading: dropped"));
                    }
                }
                None => self.log.log(format!("pipe.send for client {conn}, which is not attached")),
            },
            FromChild::Drop { conn } => {
                if let Some(client) = self.clients.get(&conn) {
                    self.log.log(format!("pipe: dropping client {conn}, as the child asked"));
                    client.close();
                }
            }
            FromChild::Want { ready, streaming } => {
                self.want = Want { ready, streaming };
                self.apply_power();
            }
            FromChild::Unknown { method } => self.log.log(format!("child: {method} is not a method this shim knows; ignored")),
            FromChild::Malformed { method, why } => self.log.log(format!("child: {method} ignored: {why}")),
            FromChild::Text => {
                let text = String::from_utf8_lossy(line);
                let cut: String = text.chars().take(TEXT_LOG).collect();
                self.log.log(format!("child: {cut}{}", if cut.len() < text.len() { "…" } else { "" }));
            }
        }
    }

    fn sense(&mut self) {
        self.sense_console();
        self.sense_ac();
    }

    fn sense_console(&mut self) {
        if matches!(self.opts.sensors, Sensors::Live) {
            let c = session::console_state(&mut self.wts_warned, &self.log);
            self.set_console(c);
        }
    }

    fn sense_ac(&mut self) {
        if matches!(self.opts.sensors, Sensors::Live) {
            if let Some(on) = session::ac() {
                self.set_ac(on);
            }
        }
    }

    fn set_console(&mut self, console: Console) {
        if console == self.console {
            return;
        }
        self.log.log(format!("console: {} -> {}", self.console.as_str(), console.as_str()));
        self.console = console;
        self.to_child(proto::console_state(console));
        self.apply_power();
    }

    fn set_ac(&mut self, ac: bool) {
        if ac == self.ac {
            return;
        }
        self.log.log(format!("power: {}", if ac { "on AC" } else { "on battery" }));
        self.ac = ac;
        self.to_child(proto::power_state(ac));
        self.apply_power();
    }

    fn apply_power(&mut self) {
        let hold = power::hold(self.want, self.console, self.ac);
        let why = format!(
            "{}{}, console {}, {}",
            if self.want.streaming { "streaming" } else { "not streaming" },
            if self.want.ready { ", ready" } else { ", not ready" },
            self.console.as_str(),
            if self.ac { "AC" } else { "battery" }
        );
        self.power.set(hold, &why, &self.log);
    }

    fn stop(&mut self) {
        if self.stopping {
            return;
        }
        self.stopping = true;
        self.next_spawn = None;
        match &self.child {
            Some(child) => {
                self.log.log(format!("stopping: shim.stop to child {}, {} s to exit", child.gen, STOP_GRACE_MS / 1000));
                child.send(proto::shim_stop());
                self.kill_at = Some(Instant::now() + Duration::from_millis(STOP_GRACE_MS as u64));
            }
            None => self.log.log("stopping"),
        }
    }

    fn finish(&mut self) {
        self.clients.clear();
        self.want = Want::default();
        self.apply_power();
    }
}
