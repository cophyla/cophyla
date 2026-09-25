// The seed: the read-only first contents of the root, shipped inside the package where the
// package is sealed (`Cophyla.app/Contents/Resources/seed` on macOS, `/usr/lib/Cophyla/seed`
// on Linux; the Windows installer writes the root itself and ships no seed). It holds
// `versions/<v>/` for the one version the package was built with, `brain/` for the bundled
// brain, and `current`. At every start the launcher syncs it into the root: an empty root
// gets its first contents; a root that predates a reinstalled package gets the package's
// version copied and `staged`, so the same run rotates it in and the newer bundled brain
// replaces the older one. Copies go through `.partial` and a rename, so a crash leaves a
// version directory either whole or absent.

use std::fs;
use std::io;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

use crate::layout;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seeded {
    /// No seed beside the launcher: the Windows layout, or a package without one.
    NoSeed,
    /// The root was empty; the seed's version is `current` now.
    First(String),
    /// The package is newer than the root's `current`: its version was copied and `staged`.
    Reinstalled(String),
    UpToDate,
}

/// The one version the seed carries: the newest `versions/<v>` directory in it.
pub fn seed_version(seed: &Path) -> Option<String> {
    let mut best: Option<String> = None;
    for entry in fs::read_dir(seed.join("versions")).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !layout::is_version(&name) || !entry.path().is_dir() {
            continue;
        }
        if best.as_deref().map_or(true, |b| layout::newer(&name, b)) {
            best = Some(name);
        }
    }
    best
}

/// The `version` field of a `release.json`, read without a JSON parser: the file is ours.
pub fn release_version(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join(layout::RELEASE_FILE)).ok()?;
    let at = text.find("\"version\"")?;
    let rest = &text[at + "\"version\"".len()..];
    let rest = rest.trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    let end = rest.find('"')?;
    let v = &rest[..end];
    layout::is_version(v).then(|| v.to_string())
}

/// Copies a tree, files and directories, preserving modes (`fs::copy` keeps the permission
/// bits on Unix) and symlinks as symlinks.
pub fn copy_tree(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            let target = fs::read_link(&from)?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&target, &to)?;
            #[cfg(windows)]
            {
                if from.is_dir() {
                    std::os::windows::fs::symlink_dir(&target, &to)?;
                } else {
                    std::os::windows::fs::symlink_file(&target, &to)?;
                }
            }
        } else if kind.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Copies `src` to `dst` through `<dst>.partial` and a rename; a stale partial is removed
/// first, and a failure removes the partial again. On macOS the quarantine attribute a
/// downloaded package carries is stripped from the copy, so Gatekeeper does not hold the
/// shell at its first start.
pub fn copy_whole(src: &Path, dst: &Path) -> io::Result<()> {
    let name = dst.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let partial = dst.with_file_name(format!("{name}.partial"));
    let _ = fs::remove_dir_all(&partial);
    if let Err(e) = copy_tree(src, &partial) {
        let _ = fs::remove_dir_all(&partial);
        return Err(e);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("xattr").args(["-dr", "com.apple.quarantine"]).arg(&partial).status();
    }
    let _ = fs::remove_dir_all(dst);
    fs::rename(&partial, dst)
}

/// Copies the seed's brain over the root's when the root has none or the seed's is newer.
fn sync_brain(root: &Path, seed: &Path, log: &mut dyn FnMut(&str)) -> io::Result<bool> {
    let from = seed.join("brain");
    if !from.is_dir() {
        return Ok(false);
    }
    let to = root.join("brain");
    let mine = release_version(&from);
    let theirs = release_version(&to);
    let replace = match (&mine, &theirs) {
        (Some(m), Some(t)) => layout::newer(m, t),
        (Some(_), None) => true,
        (None, _) => !to.exists(),
    };
    if !replace {
        return Ok(false);
    }
    copy_whole(&from, &to)?;
    log(&format!("seeded brain {} (was {})", mine.as_deref().unwrap_or("?"), theirs.as_deref().unwrap_or("none")));
    Ok(true)
}

