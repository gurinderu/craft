//! The store read as it is written: `index.jsonl` one line at a time, the detail records one file
//! at a time, nothing held but what the caller keeps. A line or file that does not read as a JSON
//! object is passed over and counted, never the reason a read stops.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use crate::js::{Js, Obj, parse};

/// What a read passed over.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Skipped {
    /// The 1-based numbers of the index lines that are not a JSON object.
    pub lines: Vec<usize>,
    /// The detail files that are not a JSON object, with why.
    pub records: Vec<(String, String)>,
}

impl Skipped {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty() && self.records.is_empty()
    }
}

/// Every line of `store`'s index that reads as an object, in order, handed to `each` with its
/// 1-based number; the others counted in `skipped`. A store with no index yet has no lines.
///
/// # Errors
/// When the index is there and cannot be read.
pub fn index(
    store: &Path,
    skipped: &mut Skipped,
    mut each: impl FnMut(usize, Obj),
) -> std::io::Result<()> {
    let file = match std::fs::File::open(store.join("index.jsonl")) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let mut reader = BufReader::new(file);
    let mut buf = Vec::new();
    let mut n = 0;
    loop {
        buf.clear();
        if reader.read_until(b'\n', &mut buf)? == 0 {
            return Ok(());
        }
        n += 1;
        if buf.trim_ascii().is_empty() {
            continue;
        }
        match std::str::from_utf8(&buf).ok().map(parse) {
            Some(Ok(Js::Obj(o))) => each(n, o),
            _ => skipped.lines.push(n),
        }
    }
}

/// The detail records' file names in `store`, oldest first (`<ts>-<kind>-<name>.json` sorts by time).
///
/// # Errors
/// When the store cannot be listed.
pub fn record_names(store: &Path) -> std::io::Result<Vec<String>> {
    let mut names: Vec<String> = std::fs::read_dir(store)?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    Ok(names)
}

/// One detail record by its file name in `store`, or why it does not read.
///
/// # Errors
/// When the file cannot be read or is not a JSON object.
pub fn record(store: &Path, name: &str) -> Result<Obj, String> {
    let text = std::fs::read_to_string(store.join(name)).map_err(|e| e.to_string())?;
    match parse(&text) {
        Ok(Js::Obj(o)) => Ok(o),
        Ok(_) => Err("not a JSON object".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Every detail record of `store`, oldest first, handed to `each` with its file name; one that
/// does not read counted in `skipped`.
///
/// # Errors
/// When the store cannot be listed.
pub fn records(
    store: &Path,
    skipped: &mut Skipped,
    mut each: impl FnMut(&str, Obj),
) -> std::io::Result<()> {
    for name in record_names(store)? {
        match record(store, &name) {
            Ok(o) => each(&name, o),
            Err(why) => skipped.records.push((name, why)),
        }
    }
    Ok(())
}

/// The run store under the user's home, `~/.craft/runs`.
#[must_use]
pub fn home_store() -> Option<PathBuf> {
    home_from(std::env::var_os("HOME")).map(|h| h.join(".craft/runs"))
}

/// The user's home: `HOME` when set and not empty, else the passwd entry ([`home_from`]).
#[must_use]
pub fn home() -> Option<PathBuf> {
    home_from(std::env::var_os("HOME"))
}

/// The user's home as `os.homedir()` finds it: `home` (`$HOME`) when set and not empty, else the
/// passwd entry of the user the process runs as.
#[must_use]
pub fn home_from(home: Option<std::ffi::OsString>) -> Option<PathBuf> {
    home.filter(|h| !h.is_empty())
        .map(PathBuf::from)
        .or_else(passwd_home)
}

#[cfg(unix)]
fn passwd_home() -> Option<PathBuf> {
    let user = nix::unistd::User::from_uid(nix::unistd::getuid()).ok()??;
    Some(user.dir).filter(|d| !d.as_os_str().is_empty())
}

#[cfg(not(unix))]
fn passwd_home() -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_no_home_set_the_store_is_under_the_users_passwd_home() {
        let given = home_from(Some("/h".into()));
        assert_eq!(given, Some(PathBuf::from("/h")));
        let passwd = nix::unistd::User::from_uid(nix::unistd::getuid())
            .unwrap()
            .map(|u| u.dir);
        assert!(passwd.is_some());
        assert_eq!(home_from(None), passwd);
        assert_eq!(home_from(Some("".into())), passwd, "an empty HOME is none");
    }
}
