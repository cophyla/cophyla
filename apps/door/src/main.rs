//! `cophyla-door`: the CophylaDoor service, and the commands that install, remove and report on
//! it.
//!   cophyla-door service                      what the SCM runs
//!   cophyla-door run --console [...]          the same machinery in a console, for kits
//!   cophyla-door install --from <v> --user-sid <sid> [--result <file>]   elevated
//!   cophyla-door uninstall [--result <file>]  elevated
//!   cophyla-door status                       one JSON line
//! The service supervises a Bun child (cophylad's `main.ts door`) from `program\versions\
//! <current>`, tells it the console's state and the power line over stdio, holds a power request
//! while the rule in `power` says so, and bridges `\\.\pipe\cophyla-door`, where the door's user
//! alone may attach, to the child's stdio. Everything that decides something (arguments, the
//! protocols, the console and power rules, the supervisor, the SDDL, the layout) is
//! platform-free and tested on every OS; what calls Windows is under `win` and `door`, and on
//! another OS the program only says it is Windows only.

#![cfg_attr(not(windows), allow(dead_code))]

mod args;
mod childenv;
mod console;
mod constants;
mod layout;
mod log;
mod power;
mod proto;
mod sddl;
mod status;
mod supervisor;

#[cfg(windows)]
mod door;
#[cfg(windows)]
mod win;

#[cfg(windows)]
fn main() {
    std::process::exit(win::main());
}

#[cfg(not(windows))]
fn main() {
    eprintln!("cophyla-door is Windows only: the door is a Windows service.");
    std::process::exit(2);
}
