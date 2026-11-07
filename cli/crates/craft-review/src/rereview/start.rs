//! Where a run joins its branch's chain: the prior round it builds on and what its lenses review.

use std::path::Path;

use super::{Chain, Fate, PriorFinding, PriorRun};
use crate::chain::{self, Prior};
use crate::git::{self, Diff, GitError};
use crate::ledger::LedgerRow;
use crate::prompts::ReScope;

/// The prior round's rows: tombstones apart, every other row a prior finding with its starting fate.
pub(super) fn take_ledger(chain: &mut Chain, ledger: Vec<LedgerRow>) {
    for row in ledger {
        let fate = match row.disposition.as_str() {
            "closed" => {
                chain.tombstones.push(row);
                continue;
            }
            "open" if row.tier == "unverified" => Fate::Unverified,
            "open" => Fate::Pending,
            _ => Fate::Carried,
        };
        chain.priors.push(PriorFinding {
            row,
            fate,
            located: false,
        });
    }
}

/// The chain of the run about to start in `cwd`: its key, its round and the prior round it builds
/// on under `runs`, unless `fresh` asks for a new chain. `base` is the branch's own base.
///
/// # Errors
/// When `cwd`'s git directory cannot be read.
pub fn begin(
    cwd: &Path,
    runs: &Path,
    fresh: bool,
    full_every: u32,
    base: &str,
) -> Result<Chain, GitError> {
    let mut chain = Chain {
        repo: git::common_dir(cwd)?,
        branch: git::branch(cwd),
        round: 1,
        base: base.to_owned(),
        ..Chain::default()
    };
    match chain::locate(runs, cwd, &chain.repo, chain.branch.as_deref(), fresh) {
        Err(why) => chain.unchained = Some(why.reason().to_owned()),
        Ok(Prior { dir, record }) => {
            chain.round = record.round.saturating_add(1);
            if chain::periodic_rescan(chain.round, full_every) {
                chain.rescan = Some(format!(
                    "every {full_every}th round (fullEvery={full_every}) reviews the whole diff again, so a defect an earlier round missed in code no fix touched is found"
                ));
            }
            chain.prior = Some(PriorRun {
                dir: dir.display().to_string(),
                round: record.round,
                head: record.head,
            });
            take_ledger(&mut chain, record.ledger);
        }
    }
    Ok(chain)
}

/// What the run's lenses review: the branch's diff on a first review or a re-scan, else the fix
/// commits since the prior round's head — the whole diff again when nothing changed since it.
///
/// # Errors
/// When the diff from the prior head cannot be read.
pub fn scope(cwd: &Path, chain: &mut Chain, branch: Diff) -> Result<(Diff, ReScope), GitError> {
    let Some(prior) = chain.prior.as_ref() else {
        return Ok((branch, ReScope::First));
    };
    if chain.rescan.is_some() {
        return Ok((branch, ReScope::Rescan));
    }
    let delta = git::read_diff(cwd, Some(&prior.head))?;
    if delta.files.is_empty() {
        chain.rescan = Some("nothing changed since the prior round's head, so there were no fix commits to review on their own".into());
        return Ok((branch, ReScope::Rescan));
    }
    Ok((delta, ReScope::Fixes))
}
