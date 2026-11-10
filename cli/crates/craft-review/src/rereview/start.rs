//! Where a run joins its branch's chain: the prior round it builds on and what its lenses review.

use std::path::Path;

use super::branch::{self, Lookup};
use super::{Chain, Fate, PriorFinding, PriorRun};
use crate::chain::{self, Prior};
use crate::git::{self, Diff, GitError};
use crate::ledger::LedgerRow;
use crate::prompts::ReScope;

/// The prior round's rows: tombstones apart, every other row a prior finding with its starting fate.
/// `quiet` says of a `deferred` row whether its deferral may be carried without an adjudicator.
pub(super) fn take_ledger(
    chain: &mut Chain,
    ledger: Vec<LedgerRow>,
    quiet: &dyn Fn(&LedgerRow) -> bool,
) {
    for row in ledger {
        let fate = match row.disposition.as_str() {
            "closed" => {
                chain.tombstones.push(row);
                continue;
            }
            // The unverified tier is taken out first, whatever the row's disposition, as
            // `carryUnverifiedPriors` does: nothing checked it, so there is nothing to adjudicate or
            // carry-check, and it is carried forward unverified.
            _ if row.tier == "unverified" => Fate::Unverified,
            // Only the author's dismissals are carry-checked, as `isSettledPrior` settles them.
            "rejected" | "justified" => Fate::Carried,
            // A `deferred` row whose deferral is quiet — it names its question, it is not Critical or
            // High, and the code of its file is unchanged since the question's commit — is carried as
            // Known and deferred, as the engine's carry-check carries it; whether its question still
            // holds is settled once the memory is recalled (`hold_deferrals`).
            "deferred" if quiet(&row) => Fate::Deferred,
            // Everything else is adjudicated and counted by its answer: `open`; a `deferred` row with
            // no deferral, Critical or High, or whose code changed since its question's commit (the
            // engine adjudicates it once its carry-check sees the change); a disposition this CLI does
            // not know.
            _ => Fate::Pending,
        };
        chain.priors.push(PriorFinding {
            row,
            fate,
            located: false,
            contradicts: None,
        });
    }
}

/// Whether a deferred row may be carried without an adjudicator: it carries a deferral with a
/// commit, it is not Critical or High, and git shows its file unchanged since that commit, the
/// working tree included (the scope check the memory runs for its records).
fn quiet_deferral(cwd: &Path, row: &LedgerRow) -> bool {
    let Some(d) = row.deferral.as_ref().filter(|d| !d.commit.is_empty()) else {
        return false;
    };
    let severe = matches!(row.severity.to_lowercase().as_str(), "critical" | "high");
    let file = if row.file.is_empty() {
        "."
    } else {
        row.file.as_str()
    };
    !severe && git::has_commit(cwd, &d.commit) && git::unchanged_since(cwd, &d.commit, file)
}

/// The chain of the run about to start in `cwd`: its key, its round and the prior round it builds
/// on under `runs`, unless `fresh` asks for a new chain or the run is `nested` (a parent engine
/// launched it, so it stays out of the chain). `base` is the branch's own base, `scope` the
/// directory of the change the run reviews (`None`, the whole change); on a detached `HEAD`,
/// `lookup` asks gh for the pull request whose branch keys the chain ([`branch::resolve`]).
///
/// # Errors
/// When `cwd`'s git directory cannot be read.
pub fn begin(
    cwd: &Path,
    runs: &Path,
    (fresh, nested): (bool, bool),
    full_every: u32,
    base: &str,
    scope: Option<&str>,
    lookup: Lookup<'_>,
) -> Result<Chain, GitError> {
    // A nested run stays out of the chain, so gh is not asked for one.
    let gh = lookup.gh.filter(|_| !nested);
    let resolved = branch::resolve(cwd, Lookup { gh, ..lookup });
    let mut chain = Chain {
        repo: git::common_dir(cwd)?,
        branch: resolved.name.clone(),
        branch_from: resolved.from.clone(),
        pr: resolved.pr,
        scope: scope.unwrap_or_default().to_owned(),
        round: 1,
        base: base.to_owned(),
        nested,
        started_at_ms: chain::now_ms(),
        ..Chain::default()
    };
    let key = (
        chain.repo.as_str(),
        chain.branch.as_deref(),
        chain.scope.as_str(),
    );
    let found = if nested {
        Err(chain::Unchained::Nested)
    } else {
        chain::locate(runs, cwd, key, fresh)
    };
    match found {
        Err(why) => chain.unchained = Some(branch::unchained(why, &resolved)),
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
            take_ledger(&mut chain, record.ledger, &|row| quiet_deferral(cwd, row));
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
    let scope = Some(chain.scope.as_str()).filter(|s| !s.is_empty());
    let delta = git::read_diff(cwd, Some(&prior.head), scope)?;
    if delta.files.is_empty() {
        chain.rescan = Some("nothing changed since the prior round's head, so there were no fix commits to review on their own".into());
        return Ok((branch, ReScope::Rescan));
    }
    Ok((delta, ReScope::Fixes))
}
