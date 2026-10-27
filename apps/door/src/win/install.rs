//! The elevated install and uninstall, run once each through ShellExecuteEx `runas`, whose
//! caller cannot see stdout: the outcome goes to `--result` as one JSON object, written to a
//! temporary file and renamed over the path, so the caller never reads half of one and a link
//! planted at the path is replaced, not followed. Exit codes: 0 done, 1 failed, 2 bad
//! arguments, 5 not elevated.
//!
//! The install takes a user's installed platform version and makes the machine's door of it:
//! it refuses a data root someone else made (users may create folders under `%ProgramData%`,
//! so a squatter could have made it first, with a DACL of their own), stops a running door,
//! copies this exe, the runtime and cophylad's tree (without the models, the views and the
//! phone app) and cophyla-net under `%ProgramFiles%\Cophyla Door`, points `current` at the
//! version, creates or updates the service, sets the ACLs, writes `door.json`, replaces the two
//! firewall rules and starts the service. Links found under the folders the service may write
//! are removed before an administrator copies into them or sets their ACLs, since the service
//! account could have made them to point the install elsewhere. The uninstall removes all of
//! it, the data root (which holds the door's secrets) first.

use std::env;
use std::fs;
use std::io;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::json;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

use super::{is_within, machine_layout, scm, security, system32, system_root};
use crate::args::InstallArgs;
use crate::constants::{EXE_NAME, FIREWALL_NET, FIREWALL_STREAMER};
use crate::layout::{self, DoorConfig, Layout, BUN, DOOR_JSON, LICENCES, RELEASE_FILE};
use crate::log::Logger;
use crate::sddl;

const STOP_WAIT: Duration = Duration::from_secs(20);
const START_WAIT: Duration = Duration::from_secs(15);

/// Why an install or an uninstall ended without doing it, and its exit code.
struct Fail {
    code: i32,
    message: String,
}

fn failed(message: impl Into<String>) -> Fail {
    Fail { code: 1, message: message.into() }
}

fn bad(message: impl Into<String>) -> Fail {
    Fail { code: 2, message: message.into() }
}

fn not_elevated() -> Fail {
    Fail { code: 5, message: "this needs an elevated process".into() }
}

/// Writes the outcome where the caller looks: `{"ok":true,"version":v}` (no version for an
/// uninstall) or `{"ok":false,"error":e}`.
pub fn write_result(path: &Path, outcome: Result<Option<&str>, &str>, log: Option<&Logger>) {
    let body = match outcome {
        Ok(Some(v)) => json!({ "ok": true, "version": v }),
        Ok(None) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    };
    if let Err(e) = layout::write_text(path, &format!("{body}\n")) {
        match log {
            Some(log) => log.log(format!("cannot write the result to {}: {e}", path.display())),
            None => eprintln!("cophyla-door: cannot write the result to {}: {e}", path.display()),
        }
    }
}

fn finish(log: &Logger, result: Option<PathBuf>, outcome: Result<Option<String>, Fail>, what: &str) -> i32 {
    match outcome {
        Ok(version) => {
            log.log(format!("{what}: done"));
            if let Some(path) = result {
                write_result(&path, Ok(version.as_deref()), Some(log));
            }
            0
        }
        Err(fail) => {
            log.log(format!("{what} failed: {}", fail.message));
            if let Some(path) = result {
                write_result(&path, Err(&fail.message), Some(log));
            }
            fail.code
        }
    }
}

pub fn install(args: InstallArgs) -> i32 {
    let log = Logger::buffer(true);
    let result = args.result.clone();
    let outcome = run_install(args, &log).map(Some);
    finish(&log, result, outcome, "install")
}

pub fn uninstall(result: Option<PathBuf>) -> i32 {
    let log = Logger::buffer(true);
    let outcome = run_uninstall(&log).map(|()| None);
    finish(&log, result, outcome, "uninstall")
}

