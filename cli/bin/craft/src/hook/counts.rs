//! Whether a run on the head counts as a full craft review of the pull request's whole change
//! (realm @nick/craft, node #541): silence must mean exactly that, so every field a record carries
//! that narrows what it reviewed takes it out, and a record that lacks the field to tell is out too.

use super::here::{Git, Here};
use super::record::{Detail, Line};

/// What a run on the head amounts to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Counts {
    /// A finished full review of the PR's whole change.
    Full,
    /// A finished rust-audit whose crate reviews left files of the change outside every crate.
    CratesOnly,
    No,
}

/// What `line`, with its detail file `detail`, amounts to for `here`.
pub fn counts(line: &Line, detail: Option<&Detail>, here: &Here, git: &dyn Git) -> Counts {
    let Some(d) = detail else { return Counts::No };
    let finished = line.kind.as_deref() == Some("workflow")
        && clean(line.verdict.as_deref())
        && line.dirty != Some(true)
        && d.partial != Some(true);
    match line.name.as_deref() {
        Some("review" | "cli-review") if finished && review(d, here, git) => Counts::Full,
        Some("rust-audit") if finished => audit(d, here, git),
        _ => Counts::No,
    }
}

/// A verdict that claims its whole scope: not empty, and with neither of the markers the review
/// writers put on a verdict that did not cover it — INCOMPLETE (`honestVerdict`, the CLI's
/// `report::verdict` and its coverage exits, `INCOMPLETE (<why>)` among them) and PARTIAL COVERAGE
/// (`report::verdict`, `verdictSuffix` in `lib/review-coverage.mjs`).
fn clean(verdict: Option<&str>) -> bool {
    let v = verdict.unwrap_or_default().to_ascii_uppercase();
    !v.trim().is_empty() && !v.contains("INCOMPLETE") && !v.contains("PARTIAL COVERAGE")
}

/// A CLI review: every lens over the whole change — not a delta round, not a light pass, not
/// confined to a path, nothing it needed left unrun, its lenses ran (a red gate ends before them),
/// and its base is the PR's.
fn review(d: &Detail, here: &Here, git: &dyn Git) -> bool {
    d.lens_scope.as_deref() != Some("delta")
        && d.depth.as_deref() != Some("light")
        && whole(d.path.as_deref())
        && d.not_run.as_ref().is_some_and(Vec::is_empty)
        && d.lens_rounds.as_ref().is_some_and(|r| !r.is_empty())
        && d.base.as_deref().is_some_and(|b| pr_base(b, here, git))
}

/// A rust-audit: no review kept from starting by a red gate, every nested review it filed finished,
/// its base the PR's, and its reviews' paths covering every file of the change; one filed before it
/// listed its reviews never counts.
fn audit(d: &Detail, here: &Here, git: &dyn Git) -> Counts {
    let base = d.scout.as_ref().and_then(|s| s.base_ref.as_deref());
    // An empty base: the scout resolved none, and the nested reviews took origin's default branch.
    let based = base.is_none_or(|b| b.is_empty() || pr_base(b, here, git));
    let reviews = d.reviews.as_deref().unwrap_or_default();
    let finished = !reviews.is_empty()
        && reviews.iter().all(|r| clean(r.verdict.as_deref()))
        && d.gate_blocked.as_ref().is_none_or(Vec::is_empty);
    if !(based && finished) {
        return Counts::No;
    }
    if reviews.iter().any(|r| whole(r.path.as_deref())) {
        return Counts::Full;
    }
    let Some(files) = git.changed() else {
        return Counts::No;
    };
    let covered = |f: &String| reviews.iter().any(|r| under(f, r.path.as_deref()));
    if files.iter().all(covered) {
        Counts::Full
    } else {
        Counts::CratesOnly
    }
}

/// Whether a review over `base` reviewed the PR's whole change: `base` is origin's default branch,
/// or meets the head where that branch does.
fn pr_base(base: &str, here: &Here, git: &dyn Git) -> bool {
    base == here.trunk || git.merge_base(base).is_some_and(|m| m == here.point)
}

/// A path that confines a review to nothing narrower than the repository.
fn whole(path: Option<&str>) -> bool {
    matches!(path.map(|p| p.trim_end_matches('/')), None | Some("" | "."))
}

fn under(file: &str, path: Option<&str>) -> bool {
    let p = path.unwrap_or_default().trim_end_matches('/');
    file == p || file.strip_prefix(p).is_some_and(|r| r.starts_with('/'))
}

#[cfg(test)]
#[path = "counts_tests.rs"]
pub(super) mod tests;
