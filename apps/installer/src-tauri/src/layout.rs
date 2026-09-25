// The install directory as the launcher sees it: three pointer files, `current`, `previous`
// and `staged`, each one version on one line, and `versions/<v>/` directories. The launcher
// is the only writer of `current` and `previous`; cophylad writes `staged` once a version
// directory is complete. A version is complete when `release.json` and the shell are there
// and no `.broken` marker is; the launcher writes `.broken` on a version that failed to
// start, and never rotates one in again.

use std::cmp::Ordering;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The shell inside `versions/<v>/`; pinned equal to `SHELL_PATHS` in apps/cophylad/src/update/platform.ts.
#[cfg(windows)]
pub const SHELL: &str = "cophyla-ui.exe";
#[cfg(target_os = "macos")]
pub const SHELL: &str = "Cophyla.app/Contents/MacOS/cophyla-ui";
#[cfg(all(unix, not(target_os = "macos")))]
pub const SHELL: &str = "cophyla-ui";
pub const RELEASE_FILE: &str = "release.json";
pub const BROKEN: &str = ".broken";
/// Where the launcher writes its own path, so the shell relaunches through it without guessing.
pub const LAUNCHER_FILE: &str = "launcher";

/// `major.minor.patch` with an optional pre-release tag: what a pointer may name.
pub fn is_version(s: &str) -> bool {
    let (core, _tag) = match s.split_once('-') {
        Some((c, t)) if !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') => (c, Some(t)),
        Some(_) => return false,
        None => (s, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// Orders two versions: the numeric core first, then a release above any pre-release, then
/// the pre-release tags as text. Anything that is not a version sorts below everything.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    fn parts(v: &str) -> Option<([u64; 3], Option<&str>)> {
        if !is_version(v) {
            return None;
        }
        let (core, tag) = match v.split_once('-') {
            Some((c, t)) => (c, Some(t)),
            None => (v, None),
        };
        let mut n = [0u64; 3];
        for (i, p) in core.split('.').enumerate().take(3) {
            n[i] = p.parse().ok()?;
        }
        Some((n, tag))
    }
    match (parts(a), parts(b)) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some((na, ta)), Some((nb, tb))) => na.cmp(&nb).then_with(|| match (ta, tb) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(x), Some(y)) => x.cmp(y),
        }),
    }
}

/// Whether `a` is a newer version than `b`.
pub fn newer(a: &str, b: &str) -> bool {
    compare_versions(a, b) == Ordering::Greater
}

pub fn version_dir(dir: &Path, version: &str) -> PathBuf {
    dir.join("versions").join(version)
}

/// The version a pointer names, when the file is there and holds one.
pub fn read_pointer(dir: &Path, name: &str) -> Option<String> {
    let text = fs::read_to_string(dir.join(name)).ok()?;
    let v = text.trim();
    is_version(v).then(|| v.to_string())
}

/// Temp file and rename, so a reader never sees a half-written file.
pub fn write_text(path: &Path, text: &str) -> io::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!("{name}.tmp-{}", std::process::id()));
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)
}

/// A pointer: one version on one line.
pub fn write_pointer(dir: &Path, name: &str, version: &str) -> io::Result<()> {
    if !is_version(version) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("not a version: {version}")));
    }
    write_text(&dir.join(name), &format!("{version}\n"))
}

