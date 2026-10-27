//! The security descriptors the door sets, written as SDDL, and the checks on the SIDs that go
//! into them. A SID is checked for its shape before it is put in a string Windows parses, so a
//! value off the command line or `door.json` cannot close the ACE and open another.
//!
//! The pipe: SYSTEM and Administrators in full, the shim's own account in full (it creates the
//! later instances, which takes FILE_CREATE_PIPE_INSTANCE), and the door's user read and write,
//! no one else; `P` keeps anything from being inherited. Every client is checked again by SID
//! after it connects, which this DACL cannot do for an administrator.
//!
//! The data root and the web viewer's folder: SYSTEM and Administrators in full, the service's
//! account Modify, inherited by everything below, nothing inherited from above, so Users, who
//! may read what sits under `%ProgramData%` and `%ProgramFiles%`, read none of it.

/// The owners a data root may already have: SYSTEM, or the Administrators group, which owns
/// what an elevated administrator creates. Anything else may be a squatter's.
pub const SYSTEM: &str = "S-1-5-18";
pub const ADMINISTRATORS: &str = "S-1-5-32-544";

/// FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE: what icacls calls M.
pub const MODIFY: u32 = 0x0013_01bf;

/// Whether `s` has a SID's shape: `S-1-`, an authority, and one or more sub-authorities, all
/// decimal. Upper-case `S` only, as Windows writes them, since SIDs are compared as text.
pub fn is_sid(s: &str) -> bool {
    let mut parts = s.split('-');
    if parts.next() != Some("S") || parts.next() != Some("1") {
        return false;
    }
    let rest: Vec<&str> = parts.collect();
    if rest.len() < 2 || rest.len() > 16 {
        return false;
    }
    let decimal = |p: &str, max: u64| !p.is_empty() && p.len() <= 20 && p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u64>().is_ok_and(|n| n <= max);
    decimal(rest[0], 0xFFFF_FFFF_FFFF) && rest[1..].iter().all(|p| decimal(p, u32::MAX as u64))
}

/// The pipe's descriptor: the shim's own account (`own`) and the door's user (`user`).
pub fn pipe(own: &str, user: &str) -> Result<String, String> {
    for sid in [own, user] {
        if !is_sid(sid) {
            return Err(format!("not a SID: {sid}"));
        }
    }
    Ok(format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{own})(A;;GRGW;;;{user})"))
}

/// A protected folder: SYSTEM and Administrators full control, and the service's account
/// Modify once it exists (`None` while the install has not created the service yet), all
/// inherited by files and folders below.
pub fn protected_folder(service: Option<&str>) -> Result<String, String> {
    let mut sddl = String::from("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
    if let Some(sid) = service {
        if !is_sid(sid) {
            return Err(format!("not a SID: {sid}"));
        }
        sddl.push_str(&format!("(A;OICI;0x{MODIFY:x};;;{sid})"));
    }
    Ok(sddl)
}

/// Whether a folder owned by `owner` may be taken as the data root.
pub fn is_trusted_owner(owner: &str) -> bool {
    owner == SYSTEM || owner == ADMINISTRATORS
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "S-1-5-21-1004336348-1177238915-682003330-1001";
    const SERVICE: &str = "S-1-5-80-2229436862-3445512339-2390413535-4196318911-2549574212";

    #[test]
    fn sids_are_checked_for_their_shape() {
        for good in [USER, SERVICE, SYSTEM, ADMINISTRATORS, "S-1-1-0", "S-1-12-1-1234567890-1234567890-1234567890-1234567890"] {
            assert!(is_sid(good), "{good}");
        }
        for bad in ["", "S", "S-1", "S-1-5", "s-1-5-18", "S-2-5-18", "S-1-5-", "S-1--18", "S-1-5-18-", "S-1-5-x", "S-1-5-4294967296", "S-1-5-18)(A;;GA;;;WD", " S-1-5-18", "SY"] {
            assert!(!is_sid(bad), "{bad}");
        }
    }

    #[test]
    fn the_pipe_lets_in_the_system_administrators_the_shim_and_the_user() {
        assert_eq!(pipe(SERVICE, USER).unwrap(), format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{SERVICE})(A;;GRGW;;;{USER})"));
        // the console mode, where the shim runs as the user itself
        assert_eq!(pipe(USER, USER).unwrap(), format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{USER})(A;;GRGW;;;{USER})"));
        assert!(pipe(SERVICE, "S-1-5-18)(A;;GA;;;WD").is_err());
        assert!(pipe("WD", USER).is_err());
    }

    #[test]
    fn protected_folders_give_the_service_modify_and_users_nothing() {
        assert_eq!(protected_folder(None).unwrap(), "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
        let with = protected_folder(Some(SERVICE)).unwrap();
        assert_eq!(with, format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;{SERVICE})"));
        assert!(!with.contains(";BU)") && !with.contains(";WD)") && !with.contains(";AU)"));
        assert!(protected_folder(Some("BU")).is_err());
    }

    #[test]
    fn only_the_system_or_administrators_may_own_the_data_root() {
        assert!(is_trusted_owner(SYSTEM));
        assert!(is_trusted_owner(ADMINISTRATORS));
        assert!(!is_trusted_owner(USER));
        assert!(!is_trusted_owner("S-1-5-32-545"));
    }
}