/// The files a version folder must hold for the door to run from it.
fn check_version_dir(from: &Path) -> Result<String, Fail> {
    if !from.is_dir() {
        return Err(bad(format!("--from {} is not a folder", from.display())));
    }
    let version = from.file_name().and_then(|n| n.to_str()).filter(|v| layout::is_version(v)).ok_or_else(|| bad(format!("--from {} is not named for a version", from.display())))?;
    let cophylad = from.join("cophylad");
    let mut need = vec![from.join(BUN), from.join(RELEASE_FILE), from.join("bin").join("cophyla-net.exe")];
    need.push(layout::MAIN.iter().fold(from.to_path_buf(), |p, c| p.join(c)));
    for file in &need {
        if !file.is_file() {
            return Err(bad(format!("{} is missing", file.display())));
        }
    }
    let modules = [cophylad.join("apps").join("cophylad").join("node_modules"), cophylad.join("node_modules")];
    if !modules.iter().any(|m| m.is_dir()) {
        return Err(bad(format!("{} has no node_modules", cophylad.display())));
    }
    Ok(version.to_string())
}

/// Takes the data root as the install's own, or refuses it: one that is there already must be
/// a plain folder owned by SYSTEM or Administrators; a missing one is made with SYSTEM and
/// Administrators alone, the service added once it exists.
fn secure_data_root(data: &Path) -> Result<(), Fail> {
    match fs::symlink_metadata(data) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err(failed(format!("{} is there and is not a plain folder; refusing to use it", data.display())));
            }
            let owner = security::owner_sid(data).map_err(|e| failed(format!("cannot read who owns {} ({e}); refusing to use it", data.display())))?;
            if !sddl::is_trusted_owner(&owner) {
                return Err(failed(format!(
                    "{} is there already and owned by {owner}, not SYSTEM or Administrators: someone else may have made it, so the door will not use it. Remove it and install again",
                    data.display()
                )));
            }
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            if let Some(parent) = data.parent() {
                fs::create_dir_all(parent).map_err(|e| failed(format!("cannot create {}: {e}", parent.display())))?;
            }
            let descriptor = sddl::protected_folder(None).map_err(failed)?;
            security::create_dir_with(data, &descriptor).map_err(|e| failed(format!("cannot create {}: {e}", data.display())))
        }
        Err(e) => Err(failed(format!("cannot look at {}: {e}", data.display()))),
    }
}

/// Removes every symbolic link and junction below `dir` (not following any), and `dir` itself
/// if it is one.
fn remove_links(dir: &Path, log: &Logger) -> io::Result<()> {
    let meta = match fs::symlink_metadata(dir) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if meta.file_type().is_symlink() {
        log.log(format!("removing a link at {}", dir.display()));
        return fs::remove_dir(dir).or_else(|_| fs::remove_file(dir));
    }
    if !meta.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            log.log(format!("removing a link at {}", path.display()));
            fs::remove_dir(&path).or_else(|_| fs::remove_file(&path))?;
        } else if kind.is_dir() {
            remove_links(&path, log)?;
        }
    }
    Ok(())
}

/// Copies `src` over `dst`; a `dst` in use (a service image that has not quite let go) is moved
/// aside first, and removed after if it can be.
fn replace_file(src: &Path, dst: &Path) -> io::Result<()> {
    if fs::copy(src, dst).is_ok() {
        return Ok(());
    }
    if !dst.exists() {
        return fs::copy(src, dst).map(|_| ());
    }
    let name = dst.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let aside = dst.with_file_name(format!("{name}.old-{}", std::process::id()));
    fs::rename(dst, &aside)?;
    fs::copy(src, dst)?;
    let _ = fs::remove_file(&aside);
    Ok(())
}

