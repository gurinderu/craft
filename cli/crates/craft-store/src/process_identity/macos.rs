//! Apple xnu `bsd/sys/proc_info_private.h`: flavour 17, ABI size 56; #563 in @nick/craft.
#![expect(unsafe_code, reason = "checked native process and boot identity FFI")]
use super::{invalid, uuid};
use nix::libc;
use std::io::{Error, Result};

#[repr(C)]
#[derive(Default)]
struct UniqueInfo {
    uuid: [u8; 16],
    unique: u64,
    parent_unique: u64,
    id_version: i32,
    original_parent_version: i32,
    reserved: [u64; 2],
}
const _: () = assert!(size_of::<UniqueInfo>() == 56);

#[link(name = "proc")]
unsafe extern "C" {
    fn proc_pidinfo(
        pid: libc::c_int,
        flavor: libc::c_int,
        arg: u64,
        buffer: *mut libc::c_void,
        size: libc::c_int,
    ) -> libc::c_int;
}

fn boot() -> Result<String> {
    let mut buffer = [0_u8; 37];
    let mut size = buffer.len();
    // SAFETY: nul-terminated name; writable 37-byte buffer and its length; no new value supplied.
    let status = unsafe {
        libc::sysctlbyname(
            c"kern.bootsessionuuid".as_ptr(),
            buffer.as_mut_ptr().cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if status != 0 {
        return Err(Error::last_os_error());
    }
    if size != buffer.len() || buffer[36] != 0 {
        return Err(invalid("unexpected boot-session UUID size"));
    }
    uuid(
        std::str::from_utf8(&buffer[..36])
            .map_err(|_invalid| invalid("invalid boot-session UUID"))?,
    )
}

pub(super) fn query(pid: u32) -> Result<Option<(String, u64)>> {
    let pid = i32::try_from(pid).map_err(|_invalid| invalid("invalid process identity PID"))?;
    let boot = boot()?;
    let mut info = UniqueInfo::default();
    nix::errno::Errno::clear();
    // SAFETY: verified repr(C) 56-byte output struct, valid signed PID; proc_pidinfo writes at most size.
    let size = unsafe { proc_pidinfo(pid, 17, 0, (&raw mut info).cast(), 56) };
    if size <= 0 {
        let error = Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        if error.raw_os_error() == Some(0) {
            return Err(invalid("proc_pidinfo returned no identity or error"));
        }
        return Err(error);
    }
    if size != 56 {
        return Err(invalid("unexpected proc unique identifier size"));
    }
    Ok(Some((boot, info.unique)))
}
