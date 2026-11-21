//! Native, non-blocking process liveness for admission (realm @nick/craft, #557).
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

use windows_sys::Win32::Foundation::{ERROR_INVALID_PARAMETER, GetLastError, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};

#[expect(
    unsafe_code,
    reason = "Windows process handles have no safe standard-library opener"
)]
pub(super) fn alive(pid: u32) -> bool {
    // SAFETY: OpenProcess accepts a numeric PID and flags, no borrowed memory. The returned handle
    // is uniquely owned here; a null return is inspected before constructing OwnedHandle.
    let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if raw.is_null() {
        // SAFETY: thread-local error from the immediately preceding failed OpenProcess.
        return unsafe { GetLastError() } != ERROR_INVALID_PARAMETER;
    }
    // SAFETY: the non-null handle came from OpenProcess and ownership is transferred exactly once.
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    // SAFETY: handle stays live through the call and was opened with SYNCHRONIZE; zero never waits.
    // An access/query failure is uncertainty, so only a signalled process counts as dead.
    unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) != WAIT_OBJECT_0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_is_alive_and_a_finished_child_is_not() {
        assert!(alive(std::process::id()));
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!alive(pid));
    }
}
