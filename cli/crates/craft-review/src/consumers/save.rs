//! The list saved whole to the run directory, and the lenses' budgeted part of it.

use std::path::Path;

use super::{Consumers, FILE};

/// The list a thread built for the run in `dir`, kept as [`keep`] keeps it; a list saying the build
/// stopped when its thread panicked (realm @nick/craft, node #529).
#[must_use]
pub fn prepare(dir: &Path, built: std::thread::Result<Consumers>) -> (Consumers, Option<String>) {
    let full =
        built.unwrap_or_else(|_| Consumers::failed("the consumers list stopped unexpectedly"));
    keep(dir, full)
}

/// Saves `full` as `dir`/[`FILE`] and gives it back with the file's path, each lens task cutting
/// its own part ([`super::text`]); a note when the file could not be written, its path then left
/// empty.
#[must_use]
pub fn keep(dir: &Path, full: Consumers) -> (Consumers, Option<String>) {
    let mut lens = full;
    let note = write(dir, &mut lens)
        .err()
        .map(|e| format!("the consumers list could not be written: {e}"));
    if note.is_some() {
        lens.file.clear();
    }
    (lens, note)
}

/// Writes `c` as `dir`/[`FILE`], noting the path in it.
fn write(dir: &Path, c: &mut Consumers) -> std::io::Result<()> {
    let path = dir.join(FILE);
    c.file = path.display().to_string();
    let body = serde_json::to_string_pretty(c).map_err(std::io::Error::other)?;
    std::fs::write(&path, body)
}

#[cfg(test)]
mod tests;
