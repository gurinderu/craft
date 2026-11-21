//! Native boot and process incarnations, shared by admission and the CLI helper (#563 in @nick/craft).
use std::io::{Error, ErrorKind, Result};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

pub(crate) fn invalid(message: &str) -> Error {
    Error::new(ErrorKind::InvalidData, message)
}

#[cfg(unix)]
pub(crate) fn uuid(text: &str) -> Result<String> {
    let positions = [8, 13, 18, 23];
    if text.len() != 36
        || !text.bytes().enumerate().all(|(i, b)| {
            if positions.contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return Err(invalid("invalid process boot identity"));
    }
    Ok(text.replace('-', "").to_ascii_lowercase())
}

/// Canonical identity (`v1_<32 boot hex>_<16 incarnation hex>`), or proven absence.
///
/// # Errors
/// Refuses an invalid PID, unavailable native interface, malformed data or an access failure.
pub fn query(pid: u32) -> Result<Option<String>> {
    if pid == 0 {
        return Err(invalid("invalid process identity PID"));
    }
    #[cfg(target_os = "linux")]
    let value = linux::query(pid)?;
    #[cfg(target_os = "macos")]
    let value = macos::query(pid)?;
    #[cfg(windows)]
    let value = windows::query(pid)?;
    Ok(value.map(|(boot, incarnation)| format!("v1_{boot}_{incarnation:016x}")))
}

pub(crate) fn valid(text: &str) -> bool {
    let hex = |s: &str| {
        s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    text.len() == 52
        && text.starts_with("v1_")
        && text.as_bytes().get(35) == Some(&b'_')
        && text.get(3..35).is_some_and(hex)
        && text.get(36..52).is_some_and(hex)
}
