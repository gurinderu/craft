//! How many names a file opened on Windows has: `nNumberOfLinks` of its handle.
#![expect(
    unsafe_code,
    reason = "one documented Win32 query on an open handle into a local, fixed-size struct"
)]

use std::fs::File;
use std::os::windows::io::AsRawHandle;

use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
};

/// The link count of the file behind `file`'s handle.
pub(super) fn of(file: &File) -> std::io::Result<u32> {
    // SAFETY: a zeroed BY_HANDLE_FILE_INFORMATION is a valid value of a plain-data struct.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the handle is `file`'s own, open for the call; `info` is a writable local of the
    // exact type the function fills (windows-sys 0.61).
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &raw mut info) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(info.nNumberOfLinks)
}