/// Removes what earlier installs left aside in `dir`.
fn remove_aside(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().contains(".old-") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Copies a tree, files and folders only: a link is not followed, and what `skip` names (by
/// its path below `base`) is left out. The number of files copied.
fn copy_tree(src: &Path, dst: &Path, base: &Path, skip: &dyn Fn(&Path) -> bool, log: &Logger) -> io::Result<u64> {
    fs::create_dir_all(dst)?;
    let mut files = 0;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let rel = from.strip_prefix(base).unwrap_or(&from).to_path_buf();
        if skip(&rel) {
            continue;
        }
        let to = dst.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            log.log(format!("not copying the link {}", rel.display()));
        } else if kind.is_dir() {
            files += copy_tree(&from, &to, base, skip, log)?;
        } else if kind.is_file() {
            fs::copy(&from, &to).map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", rel.display())))?;
            files += 1;
        }
    }
    Ok(files)
}

/// Runs a system tool with its arguments as Windows will read them; its output to the log.
fn tool(exe: &str, args: &str, log: &Logger) -> io::Result<bool> {
    let out = Command::new(system32(exe)).raw_arg(args).current_dir(system_root()).stdin(Stdio::null()).creation_flags(CREATE_NO_WINDOW).output()?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    log.log(format!("{exe} {args}: {} {text}", if out.status.success() { "ok" } else { "failed" }));
    Ok(out.status.success())
}

fn delete_rule(name: &str, log: &Logger) {
    // no rule by that name is no failure
    let _ = tool("netsh.exe", &format!("advfirewall firewall delete rule name=\"{name}\""), log);
}