/// Syncs the seed into the root, as the module comment says.
pub fn sync(root: &Path, seed: Option<&Path>, log: &mut dyn FnMut(&str)) -> io::Result<Seeded> {
    let Some(seed) = seed.filter(|s| s.is_dir()) else {
        return Ok(Seeded::NoSeed);
    };
    let Some(version) = seed_version(seed) else {
        log(&format!("seed {} carries no version", seed.display()));
        return Ok(Seeded::NoSeed);
    };
    fs::create_dir_all(root.join("versions"))?;
    let current = layout::read_pointer(root, "current");
    let have = layout::version_dir(root, &version).exists();

    if current.is_none() {
        if !have {
            copy_whole(&layout::version_dir(seed, &version), &layout::version_dir(root, &version))?;
        }
        sync_brain(root, seed, log)?;
        layout::write_pointer(root, "current", &version)?;
        let _ = layout::remove_pointer(root, "staged");
        log(&format!("seeded {version} into {}: first start", root.display()));
        return Ok(Seeded::First(version));
    }

    let current = current.unwrap_or_default();
    if have || !layout::newer(&version, &current) {
        return Ok(Seeded::UpToDate);
    }
    copy_whole(&layout::version_dir(seed, &version), &layout::version_dir(root, &version))?;
    sync_brain(root, seed, log)?;
    match layout::read_pointer(root, "staged") {
        Some(staged) if layout::newer(&staged, &version) && layout::is_complete(root, &staged) => {
            log(&format!("seeded {version}; staged {staged} is newer and stays"));
        }
        _ => layout::write_pointer(root, "staged", &version)?,
    }
    log(&format!("seeded {version} over current {current}: package reinstalled"));
    Ok(Seeded::Reinstalled(version))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::tests::complete;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cophyla-seed-test-{}-{}-{tag}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn brain(dir: &Path, version: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("brain"), format!("brain {version}")).unwrap();
        fs::write(dir.join(layout::RELEASE_FILE), format!("{{\n  \"component\": \"brain\",\n  \"version\": \"{version}\"\n}}\n")).unwrap();
    }

    fn seed(version: &str, brain_version: Option<&str>) -> PathBuf {
        let s = temp("seed");
        complete(&s, version);
        fs::write(layout::version_dir(&s, version).join("cophylad.txt"), "daemon").unwrap();
        if let Some(b) = brain_version {
            brain(&s.join("brain"), b);
        }
        fs::write(s.join("current"), format!("{version}\n")).unwrap();
        s
    }

    fn quiet() -> impl FnMut(&str) {
        |_: &str| {}
    }

    #[test]
    fn no_seed_or_an_empty_one_changes_nothing() {
        let root = temp("root");
        let mut log = quiet();
        assert_eq!(sync(&root, None, &mut log).unwrap(), Seeded::NoSeed);
        assert_eq!(sync(&root, Some(&root.join("missing")), &mut log).unwrap(), Seeded::NoSeed);
        let empty = temp("empty-seed");
        assert_eq!(sync(&root, Some(&empty), &mut log).unwrap(), Seeded::NoSeed);
        assert!(!root.join("current").exists());
    }

    #[test]
    fn first_run_seeds_the_version_the_brain_and_current_and_a_second_run_is_a_no_op() {
        let root = temp("root");
        let s = seed("0.1.0", Some("0.1.0"));
        let mut log = quiet();
        assert_eq!(sync(&root, Some(&s), &mut log).unwrap(), Seeded::First("0.1.0".into()));
        assert_eq!(layout::read_pointer(&root, "current").as_deref(), Some("0.1.0"));
        assert!(layout::is_complete(&root, "0.1.0"));
        assert_eq!(fs::read_to_string(layout::version_dir(&root, "0.1.0").join("cophylad.txt")).unwrap(), "daemon");
        assert_eq!(fs::read_to_string(root.join("brain").join("brain")).unwrap(), "brain 0.1.0");
        assert!(!layout::version_dir(&root, "0.1.0.partial").exists());
        assert_eq!(sync(&root, Some(&s), &mut log).unwrap(), Seeded::UpToDate);
        assert_eq!(layout::read_pointer(&root, "staged"), None);
    }

    #[test]
    fn a_newer_package_is_copied_and_staged_and_an_older_or_equal_one_is_not() {
        let root = temp("root");
        let mut log = quiet();
        sync(&root, Some(&seed("0.1.0", None)), &mut log).unwrap();
        assert_eq!(sync(&root, Some(&seed("0.0.9", None)), &mut log).unwrap(), Seeded::UpToDate);
        assert!(!layout::version_dir(&root, "0.0.9").exists());
        assert_eq!(sync(&root, Some(&seed("0.1.0", None)), &mut log).unwrap(), Seeded::UpToDate);
        assert_eq!(sync(&root, Some(&seed("0.1.1", None)), &mut log).unwrap(), Seeded::Reinstalled("0.1.1".into()));
        assert!(layout::is_complete(&root, "0.1.1"));
        assert_eq!(layout::read_pointer(&root, "current").as_deref(), Some("0.1.0"));
        assert_eq!(layout::read_pointer(&root, "staged").as_deref(), Some("0.1.1"));
        // The same run rotates it; the next start finds the version present and does nothing.
        layout::rotate(&root).unwrap();
        assert_eq!(layout::read_pointer(&root, "current").as_deref(), Some("0.1.1"));
        assert_eq!(sync(&root, Some(&seed("0.1.1", None)), &mut log).unwrap(), Seeded::UpToDate);
    }

    #[test]
    fn a_newer_staged_version_is_not_overridden_by_the_package() {
        let root = temp("root");
        let mut log = quiet();
        sync(&root, Some(&seed("0.1.0", None)), &mut log).unwrap();
        complete(&root, "0.2.0");
        layout::write_pointer(&root, "staged", "0.2.0").unwrap();
        assert_eq!(sync(&root, Some(&seed("0.1.5", None)), &mut log).unwrap(), Seeded::Reinstalled("0.1.5".into()));
        assert_eq!(layout::read_pointer(&root, "staged").as_deref(), Some("0.2.0"));
        assert!(layout::is_complete(&root, "0.1.5"));
        // An incomplete newer staged pointer is replaced: it would be dropped at rotation anyway.
        layout::write_pointer(&root, "staged", "0.3.0").unwrap();
        assert_eq!(sync(&root, Some(&seed("0.1.6", None)), &mut log).unwrap(), Seeded::Reinstalled("0.1.6".into()));
        assert_eq!(layout::read_pointer(&root, "staged").as_deref(), Some("0.1.6"));
    }

    #[test]
    fn the_brain_is_replaced_only_by_a_newer_one() {
        let root = temp("root");
        let mut log = quiet();
        sync(&root, Some(&seed("0.1.0", Some("0.1.0"))), &mut log).unwrap();
        // A newer package with an older brain keeps the brain.
        sync(&root, Some(&seed("0.1.1", Some("0.0.9"))), &mut log).unwrap();
        assert_eq!(fs::read_to_string(root.join("brain").join("brain")).unwrap(), "brain 0.1.0");
        // A newer brain replaces it.
        sync(&root, Some(&seed("0.1.2", Some("0.1.3"))), &mut log).unwrap();
        assert_eq!(fs::read_to_string(root.join("brain").join("brain")).unwrap(), "brain 0.1.3");
        assert!(!root.join("brain.partial").exists());
        // A package without a brain leaves it alone.
        sync(&root, Some(&seed("0.1.4", None)), &mut log).unwrap();
        assert_eq!(fs::read_to_string(root.join("brain").join("brain")).unwrap(), "brain 0.1.3");
    }

    #[test]
    fn a_stale_partial_is_cleaned_and_the_release_version_is_read() {
        let root = temp("root");
        let stale = root.join("versions").join("0.1.0.partial");
        fs::create_dir_all(&stale).unwrap();
        fs::write(stale.join("junk"), "x").unwrap();
        let mut log = quiet();
        sync(&root, Some(&seed("0.1.0", None)), &mut log).unwrap();
        assert!(!stale.exists());
        assert!(!layout::version_dir(&root, "0.1.0").join("junk").exists());
        let dir = temp("release");
        fs::write(dir.join(layout::RELEASE_FILE), "{\"component\":\"brain\",\"name\":\"brain-0.1.2-macos-arm64\",\"version\": \"0.1.2\"}").unwrap();
        assert_eq!(release_version(&dir).as_deref(), Some("0.1.2"));
        assert_eq!(release_version(&temp("none")), None);
    }

    #[test]
    fn copy_tree_keeps_nested_directories_and_symlinks() {
        let src = temp("src");
        fs::create_dir_all(src.join("a").join("b")).unwrap();
        fs::write(src.join("a").join("b").join("f"), "deep").unwrap();
        fs::write(src.join("top"), "top").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("top", src.join("link")).unwrap();
        let dst = temp("dst").join("copy");
        copy_tree(&src, &dst).unwrap();
        assert_eq!(fs::read_to_string(dst.join("a").join("b").join("f")).unwrap(), "deep");
        assert_eq!(fs::read_to_string(dst.join("top")).unwrap(), "top");
        #[cfg(unix)]
        {
            assert!(fs::symlink_metadata(dst.join("link")).unwrap().file_type().is_symlink());
            assert_eq!(fs::read_link(dst.join("link")).unwrap(), PathBuf::from("top"));
        }
    }
}