pub fn remove_pointer(dir: &Path, name: &str) -> io::Result<()> {
    match fs::remove_file(dir.join(name)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

pub fn is_broken(dir: &Path, version: &str) -> bool {
    version_dir(dir, version).join(BROKEN).exists()
}

pub fn mark_broken(dir: &Path, version: &str, reason: &str) -> io::Result<()> {
    fs::write(version_dir(dir, version).join(BROKEN), format!("{reason}\n"))
}

pub fn is_complete(dir: &Path, version: &str) -> bool {
    let vdir = version_dir(dir, version);
    vdir.join(RELEASE_FILE).exists() && vdir.join(SHELL).exists() && !is_broken(dir, version)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rotation {
    /// No `staged` pointer.
    Nothing,
    /// `staged` named `current`: a rotation interrupted after the pointer move; the leftover is removed.
    AlreadyCurrent(String),
    /// `staged` named a version that is not complete (or is broken); the pointer is removed.
    Incomplete(String),
    Rotated { from: Option<String>, to: String },
}

/// Moves a staged version into `current`, the old current into `previous`, and removes
/// `staged`. Idempotent under a crash at any point: each step re-run gives the same end.
pub fn rotate(dir: &Path) -> io::Result<Rotation> {
    let Some(staged) = read_pointer(dir, "staged") else {
        return Ok(Rotation::Nothing);
    };
    let current = read_pointer(dir, "current");
    if current.as_deref() == Some(staged.as_str()) {
        remove_pointer(dir, "staged")?;
        return Ok(Rotation::AlreadyCurrent(staged));
    }
    if !is_complete(dir, &staged) {
        remove_pointer(dir, "staged")?;
        return Ok(Rotation::Incomplete(staged));
    }
    if let Some(cur) = &current {
        write_pointer(dir, "previous", cur)?;
    }
    write_pointer(dir, "current", &staged)?;
    remove_pointer(dir, "staged")?;
    Ok(Rotation::Rotated { from: current, to: staged })
}

/// Marks `current` broken and moves the pointer back to `previous`, which must be complete.
/// `previous` is removed: there is nothing further back. Returns the version now current.
pub fn rollback(dir: &Path, reason: &str) -> Result<String, String> {
    let current = read_pointer(dir, "current").ok_or_else(|| "no current pointer".to_string())?;
    let previous = read_pointer(dir, "previous").ok_or_else(|| "no previous pointer: nothing to roll back to".to_string())?;
    if previous == current {
        return Err(format!("previous names the current version {current}"));
    }
    if is_broken(dir, &previous) {
        return Err(format!("previous version {previous} is marked broken"));
    }
    if !is_complete(dir, &previous) {
        return Err(format!("previous version {previous} is not complete"));
    }
    mark_broken(dir, &current, reason).map_err(|e| format!("cannot mark {current} broken: {e}"))?;
    write_pointer(dir, "current", &previous).map_err(|e| format!("cannot write current: {e}"))?;
    remove_pointer(dir, "previous").map_err(|e| format!("cannot remove previous: {e}"))?;
    Ok(previous)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cophyla-launcher-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir_all(dir.join("versions")).unwrap();
        dir
    }

    pub fn complete(dir: &Path, v: &str) {
        let vdir = version_dir(dir, v);
        let shell = vdir.join(SHELL);
        fs::create_dir_all(shell.parent().unwrap()).unwrap();
        fs::write(&shell, "shell").unwrap();
        fs::write(vdir.join(RELEASE_FILE), "{}").unwrap();
    }

    #[test]
    fn versions_are_three_numbers_with_an_optional_tag() {
        for ok in ["0.1.0", "10.20.30", "1.0.0-beta.1", "1.0.0-rc-2"] {
            assert!(is_version(ok), "{ok}");
        }
        for bad in ["", "1.0", "1.0.0.0", "v1.0.0", "1.0.0-", "1.a.0", "../x", "0.1.0\n"] {
            assert!(!is_version(bad), "{bad}");
        }
    }

    #[test]
    fn versions_compare_numerically_and_a_release_beats_its_pre_releases() {
        for (a, b) in [("0.1.10", "0.1.9"), ("1.0.0", "0.99.99"), ("0.2.0", "0.1.5"), ("1.0.0", "1.0.0-rc.1"), ("1.0.0-rc.2", "1.0.0-rc.1"), ("0.1.0", "nope")] {
            assert!(newer(a, b), "{a} > {b}");
            assert!(!newer(b, a), "{b} !> {a}");
        }
        assert_eq!(compare_versions("0.1.0", "0.1.0"), std::cmp::Ordering::Equal);
        assert_eq!(compare_versions("x", "y"), std::cmp::Ordering::Equal);
        assert!(!newer("0.1.0", "0.1.0"));
    }

    #[test]
    fn write_text_leaves_no_temp_file() {
        let dir = temp();
        write_text(&dir.join(LAUNCHER_FILE), "/Applications/Cophyla.app/Contents/MacOS/Cophyla\n").unwrap();
        assert_eq!(fs::read_to_string(dir.join(LAUNCHER_FILE)).unwrap().trim(), "/Applications/Cophyla.app/Contents/MacOS/Cophyla");
        assert!(fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains(".tmp-")));
    }

    #[test]
    fn pointers_round_trip_and_reject_junk() {
        let dir = temp();
        assert_eq!(read_pointer(&dir, "current"), None);
        write_pointer(&dir, "current", "0.1.0").unwrap();
        assert_eq!(read_pointer(&dir, "current").as_deref(), Some("0.1.0"));
        fs::write(dir.join("current"), "  0.1.1\r\n").unwrap();
        assert_eq!(read_pointer(&dir, "current").as_deref(), Some("0.1.1"));
        fs::write(dir.join("current"), "..\\evil").unwrap();
        assert_eq!(read_pointer(&dir, "current"), None);
        assert!(write_pointer(&dir, "current", "nope").is_err());
        remove_pointer(&dir, "current").unwrap();
        remove_pointer(&dir, "current").unwrap();
        assert!(fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains(".tmp-")));
    }

    #[test]
    fn completeness_needs_the_shell_the_entry_and_no_marker() {
        let dir = temp();
        assert!(!is_complete(&dir, "0.1.0"));
        complete(&dir, "0.1.0");
        assert!(is_complete(&dir, "0.1.0"));
        fs::remove_file(version_dir(&dir, "0.1.0").join(RELEASE_FILE)).unwrap();
        assert!(!is_complete(&dir, "0.1.0"));
        complete(&dir, "0.1.0");
        mark_broken(&dir, "0.1.0", "test").unwrap();
        assert!(is_broken(&dir, "0.1.0"));
        assert!(!is_complete(&dir, "0.1.0"));
    }

    #[test]
    fn rotate_moves_staged_into_current_and_current_into_previous() {
        let dir = temp();
        complete(&dir, "0.1.0");
        complete(&dir, "0.1.1");
        write_pointer(&dir, "current", "0.1.0").unwrap();
        assert_eq!(rotate(&dir).unwrap(), Rotation::Nothing);
        write_pointer(&dir, "staged", "0.1.1").unwrap();
        assert_eq!(rotate(&dir).unwrap(), Rotation::Rotated { from: Some("0.1.0".into()), to: "0.1.1".into() });
        assert_eq!(read_pointer(&dir, "current").as_deref(), Some("0.1.1"));
        assert_eq!(read_pointer(&dir, "previous").as_deref(), Some("0.1.0"));
        assert_eq!(read_pointer(&dir, "staged"), None);
        // Again: nothing to do.
        assert_eq!(rotate(&dir).unwrap(), Rotation::Nothing);
    }

    #[test]
    fn rotate_is_idempotent_after_a_crash_between_steps() {
        let dir = temp();
        complete(&dir, "0.1.0");
        complete(&dir, "0.1.1");
        // Crashed after `current := staged` but before `staged` was removed.
        write_pointer(&dir, "previous", "0.1.0").unwrap();
        write_pointer(&dir, "current", "0.1.1").unwrap();
        write_pointer(&dir, "staged", "0.1.1").unwrap();
        assert_eq!(rotate(&dir).unwrap(), Rotation::AlreadyCurrent("0.1.1".into()));
        assert_eq!(read_pointer(&dir, "current").as_deref(), Some("0.1.1"));
        assert_eq!(read_pointer(&dir, "previous").as_deref(), Some("0.1.0"));
        assert_eq!(read_pointer(&dir, "staged"), None);
        // Crashed after `previous := current` but before `current := staged`: the re-run finishes it.
        write_pointer(&dir, "current", "0.1.0").unwrap();
        write_pointer(&dir, "previous", "0.1.0").unwrap();
        write_pointer(&dir, "staged", "0.1.1").unwrap();
        assert_eq!(rotate(&dir).unwrap(), Rotation::Rotated { from: Some("0.1.0".into()), to: "0.1.1".into() });
        assert_eq!(read_pointer(&dir, "previous").as_deref(), Some("0.1.0"));
    }

    #[test]
    fn rotate_refuses_an_incomplete_or_broken_staged_version() {
        let dir = temp();
        complete(&dir, "0.1.0");
        write_pointer(&dir, "current", "0.1.0").unwrap();
        write_pointer(&dir, "staged", "0.1.2").unwrap();
        assert_eq!(rotate(&dir).unwrap(), Rotation::Incomplete("0.1.2".into()));
        assert_eq!(read_pointer(&dir, "current").as_deref(), Some("0.1.0"));
        assert_eq!(read_pointer(&dir, "staged"), None);
        complete(&dir, "0.1.2");
        mark_broken(&dir, "0.1.2", "test").unwrap();
        write_pointer(&dir, "staged", "0.1.2").unwrap();
        assert_eq!(rotate(&dir).unwrap(), Rotation::Incomplete("0.1.2".into()));
        assert_eq!(read_pointer(&dir, "current").as_deref(), Some("0.1.0"));
    }

    #[test]
    fn first_install_has_no_previous() {
        let dir = temp();
        complete(&dir, "0.1.0");
        write_pointer(&dir, "staged", "0.1.0").unwrap();
        assert_eq!(rotate(&dir).unwrap(), Rotation::Rotated { from: None, to: "0.1.0".into() });
        assert_eq!(read_pointer(&dir, "previous"), None);
    }

    #[test]
    fn rollback_marks_current_broken_and_moves_the_pointer_back() {
        let dir = temp();
        complete(&dir, "0.1.0");
        complete(&dir, "0.1.1");
        write_pointer(&dir, "previous", "0.1.0").unwrap();
        write_pointer(&dir, "current", "0.1.1").unwrap();
        assert_eq!(rollback(&dir, "exit 1").unwrap(), "0.1.0");
        assert_eq!(read_pointer(&dir, "current").as_deref(), Some("0.1.0"));
        assert_eq!(read_pointer(&dir, "previous"), None);
        assert!(is_broken(&dir, "0.1.1"));
        assert_eq!(fs::read_to_string(version_dir(&dir, "0.1.1").join(BROKEN)).unwrap().trim(), "exit 1");
        // A broken version is never rotated in again.
        write_pointer(&dir, "staged", "0.1.1").unwrap();
        assert_eq!(rotate(&dir).unwrap(), Rotation::Incomplete("0.1.1".into()));
        // No second rollback: previous is gone.
        assert!(rollback(&dir, "again").unwrap_err().contains("no previous"));
        assert!(!is_broken(&dir, "0.1.0"));
    }

    #[test]
    fn rollback_refuses_a_missing_broken_or_incomplete_previous() {
        let dir = temp();
        complete(&dir, "0.1.1");
        write_pointer(&dir, "current", "0.1.1").unwrap();
        assert!(rollback(&dir, "x").unwrap_err().contains("no previous"));
        write_pointer(&dir, "previous", "0.1.0").unwrap();
        assert!(rollback(&dir, "x").unwrap_err().contains("not complete"));
        complete(&dir, "0.1.0");
        mark_broken(&dir, "0.1.0", "earlier").unwrap();
        assert!(rollback(&dir, "x").unwrap_err().contains("marked broken"));
        // Nothing was changed by the refused attempts.
        assert_eq!(read_pointer(&dir, "current").as_deref(), Some("0.1.1"));
        assert!(!is_broken(&dir, "0.1.1"));
        write_pointer(&dir, "previous", "0.1.1").unwrap();
        assert!(rollback(&dir, "x").unwrap_err().contains("names the current"));
    }
}
