// Installed mode: the shell runs from `<root>/versions/<v>/<shell>` behind the launcher,
// which owns the `current` and `previous` pointers and rotates a version cophylad staged at
// every start. The root is the launcher's own directory on Windows (`%LOCALAPPDATA%\Cophyla`)
// and the user's data directory on macOS and Linux, where the launcher is a sealed package
// (`/Applications/Cophyla.app`, `/usr/bin/Cophyla`). The shell learns where it is from the
// launcher's `COPHYLA_INSTALL_DIR` and `COPHYLA_PLATFORM_DIR`, or from its own path (four levels
// down on macOS, where the shell is a bundle per version); and where the launcher is from
// `COPHYLA_LAUNCHER`, else the `launcher` file the launcher writes in the root, else a launcher
// beside the root (Windows). A shell run from a checkout is not installed and none of this
// applies. Relaunching goes through the launcher with `--wait-pid`, so the single instance is
// released before the next version starts; on Unix the launcher gets its own process group,
// so it outlives this one.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The launcher's binary name; pinned equal to `LAUNCHER_NAMES` in apps/cophylad/src/update/platform.ts.
#[cfg(windows)]
pub const LAUNCHER: &str = "Cophyla.exe";
#[cfg(not(windows))]
pub const LAUNCHER: &str = "Cophyla";
/// The file the launcher writes in the root with its own path.
pub const LAUNCHER_FILE: &str = "launcher";
/// How many parents of the shell executable may lie between it and `versions/<v>`.
const MAX_DEPTH: usize = 6;

#[derive(Debug, Clone)]
pub struct Install {
    /// The root: the pointers, `versions/`, the bundled brain (and the launcher on Windows).
    pub dir: PathBuf,
    /// `versions/<v>`: this shell, the runtime, cophylad's tree and the icons.
    pub version_dir: PathBuf,
    /// The launcher, when it is known; relaunching and launch at login need it.
    pub launcher: Option<PathBuf>,
    /// This shell's version, from the directory name; equals `CARGO_PKG_VERSION` in a consistent build.
    pub version: String,
}

fn is_version(s: &str) -> bool {
    let core = s.split_once('-').map(|(c, _)| c).unwrap_or(s);
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// The root and the version directory of a shell executable: the nearest ancestor that is
/// `versions/<v>` (one up on Windows and Linux, four up inside a macOS bundle).
pub fn split_exe(exe: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut cursor = exe.parent()?;
    for _ in 0..MAX_DEPTH {
        let parent = cursor.parent()?;
        if parent.file_name().and_then(|n| n.to_str()) == Some("versions") && cursor.file_name().and_then(|n| n.to_str()).is_some_and(is_version) {
            return Some((parent.parent()?.to_path_buf(), cursor.to_path_buf()));
        }
        cursor = parent;
    }
    None
}

/// `COPHYLA_LAUNCHER` from the environment, else the root's `launcher` file, else `<root>/<LAUNCHER>`.
pub fn resolve_launcher(env_launcher: Option<PathBuf>, root: &Path) -> Option<PathBuf> {
    if let Some(p) = env_launcher.filter(|p| !p.as_os_str().is_empty()) {
        return Some(p);
    }
    if let Ok(text) = std::fs::read_to_string(root.join(LAUNCHER_FILE)) {
        let line = text.trim();
        if !line.is_empty() {
            return Some(PathBuf::from(line));
        }
    }
    let beside = root.join(LAUNCHER);
    beside.exists().then_some(beside)
}

impl Install {
    fn from_dirs(dir: PathBuf, version_dir: PathBuf, env_launcher: Option<PathBuf>) -> Option<Install> {
        let version = version_dir.file_name()?.to_string_lossy().into_owned();
        if !is_version(&version) {
            return None;
        }
        if !dir.join("current").exists() && !dir.join("versions").is_dir() {
            return None;
        }
        let launcher = resolve_launcher(env_launcher, &dir);
        Some(Install { dir, version_dir, launcher, version })
    }

    /// The environment the launcher sets, else this executable's place under `versions/<v>/`.
    pub fn detect() -> Option<Install> {
        let env_launcher = std::env::var_os("COPHYLA_LAUNCHER").map(PathBuf::from);
        let from_env = std::env::var_os("COPHYLA_INSTALL_DIR").zip(std::env::var_os("COPHYLA_PLATFORM_DIR"));
        if let Some((dir, vdir)) = from_env {
            if let Some(i) = Install::from_dirs(PathBuf::from(dir), PathBuf::from(vdir), env_launcher.clone()) {
                return Some(i);
            }
        }
        let exe = std::env::current_exe().ok()?;
        let (dir, version_dir) = split_exe(&exe)?;
        Install::from_dirs(dir, version_dir, env_launcher)
    }

    pub fn pointer(&self, name: &str) -> Option<String> {
        let text = std::fs::read_to_string(self.dir.join(name)).ok()?;
        let v = text.trim();
        is_version(v).then(|| v.to_string())
    }

    pub fn current(&self) -> Option<String> {
        self.pointer("current")
    }

    pub fn staged(&self) -> Option<String> {
        self.pointer("staged")
    }

    /// Another version should run instead of this one: cophylad staged one, or the launcher
    /// already rotated `current` past us (a Start Menu launch while we ran).
    pub fn newer_waiting(&self) -> Option<String> {
        if let Some(staged) = self.staged() {
            if staged != self.version {
                return Some(staged);
            }
        }
        self.current().filter(|c| c != &self.version)
    }

    /// Starts the launcher, which waits for this process, rotates and starts the current version.
    pub fn relaunch(&self, hidden: bool, rollback: bool) -> std::io::Result<()> {
        let Some(launcher) = self.launcher.as_ref() else {
            return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "the launcher is not known: no COPHYLA_LAUNCHER and no launcher file in the root"));
        };
        let mut cmd = Command::new(launcher);
        cmd.arg("--wait-pid").arg(std::process::id().to_string());
        if rollback {
            cmd.arg("--rollback");
        }
        if hidden {
            cmd.arg(crate::HIDDEN_FLAG);
        }
        cmd.current_dir(&self.dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        cmd.spawn().map(drop)
    }

    pub fn icon(&self, name: &str) -> PathBuf {
        self.version_dir.join("icons").join(name)
    }

    pub fn file(&self, rel: &str) -> PathBuf {
        self.version_dir.join(rel)
    }
}

