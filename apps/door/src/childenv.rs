//! The child's environment, built from nothing: the service's own is the SCM's, and a console
//! kit's is a developer's, and neither should leak into a process that serves the sign-in
//! screen. A few of the machine's variables pass through, because Bun and the Windows APIs
//! under it need them (SystemRoot for its DLLs and crypto, the folders, the processor); PATH
//! is the system's folders only; the temporary folders, the profile and Bun's cache are under
//! the child's home, which the service may write and Users may not read.

use std::ffi::OsString;
use std::path::Path;

/// The machine's variables passed through as they are, when set.
pub const PASSED: [&str; 9] = ["SystemRoot", "windir", "SystemDrive", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"];

/// The environment for a child with `home` as its home, reading the shim's own through `get`.
pub fn build(get: impl Fn(&str) -> Option<OsString>, home: &Path) -> Vec<(&'static str, OsString)> {
    let mut env: Vec<(&'static str, OsString)> = PASSED.iter().filter_map(|name| get(name).filter(|v| !v.is_empty()).map(|v| (*name, v))).collect();
    let root = get("SystemRoot").filter(|v| !v.is_empty()).unwrap_or_else(|| OsString::from(r"C:\Windows"));
    let root = root.to_string_lossy();
    env.push(("PATH", OsString::from(format!(r"{root}\System32;{root};{root}\System32\WindowsPowerShell\v1.0"))));
    let tmp = home.join("tmp");
    env.push(("TEMP", tmp.clone().into_os_string()));
    env.push(("TMP", tmp.into_os_string()));
    env.push(("USERPROFILE", home.as_os_str().to_os_string()));
    env.push(("LOCALAPPDATA", home.join("appdata").into_os_string()));
    env.push(("BUN_INSTALL_CACHE_DIR", home.join("bun-cache").into_os_string()));
    env.push(("COPHYLA_DOOR", OsString::from("1")));
    env
}

/// The folders under the child's home the shim makes before a spawn.
pub const HOME_DIRS: [&str; 3] = ["tmp", "bun-cache", "appdata"];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn machine(name: &str) -> Option<OsString> {
        let vars: HashMap<&str, &str> = HashMap::from([
            ("SystemRoot", r"C:\WINDOWS"),
            ("windir", r"C:\WINDOWS"),
            ("SystemDrive", "C:"),
            ("ProgramData", r"C:\ProgramData"),
            ("ProgramFiles", r"C:\Program Files"),
            ("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            ("COMPUTERNAME", "DESK"),
            ("NUMBER_OF_PROCESSORS", "16"),
            ("PROCESSOR_ARCHITECTURE", "AMD64"),
            ("USERNAME", "alice"),
            ("APPDATA", r"C:\Users\alice\AppData\Roaming"),
            ("ANTHROPIC_API_KEY", "sk-secret"),
            ("PATH", r"C:\Users\alice\.bun\bin;C:\WINDOWS\system32"),
        ]);
        vars.get(name).map(OsString::from)
    }

    #[test]
    fn only_the_listed_variables_and_the_home_s_own() {
        let home = PathBuf::from(r"C:\ProgramData\Cophyla Door\home");
        let env = build(machine, &home);
        let map: HashMap<&str, String> = env.iter().map(|(k, v)| (*k, v.to_string_lossy().into_owned())).collect();
        assert_eq!(map.len(), env.len(), "no name twice");
        let mut names: Vec<&str> = map.keys().copied().collect();
        names.sort_unstable();
        let mut want = PASSED.to_vec();
        want.extend(["PATH", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "BUN_INSTALL_CACHE_DIR", "COPHYLA_DOOR"]);
        want.sort_unstable();
        assert_eq!(names, want);
        assert_eq!(map["PATH"], r"C:\WINDOWS\System32;C:\WINDOWS;C:\WINDOWS\System32\WindowsPowerShell\v1.0");
        assert_eq!(map["TEMP"], home.join("tmp").to_string_lossy());
        assert_eq!(map["TMP"], home.join("tmp").to_string_lossy());
        assert_eq!(map["USERPROFILE"], home.to_string_lossy());
        assert_eq!(map["LOCALAPPDATA"], home.join("appdata").to_string_lossy());
        assert_eq!(map["BUN_INSTALL_CACHE_DIR"], home.join("bun-cache").to_string_lossy());
        assert_eq!(map["COPHYLA_DOOR"], "1");
        assert_eq!(map["COMPUTERNAME"], "DESK");
    }

    #[test]
    fn unset_variables_are_left_out_and_path_still_names_the_system() {
        let env = build(|_| None, Path::new("H"));
        let names: Vec<&str> = env.iter().map(|(k, _)| *k).collect();
        assert_eq!(names, ["PATH", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "BUN_INSTALL_CACHE_DIR", "COPHYLA_DOOR"]);
        assert_eq!(env[0].1, OsString::from(r"C:\Windows\System32;C:\Windows;C:\Windows\System32\WindowsPowerShell\v1.0"));
    }
}
