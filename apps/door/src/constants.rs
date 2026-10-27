//! The names and numbers this shim shares with cophylad's door code, which installs it, attaches
//! to its pipe and runs as its child. A TypeScript test reads this file as text and pins each
//! value against its own copy, matching whole lines of the form
//! `pub const NAME: &str = "...";` or `pub const NAME: u32 = N;`. Keep every constant on one
//! line in that form (the test below checks it), and anything the other side does not share in
//! the module that uses it.

/// The service's name in the SCM, and so its virtual account's, `NT SERVICE\CophylaDoor`.
pub const SERVICE_NAME: &str = "CophylaDoor";
/// What the Services console shows.
pub const SERVICE_DISPLAY: &str = "Cophyla sign-in door";
/// The pipe the user's daemon attaches to.
pub const PIPE_NAME: &str = r"\\.\pipe\cophyla-door";
/// The folder under both `%ProgramFiles%` and `%ProgramData%`.
pub const FOLDER: &str = "Cophyla Door";
/// The SCM's image, in `%ProgramFiles%\Cophyla Door`.
pub const EXE_NAME: &str = "cophyla-door.exe";
/// The shim-child protocol's version, sent in `shim.hello`.
pub const SHIM_PROTOCOL: u32 = 1;
/// The child's exit code for "a new version is current: start me again", which is no crash.
pub const EXIT_UPDATED: u32 = 75;
/// How long a child has, after `shim.stop`, to exit before it is killed.
pub const STOP_GRACE_MS: u32 = 10000;
/// The window, from a version's first start in this shim's life, in which its crashes count.
pub const CRASH_WINDOW_MS: u32 = 300000;
/// That many crashes within the window, and the version is given up for `previous`.
pub const CRASH_LIMIT: u32 = 5;
/// The inbound UDP rule for the web viewer's streamer.
pub const FIREWALL_STREAMER: &str = "Cophyla Door streamer";
/// The inbound UDP rule for cophyla-net, the direct connections' helper.
pub const FIREWALL_NET: &str = "Cophyla Door net";

#[cfg(test)]
mod tests {
    /// The TypeScript side finds the values with a line regex: a constant split over lines, or
    /// written in another form, would be missed there rather than fail here.
    #[test]
    fn every_constant_is_one_line_in_the_pinned_form() {
        let source = include_str!("constants.rs");
        let mut seen = 0;
        for line in source.lines().map(str::trim_end) {
            if !line.starts_with("pub const ") {
                continue;
            }
            seen += 1;
            let rest = &line["pub const ".len()..];
            let (name, rest) = rest.split_once(": ").expect(line);
            assert!(!name.is_empty() && name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'), "{line}");
            if let Some(value) = rest.strip_prefix("&str = ") {
                let quoted = value.strip_suffix(';').expect(line);
                let inner = quoted.strip_prefix("r\"").or_else(|| quoted.strip_prefix('"')).and_then(|q| q.strip_suffix('"'));
                assert!(inner.is_some_and(|s| !s.contains('"')), "{line}");
            } else if let Some(value) = rest.strip_prefix("u32 = ") {
                let digits = value.strip_suffix(';').expect(line);
                assert!(!digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()), "{line}");
            } else {
                panic!("not a pinned form: {line}");
            }
        }
        assert_eq!(seen, 12);
    }

    #[test]
    fn the_pipe_name_is_the_local_namespace() {
        assert_eq!(super::PIPE_NAME, "\\\\.\\pipe\\cophyla-door");
    }
}
