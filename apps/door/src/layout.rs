//! Where the door keeps things, platform-free.
//!
//! `%ProgramFiles%\Cophyla Door\` holds the SCM's image, which only administrators may change,
//! and `program\`, which the service may: `versions\<v>\` (Bun, `release.json` and cophylad's
//! tree), the pointers `current` and `previous` (one version on one line each, as the
//! launcher's), the fixed `bin\cophyla-net.exe`, and `moonlight-web\`, which the child fills.
//! A version is launchable when its `bun.exe` and cophylad's `main.ts` are there and no
//! `.broken` marker is. `%ProgramData%\Cophyla Door\` is the data root: `door.json`, the logs,
//! and `home\`, the child's `--home`.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use crate::constants::{EXE_NAME, FOLDER};
use crate::sddl;

pub const BUN: &str = "bun.exe";
pub const RELEASE_FILE: &str = "release.json";
pub const BROKEN: &str = ".broken";
pub const DOOR_JSON: &str = "door.json";
/// The version tree's entry point, below `versions\<v>\`.
pub const MAIN: [&str; 5] = ["cophylad", "apps", "cophylad", "src", "main.ts"];
/// What the install leaves out of a user's version tree: the embedding model, the views and
/// the phone app, none of which the door runs.
pub const EXCLUDED: [&[&str]; 3] = [&["cophylad", "apps", "cophylad", "models"], &["cophylad", "apps", "cophylad", "views"], &["cophylad", "apps", "controller"]];
/// The licences file the release stages beside the exe, copied beside the service's image.
pub const LICENCES: &str = "cophyla-door-THIRD-PARTY-LICENSES.html";

/// The door's folders on a machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    /// `%ProgramFiles%\Cophyla Door`
    pub root: PathBuf,
    /// `%ProgramFiles%\Cophyla Door\program`
    pub program: PathBuf,
    /// `%ProgramData%\Cophyla Door`
    pub data: PathBuf,
}

impl Layout {
    pub fn new(program_files: &Path, program_data: &Path) -> Layout {
        let root = program_files.join(FOLDER);
        Layout { program: root.join("program"), root, data: program_data.join(FOLDER) }
    }

    pub fn exe(&self) -> PathBuf {
        self.root.join(EXE_NAME)
    }

    pub fn home(&self) -> PathBuf {
        self.data.join("home")
    }

    pub fn streamer(&self) -> PathBuf {
        self.program.join("moonlight-web").join("streamer.exe")
    }

    pub fn net(&self) -> PathBuf {
        self.program.join("bin").join("cophyla-net.exe")
    }
}

/// `major.minor.patch` with an optional pre-release tag: what a pointer may name, and what a
/// version folder is called. The same rule as the launcher's.
pub fn is_version(s: &str) -> bool {
    let core = match s.split_once('-') {
        Some((c, t)) if !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') => c,
        Some(_) => return false,
        None => s,
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

pub fn version_dir(program: &Path, version: &str) -> PathBuf {
    program.join("versions").join(version)
}

/// The child's runtime and entry point in a version.
pub fn launch_paths(program: &Path, version: &str) -> (PathBuf, PathBuf) {
    let dir = version_dir(program, version);
    (dir.join(BUN), MAIN.iter().fold(dir, |p, c| p.join(c)))
}

pub fn is_broken(program: &Path, version: &str) -> bool {
    version_dir(program, version).join(BROKEN).exists()
}

pub fn mark_broken(program: &Path, version: &str, reason: &str) -> io::Result<()> {
    fs::write(version_dir(program, version).join(BROKEN), format!("{reason}\n"))
}

/// Whether a version can be started: its runtime and entry point are there, and it is not
/// marked broken.
pub fn is_launchable(program: &Path, version: &str) -> bool {
    let (bun, main) = launch_paths(program, version);
    bun.is_file() && main.is_file() && !is_broken(program, version)
}

/// The version a pointer names, when the file is there and holds one.
pub fn read_pointer(program: &Path, name: &str) -> Option<String> {
    let text = fs::read_to_string(program.join(name)).ok()?;
    let v = text.trim();
    is_version(v).then(|| v.to_string())
}

/// A temporary file renamed over the target, so a reader never sees half of one, and a link
/// planted where the target goes is replaced rather than followed.
pub fn write_text(path: &Path, text: &str) -> io::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!("{name}.tmp-{}", std::process::id()));
    let _ = fs::remove_file(&tmp);
    let written = fs::OpenOptions::new().write(true).create_new(true).open(&tmp).and_then(|mut f| {
        use std::io::Write;
        f.write_all(text.as_bytes())?;
        f.sync_all()
    });
    if let Err(e) = written.and_then(|_| fs::rename(&tmp, path)) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

pub fn write_pointer(program: &Path, name: &str, version: &str) -> io::Result<()> {
    if !is_version(version) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("not a version: {version}")));
    }
    write_text(&program.join(name), &format!("{version}\n"))
}

