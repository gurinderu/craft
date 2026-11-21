//! Local-process admission, shared with `lib/index-turn.mjs` (realm @nick/craft, #557).
//! A ticket has one writer and an immutable name. A dead owner's ticket is ignored, not stolen.

use std::io::{Error, ErrorKind};
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::StoreError;

pub(super) const TURNS: &str = ".index-writers";
const MAX_NUMBER: u64 = 9_007_199_254_740_991;

fn alive(name: &str) -> std::io::Result<bool> {
    let pid = name.split('-').next().and_then(|p| p.parse::<i32>().ok());
    let Some(pid) = pid.filter(|p| *p > 0) else {
        return Err(Error::new(
            ErrorKind::InvalidData,
            "invalid index writer ticket",
        ));
    };
    #[cfg(unix)]
    {
        Ok(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None)
                != Err(nix::errno::Errno::ESRCH),
        )
    }
    #[cfg(windows)]
    {
        Ok(super::windows::alive(pid.unsigned_abs()))
    }
}

fn number(root: &Path, name: &str) -> std::io::Result<Option<u64>> {
    match std::fs::read_to_string(root.join(name).join("number")) {
        Ok(text) => text
            .parse::<u64>()
            .ok()
            .filter(|n| *n > 0 && *n <= MAX_NUMBER && n.to_string() == text)
            .map(Some)
            .ok_or_else(|| Error::new(ErrorKind::InvalidData, "invalid index writer number")),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn peers(root: &Path, own: &str) -> std::io::Result<Vec<String>> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let name = entry?.file_name().into_string().map_err(|name| {
            Error::new(
                ErrorKind::InvalidData,
                format!("invalid index writer name: {}", name.display()),
            )
        })?;
        if name != own && alive(&name)? {
            found.push(name);
        }
    }
    Ok(found)
}

fn ahead(root: &Path, peer: &str, own: &str, ticket: u64) -> std::io::Result<bool> {
    if !root.join(peer).try_exists()? || !alive(peer)? {
        return Ok(false);
    }
    Ok(number(root, peer)?.is_none_or(|n| n < ticket || (n == ticket && peer < own)))
}

struct Ticket(PathBuf);
impl Drop for Ticket {
    fn drop(&mut self) {
        drop(std::fs::remove_dir_all(&self.0));
    }
}

fn publish(root: &Path, own: &str) -> std::io::Result<u64> {
    let mut maximum = 0;
    for peer in peers(root, own)? {
        maximum = maximum.max(number(root, &peer)?.unwrap_or(0));
    }
    let ticket = maximum + 1;
    if ticket > MAX_NUMBER {
        return Err(Error::other("index writer ticket numbers exhausted"));
    }
    let dir = root.join(own);
    std::fs::write(dir.join("choosing"), ticket.to_string())?;
    std::fs::rename(dir.join("choosing"), dir.join("number"))?;
    Ok(ticket)
}

pub(super) fn with_turn<T>(
    store: &Path,
    deadline: Instant,
    f: impl FnOnce() -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let root = store.join(TURNS);
    let io = |e: Error| StoreError::io(&root, &e);
    std::fs::create_dir_all(&root).map_err(io)?;
    let own = super::token();
    let dir = root.join(&own);
    std::fs::create_dir(&dir).map_err(io)?;
    let _ticket = Ticket(dir);
    let ticket = publish(&root, &own).map_err(io)?;
    for peer in peers(&root, &own).map_err(io)? {
        while ahead(&root, &peer, &own, ticket).map_err(io)? {
            if Instant::now() >= deadline {
                return Err(StoreError::Locked(format!(
                    "index.jsonl stays locked: waiting for writer {peer}"
                )));
            }
            std::thread::sleep(super::WAIT);
        }
    }
    f()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_live_chooser_blocks_and_an_expired_wait_leaves_its_ticket_alone() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join(TURNS);
        let peer = root.join(format!("{}-choosing", std::process::id()));
        std::fs::create_dir_all(&peer).unwrap();
        let result = with_turn(
            d.path(),
            Instant::now() + Duration::from_millis(40),
            || -> Result<(), StoreError> { panic!("entered beside a live chooser") },
        );
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("waiting for writer")
        );
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir(peer).unwrap();
        with_turn(d.path(), Instant::now() + Duration::from_secs(1), || Ok(())).unwrap();
    }

    #[test]
    fn invalid_and_exhausted_tickets_refuse_admission() {
        let d = tempfile::tempdir().unwrap();
        let peer = d
            .path()
            .join(TURNS)
            .join(format!("{}-peer", std::process::id()));
        std::fs::create_dir_all(&peer).unwrap();
        for text in ["broken", "0", "9007199254740992", "9007199254740991"] {
            std::fs::write(peer.join("number"), text).unwrap();
            let result = with_turn(
                d.path(),
                Instant::now() + Duration::from_secs(1),
                || -> Result<(), StoreError> { panic!("entered with an invalid ticket") },
            );
            assert!(result.is_err());
        }
    }
}
