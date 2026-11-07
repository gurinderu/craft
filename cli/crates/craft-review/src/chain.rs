//! The chain of a branch's review rounds: each finished run files a
//! small round record, `round.json`, beside its state — the repository and branch it reviewed, the
//! head it read, its round and its ledger — and a later run of the same branch builds on the newest
//! one whose head is still on its history, as `findPriorRound` in `lib/craft-log-run.mjs` picks a
//! round from the run store. The binary reads its own records, so no ledger crosses a model.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::git;
use crate::ledger::LedgerRow;

/// The round record's format; a record of another format is not read as a round.
const ROUND_VERSION: u32 = 1;

/// The round record of a finished run.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundRecord {
    pub version: u32,
    /// The repository's shared git directory ([`git::common_dir`]).
    pub repo: String,
    pub branch: String,
    /// The commit `HEAD` named when the run started.
    pub head: String,
    pub round: u32,
    /// When the run finished, in milliseconds since the epoch: the newest record wins.
    pub finished_at_ms: u64,
    pub ledger: Vec<LedgerRow>,
}

/// The record of the run in `dir`.
#[must_use]
pub fn record_path(dir: &Path) -> PathBuf {
    dir.join("round.json")
}

/// Milliseconds since the epoch, 0 when the clock is before it.
#[must_use]
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

/// The prior round a run builds on: where its run is and what it recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prior {
    pub dir: PathBuf,
    pub record: RoundRecord,
}

/// Why a run starts a chain of its own instead of building on a prior round.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unchained {
    /// The caller asked for a new chain.
    Fresh,
    /// `HEAD` is on no branch (detached), so there is no chain to key it on.
    NoBranch,
    /// No finished round of this branch is on `HEAD`'s history.
    NoPriorRound,
}

impl Unchained {
    /// The reason as the report and the record name it.
    #[must_use]
    pub fn reason(self) -> &'static str {
        match self {
            Self::Fresh => "fresh: a new chain was asked for",
            Self::NoBranch => {
                "no branch (a detached HEAD): findings do not carry to a later run; check out a branch to chain review rounds"
            }
            Self::NoPriorRound => "no earlier round of this branch is on HEAD's history",
        }
    }
}

/// The round record in `dir`, when it is one of this format.
fn read_record(dir: &Path) -> Option<RoundRecord> {
    let text = std::fs::read_to_string(record_path(dir)).ok()?;
    serde_json::from_str::<RoundRecord>(&text)
        .ok()
        .filter(|r| r.version == ROUND_VERSION)
}

/// The newest round under `runs` of `repo`'s `branch` whose head is on the history of `cwd`'s
/// `HEAD`; a rebase or a force-push leaves an older chain behind.
#[must_use]
pub fn newest(runs: &Path, cwd: &Path, repo: &str, branch: &str) -> Option<Prior> {
    let entries = std::fs::read_dir(runs).ok()?;
    entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter_map(|dir| Some((read_record(&dir)?, dir)))
        .filter(|(r, _)| r.repo == repo && r.branch == branch)
        .filter(|(r, _)| git::is_ancestor(cwd, &r.head))
        .max_by_key(|(r, _)| r.finished_at_ms)
        .map(|(record, dir)| Prior { dir, record })
}

/// The prior round of `cwd`'s branch under `runs`, or why there is none.
///
/// # Errors
/// [`Unchained`] when `fresh`, on a detached `HEAD`, or when no round qualifies.
pub fn locate(
    runs: &Path,
    cwd: &Path,
    repo: &str,
    branch: Option<&str>,
    fresh: bool,
) -> Result<Prior, Unchained> {
    if fresh {
        return Err(Unchained::Fresh);
    }
    let branch = branch.ok_or(Unchained::NoBranch)?;
    newest(runs, cwd, repo, branch).ok_or(Unchained::NoPriorRound)
}

/// Whether round `round` of a chain reviews the whole diff again rather than the fix commits:
/// every `full_every`-th round, never when it is 0, as `shouldFullRescan`.
#[must_use]
pub fn periodic_rescan(round: u32, full_every: u32) -> bool {
    full_every >= 1 && round.is_multiple_of(full_every)
}

/// Writes the round record into `dir`.
///
/// # Errors
/// When it cannot be encoded or written.
pub fn file_record(dir: &Path, record: &RoundRecord) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(record).map_err(std::io::Error::other)?;
    std::fs::write(record_path(dir), format!("{text}\n"))
}

/// A record of this format.
#[must_use]
pub fn record(
    repo: &str,
    branch: &str,
    head: &str,
    round: u32,
    ledger: Vec<LedgerRow>,
) -> RoundRecord {
    RoundRecord {
        version: ROUND_VERSION,
        repo: repo.to_owned(),
        branch: branch.to_owned(),
        head: head.to_owned(),
        round,
        finished_at_ms: now_ms(),
        ledger,
    }
}

#[cfg(test)]
mod tests {
    use super::periodic_rescan;

    #[test]
    fn every_nth_round_rescans_and_zero_never_does() {
        assert!(!periodic_rescan(2, 3));
        assert!(periodic_rescan(3, 3));
        assert!(periodic_rescan(6, 3));
        assert!(periodic_rescan(2, 1));
        assert!(!periodic_rescan(3, 0));
    }
}