pub fn remove_pointer(program: &Path, name: &str) -> io::Result<()> {
    match fs::remove_file(program.join(name)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Gives `bad` up for `to`: marks it broken, makes `to` current and removes `previous`, as the
/// launcher's rollback does; there is nothing further back.
pub fn fall_back(program: &Path, bad: &str, to: &str, reason: &str) -> io::Result<()> {
    mark_broken(program, bad, reason)?;
    write_pointer(program, "current", to)?;
    remove_pointer(program, "previous")
}

/// Whether a path below a version folder is one the install leaves out. Windows compares
/// names without case, so this does too.
pub fn is_excluded(rel: &Path) -> bool {
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(n) => Some(n.to_string_lossy().to_ascii_lowercase()),
            _ => None,
        })
        .collect();
    EXCLUDED.iter().any(|ex| parts.len() >= ex.len() && ex.iter().zip(&parts).all(|(a, b)| *a == b))
}

/// `door.json`: who the door is for and what the install put in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoorConfig {
    pub user_sid: String,
    pub version: String,
    pub installed_at: u64,
}

impl DoorConfig {
    pub fn encode(&self) -> String {
        json!({ "v": 1, "userSid": self.user_sid, "version": self.version, "installedAt": self.installed_at }).to_string() + "\n"
    }

    pub fn decode(bytes: &[u8]) -> Result<DoorConfig, String> {
        let v: Value = serde_json::from_slice(bytes).map_err(|e| format!("not JSON: {e}"))?;
        if v.get("v").and_then(Value::as_u64) != Some(1) {
            return Err("not version 1".into());
        }
        let user_sid = v.get("userSid").and_then(Value::as_str).filter(|s| sddl::is_sid(s)).ok_or("no userSid")?;
        let version = v.get("version").and_then(Value::as_str).unwrap_or_default();
        let installed_at = v.get("installedAt").and_then(Value::as_u64).unwrap_or(0);
        Ok(DoorConfig { user_sid: user_sid.to_string(), version: version.to_string(), installed_at })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temporary folder of the test's own, removed when it ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("cophyla-door-layout-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn make_version(program: &Path, v: &str) {
        let (bun, main) = launch_paths(program, v);
        fs::create_dir_all(main.parent().unwrap()).unwrap();
        fs::write(bun, b"").unwrap();
        fs::write(main, b"").unwrap();
    }

    #[test]
    fn the_folders() {
        let l = Layout::new(Path::new("PF"), Path::new("PD"));
        assert_eq!(l.root, Path::new("PF").join("Cophyla Door"));
        assert_eq!(l.exe(), Path::new("PF").join("Cophyla Door").join("cophyla-door.exe"));
        assert_eq!(l.program, Path::new("PF").join("Cophyla Door").join("program"));
        assert_eq!(l.streamer(), l.program.join("moonlight-web").join("streamer.exe"));
        assert_eq!(l.net(), l.program.join("bin").join("cophyla-net.exe"));
        assert_eq!(l.data, Path::new("PD").join("Cophyla Door"));
        assert_eq!(l.home(), l.data.join("home"));
        let (bun, main) = launch_paths(Path::new("P"), "0.21.0");
        assert_eq!(bun, Path::new("P").join("versions").join("0.21.0").join("bun.exe"));
        assert_eq!(main, Path::new("P").join("versions").join("0.21.0").join("cophylad").join("apps").join("cophylad").join("src").join("main.ts"));
    }

    #[test]
    fn versions() {
        for good in ["0.21.0", "1.2.3-beta.1", "10.0.0-rc-2"] {
            assert!(is_version(good), "{good}");
        }
        for bad in ["", "0.21", "0.21.0.1", "v0.21.0", "0.21.x", "0.21.0-", "..\\evil", "0.21.0-a/b", "0.21.0 "] {
            assert!(!is_version(bad), "{bad}");
        }
    }

