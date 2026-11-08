//! Publishing findings on the PR (`comment`; realm @nick/craft, nodes #194, #270, #271, #281), as
//! the review engine's sorting phase does (`lib/review-sorting.mjs`): when the run finishes, the
//! findings a comment could carry — confirmed, and suspected the reviewer may still ask about —
//! are sorted into defects and doubtful ones ([`sort`]); the defects are posted on the branch's PR
//! with the craft-finding marker ([`gh`]), the doubtful ones listed for the reviewer, numbered as
//! the run record keeps them for `lib/finding-post.mjs`. Every run, asked or not, counts the
//! findings going against a memory record. The binary reads the changed lines with git, where the
//! engine asks an agent for them.

use std::path::Path;

use serde_json::{Value, json};

use crate::Error;
use crate::gate::lines::Lines;
use crate::report::Tier;
use crate::state::{self, Phase, RunState};
use crate::step::StepError;

mod body;
mod gh;
mod kept;
#[cfg(test)]
mod parity;
mod section;
mod sort;
#[cfg(test)]
mod tests;

pub use gh::PostSetup;
pub use kept::{Defect, Posted, Publish, Sorting};
pub(crate) use section::section;
pub(crate) use sort::doubt_reasons;

/// Why nothing is posted from a review of uncommitted work: its lines are not the PR head's.
const DIRTY: &str = "the review read uncommitted changes, whose lines the PR's head does not hold: commit, push and review again";

/// Why the changed lines are unknown, as the engine's note says it of its agent.
const NOT_JUDGED: &str = "git could not list the lines the diff changed, so whether a line is inside the diff was not judged";

/// The findings a PR comment could carry, each with its tier.
fn candidates(run: &RunState) -> Vec<Value> {
    run.settled
        .iter()
        .filter(|f| matches!(Tier::of(f), Tier::Confirmed | Tier::Suspected))
        .cloned()
        .collect()
}

/// The lines the branch's whole diff changed, from its base to the working tree.
fn changed_lines(run: &RunState) -> Option<Lines> {
    let base = crate::finished::base(run);
    crate::git::zero_context_diff(Path::new(&run.context.repo), base)
        .ok()
        .map(|d| Lines::parse(&d))
}

/// Sorts the finished run's findings when it was asked to publish them, and counts those going
/// against memory either way.
pub(crate) fn settle(run: &mut RunState) {
    // This round's findings only, as the engine's record counts its sort candidates: a prior the
    // round carries was counted, and posted or not, by the round that found it.
    let found = candidates(run);
    if !run.publish.asked {
        run.publish.contradictions =
            Some(crate::memory::contradiction_record(&found, None, |_| false));
        return;
    }
    let changed = changed_lines(run);
    let (defect, doubtful) = sort::sort(&found, changed.as_ref());
    let defects: Vec<Defect> = defect
        .iter()
        .map(|f| Defect {
            finding: f.clone(),
            file: sort::text(f, "file").trim().to_owned(),
            line: sort::in_diff(changed.as_ref(), f)
                .filter(|&inside| inside)
                .map(|_| sort::line(f)),
        })
        .collect();
    let to_pr = |f: &Value| defect.contains(f);
    run.publish.contradictions = Some(crate::memory::contradiction_record(
        &found,
        changed.as_ref(),
        to_pr,
    ));
    let note = if changed.is_none() { NOT_JUDGED } else { "" };
    run.publish.sorting = Some(Sorting {
        defects,
        doubtful,
        note: note.into(),
    });
}

/// Posts the finished run's defects once, when it was asked to, and writes its report again with
/// what came of it; the verdict stands whatever gh does.
///
/// # Errors
/// When the report cannot be written.
pub fn deliver(dir: &Path, run: &mut RunState, setup: &PostSetup) -> Result<(), Error> {
    let (Some(sorting), Some(verdict)) = (&run.publish.sorting, &run.verdict) else {
        return Ok(());
    };
    if run.phase != Phase::Done || run.publish.posted.is_some() {
        return Ok(());
    }
    let (with_file, no_file): (Vec<&Defect>, Vec<&Defect>) =
        sorting.defects.iter().partition(|d| !d.file.is_empty());
    let mut posted = if with_file.is_empty() {
        Posted {
            reason: "no defect to post".into(),
            ..Posted::default()
        }
    } else if run.diff.dirty {
        Posted {
            requested: with_file.len(),
            reason: DIRTY.into(),
            ..Posted::default()
        }
    } else {
        let defects: Vec<Defect> = with_file.into_iter().cloned().collect();
        gh::post(
            Path::new(&run.context.repo),
            &run.diff.head,
            &defects,
            dir,
            setup,
        )
    };
    posted.no_file = no_file.len();
    run.publish.posted = Some(posted);
    let path = state::report_path(dir);
    let verdict = verdict.clone();
    std::fs::write(&path, crate::report::markdown(run, &verdict))
        .map_err(|source| StepError::NoReport { path, source }.into())
}

/// What the finished step and the run record carry: the sorting (null when not asked), the memory
/// contradictions and the posting's outcome (null when not asked).
pub(crate) fn finished(run: &RunState) -> [(&'static str, Value); 3] {
    let p = &run.publish;
    let sorting = p.sorting.as_ref().map_or(Value::Null, |s| {
        let findings: Vec<Value> = s
            .doubtful
            .iter()
            .enumerate()
            .map(|(i, (f, r))| sort::postable(f, i, r))
            .collect();
        let mut v = json!({"defect": s.defects.len(), "doubtful": s.doubtful.len(), "inDiffJudged": s.note.is_empty(), "findings": findings});
        if let (Some(o), false) = (v.as_object_mut(), s.note.is_empty()) {
            o.insert("inDiffNote".into(), json!(s.note));
        }
        v
    });
    [
        ("sorting", sorting),
        (
            "memoryContradictions",
            p.contradictions.clone().unwrap_or(Value::Null),
        ),
        (
            "prComments",
            p.posted.as_ref().map_or(Value::Null, |x| json!(x)),
        ),
    ]
}
