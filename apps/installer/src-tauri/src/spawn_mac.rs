// macOS: the shell started as a responsible process of its own. A process that another starts
// is, to macOS's privacy checks (TCC), the responsibility of its starter's app: the microphone,
// Automation (System Events, for `session.focus`) and the local network would be asked for in
// the launcher's name, whose bundle declares none of them and which is gone ten seconds after
// the start. `responsibility_spawnattrs_setdisclaim` (libSystem, what Chromium and node-pty use)
// makes the shell answer for itself and for what it starts (cophylad, osascript, cophyla-net),
// under its own bundle's usage texts and entitlements. The rest is what `Command` gave: its own
// process group, the version directory as its folder, `/dev/null` for its stdio, no other
// handle inherited, the environment plus the launcher's variables.

use std::ffi::{CString, OsStr};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

extern "C" {
    fn responsibility_spawnattrs_setdisclaim(attrs: *mut libc::posix_spawnattr_t, disclaim: libc::c_int) -> libc::c_int;
    fn posix_spawn_file_actions_addchdir_np(actions: *mut libc::posix_spawn_file_actions_t, path: *const libc::c_char) -> libc::c_int;
}

/// Apple's flag: every handle not named in the file actions is closed in the child.
const POSIX_SPAWN_CLOEXEC_DEFAULT: libc::c_short = 0x4000;

pub struct Spawned {
    pid: libc::pid_t,
}

impl Spawned {
    pub fn id(&self) -> u32 {
        self.pid as u32
    }

    /// `Some((success, description))` once it has exited, `None` while it runs.
    pub fn try_wait(&mut self) -> io::Result<Option<(bool, String)>> {
        let mut status: libc::c_int = 0;
        let r = unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) };
        if r < 0 {
            return Err(io::Error::last_os_error());
        }
        if r == 0 {
            return Ok(None);
        }
        if libc::WIFEXITED(status) {
            let code = libc::WEXITSTATUS(status);
            Ok(Some((code == 0, format!("exit status: {code}"))))
        } else {
            Ok(Some((false, format!("signal: {}", libc::WTERMSIG(status)))))
        }
    }
}

fn cstring(bytes: &[u8]) -> io::Result<CString> {
    CString::new(bytes).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "a NUL in an argument or the environment"))
}

fn check(r: libc::c_int, what: &str) -> io::Result<()> {
    if r == 0 {
        Ok(())
    } else {
        Err(io::Error::new(io::Error::from_raw_os_error(r).kind(), format!("{what}: {}", io::Error::from_raw_os_error(r))))
    }
}

pub fn spawn(program: &Path, args: &[String], cwd: &Path, set: &[(&str, &OsStr)]) -> io::Result<Spawned> {
    let path = cstring(program.as_os_str().as_bytes())?;
    let mut argv = vec![path.clone()];
    for a in args {
        argv.push(cstring(a.as_bytes())?);
    }
    let mut argv_ptrs: Vec<*mut libc::c_char> = argv.iter().map(|a| a.as_ptr() as *mut libc::c_char).collect();
    argv_ptrs.push(std::ptr::null_mut());
    let mut env = Vec::new();
    for (k, v) in std::env::vars_os() {
        if set.iter().any(|(name, _)| OsStr::new(name) == k) {
            continue;
        }
        env.push(cstring(&[k.as_bytes(), b"=", v.as_bytes()].concat())?);
    }
    for (k, v) in set {
        env.push(cstring(&[k.as_bytes(), b"=", v.as_bytes()].concat())?);
    }
    let mut env_ptrs: Vec<*mut libc::c_char> = env.iter().map(|e| e.as_ptr() as *mut libc::c_char).collect();
    env_ptrs.push(std::ptr::null_mut());
    let dir = cstring(cwd.as_os_str().as_bytes())?;
    let null = cstring(b"/dev/null")?;

    // SAFETY: every pointer handed over lives until posix_spawn returns; the attributes and
    // file actions are initialised before use and destroyed on every path after it.
    unsafe {
        let mut attrs: libc::posix_spawnattr_t = std::mem::zeroed();
        check(libc::posix_spawnattr_init(&mut attrs), "posix_spawnattr_init")?;
        let mut actions: libc::posix_spawn_file_actions_t = std::mem::zeroed();
        if let Err(e) = check(libc::posix_spawn_file_actions_init(&mut actions), "posix_spawn_file_actions_init") {
            libc::posix_spawnattr_destroy(&mut attrs);
            return Err(e);
        }
        let result = (|| {
            check(libc::posix_spawnattr_setflags(&mut attrs, libc::POSIX_SPAWN_SETPGROUP as libc::c_short | POSIX_SPAWN_CLOEXEC_DEFAULT), "posix_spawnattr_setflags")?;
            check(libc::posix_spawnattr_setpgroup(&mut attrs, 0), "posix_spawnattr_setpgroup")?;
            check(responsibility_spawnattrs_setdisclaim(&mut attrs, 1), "responsibility_spawnattrs_setdisclaim")?;
            for fd in 0..3 {
                check(libc::posix_spawn_file_actions_addopen(&mut actions, fd, null.as_ptr(), libc::O_RDWR, 0), "posix_spawn_file_actions_addopen")?;
            }
            check(posix_spawn_file_actions_addchdir_np(&mut actions, dir.as_ptr()), "posix_spawn_file_actions_addchdir_np")?;
            let mut pid: libc::pid_t = 0;
            check(libc::posix_spawn(&mut pid, path.as_ptr(), &actions, &attrs, argv_ptrs.as_ptr(), env_ptrs.as_ptr()), "posix_spawn")?;
            Ok(Spawned { pid })
        })();
        libc::posix_spawn_file_actions_destroy(&mut actions);
        libc::posix_spawnattr_destroy(&mut attrs);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn wait(child: &mut Spawned) -> (bool, String) {
        let started = Instant::now();
        loop {
            if let Some(done) = child.try_wait().unwrap() {
                return done;
            }
            assert!(started.elapsed() < Duration::from_secs(10), "the child did not exit");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn the_child_runs_in_its_folder_and_group_with_the_variables_and_reports_its_exit() {
        let dir = std::env::temp_dir().join(format!("cophyla-spawn-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let out = dir.join("out.txt");
        let script = format!("pwd > '{}'; echo \"$COPHYLA_LAUNCHER\" >> '{}'; ps -o pgid= -p $$ >> '{}'; echo $$ >> '{}'; exit 3", out.display(), out.display(), out.display(), out.display());
        let mut child = spawn(Path::new("/bin/sh"), &["-c".into(), script], &dir, &[("COPHYLA_LAUNCHER", OsStr::new("/Applications/Cophyla.app/Contents/MacOS/Cophyla"))]).unwrap();
        let (ok, what) = wait(&mut child);
        assert!(!ok);
        assert_eq!(what, "exit status: 3");
        let text = std::fs::read_to_string(&out).unwrap();
        let lines: Vec<&str> = text.lines().map(str::trim).collect();
        assert_eq!(lines[0], dir.to_string_lossy());
        assert_eq!(lines[1], "/Applications/Cophyla.app/Contents/MacOS/Cophyla");
        // its own process group: the group id is its own pid
        assert_eq!(lines[2], lines[3]);
        let mut ok = spawn(Path::new("/usr/bin/true"), &[], &dir, &[]).unwrap();
        assert_eq!(wait(&mut ok), (true, "exit status: 0".to_string()));
        assert!(spawn(Path::new("/no/such/shell"), &[], &dir, &[]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
