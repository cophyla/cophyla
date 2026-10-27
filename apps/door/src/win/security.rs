//! SIDs and security descriptors: the shim's own account, a pipe client's, an account's by
//! name, whether this process is elevated, and folders given a protected DACL. SIDs travel as
//! their string form (`S-1-5-…`), which is what `door.json`, the protocol and the SDDL use, so
//! two are compared as text once each has been through Windows' own round trip.

use std::io;
use std::path::Path;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{LocalFree, ERROR_INSUFFICIENT_BUFFER, HANDLE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW, GetNamedSecurityInfoW, SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    GetSecurityDescriptorDacl, GetTokenInformation, LookupAccountNameW, RevertToSelf, TokenElevation, TokenUser, ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SID_NAME_USE, TOKEN_ELEVATION, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
use windows_sys::Win32::System::Pipes::ImpersonateNamedPipeClient;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken};

use super::{from_wide_ptr, wide, Handle};

/// A security descriptor Windows built from SDDL, freed when dropped.
pub struct SecurityDescriptor(PSECURITY_DESCRIPTOR);

// SAFETY: the descriptor is a block of memory only read after it is built.
unsafe impl Send for SecurityDescriptor {}
unsafe impl Sync for SecurityDescriptor {}

impl SecurityDescriptor {
    pub fn from_sddl(sddl: &str) -> io::Result<SecurityDescriptor> {
        let text = wide(sddl);
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: a NUL-terminated string in, a LocalAlloc'd descriptor out, freed on drop.
        if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(), SDDL_REVISION_1, &mut sd, null_mut()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(SecurityDescriptor(sd))
    }

    /// Attributes naming this descriptor, not inheritable. Valid while `self` lives.
    pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: self.0, bInheritHandle: 0 }
    }

    fn dacl(&self) -> io::Result<*mut ACL> {
        let (mut present, mut dacl, mut defaulted) = (0, null_mut(), 0);
        // SAFETY: a valid descriptor; the DACL pointer points into it.
        if unsafe { GetSecurityDescriptorDacl(self.0, &mut present, &mut dacl, &mut defaulted) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if present == 0 {
            return Err(io::Error::other("the descriptor has no DACL"));
        }
        Ok(dacl)
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        // SAFETY: LocalAlloc'd by ConvertStringSecurityDescriptorToSecurityDescriptorW.
        unsafe { LocalFree(self.0) };
    }
}

/// The string form of a SID.
///
/// # Safety
/// `sid` must point to a valid SID.
unsafe fn sid_string(sid: PSID) -> io::Result<String> {
    let mut text = null_mut();
    if ConvertSidToStringSidW(sid, &mut text) == 0 {
        return Err(io::Error::last_os_error());
    }
    let out = from_wide_ptr(text);
    LocalFree(text.cast());
    Ok(out)
}

/// The user a token is for.
fn token_user(token: HANDLE) -> io::Result<String> {
    let mut len = 0u32;
    // SAFETY: a size query, then a buffer of that size, 8-aligned for TOKEN_USER.
    unsafe {
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut len);
        if len == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        if GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len) == 0 {
            return Err(io::Error::last_os_error());
        }
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        sid_string(user.User.Sid)
    }
}

fn process_token() -> io::Result<Handle> {
    let mut token = null_mut();
    // SAFETY: the pseudo-handle of this process; the token handle is owned.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Handle::new(token).ok_or_else(io::Error::last_os_error)
}

/// The account this process runs as: the user in a console, `NT SERVICE\CophylaDoor` under
/// the SCM.
pub fn process_user_sid() -> io::Result<String> {
    token_user(process_token()?.raw())
}

/// Whether this process holds an elevated token.
pub fn is_elevated() -> bool {
    let Ok(token) = process_token() else { return false };
    let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut len = 0;
    // SAFETY: a fixed-size struct for TokenElevation.
    let ok = unsafe { GetTokenInformation(token.raw(), TokenElevation, (&mut elevation as *mut TOKEN_ELEVATION).cast(), std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut len) };
    ok != 0 && elevation.TokenIsElevated != 0
}

/// `text` as Windows writes the same SID, or `None` when it is not one.
pub fn canonical_sid(text: &str) -> Option<String> {
    let w = wide(text);
    let mut sid: PSID = null_mut();
    // SAFETY: a LocalAlloc'd SID out, freed here.
    unsafe {
        if ConvertStringSidToSidW(w.as_ptr(), &mut sid) == 0 {
            return None;
        }
        let out = sid_string(sid).ok();
        LocalFree(sid);
        out
    }
}

/// An account's SID by name, as `NT SERVICE\CophylaDoor` once the service exists.
pub fn account_sid(name: &str) -> io::Result<String> {
    let w = wide(name);
    let (mut sid_len, mut dom_len, mut usage) = (0u32, 0u32, 0 as SID_NAME_USE);
    // SAFETY: a size query, then buffers of those sizes.
    unsafe {
        LookupAccountNameW(null(), w.as_ptr(), null_mut(), &mut sid_len, null_mut(), &mut dom_len, &mut usage);
        let err = io::Error::last_os_error();
        if sid_len == 0 || err.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) {
            return Err(err);
        }
        let mut sid = vec![0u64; (sid_len as usize).div_ceil(8)];
        let mut dom = vec![0u16; dom_len as usize + 1];
        if LookupAccountNameW(null(), w.as_ptr(), sid.as_mut_ptr().cast(), &mut sid_len, dom.as_mut_ptr(), &mut dom_len, &mut usage) == 0 {
            return Err(io::Error::last_os_error());
        }
        sid_string(sid.as_mut_ptr().cast())
    }
}

