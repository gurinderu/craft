//! Whether a run counts as a full craft review of the pull request's whole change on its head
//! (realm @nick/craft, node #541): silence must mean exactly that, so every field a record carries
//! that narrows what it reviewed takes it out, and a record that lacks the field to tell is out too.
//! Only a `craft:review` run counts (`review`, or the CLI's interim `cli-review`).

use super::record::{Detail, Line};
use super::repo::{Git, Here};

/// Whether `line`, with its detail file `detail`, is a finished full review of `here`'s PR.
pub fn counts(line: &Line, detail: Option<&Detail>, here: &Here, git: &dyn Git) -> bool {
    let Some(d) = detail else { return false };
    matches!(line.name.as_deref(), Some("review" | "cli-review"))
        && line.kind.as_deref() == Some("workflow")
        && line.head.as_deref() == Some(here.head.as_str())
        && clean(line.verdict.as_deref())
        && line.dirty != Some(true)
        && line.nested != Some(true)
        && d.partial != Some(true)
        && d.lens_scope.as_deref() != Some("delta")
        && d.depth.as_deref() != Some("light")
        && whole(d.path.as_deref())
        && d.not_run.as_ref().is_some_and(Vec::is_empty)
        && d.lens_rounds.as_ref().is_some_and(|r| !r.is_empty())
        && d.base.as_deref().is_some_and(|b| pr_base(b, here, git))
}

/// A verdict that claims its whole scope: not empty, and with neither of the markers the review
/// writers put on a verdict that did not cover it — INCOMPLETE (`honestVerdict`, the CLI's
/// `report::verdict` and its coverage exits, `INCOMPLETE (<why>)` among them) and PARTIAL COVERAGE
/// (`report::verdict`, `verdictSuffix` in `lib/review-coverage.mjs`).
fn clean(verdict: Option<&str>) -> bool {
    let v = verdict.unwrap_or_default().to_ascii_uppercase();
    !v.trim().is_empty() && !v.contains("INCOMPLETE") && !v.contains("PARTIAL COVERAGE")
}

/// Whether a review over `base` reviewed the PR's whole change: `base` is `origin/<the PR's base>`,
/// or meets the head where that ref does.
fn pr_base(base: &str, here: &Here, git: &dyn Git) -> bool {
    base == here.trunk || git.merge_base(base).is_some_and(|m| m == here.point)
}

/// A path that confines a review to nothing narrower than the repository.
fn whole(path: Option<&str>) -> bool {
    matches!(path.map(|p| p.trim_end_matches('/')), None | Some("" | "."))
}

#[cfg(test)]
#[path = "counts_tests.rs"]
pub(super) mod tests;