    #[test]
    fn pointers_round_trip_and_refuse_what_is_no_version() {
        let s = Scratch::new("pointers");
        assert_eq!(read_pointer(&s.0, "current"), None);
        write_pointer(&s.0, "current", "0.21.0").unwrap();
        assert_eq!(read_pointer(&s.0, "current").as_deref(), Some("0.21.0"));
        fs::write(s.0.join("current"), "  0.21.1\r\n").unwrap();
        assert_eq!(read_pointer(&s.0, "current").as_deref(), Some("0.21.1"));
        fs::write(s.0.join("current"), "..\\..\\Windows").unwrap();
        assert_eq!(read_pointer(&s.0, "current"), None);
        assert!(write_pointer(&s.0, "current", "nope").is_err());
        remove_pointer(&s.0, "current").unwrap();
        remove_pointer(&s.0, "current").unwrap();
        assert!(fs::read_dir(&s.0).unwrap().next().is_none(), "no temporary file left");
    }

    #[test]
    fn a_version_is_launchable_until_it_is_marked_broken() {
        let s = Scratch::new("launchable");
        assert!(!is_launchable(&s.0, "0.21.0"));
        make_version(&s.0, "0.21.0");
        assert!(is_launchable(&s.0, "0.21.0"));
        mark_broken(&s.0, "0.21.0", "crashed").unwrap();
        assert!(is_broken(&s.0, "0.21.0"));
        assert!(!is_launchable(&s.0, "0.21.0"));
    }

    #[test]
    fn falling_back_marks_moves_and_forgets_previous() {
        let s = Scratch::new("fallback");
        make_version(&s.0, "0.21.0");
        make_version(&s.0, "0.20.0");
        write_pointer(&s.0, "current", "0.21.0").unwrap();
        write_pointer(&s.0, "previous", "0.20.0").unwrap();
        fall_back(&s.0, "0.21.0", "0.20.0", "crashed 5 times").unwrap();
        assert!(is_broken(&s.0, "0.21.0"));
        assert_eq!(read_pointer(&s.0, "current").as_deref(), Some("0.20.0"));
        assert_eq!(read_pointer(&s.0, "previous"), None);
        assert!(is_launchable(&s.0, "0.20.0"));
    }

    #[test]
    fn the_install_leaves_out_models_views_and_the_phone_app() {
        let p = |s: &str| PathBuf::from_iter(s.split('/'));
        assert!(is_excluded(&p("cophylad/apps/cophylad/models")));
        assert!(is_excluded(&p("cophylad/apps/cophylad/models/bge-small-en-v1.5/model.onnx")));
        assert!(is_excluded(&p("cophylad/apps/cophylad/views/default/index.html")));
        assert!(is_excluded(&p("cophylad/apps/controller/dist/index.html")));
        assert!(is_excluded(&p("Cophylad/Apps/Controller")));
        assert!(!is_excluded(&p("cophylad/apps/cophylad/src/main.ts")));
        assert!(!is_excluded(&p("cophylad/apps/cophylad/node_modules/views/index.js")));
        assert!(!is_excluded(&p("cophylad/apps/cophylad")));
        assert!(!is_excluded(&p("cophylad/apps/controllers")));
        assert!(!is_excluded(&p("bun.exe")));
    }

    #[test]
    fn door_json_round_trips() {
        let c = DoorConfig { user_sid: "S-1-5-21-1-2-3-1001".into(), version: "0.21.0".into(), installed_at: 1_793_000_000_000 };
        let text = c.encode();
        assert!(text.ends_with('\n'));
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v, json!({ "v": 1, "userSid": "S-1-5-21-1-2-3-1001", "version": "0.21.0", "installedAt": 1_793_000_000_000u64 }));
        assert_eq!(DoorConfig::decode(text.as_bytes()), Ok(c));
        assert!(DoorConfig::decode(br#"{"v":2,"userSid":"S-1-5-18"}"#).is_err());
        assert!(DoorConfig::decode(br#"{"v":1,"userSid":"Everyone"}"#).is_err());
        assert!(DoorConfig::decode(b"").is_err());
    }
}