fn add_rule(name: &str, program: &Path, log: &Logger) -> Result<(), Fail> {
    let args = format!("advfirewall firewall add rule name=\"{name}\" dir=in action=allow protocol=UDP profile=any enable=yes program=\"{}\"", program.display());
    match tool("netsh.exe", &args, log) {
        Ok(true) => Ok(()),
        Ok(false) => Err(failed(format!("netsh could not add the firewall rule {name}"))),
        Err(e) => Err(failed(format!("cannot run netsh: {e}"))),
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn run_install(args: InstallArgs, log: &Logger) -> Result<String, Fail> {
    if !security::is_elevated() {
        return Err(not_elevated());
    }
    let from = std::path::absolute(&args.from).unwrap_or(args.from.clone());
    let version = check_version_dir(&from)?;
    let user_sid = security::canonical_sid(&args.user_sid).ok_or_else(|| bad(format!("--user-sid {} is not a SID", args.user_sid)))?;
    let layout: Layout = machine_layout();

    // the data root before anything changes: refused, nothing has
    secure_data_root(&layout.data)?;
    log.to_file(&layout.data.join("install.log")).map_err(|e| failed(format!("cannot write install.log: {e}")))?;
    log.log(format!("installing the door {version} from {} for {user_sid}, shim {}", from.display(), env!("CARGO_PKG_VERSION")));

    let manager = scm::manager(scm::MANAGER_ALL).map_err(|e| failed(format!("cannot open the SCM: {e}")))?;
    if let Some(existing) = scm::open(&manager, scm::SERVICE_ALL).map_err(|e| failed(format!("cannot open the service: {e}")))? {
        match scm::stop(&existing, STOP_WAIT, log) {
            Ok(true) => log.log("the running door is stopped"),
            Ok(false) => log.log("the running door did not stop; going on, and a file in use will fail the install"),
            Err(e) => log.log(format!("cannot stop the running door: {e}")),
        }
    }

    // the service is stopped: nothing of its own can race what follows
    remove_links(&layout.program, log).map_err(|e| failed(format!("cannot check {} for links: {e}", layout.program.display())))?;
    remove_links(&layout.data, log).map_err(|e| failed(format!("cannot check {} for links: {e}", layout.data.display())))?;

    fs::create_dir_all(&layout.root).map_err(|e| failed(format!("cannot create {}: {e}", layout.root.display())))?;
    remove_aside(&layout.root);
    let me = env::current_exe().map_err(|e| failed(format!("cannot find this exe: {e}")))?;
    let target = layout.exe();
    let same = fs::canonicalize(&me).ok().zip(fs::canonicalize(&target).ok()).is_some_and(|(a, b)| a == b);
    if !same {
        replace_file(&me, &target).map_err(|e| failed(format!("cannot copy {EXE_NAME} to {}: {e}", target.display())))?;
        if let Some(licences) = me.parent().map(|d| d.join(LICENCES)).filter(|p| p.is_file()) {
            replace_file(&licences, &layout.root.join(LICENCES)).map_err(|e| failed(format!("cannot copy {LICENCES}: {e}")))?;
        }
        log.log(format!("copied {} to {}", me.display(), target.display()));
    }

    let vdir = layout::version_dir(&layout.program, &version);
    if vdir.exists() {
        fs::remove_dir_all(&vdir).map_err(|e| failed(format!("cannot clear {}: {e}", vdir.display())))?;
    }
    fs::create_dir_all(&vdir).map_err(|e| failed(format!("cannot create {}: {e}", vdir.display())))?;
    for file in [BUN, RELEASE_FILE] {
        fs::copy(from.join(file), vdir.join(file)).map_err(|e| failed(format!("cannot copy {file}: {e}")))?;
    }
    let files = copy_tree(&from.join("cophylad"), &vdir.join("cophylad"), &from, &layout::is_excluded, log).map_err(|e| failed(format!("cannot copy cophylad's tree: {e}")))?;
    log.log(format!("copied {version}: bun, release.json and {files} files of cophylad's tree"));

    let bin = layout.program.join("bin");
    fs::create_dir_all(&bin).map_err(|e| failed(format!("cannot create {}: {e}", bin.display())))?;
    remove_aside(&bin);
    replace_file(&from.join("bin").join("cophyla-net.exe"), &layout.net()).map_err(|e| failed(format!("cannot copy cophyla-net.exe: {e}")))?;
    layout::write_pointer(&layout.program, "current", &version).map_err(|e| failed(format!("cannot write current: {e}")))?;
    log.log(format!("current is {version}"));

    let binary = format!("\"{}\" service", target.display());
    let service = scm::create_or_update(&manager, &binary).map_err(|e| failed(format!("cannot create the service: {e}")))?;
    scm::configure(&service).map_err(|e| failed(format!("cannot configure the service: {e}")))?;
    log.log(format!("the service runs {binary} as {}", scm::account()));

    let service_sid = security::account_sid(&scm::account()).map_err(|e| failed(format!("cannot look up {}: {e}", scm::account())))?;
    let grant = format!("\"{}\" /grant \"{}:(OI)(CI)M\"", layout.program.display(), scm::account());
    if !tool("icacls.exe", &grant, log).map_err(|e| failed(format!("cannot run icacls: {e}")))? {
        return Err(failed(format!("icacls could not give the service Modify on {}", layout.program.display())));
    }
    let protected = sddl::protected_folder(Some(&service_sid)).map_err(failed)?;
    // the web viewer keeps its pairing with the desktop host (a client key) here: no Users
    let viewer = layout.program.join("moonlight-web");
    if viewer.is_dir() {
        security::set_protected_dacl(&viewer, &protected).map_err(|e| failed(format!("cannot protect {}: {e}", viewer.display())))?;
    } else {
        security::create_dir_with(&viewer, &protected).map_err(|e| failed(format!("cannot create {}: {e}", viewer.display())))?;
    }
    security::set_protected_dacl(&layout.data, &protected).map_err(|e| failed(format!("cannot protect {}: {e}", layout.data.display())))?;
    log.log(format!("ACLs set: {} for the service ({service_sid}) with Modify; {} and the data root protected", layout.program.display(), viewer.display()));

    let config = DoorConfig { user_sid: user_sid.clone(), version: version.clone(), installed_at: now_ms() };
    layout::write_text(&layout.data.join(DOOR_JSON), &config.encode()).map_err(|e| failed(format!("cannot write door.json: {e}")))?;

    delete_rule(FIREWALL_STREAMER, log);
    delete_rule(FIREWALL_NET, log);
    add_rule(FIREWALL_STREAMER, &layout.streamer(), log)?;
    add_rule(FIREWALL_NET, &layout.net(), log)?;

    let running = scm::start(&service, START_WAIT).map_err(|e| failed(format!("cannot start the service: {e}")))?;
    log.log(format!("the door is running, pid {}", running.dwProcessId));
    Ok(version)
}

fn run_uninstall(log: &Logger) -> Result<(), Fail> {
    if !security::is_elevated() {
        return Err(not_elevated());
    }
    let layout = machine_layout();
    log.log(format!("uninstalling the door, shim {}", env!("CARGO_PKG_VERSION")));
    let mut errors: Vec<String> = Vec::new();

    match scm::manager(scm::MANAGER_ALL).and_then(|m| scm::open(&m, scm::SERVICE_ALL)) {
        Ok(Some(service)) => {
            match scm::stop(&service, STOP_WAIT, log) {
                Ok(true) => log.log("the door is stopped"),
                Ok(false) => errors.push("the service did not stop".into()),
                Err(e) => errors.push(format!("cannot stop the service: {e}")),
            }
            match scm::delete(&service) {
                Ok(()) => log.log("the service is deleted"),
                Err(e) => errors.push(format!("cannot delete the service: {e}")),
            }
        }
        Ok(None) => log.log("no service to delete"),
        Err(e) => errors.push(format!("cannot open the SCM: {e}")),
    }

    delete_rule(FIREWALL_STREAMER, log);
    delete_rule(FIREWALL_NET, log);

    // the data root holds the door's secrets: it goes first, links removed rather than followed
    match fs::symlink_metadata(&layout.data) {
        Ok(meta) if meta.file_type().is_symlink() => {
            if let Err(e) = fs::remove_dir(&layout.data).or_else(|_| fs::remove_file(&layout.data)) {
                errors.push(format!("cannot remove the link at {}: {e}", layout.data.display()));
            }
        }
        Ok(_) => match fs::remove_dir_all(&layout.data) {
            Ok(()) => log.log(format!("removed {}", layout.data.display())),
            Err(e) => errors.push(format!("cannot remove {}: {e}", layout.data.display())),
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => errors.push(format!("cannot look at {}: {e}", layout.data.display())),
    }

    if layout.root.exists() {
        let me = env::current_exe().ok().and_then(|p| fs::canonicalize(p).ok());
        let root = fs::canonicalize(&layout.root).unwrap_or(layout.root.clone());
        match me.filter(|me| is_within(me, &root)) {
            None => match fs::remove_dir_all(&layout.root) {
                Ok(()) => log.log(format!("removed {}", layout.root.display())),
                Err(e) => errors.push(format!("cannot remove {}: {e}", layout.root.display())),
            },
            Some(me) => {
                // this exe is in the folder: everything else now, the folder once it has exited
                for entry in fs::read_dir(&root).into_iter().flatten().flatten() {
                    let path = entry.path();
                    if fs::canonicalize(&path).ok().as_ref() == Some(&me) {
                        continue;
                    }
                    let gone = match entry.file_type() {
                        Ok(t) if t.is_dir() && !t.is_symlink() => fs::remove_dir_all(&path),
                        Ok(t) if t.is_symlink() => fs::remove_dir(&path).or_else(|_| fs::remove_file(&path)),
                        _ => fs::remove_file(&path),
                    };
                    if let Err(e) = gone {
                        errors.push(format!("cannot remove {}: {e}", path.display()));
                    }
                }
                let ping = system32("PING.EXE");
                let line = format!("/d /s /c \"\"{}\" -n 3 127.0.0.1 >nul & rmdir /s /q \"{}\"\"", ping.display(), layout.root.display());
                match Command::new(system32("cmd.exe")).raw_arg(&line).current_dir(system_root()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(CREATE_NO_WINDOW).spawn() {
                    Ok(_) => log.log(format!("{} is removed once this exits", layout.root.display())),
                    Err(e) => errors.push(format!("cannot leave {} to be removed: {e}", layout.root.display())),
                }
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(failed(errors.join("; ")))
    }
}
