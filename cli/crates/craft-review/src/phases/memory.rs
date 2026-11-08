//! The project memory's part of a run's end, as `setAsidePhase` in `lib/review-set-aside.mjs`
//! orders it: a lens finding repeating a live prior absorbed into it, then the decisions — the
//! match judge handed out first when a near miss needs it — then the project rules, the rule judge
//! handed out first when a finding sits in a rule's scope; each judge a step of its own.

use std::path::{Path, PathBuf};

use super::{finish, only_answer};
use crate::Error;
use crate::rereview;
use crate::state::{Phase, RunState};

/// Once verification settled: a lens finding repeating a live prior is absorbed into it, then the
/// project's memory is applied — the match judge handed out first when a near miss needs it.
///
/// # Errors
/// When a judge's prompt cannot be rendered or the report written.
pub(crate) fn settle(dir: &Path, run: &mut RunState) -> Result<(), Error> {
    let absorbed = rereview::absorb(&mut run.chain, &mut run.settled);
    run.notes.extend(absorbed);
    let repo = PathBuf::from(&run.context.repo);
    if let Some(task) = run.memory.match_task(&repo, &run.settled, &run.chain)? {
        run.tasks = vec![task];
        run.phase = Phase::Match;
        return Ok(());
    }
    let m = &mut run.memory;
    m.apply(
        &repo,
        &mut run.settled,
        &mut run.chain,
        &mut run.notes,
        None,
    );
    cover_by_rules(dir, run)
}

/// After the decisions: the project rules over what they left, the rule judge handed out first
/// when a finding sits in a rule's scope.
fn cover_by_rules(dir: &Path, run: &mut RunState) -> Result<(), Error> {
    if let Some(task) = run.memory.rule_task(&run.settled, &run.chain)? {
        run.tasks = vec![task];
        run.phase = Phase::Rules;
        return Ok(());
    }
    let m = &mut run.memory;
    m.cover(&mut run.settled, &mut run.chain, &mut run.notes, None);
    finish(dir, run)
}

/// The match judge answered: the decisions applied with its verdicts, then the rules.
pub(super) fn matched(dir: &Path, run: &mut RunState) -> Result<(), Error> {
    let answer = only_answer(run);
    let repo = PathBuf::from(&run.context.repo);
    let m = &mut run.memory;
    m.apply(
        &repo,
        &mut run.settled,
        &mut run.chain,
        &mut run.notes,
        answer.as_ref(),
    );
    cover_by_rules(dir, run)
}

/// The rule judge answered: the rules applied with its verdicts, then the run ends.
pub(super) fn ruled(dir: &Path, run: &mut RunState) -> Result<(), Error> {
    let answer = only_answer(run);
    let m = &mut run.memory;
    m.cover(
        &mut run.settled,
        &mut run.chain,
        &mut run.notes,
        answer.as_ref(),
    );
    finish(dir, run)
}
