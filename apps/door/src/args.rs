//! The command line, parsed into a mode and nothing more: defaults that come from the machine
//! (`%ProgramData%`, the process's own user) are filled in by the mode that needs them, so this
//! stays the same on every OS and is tested everywhere. Flags take `--name value` or
//! `--name=value`; a flag given twice, one unknown, or a value missing is a usage error
//! (exit 2), as is a SID or a pipe name that cannot be one.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

use crate::sddl;

pub const USAGE: &str = "usage:
  cophyla-door service
  cophyla-door run --console [--home <dir>] [--program <dir>] [--data <dir>] [--pipe <name>] [--user-sid <sid>] [--bun <path>] [--main <path>] [--no-power]
  cophyla-door install --from <versionDir> --user-sid <sid> [--result <file>]
  cophyla-door uninstall [--result <file>]
  cophyla-door status";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    /// What the SCM runs.
    Service,
    /// The service's machinery in a console, driven by stdin.
    Run(RunArgs),
    Install(InstallArgs),
    Uninstall { result: Option<PathBuf> },
    Status,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunArgs {
    pub home: Option<PathBuf>,
    pub program: Option<PathBuf>,
    pub data: Option<PathBuf>,
    pub pipe: Option<String>,
    pub user_sid: Option<String>,
    pub bun: Option<PathBuf>,
    pub main: Option<PathBuf>,
    pub no_power: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallArgs {
    pub from: PathBuf,
    pub user_sid: String,
    pub result: Option<PathBuf>,
}

/// The flags one mode takes, read off the arguments after the mode's name.
struct Flags {
    values: Vec<(&'static str, OsString)>,
    switches: Vec<&'static str>,
}

impl Flags {
    fn parse(args: &[OsString], valued: &[&'static str], switches: &[&'static str]) -> Result<Flags, String> {
        let mut flags = Flags { values: Vec::new(), switches: Vec::new() };
        let mut i = 0;
        while i < args.len() {
            let arg = args[i].to_str().ok_or_else(|| format!("not text: {}", args[i].to_string_lossy()))?;
            i += 1;
            let (name, inline) = match arg.split_once('=') {
                Some((n, v)) if n.starts_with("--") => (n, Some(v)),
                _ => (arg, None),
            };
            if let Some(&known) = switches.iter().find(|s| **s == name) {
                if inline.is_some() {
                    return Err(format!("{name} takes no value"));
                }
                if flags.switches.contains(&known) {
                    return Err(format!("{name} given twice"));
                }
                flags.switches.push(known);
            } else if let Some(&known) = valued.iter().find(|s| **s == name) {
                let value = match inline {
                    Some(v) => OsString::from(v),
                    None => {
                        let v = args.get(i).ok_or_else(|| format!("{name} needs a value"))?.clone();
                        i += 1;
                        v
                    }
                };
                if value.is_empty() {
                    return Err(format!("{name} needs a value"));
                }
                if flags.values.iter().any(|(n, _)| *n == known) {
                    return Err(format!("{name} given twice"));
                }
                flags.values.push((known, value));
            } else {
                return Err(format!("unknown argument: {arg}"));
            }
        }
        Ok(flags)
    }

    fn value(&self, name: &str) -> Option<&OsStr> {
        self.values.iter().find(|(n, _)| *n == name).map(|(_, v)| v.as_os_str())
    }

    fn path(&self, name: &str) -> Option<PathBuf> {
        self.value(name).map(PathBuf::from)
    }

    fn text(&self, name: &str) -> Result<Option<String>, String> {
        self.value(name).map(|v| v.to_str().map(str::to_string).ok_or_else(|| format!("{name} is not text"))).transpose()
    }

    fn sid(&self, name: &str) -> Result<Option<String>, String> {
        let sid = self.text(name)?;
        if let Some(s) = &sid {
            if !sddl::is_sid(s) {
                return Err(format!("{name} is not a SID: {s}"));
            }
        }
        Ok(sid)
    }

    fn has(&self, name: &str) -> bool {
        self.switches.contains(&name)
    }
}

/// The mode the arguments (without the program's own name) ask for.
pub fn parse(args: &[OsString]) -> Result<Mode, String> {
    let Some(mode) = args.first() else { return Err("no mode given".into()) };
    let rest = &args[1..];
    match mode.to_str() {
        Some("service") => {
            Flags::parse(rest, &[], &[])?;
            Ok(Mode::Service)
        }
        Some("run") => {
            let f = Flags::parse(rest, &["--home", "--program", "--data", "--pipe", "--user-sid", "--bun", "--main"], &["--console", "--no-power"])?;
            if !f.has("--console") {
                return Err("run needs --console: the service itself runs as `service`".into());
            }
            let pipe = f.text("--pipe")?;
            if let Some(p) = &pipe {
                let local = p.get(..9).is_some_and(|head| head.eq_ignore_ascii_case(r"\\.\pipe\"));
                if !local || p.len() == 9 || p[9..].contains('\\') {
                    return Err(format!(r"--pipe must be \\.\pipe\<name>: {p}"));
                }
            }
            Ok(Mode::Run(RunArgs {
                home: f.path("--home"),
                program: f.path("--program"),
                data: f.path("--data"),
                pipe,
                user_sid: f.sid("--user-sid")?,
                bun: f.path("--bun"),
                main: f.path("--main"),
                no_power: f.has("--no-power"),
            }))
        }
        Some("install") => {
            let f = Flags::parse(rest, &["--from", "--user-sid", "--result"], &[])?;
            let from = f.path("--from").ok_or("install needs --from <versionDir>")?;
            let user_sid = f.sid("--user-sid")?.ok_or("install needs --user-sid <sid>")?;
            Ok(Mode::Install(InstallArgs { from, user_sid, result: f.path("--result") }))
        }
        Some("uninstall") => {
            let f = Flags::parse(rest, &["--result"], &[])?;
            Ok(Mode::Uninstall { result: f.path("--result") })
        }
        Some("status") => {
            Flags::parse(rest, &[], &[])?;
            Ok(Mode::Status)
        }
        _ => Err(format!("unknown mode: {}", mode.to_string_lossy())),
    }
}

/// The `--result` path of an install or uninstall, read as well as it can be from arguments
/// that did not parse, so even a usage error is written where the caller looks.
pub fn result_path(args: &[OsString]) -> Option<PathBuf> {
    let mode = args.first()?.to_str()?;
    if mode != "install" && mode != "uninstall" {
        return None;
    }
    let mut it = args[1..].iter();
    while let Some(arg) = it.next() {
        let text = arg.to_str()?;
        if text == "--result" {
            return it.next().filter(|v| !v.is_empty()).map(PathBuf::from);
        }
        if let Some(v) = text.strip_prefix("--result=") {
            return (!v.is_empty()).then(|| PathBuf::from(v));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    const SID: &str = "S-1-5-21-1004336348-1177238915-682003330-1001";

    #[test]
    fn service_and_status_take_nothing() {
        assert_eq!(parse(&args(&["service"])), Ok(Mode::Service));
        assert_eq!(parse(&args(&["status"])), Ok(Mode::Status));
        assert!(parse(&args(&["status", "--json"])).is_err());
        assert!(parse(&args(&[])).is_err());
        assert!(parse(&args(&["serve"])).is_err());
    }

    #[test]
    fn run_needs_console_and_reads_every_flag() {
        assert!(parse(&args(&["run"])).is_err());
        assert_eq!(parse(&args(&["run", "--console"])), Ok(Mode::Run(RunArgs::default())));
        let mode = parse(&args(&[
            "run", "--console", "--home", r"C:\t\home", "--program=C:\\t\\program", "--data", r"C:\t\data", "--pipe", r"\\.\pipe\door-test-1",
            "--user-sid", SID, "--bun", "bun", "--main", r"apps\cophylad\src\main.ts", "--no-power",
        ]))
        .unwrap();
        assert_eq!(
            mode,
            Mode::Run(RunArgs {
                home: Some(r"C:\t\home".into()),
                program: Some(r"C:\t\program".into()),
                data: Some(r"C:\t\data".into()),
                pipe: Some(r"\\.\pipe\door-test-1".into()),
                user_sid: Some(SID.into()),
                bun: Some("bun".into()),
                main: Some(r"apps\cophylad\src\main.ts".into()),
                no_power: true,
            })
        );
    }

    #[test]
    fn run_refuses_bad_values() {
        for bad in [
            &["run", "--console", "--console"][..],
            &["run", "--console", "--home"],
            &["run", "--console", "--home", ""],
            &["run", "--console", "--home", "a", "--home", "b"],
            &["run", "--console", "--no-power=yes"],
            &["run", "--console", "--pipe", "cophyla-door"],
            &["run", "--console", "--pipe", r"\\server\pipe\x"],
            &["run", "--console", "--pipe", r"\\.\pipe\"],
            &["run", "--console", "--pipe", r"\\.\pipe\a\b"],
            &["run", "--console", "--user-sid", "alice"],
            &["run", "--console", "--user-sid", "S-1-5-21-1)(A;;GA;;;WD"],
            &["run", "--console", "--verbose"],
        ] {
            assert!(parse(&args(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn install_needs_from_and_a_sid() {
        let ok = parse(&args(&["install", "--from", r"C:\Users\a\AppData\Local\Cophyla\versions\0.21.0", "--user-sid", SID, "--result", r"C:\t\r.json"])).unwrap();
        assert_eq!(
            ok,
            Mode::Install(InstallArgs { from: r"C:\Users\a\AppData\Local\Cophyla\versions\0.21.0".into(), user_sid: SID.into(), result: Some(r"C:\t\r.json".into()) })
        );
        assert!(parse(&args(&["install", "--user-sid", SID])).is_err());
        assert!(parse(&args(&["install", "--from", "x"])).is_err());
        assert!(parse(&args(&["install", "--from", "x", "--user-sid", "S-1"])).is_err());
    }

    #[test]
    fn uninstall_takes_a_result() {
        assert_eq!(parse(&args(&["uninstall"])), Ok(Mode::Uninstall { result: None }));
        assert_eq!(parse(&args(&["uninstall", "--result=r.json"])), Ok(Mode::Uninstall { result: Some("r.json".into()) }));
    }

    #[test]
    fn the_result_path_is_found_in_arguments_that_do_not_parse() {
        assert_eq!(result_path(&args(&["install", "--bogus", "--result", "r.json"])), Some("r.json".into()));
        assert_eq!(result_path(&args(&["uninstall", "--result=u.json"])), Some("u.json".into()));
        assert_eq!(result_path(&args(&["install", "--result"])), None);
        assert_eq!(result_path(&args(&["status", "--result", "r.json"])), None);
    }
}
