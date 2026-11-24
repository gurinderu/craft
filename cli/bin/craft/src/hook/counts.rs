//! Whether a run counts as a full craft review of the pull request's whole change on its head
//! (realm @nick/craft, node #541): silence must mean exactly that, so every field a record carries
//! that narrows what it reviewed takes it out, and a record that lacks the field to tell is out too
//! — but its coverage gaps (`capped`), which hold its verdict at Warning instead.
//! Only a `craft:review` run counts (`review`, or the CLI's interim `cli-review`).

use craft_review::coverage;
use craft_store::js::JsStr;
use serde_json::Value;

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
        // Gaps in `capped` hold the verdict at Warning, not out (realm @nick/craft, node #541).
        && d.not_run.as_ref().is_some_and(Vec::is_empty)
        && lenses_ran(line.verdict.as_deref(), d.lens_rounds.as_deref())
        && d.base.as_deref().is_some_and(|b| pr_base(b, here, git))
}

/// Whether the run's lenses ran: a lens round filed, or none needed — the coverage exit for a
/// change of documentation, assets, lockfiles or generated output alone
/// ([`coverage::NOTHING_TO_REVIEW`], verbatim), which runs no lens, also when a coverage gap holds it
/// at Warning ([`coverage::NOTHING_TO_REVIEW_HELD`]). A red gate's bare Block files no round and
/// stays out.
fn lenses_ran(verdict: Option<&str>, rounds: Option<&[Value]>) -> bool {
    let nothing = [
        coverage::NOTHING_TO_REVIEW,
        coverage::NOTHING_TO_REVIEW_HELD,
    ];
    rounds.is_some_and(|r| !r.is_empty() || verdict.is_some_and(|v| nothing.contains(&v)))
}

/// A verdict that claims its whole scope: not empty, and with neither of the markers the review
/// writers put on a verdict that did not cover it — INCOMPLETE (`honestVerdict`, the CLI's
/// `report::verdict` and its coverage exits, `INCOMPLETE (<why>)` among them) and PARTIAL COVERAGE
/// (`report::verdict`, `verdictSuffix` in `integrations/shared/review-coverage.mjs`).
fn clean(verdict: Option<&str>) -> bool {
    let v = verdict.unwrap_or_default().to_ascii_uppercase();
    !v.js_trim().is_empty() && !v.contains("INCOMPLETE") && !v.contains("PARTIAL COVERAGE")
}

/// Whether a review over `base` reviewed the PR's whole change: `base` is `origin/<the PR's base>`,
/// or meets the PR's head where that ref does. A bare name is read as `origin/<name>` when this
/// checkout has that ref, as the PR's base is: a local trunk may lag it, and `develop` passes the
/// trunk's bare name. A base relative to the HEAD of its run (`HEAD~1`, `@`, `main~2`) cannot be
/// read again later, so it is not the PR's base.
fn pr_base(base: &str, here: &Here, git: &dyn Git) -> bool {
    if base == here.trunk {
        return true;
    }
    if relative(base) {
        return false;
    }
    let remote = format!("origin/{base}");
    let at = if git.has_ref(&remote) {
        remote.as_str()
    } else {
        base
    };
    git.merge_base(at).is_some_and(|m| m == here.point)
}

/// A revision read from where its run's HEAD stood: HEAD or another `*HEAD`, `@`, or one walked
/// from a commit (`~`, `^`).
fn relative(base: &str) -> bool {
    base.ends_with("HEAD") || base.contains(['~', '^', '@'])
}

/// A path that confines a review to nothing narrower than the repository.
fn whole(path: Option<&str>) -> bool {
    matches!(path.map(|p| p.trim_end_matches('/')), None | Some("" | "."))
}

#[cfg(test)]
#[path = "counts_tests.rs"]
pub(super) mod tests;
