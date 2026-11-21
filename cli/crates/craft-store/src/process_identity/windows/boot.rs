//! Class 90 is an internal Windows API: resolve dynamically and refuse changed status/shape (#563).
#![expect(
    unsafe_code,
    reason = "dynamic system ntdll query with a checked fixed output buffer"
)]
use crate::process_identity::invalid;
use std::io::{Error, Result};
use windows_sys::Win32::Foundation::{FreeLibrary, HMODULE};
use windows_sys::Win32::System::LibraryLoader::{
    GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW,
};
use windows_sys::core::GUID;

// SYSTEM_BOOT_ENVIRONMENT_INFORMATION, Win8+: GUID at 0, firmware at 16, flags at 24, size 32.
// Source: Geoff Chappell's published symbol-layout analysis, not a stable Microsoft API contract.
#[repr(C)]
#[derive(Default)]
struct BootInfo {
    id: GUID,
    firmware: u32,
    padding: u32,
    flags: u64,
}
const _: () = assert!(size_of::<BootInfo>() == 32);
type Query = unsafe extern "system" fn(i32, *mut core::ffi::c_void, u32, *mut u32) -> i32;

struct Library(HMODULE);
impl Drop for Library {
    fn drop(&mut self) {
        // SAFETY: handle is the owned reference from LoadLibraryExW, released exactly once.
        unsafe {
            FreeLibrary(self.0);
        }
    }
}

pub(super) fn query() -> Result<String> {
    let name: Vec<u16> = "ntdll.dll\0".encode_utf16().collect();
    // SAFETY: nul-terminated UTF16; only the system directory is searched, no file handle supplied.
    let raw = unsafe {
        LoadLibraryExW(
            name.as_ptr(),
            std::ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
    };
    if raw.is_null() {
        return Err(Error::last_os_error());
    }
    let library = Library(raw);
    // SAFETY: valid module reference and nul-terminated ASCII export name.
    let address = unsafe { GetProcAddress(library.0, c"NtQuerySystemInformation".as_ptr().cast()) }
        .ok_or_else(Error::last_os_error)?;
    // SAFETY: Microsoft's documented NtQuerySystemInformation signature, also checked against windows-sys 0.61.2.
    let query: Query = unsafe { std::mem::transmute(address) };
    let mut info = BootInfo::default();
    let mut length = 0;
    // SAFETY: aligned 32-byte repr(C) output buffer; API receives its exact size and writable length.
    let status = unsafe { query(90, (&raw mut info).cast(), 32, &raw mut length) };
    if status != 0 || length != 32 {
        return Err(invalid(&format!(
            "boot identity query: NTSTATUS {status:#x}, length {length} (expected 32)"
        )));
    }
    let id = info.id;
    Ok(format!(
        "{:08x}{:04x}{:04x}{:016x}",
        id.data1,
        id.data2,
        id.data3,
        u64::from_be_bytes(id.data4)
    ))
}