/// The user at the other end of a connected pipe instance. Impersonating takes no privilege:
/// without SeImpersonate the thread gets an identification-level token, which is enough to
/// read its user. The token is opened against the shim's own account first and the client's
/// second, and the thread always goes back to the shim's own account; were that to fail, the
/// thread would go on as the client, so the process ends instead.
pub fn pipe_client_sid(pipe: HANDLE) -> io::Result<String> {
    // SAFETY: a connected pipe instance; the impersonation is undone before anything else runs
    // on this thread.
    unsafe {
        if ImpersonateNamedPipeClient(pipe) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut token = null_mut();
        let opened = if OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) != 0 {
            Ok(())
        } else {
            let as_self = io::Error::last_os_error();
            if OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 0, &mut token) != 0 {
                Ok(())
            } else {
                Err(as_self)
            }
        };
        if RevertToSelf() == 0 {
            eprintln!("cophyla-door: RevertToSelf failed ({}); ending rather than going on as a pipe client", io::Error::last_os_error());
            std::process::abort();
        }
        opened?;
        let token = Handle::new(token).ok_or_else(|| io::Error::other("no thread token"))?;
        token_user(token.raw())
    }
}

/// The owner of a file or folder.
pub fn owner_sid(path: &Path) -> io::Result<String> {
    let w = wide(path);
    let (mut owner, mut sd): (PSID, PSECURITY_DESCRIPTOR) = (null_mut(), null_mut());
    // SAFETY: the owner points into the descriptor, freed after it is read.
    unsafe {
        let err = GetNamedSecurityInfoW(w.as_ptr(), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, &mut owner, null_mut(), null_mut(), null_mut(), &mut sd);
        if err != 0 {
            return Err(io::Error::from_raw_os_error(err as i32));
        }
        let out = if owner.is_null() { Err(io::Error::other("no owner")) } else { sid_string(owner) };
        LocalFree(sd);
        out
    }
}

/// Replaces a folder's DACL with the one in `sddl`, protected from inheritance; Windows
/// carries the inheritable entries down to what is below it.
pub fn set_protected_dacl(path: &Path, sddl: &str) -> io::Result<()> {
    let sd = SecurityDescriptor::from_sddl(sddl)?;
    let dacl = sd.dacl()?;
    let w = wide(path);
    // SAFETY: the DACL lives in `sd`, which outlives the call.
    let err = unsafe { SetNamedSecurityInfoW(w.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, null_mut(), null_mut(), dacl, null()) };
    if err != 0 {
        return Err(io::Error::from_raw_os_error(err as i32));
    }
    Ok(())
}

/// Creates a folder with the descriptor in `sddl` from its first moment, so nothing can be
/// put in it under the inherited one.
pub fn create_dir_with(path: &Path, sddl: &str) -> io::Result<()> {
    let sd = SecurityDescriptor::from_sddl(sddl)?;
    let sa = sd.attributes();
    let w = wide(path);
    // SAFETY: the attributes point into `sd`, which outlives the call.
    if unsafe { CreateDirectoryW(w.as_ptr(), &sa) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sddl;

    #[test]
    fn this_process_has_a_user_and_sids_round_trip() {
        let me = process_user_sid().unwrap();
        assert!(sddl::is_sid(&me), "{me}");
        assert_eq!(canonical_sid(&me).as_deref(), Some(me.as_str()));
        assert_eq!(canonical_sid("S-1-5-18").as_deref(), Some("S-1-5-18"));
        assert_eq!(canonical_sid("alice"), None);
        assert_eq!(account_sid("NT AUTHORITY\\SYSTEM").unwrap(), "S-1-5-18");
        assert_eq!(account_sid("BUILTIN\\Administrators").unwrap(), "S-1-5-32-544");
    }

    #[test]
    fn the_sddl_builders_make_descriptors_windows_takes() {
        let me = process_user_sid().unwrap();
        SecurityDescriptor::from_sddl(&sddl::pipe(&me, &me).unwrap()).unwrap();
        SecurityDescriptor::from_sddl(&sddl::protected_folder(None).unwrap()).unwrap();
        SecurityDescriptor::from_sddl(&sddl::protected_folder(Some(&me)).unwrap()).unwrap().dacl().unwrap();
    }

    #[test]
    fn a_folder_made_with_a_descriptor_is_owned_by_its_maker() {
        let dir = std::env::temp_dir().join(format!("cophyla-door-sd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let me = process_user_sid().unwrap();
        // a descriptor the test can still delete: the protected form, with the user given Modify
        create_dir_with(&dir, &sddl::protected_folder(Some(&me)).unwrap()).unwrap();
        let owner = owner_sid(&dir).unwrap();
        assert!(owner == me || sddl::is_trusted_owner(&owner), "{owner}");
        set_protected_dacl(&dir, &sddl::protected_folder(Some(&me)).unwrap()).unwrap();
        std::fs::write(dir.join("f"), b"x").unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
