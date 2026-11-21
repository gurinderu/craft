//! `GetProcessTimes` and death on one handle (#563 in @nick/craft).
#![expect(unsafe_code, reason = "checked native process handle API")]
use super::invalid;
use std::io::{Error, Result};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::Foundation::{
    ERROR_INVALID_PARAMETER, FILETIME, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    WaitForSingleObject,
};
mod boot;

pub(super) fn query(pid: u32) -> Result<Option<(String, u64)>> {
    let boot = boot::query()?;
    // SAFETY: numeric PID and documented access flags, no borrowed pointers.
    let raw = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if raw.is_null() {
        let error = Error::last_os_error();
        if error.raw_os_error().and_then(|n| u32::try_from(n).ok()) == Some(ERROR_INVALID_PARAMETER)
        {
            return Ok(None);
        }
        return Err(error);
    }
    // SAFETY: the non-null handle is newly owned, transferred once, and closed by OwnedHandle.
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: handle remains open with QUERY_LIMITED_INFORMATION; all four outputs are writable.
    let ok = unsafe {
        GetProcessTimes(
            handle.as_raw_handle(),
            &raw mut created,
            &raw mut exited,
            &raw mut kernel,
            &raw mut user,
        )
    };
    if ok == 0 {
        return Err(Error::last_os_error());
    }
    // SAFETY: the same live handle has SYNCHRONIZE access; zero timeout never blocks.
    match unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } {
        WAIT_OBJECT_0 => Ok(None),
        WAIT_TIMEOUT => Ok(Some((
            boot,
            (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime),
        ))),
        _ => Err(invalid("could not establish process liveness")),
    }
}