pub fn describe(install: Option<&Install>) -> String {
    match install {
        Some(i) => format!("installed {} in {}", i.version, i.dir.display()),
        None => "checkout".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_exe_finds_versions_v_one_level_up_or_four_levels_up_in_a_bundle() {
        let flat = Path::new("/home/me/.local/share/cophyla/versions/0.1.2/cophyla-ui");
        assert_eq!(split_exe(flat), Some((PathBuf::from("/home/me/.local/share/cophyla"), PathBuf::from("/home/me/.local/share/cophyla/versions/0.1.2"))));
        let bundle = Path::new("/Users/me/Library/Application Support/Cophyla/versions/0.1.2/Cophyla.app/Contents/MacOS/cophyla-ui");
        assert_eq!(
            split_exe(bundle),
            Some((PathBuf::from("/Users/me/Library/Application Support/Cophyla"), PathBuf::from("/Users/me/Library/Application Support/Cophyla/versions/0.1.2")))
        );
        // Backslashes are separators on Windows alone.
        #[cfg(windows)]
        {
            let win = Path::new(r"C:\Users\me\AppData\Local\Cophyla\versions\0.1.2-rc.1\cophyla-ui.exe");
            assert!(split_exe(win).is_some_and(|(root, vdir)| root.ends_with("Cophyla") && vdir.ends_with("0.1.2-rc.1")));
        }
        assert!(split_exe(Path::new("/r/versions/0.1.2-rc.1/cophyla-ui")).is_some_and(|(root, vdir)| root == Path::new("/r") && vdir.ends_with("0.1.2-rc.1")));
        assert_eq!(split_exe(Path::new("/home/me/src/orchestrator/apps/ui/src-tauri/target/debug/cophyla-ui")), None);
        assert_eq!(split_exe(Path::new("/x/versions/not-a-version/cophyla-ui")), None);
        // too deep: seven parents between the executable and versions/<v>
        assert_eq!(split_exe(Path::new("/r/versions/1.0.0/a/b/c/d/e/f/g/cophyla-ui")), None);
    }

    #[test]
    fn the_launcher_comes_from_the_environment_the_launcher_file_or_beside_the_root() {
        let root = std::env::temp_dir().join(format!("cophyla-install-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(resolve_launcher(Some(PathBuf::from("/Applications/Cophyla.app/Contents/MacOS/Cophyla")), &root), Some(PathBuf::from("/Applications/Cophyla.app/Contents/MacOS/Cophyla")));
        assert_eq!(resolve_launcher(Some(PathBuf::new()), &root), None);
        std::fs::write(root.join(LAUNCHER_FILE), "/usr/bin/Cophyla\n").unwrap();
        assert_eq!(resolve_launcher(None, &root), Some(PathBuf::from("/usr/bin/Cophyla")));
        std::fs::write(root.join(LAUNCHER_FILE), "  \n").unwrap();
        assert_eq!(resolve_launcher(None, &root), None);
        std::fs::write(root.join(LAUNCHER), "stub").unwrap();
        assert_eq!(resolve_launcher(None, &root), Some(root.join(LAUNCHER)));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn from_dirs_needs_a_root_the_launcher_made_and_reports_a_missing_launcher() {
        let root = std::env::temp_dir().join(format!("cophyla-install-test-dirs-{}", std::process::id()));
        let vdir = root.join("versions").join("0.1.2");
        std::fs::create_dir_all(&vdir).unwrap();
        let i = Install::from_dirs(root.clone(), vdir.clone(), None).unwrap();
        assert_eq!(i.version, "0.1.2");
        assert_eq!(i.launcher, None);
        assert!(i.relaunch(true, false).unwrap_err().to_string().contains("launcher is not known"));
        assert!(Install::from_dirs(root.clone(), root.join("versions").join("x"), None).is_none());
        let bare = root.join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        assert!(Install::from_dirs(bare.clone(), bare.join("versions").join("0.1.2"), None).is_none());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
